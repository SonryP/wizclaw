import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from './state.js';
import { StepRunner } from './step-runner.js';
import { checkAllPrereqs, installPrereq } from './prereqs/index.js';
import { runSetupToken } from './prereqs/claude.js';

/**
 * Windows only: defensively rewrite every .sh file in the cloned repo with
 * LF line endings before we hand off to bash. This covers three stale-state
 * scenarios that the clone-time `-c core.autocrlf=false` flag can't reach:
 *
 *   1. A clone produced by an older build of wizclaw (before the autocrlf
 *      flag was added) that's still on disk.
 *   2. A .gitattributes rule in the cloned repo that forces CRLF despite
 *      the core.autocrlf override at clone time.
 *   3. Any file materialized by a subsequent `git merge` / `git checkout`
 *      that respected the user's global core.autocrlf.
 *
 * bash chokes on CRLF-terminated scripts with errors like
 * `set: pipefail\r: invalid option name`, so one bad byte is enough to
 * abort the entire bootstrap. This helper is idempotent and a no-op when
 * the files are already LF, so it's safe to call every time.
 *
 * Platform-guarded at the call site — this is never invoked on macOS/Linux
 * where CRLF is never introduced in the first place.
 */
function normalizeShellScriptsForBash(
  repoDir: string,
  window: BrowserWindow,
  step: string,
): void {
  const fixed: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip dirs that would be huge, slow, or not source-controlled.
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'dist' ||
        entry.name === 'build'
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.sh')) {
        try {
          const content = fs.readFileSync(full, 'utf-8');
          if (content.includes('\r')) {
            const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            fs.writeFileSync(full, normalized);
            fixed.push(path.relative(repoDir, full));
          }
        } catch {
          // Best-effort: skip files we can't read/write.
        }
      }
    }
  };
  walk(repoDir, 0);
  if (fixed.length > 0) {
    window.webContents.send('wizard:output', {
      step,
      stream: 'stdout',
      text: `Normalized LF line endings on ${fixed.length} shell script(s): ${fixed.join(', ')}\n`,
    });
  }
}

/**
 * Ensure the native credential proxy is merged into the NanoClaw install.
 * Idempotent — checks if already applied before doing anything.
 */
async function ensureCredentialProxy(
  nanoClawPath: string,
  stepRunner: StepRunner,
  step: string,
  window: BrowserWindow,
): Promise<void> {
  // Check if already applied
  const proxyFile = path.join(nanoClawPath, 'src', 'credential-proxy.ts');
  const indexFile = path.join(nanoClawPath, 'src', 'index.ts');
  if (fs.existsSync(proxyFile)) {
    // Also verify it's imported in index.ts
    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    if (indexContent.includes('credential-proxy')) {
      return; // Already applied
    }
  }

  window.webContents.send('wizard:output', {
    step, stream: 'stdout',
    text: 'Setting up credential proxy...\n',
  });

  // Ensure upstream remote
  await stepRunner.runCommand(step, 'git', [
    'remote', 'add', 'upstream', 'https://github.com/qwibitai/nanoclaw.git',
  ], { cwd: nanoClawPath });

  const fetchResult = await stepRunner.runCommand(step, 'git', [
    'fetch', 'upstream', 'skill/native-credential-proxy',
  ], { cwd: nanoClawPath });

  if (fetchResult.code !== 0) {
    window.webContents.send('wizard:output', {
      step, stream: 'stderr',
      text: 'Warning: could not fetch credential proxy. Check internet.\n',
    });
    return;
  }

  // Merge (--no-verify to bypass the pre-commit prettier hook on the merge commit)
  const mergeResult = await stepRunner.runCommand(step, 'git', [
    'merge', 'upstream/skill/native-credential-proxy', '--no-edit', '--no-verify',
  ], { cwd: nanoClawPath });

  if (mergeResult.code !== 0) {
    // Resolve conflicts with smart per-file strategy
    const conflicts = await stepRunner.runCommand(step, 'git', [
      'diff', '--name-only', '--diff-filter=U',
    ], { cwd: nanoClawPath });

    if (conflicts.stdout.trim()) {
      for (const f of conflicts.stdout.trim().split('\n')) {
        const file = f.trim();
        if (file === 'src/channels/index.ts') {
          // Barrel file — keep ours (channel imports already there)
          await stepRunner.runCommand(step, 'git', [
            'checkout', '--ours', file,
          ], { cwd: nanoClawPath });
        } else if (file === 'package.json') {
          await mergePackageJson(nanoClawPath);
        } else {
          // For proxy files (src/index.ts, src/config.ts, etc.), accept theirs
          await stepRunner.runCommand(step, 'git', [
            'checkout', '--theirs', file,
          ], { cwd: nanoClawPath });
        }
      }
    }

    await stepRunner.runCommand(step, 'git', ['add', '-A'], { cwd: nanoClawPath });
    // --no-verify to bypass prettier pre-commit hook
    const proxyCommit = await stepRunner.runCommand(step, 'git', [
      'commit', '--no-edit', '--no-verify',
      '-m', 'Apply native credential proxy - auto resolved',
    ], { cwd: nanoClawPath });

    // If the commit failed, abort the merge so git isn't left in a half-state
    const mergeHeadPath = path.join(nanoClawPath, '.git', 'MERGE_HEAD');
    if (proxyCommit.code !== 0 || fs.existsSync(mergeHeadPath)) {
      await stepRunner.runCommand(step, 'git', [
        'merge', '--abort',
      ], { cwd: nanoClawPath }).catch(() => {});
      window.webContents.send('wizard:output', {
        step, stream: 'stderr',
        text: 'Warning: credential proxy commit failed — merge aborted.\n',
      });
      return;
    }

    // Re-verify barrel file after proxy merge (proxy's --theirs on other files is fine)
    try {
      const barrelPath = path.join(nanoClawPath, 'src', 'channels', 'index.ts');
      const barrelContent = fs.readFileSync(barrelPath, 'utf-8');
      // Find which channels were installed before the proxy merge
      const channelFiles = fs.readdirSync(path.join(nanoClawPath, 'src', 'channels'))
        .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts' && f !== 'registry.ts')
        .map(f => f.replace('.ts', ''));
      let needsFix = false;
      let fixed = barrelContent;
      for (const ch of channelFiles) {
        const importLine = `import './${ch}.js';`;
        if (!fixed.includes(importLine)) {
          const comment = `// ${ch}`;
          if (fixed.includes(comment)) {
            fixed = fixed.replace(comment, `${comment}\n${importLine}`);
          } else {
            fixed += `\n// ${ch}\n${importLine}\n`;
          }
          needsFix = true;
        }
      }
      if (needsFix) {
        fs.writeFileSync(barrelPath, fixed);
        await stepRunner.runCommand(step, 'git', ['add', barrelPath], { cwd: nanoClawPath });
        await stepRunner.runCommand(step, 'bash', ['-c',
          `git commit -m "Fix: restore channel imports after proxy merge" 2>/dev/null || true`,
        ], { cwd: nanoClawPath });
      }
    } catch {
      // Best effort
    }
  }

  // Verify
  if (!fs.existsSync(proxyFile)) {
    window.webContents.send('wizard:output', {
      step, stream: 'stderr',
      text: 'Warning: credential proxy merge failed.\n',
    });
    return;
  }

  // Reinstall + rebuild
  await stepRunner.runCommand(step, 'npm', ['install'], { cwd: nanoClawPath });
  await stepRunner.runCommand(step, 'npm', ['run', 'build'], { cwd: nanoClawPath });

  window.webContents.send('wizard:output', {
    step, stream: 'stdout',
    text: 'Credential proxy configured.\n',
  });
}

/** Channel skill repos — each channel lives in its own repo */
const CHANNEL_REPOS: Record<string, string> = {
  whatsapp: 'https://github.com/qwibitai/nanoclaw-whatsapp.git',
  telegram: 'https://github.com/qwibitai/nanoclaw-telegram.git',
  slack: 'https://github.com/qwibitai/nanoclaw-slack.git',
  discord: 'https://github.com/qwibitai/nanoclaw-discord.git',
  gmail: 'https://github.com/qwibitai/nanoclaw-gmail.git',
};

/** Env var names for token-based channels */
const CHANNEL_ENV_KEYS: Record<string, string[]> = {
  telegram: ['TELEGRAM_BOT_TOKEN'],
  slack: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  discord: ['DISCORD_BOT_TOKEN'],
};

function readEnvVar(envPath: string, key: string): string | null {
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith(`${key}=`)) {
        return line.slice(key.length + 1).trim();
      }
    }
  } catch {
    // File doesn't exist
  }
  return null;
}

/**
 * Temporarily poll the Telegram Bot API to detect a chat ID.
 * Uses getUpdates long polling — no grammy dependency needed.
 * Returns the first chat ID that sends a message to the bot.
 */
async function detectTelegramChatId(
  botToken: string,
  timeoutMs: number = 60000,
  onStatus?: (msg: string) => void,
): Promise<{ chatId: number; chatName: string; chatType: string }> {
  const baseUrl = `https://api.telegram.org/bot${botToken}`;

  // Clear any pending updates so we only capture new messages
  onStatus?.('Clearing old updates...');
  try {
    const clearResp = await fetch(`${baseUrl}/getUpdates?offset=-1&limit=1`);
    const clearData = await clearResp.json() as any;
    if (clearData.ok && clearData.result?.length > 0) {
      // Acknowledge the last update by requesting offset = lastUpdateId + 1
      const lastId = clearData.result[clearData.result.length - 1].update_id;
      await fetch(`${baseUrl}/getUpdates?offset=${lastId + 1}&limit=1`);
    }
  } catch {
    // Best effort
  }

  onStatus?.('Waiting for a message from you in Telegram...');

  const deadline = Date.now() + timeoutMs;
  let offset = 0;

  while (Date.now() < deadline) {
    const remaining = Math.min(15, Math.ceil((deadline - Date.now()) / 1000));
    if (remaining <= 0) break;

    try {
      const resp = await fetch(
        `${baseUrl}/getUpdates?offset=${offset}&limit=1&timeout=${remaining}`,
        { signal: AbortSignal.timeout(remaining * 1000 + 5000) },
      );
      const data = await resp.json() as any;

      if (data.ok && data.result?.length > 0) {
        const update = data.result[0];
        offset = update.update_id + 1;

        const msg = update.message || update.channel_post;
        if (msg?.chat) {
          const chatId = msg.chat.id;
          const chatType = msg.chat.type;
          const chatName =
            chatType === 'private'
              ? [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || 'Private'
              : msg.chat.title || 'Unknown';

          // Send a confirmation message back
          try {
            await fetch(`${baseUrl}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text: `✅ Chat detected!\n\nChat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}\n\nYou can now continue setup in the wizard.`,
                parse_mode: 'Markdown',
              }),
            });
          } catch {
            // Best effort
          }

          return { chatId, chatName, chatType };
        }
      }
    } catch (err: any) {
      // Timeout or network error — retry if within deadline
      if (Date.now() >= deadline) break;
    }
  }

  throw new Error('Timed out waiting for a Telegram message. Make sure you sent a message to your bot.');
}

/**
 * Fetch Slack channels the bot is a member of using the Web API.
 * Uses only the bot token — no @slack/bolt needed.
 */
async function detectSlackChannels(
  botToken: string,
  onStatus?: (msg: string) => void,
): Promise<Array<{ id: string; name: string; is_private: boolean; num_members: number }>> {
  onStatus?.('Verifying Slack bot token...');

  // Verify token
  const authResp = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
  });
  const authData = await authResp.json() as any;
  if (!authData.ok) {
    throw new Error(`Slack token invalid: ${authData.error}`);
  }

  onStatus?.(`Connected as "${authData.user}" in workspace "${authData.team}"...`);

  // Fetch channels the bot is in
  const channels: Array<{ id: string; name: string; is_private: boolean; num_members: number }> = [];
  let cursor = '';

  do {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    });
    if (cursor) params.set('cursor', cursor);

    const resp = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: { 'Authorization': `Bearer ${botToken}` },
    });
    const data = await resp.json() as any;

    if (!data.ok) {
      throw new Error(`Failed to list Slack channels: ${data.error}`);
    }

    for (const ch of (data.channels || [])) {
      if (ch.is_member) {
        channels.push({
          id: ch.id,
          name: ch.name || ch.id,
          is_private: !!ch.is_private,
          num_members: ch.num_members || 0,
        });
      }
    }

    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);

  onStatus?.(`Found ${channels.length} channel(s) the bot is a member of.`);
  return channels;
}

/**
 * Fetch Discord guilds and text channels the bot has access to.
 * Uses only the bot token REST API — no discord.js needed.
 */
async function detectDiscordChannels(
  botToken: string,
  onStatus?: (msg: string) => void,
): Promise<Array<{ id: string; name: string; guildName: string; guildId: string }>> {
  onStatus?.('Verifying Discord bot token...');

  // Verify token and get bot info
  const meResp = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { 'Authorization': `Bot ${botToken}` },
  });
  if (!meResp.ok) {
    const err = await meResp.json().catch(() => ({})) as any;
    throw new Error(`Discord token invalid: ${err.message || meResp.statusText}`);
  }
  const me = await meResp.json() as any;
  onStatus?.(`Connected as "${me.username}"...`);

  // Get guilds (servers) the bot is in
  const guildsResp = await fetch('https://discord.com/api/v10/users/@me/guilds', {
    headers: { 'Authorization': `Bot ${botToken}` },
  });
  if (!guildsResp.ok) {
    throw new Error('Failed to list Discord servers');
  }
  const guilds = await guildsResp.json() as any[];

  onStatus?.(`Found ${guilds.length} server(s). Loading channels...`);

  const channels: Array<{ id: string; name: string; guildName: string; guildId: string }> = [];

  for (const guild of guilds) {
    try {
      const chResp = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
        headers: { 'Authorization': `Bot ${botToken}` },
      });
      if (!chResp.ok) continue;
      const guildChannels = await chResp.json() as any[];

      // Type 0 = GUILD_TEXT, Type 5 = GUILD_ANNOUNCEMENT
      for (const ch of guildChannels) {
        if (ch.type === 0 || ch.type === 5) {
          channels.push({
            id: ch.id,
            name: ch.name || ch.id,
            guildName: guild.name,
            guildId: guild.id,
          });
        }
      }
    } catch {
      // Skip guilds we can't access
    }
  }

  onStatus?.(`Found ${channels.length} text channel(s) across ${guilds.length} server(s).`);
  return channels;
}

/**
 * Merge the channel barrel file (src/channels/index.ts) during a conflict.
 * Instead of --theirs (which loses previously merged imports), this reads
 * both sides and produces a file with ALL active imports preserved.
 *
 * The barrel file has a simple structure:
 *   // channelname
 *   import './channelname.js';   ← present if that channel's skill was merged
 */
async function mergeChannelBarrelFile(nanoClawPath: string, newChannel: string): Promise<void> {
  const barrelPath = path.join(nanoClawPath, 'src', 'channels', 'index.ts');

  // Read "ours" (current HEAD, has previously merged channels)
  let oursContent = '';
  try {
    oursContent = execSync('git show :2:src/channels/index.ts', {
      cwd: nanoClawPath, encoding: 'utf-8',
    });
  } catch {
    try { oursContent = fs.readFileSync(barrelPath, 'utf-8'); } catch { /* */ }
  }

  // Read "theirs" (incoming channel branch)
  let theirsContent = '';
  try {
    theirsContent = execSync('git show :3:src/channels/index.ts', {
      cwd: nanoClawPath, encoding: 'utf-8',
    });
  } catch { /* */ }

  // Extract all active imports from both sides
  const importRegex = /^import\s+['"]\.\/([\w-]+)\.js['"];?\s*$/gm;
  const activeImports = new Set<string>();

  for (const content of [oursContent, theirsContent]) {
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      activeImports.add(match[1]);
    }
  }

  // Known channel slots in order
  const channelSlots = ['discord', 'gmail', 'slack', 'telegram', 'whatsapp'];

  // Build the merged file
  let merged = '// Channel self-registration barrel file.\n';
  merged += '// Each import triggers the channel module\'s registerChannel() call.\n';

  for (const slot of channelSlots) {
    merged += `\n// ${slot}\n`;
    if (activeImports.has(slot)) {
      merged += `import './${slot}.js';\n`;
    }
  }

  fs.writeFileSync(barrelPath, merged);
}

/**
 * Merge package.json during a conflict — combines dependencies from both sides.
 * Without this, --theirs drops previously installed channel dependencies.
 */
async function mergePackageJson(nanoClawPath: string): Promise<void> {
  const pkgPath = path.join(nanoClawPath, 'package.json');

  let oursPkg: any = {};
  let theirsPkg: any = {};

  try {
    oursPkg = JSON.parse(
      execSync('git show :2:package.json', { cwd: nanoClawPath, encoding: 'utf-8' }),
    );
  } catch { /* */ }

  try {
    theirsPkg = JSON.parse(
      execSync('git show :3:package.json', { cwd: nanoClawPath, encoding: 'utf-8' }),
    );
  } catch { /* */ }

  // Start with theirs as the base (new channel code), then add back ours' deps
  const merged = { ...theirsPkg };

  // Merge dependencies — combine both sides
  merged.dependencies = {
    ...(oursPkg.dependencies || {}),
    ...(theirsPkg.dependencies || {}),
  };
  merged.devDependencies = {
    ...(oursPkg.devDependencies || {}),
    ...(theirsPkg.devDependencies || {}),
  };

  // Merge scripts — combine both sides
  merged.scripts = {
    ...(oursPkg.scripts || {}),
    ...(theirsPkg.scripts || {}),
  };

  fs.writeFileSync(pkgPath, JSON.stringify(merged, null, 2) + '\n');
}

/**
 * Ensure package.json contains the dependencies of every installed channel.
 *
 * Why this exists: git can auto-merge package.json cleanly (no conflict
 * reported) in a way that drops dependencies previously added by earlier
 * channel merges. When that happens, `mergePackageJson` — which only runs
 * during conflict resolution — never gets a chance to repair it.
 *
 * This function runs unconditionally after every channel merge: it walks
 * every installed channel (detected from `src/channels/*.ts`), fetches the
 * corresponding remote's `package.json` via `git show`, and adds back any
 * missing dependencies or devDependencies to the local `package.json`.
 *
 * Returns the list of channels for which deps were restored (empty if none).
 */
async function ensureChannelDependencies(
  nanoClawPath: string,
  channelRepos: Record<string, string>,
  stepRunner: StepRunner,
  step: string,
  window: BrowserWindow,
): Promise<string[]> {
  const channelsDir = path.join(nanoClawPath, 'src', 'channels');
  const localPkgPath = path.join(nanoClawPath, 'package.json');

  if (!fs.existsSync(channelsDir) || !fs.existsSync(localPkgPath)) return [];

  // Detect installed channels by presence of `src/channels/<name>.ts`
  const installed = Object.keys(channelRepos).filter((name) =>
    fs.existsSync(path.join(channelsDir, `${name}.ts`)),
  );
  if (installed.length === 0) return [];

  const localPkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf-8'));
  localPkg.dependencies = localPkg.dependencies || {};
  localPkg.devDependencies = localPkg.devDependencies || {};

  const restored: string[] = [];
  let changed = false;

  for (const channel of installed) {
    // Make sure the remote exists and is fetched before we try `git show`
    await stepRunner.runCommand(step, 'git', [
      'remote', 'add', channel, channelRepos[channel],
    ], { cwd: nanoClawPath }).catch(() => {});
    const fetchResult = await stepRunner.runCommand(step, 'git', [
      'fetch', channel, 'main',
    ], { cwd: nanoClawPath });
    if (fetchResult.code !== 0) continue;

    let channelPkg: any;
    try {
      channelPkg = JSON.parse(
        execSync(`git show ${channel}/main:package.json`, {
          cwd: nanoClawPath, encoding: 'utf-8',
        }),
      );
    } catch {
      continue;
    }

    let addedForThisChannel = false;
    for (const [dep, ver] of Object.entries(channelPkg.dependencies || {})) {
      if (!localPkg.dependencies[dep]) {
        localPkg.dependencies[dep] = ver;
        changed = true;
        addedForThisChannel = true;
      }
    }
    for (const [dep, ver] of Object.entries(channelPkg.devDependencies || {})) {
      if (!localPkg.devDependencies[dep]) {
        localPkg.devDependencies[dep] = ver;
        changed = true;
        addedForThisChannel = true;
      }
    }
    if (addedForThisChannel) restored.push(channel);
  }

  if (changed) {
    fs.writeFileSync(localPkgPath, JSON.stringify(localPkg, null, 2) + '\n');
    window.webContents.send('wizard:output', {
      step, stream: 'stdout',
      text: `Restored missing dependencies for: ${restored.join(', ')}\n`,
    });
    // Commit the restoration immediately. Without this commit the patched
    // package.json sits as a working-tree change that the next git operation
    // (merge, reset, remove-channel) can clobber or absorb into an unrelated
    // commit, hiding the dep restore from history and breaking idempotency.
    await stepRunner.runCommand(step, 'git', ['add', 'package.json'], {
      cwd: nanoClawPath,
    }).catch(() => {});
    await stepRunner.runCommand(step, 'git', [
      'commit', '--no-verify',
      '-m', `chore: restore dependencies for ${restored.join(', ')}`,
    ], { cwd: nanoClawPath }).catch(() => {});
  }

  return restored;
}

/**
 * Resolve all git merge conflicts using per-file strategy.
 * - barrel file: merge both sides' imports
 * - package.json: merge both sides' dependencies
 * - package-lock.json: accept theirs (npm install regenerates)
 * - core files (index.ts, config.ts, container-runner.ts): keep ours (preserves proxy etc.)
 * - everything else: accept theirs
 */
async function resolveConflicts(
  nanoClawPath: string,
  channel: string,
  stepRunner: StepRunner,
  step: string,
): Promise<void> {
  const listConflicts = await stepRunner.runCommand(step, 'git', [
    'diff', '--name-only', '--diff-filter=U',
  ], { cwd: nanoClawPath });

  if (!listConflicts.stdout.trim()) return;

  const conflicted = listConflicts.stdout.trim().split('\n');
  for (const file of conflicted) {
    const f = file.trim();
    if (!f) continue;
    if (f === 'src/channels/index.ts') {
      await mergeChannelBarrelFile(nanoClawPath, channel);
    } else if (f === 'package.json') {
      try {
        await mergePackageJson(nanoClawPath);
      } catch {
        await stepRunner.runCommand(step, 'git', ['checkout', '--theirs', f], { cwd: nanoClawPath });
      }
    } else if (
      f === 'src/index.ts' || f === 'src/config.ts' || f === 'src/container-runner.ts'
    ) {
      await stepRunner.runCommand(step, 'git', ['checkout', '--ours', f], { cwd: nanoClawPath });
    } else {
      await stepRunner.runCommand(step, 'git', ['checkout', '--theirs', f], { cwd: nanoClawPath });
    }
  }
}

function writeEnvVar(envPath: string, key: string, value: string): void {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    // File doesn't exist yet
  }
  // Remove existing line for this key
  const lines = content.split('\n').filter((l) => !l.startsWith(`${key}=`));
  content = lines.join('\n').trimEnd() + '\n' + `${key}=${value}` + '\n';
  fs.writeFileSync(envPath, content);
}

// ─── Docker AI Sandbox helpers ────────────────────────────────────────────────

/**
 * Proxy bypass hosts copied from nanoclaw's official Windows sandbox script
 * (https://nanoclaw.dev/install-docker-sandboxes-windows.sh).
 * Keep in sync when the upstream list changes.
 */
const SANDBOX_PROXY_BYPASS_HOSTS = [
  'api.anthropic.com',
  'api.telegram.org',
  '*.telegram.org',
  '*.whatsapp.com',
  '*.whatsapp.net',
  '*.web.whatsapp.com',
  'discord.com',
  '*.discord.com',
  '*.discord.gg',
  '*.discord.media',
  'slack.com',
  '*.slack.com',
];

/**
 * Run `docker sandbox create` with stdin pre-answered as 'y' so the
 * confirmation prompt doesn't stall the process.  Streams stdout/stderr
 * back through `onOutput`.
 */
function spawnDockerSandboxCreate(
  sandboxName: string,
  windowsWorkspacePath: string,
  onOutput: (text: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      'docker',
      ['sandbox', 'create', '--name', sandboxName, 'claude', windowsWorkspacePath],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // Pre-answer any confirmation prompt with 'y'
    child.stdin?.write('y\n');
    child.stdin?.end();
    child.stdout?.on('data', (d: Buffer) => onOutput(d.toString()));
    child.stderr?.on('data', (d: Buffer) => onOutput(d.toString()));
    child.on('close', (code) => resolve(code === 0));
    child.on('error', (err) => {
      onOutput(`Error: ${err.message}\n`);
      resolve(false);
    });
  });
}

/**
 * Set up a Docker AI Sandbox (Docker Desktop 4.40+) as the NanoClaw
 * container runtime.  Mirrors the steps in nanoclaw's official Windows
 * sandbox install script, but reuses the already-cloned repo rather than
 * cloning again.
 *
 * On success, writes { runtime: 'docker-sandbox', sandboxName } into the
 * 'container' completed-step entry so the service step can read it later.
 */
async function setupDockerSandbox(
  nanoClawPath: string,
  window: BrowserWindow,
  stateManager: StateManager,
  step: string,
): Promise<void> {
  const emit = (text: string) =>
    window.webContents.send('wizard:output', { step, stream: 'stdout', text });

  // 1. Verify Docker sandbox is available (requires Docker Desktop 4.40+)
  emit('Checking Docker sandbox support...\n');
  try {
    execSync('docker sandbox version', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'Docker sandbox not available. ' +
      'Install or update to Docker Desktop 4.40+ and make sure sandbox support is enabled.',
    );
  }

  // 2. Resolve a Windows-native path for the workspace.
  //
  //    Docker Desktop (Windows) can only mount paths it can reach from the
  //    Windows side:
  //      - win32: nanoClawPath is already a Windows path (e.g. C:\Users\...)
  //      - linux (WSLg Electron): nanoClawPath is a Linux path; convert with
  //        wslpath so Docker Desktop gets \\wsl.localhost\<distro>\...
  emit('Resolving workspace path...\n');
  let windowsPath: string;
  if (process.platform === 'win32') {
    windowsPath = nanoClawPath;
  } else {
    try {
      windowsPath = execSync(`wslpath -w "${nanoClawPath}"`, { encoding: 'utf-8' }).trim();
    } catch {
      throw new Error(
        'Could not convert workspace path to a Windows path. ' +
        'Make sure wslpath is available (WSL2 required).',
      );
    }
  }
  emit(`Workspace: ${windowsPath}\n`);

  // 3. Generate a unique sandbox name (same scheme as the official script)
  const suffix = Date.now().toString().slice(-5);
  const sandboxName = `nanoclaw-sandbox-${suffix}`;
  emit(`\nCreating sandbox "${sandboxName}"...\n`);

  // 4. Create the sandbox
  const created = await spawnDockerSandboxCreate(sandboxName, windowsPath, emit);
  if (!created) {
    throw new Error('Docker sandbox creation failed — check terminal output for details.');
  }

  // 5. Configure proxy bypass so the sandbox can reach messaging APIs
  emit('\nConfiguring network proxy bypass...\n');
  const proxyArgs = ['sandbox', 'network', 'proxy', sandboxName];
  for (const host of SANDBOX_PROXY_BYPASS_HOSTS) {
    proxyArgs.push('--bypass-host', host);
  }
  try {
    execSync(['docker', ...proxyArgs].join(' '), { stdio: 'pipe' });
    emit('Proxy bypass configured.\n');
  } catch {
    // Non-fatal — sandbox still works, just won't have bypass rules
    emit('Warning: could not configure proxy bypass (non-fatal).\n');
  }

  // 6. Persist sandbox metadata so the service step knows how to launch it
  stateManager.markStepComplete(step, {
    runtime: 'docker-sandbox',
    sandboxName,
  });

  emit(`\n✓ Sandbox "${sandboxName}" is ready.\n`);
  emit(`  To launch: docker sandbox run ${sandboxName}\n`);
  emit('  Type /setup when Claude Code starts inside the sandbox.\n');
}

// ─── Windows service setup ────────────────────────────────────────────────────

/**
 * Install and start NanoClaw as a Windows service.
 *
 * nanoclaw's service.ts only handles 'macos' and 'linux'; on Windows
 * getPlatform() returns 'unknown' and the step fails with unsupported_platform.
 * We replicate what nanoclaw does but use Windows-native mechanisms:
 *
 *   1. npm run build  (same first step nanoclaw does)
 *   2. Write a start-nanoclaw.bat wrapper script
 *   3. Register a Task Scheduler task to run it at every user log-on
 *   4. Start the process immediately (detached) so it's live right now
 */
// ─── Windows native-process helpers ──────────────────────────────────────────

/** Path to the PID file written when NanoClaw is spawned on Windows. */
function nanoclawPidFile(nanoClawPath: string): string {
  return path.join(nanoClawPath, 'nanoclaw.pid');
}

/** Read the PID from the pid file; returns null if missing or unparseable. */
function readNanoclawPid(nanoClawPath: string): number | null {
  try {
    const raw = fs.readFileSync(nanoclawPidFile(nanoClawPath), 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Check if a process with the given PID is alive.
 * signal 0 never actually sends — it only tests existence.
 *   throws ESRCH  → no such process (dead)
 *   throws EPERM  → exists but we don't own it (alive)
 *   returns void  → alive and we own it
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * CJS patch injected via --require before NanoClaw loads on Windows.
 *
 * NanoClaw spawns `docker run` for every agent task. On Windows, when a
 * console app (docker.exe) is launched from a process that has no console
 * (our windowsHide spawn), Windows allocates a new console window for the
 * child — one popup per agent run. This patch monkey-patches child_process
 * so every subprocess NanoClaw spawns inherits windowsHide:true, suppressing
 * those windows without requiring any changes to nanoclaw's source.
 */
const WIN_HIDE_PATCH = `
if (process.platform === 'win32') {
  const cp = require('child_process');
  const hide = (opts) => {
    if (!opts || typeof opts !== 'object') opts = {};
    return Object.assign({ windowsHide: true }, opts);
  };
  const origSpawn = cp.spawn.bind(cp);
  cp.spawn = (cmd, args, opts) => origSpawn(cmd, args, hide(opts));
  const origExecSync = cp.execSync.bind(cp);
  cp.execSync = (cmd, opts) => origExecSync(cmd, hide(opts));
  const origExec = cp.exec.bind(cp);
  cp.exec = (cmd, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    return origExec(cmd, hide(opts), cb);
  };
  const origSpawnSync = cp.spawnSync.bind(cp);
  cp.spawnSync = (cmd, args, opts) => origSpawnSync(cmd, args, hide(opts));
}
`;

/**
 * Spawn NanoClaw as a hidden, detached Windows process.
 * Stdout/stderr are appended to nanoclaw.log in the repo directory so the
 * Dashboard "Logs" tab has something to show.
 * Kills any previous instance first and waits briefly for the port to clear.
 */
async function spawnNanoclawWindows(nanoClawPath: string): Promise<void> {
  const pidFile = nanoclawPidFile(nanoClawPath);
  const logPath = path.join(nanoClawPath, 'nanoclaw.log');

  // Write the windowsHide patch so child processes don't pop console windows.
  const patchFile = path.join(nanoClawPath, 'win-hide-patch.cjs');
  fs.writeFileSync(patchFile, WIN_HIDE_PATCH.trim());

  // Kill existing instance if alive.
  const existingPid = readNanoclawPid(nanoClawPath);
  if (existingPid && isProcessAlive(existingPid)) {
    try { execSync(`taskkill /PID ${existingPid} /F`, { stdio: 'pipe' }); } catch { /* already dead */ }
    // Brief wait so the OS releases port 3001 before we respawn.
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));
  }

  // Redirect output to a log file (append so previous logs aren't lost).
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn('node', ['--require', './win-hide-patch.cjs', 'dist/index.js'], {
    cwd: nanoClawPath,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  fs.writeFileSync(pidFile, String(child.pid));
}

async function setupServiceWindows(
  nanoClawPath: string,
  stepRunner: StepRunner,
  step: string,
  window: BrowserWindow,
  stateManager: StateManager,
): Promise<void> {
  const emit = (text: string) =>
    window.webContents.send('wizard:output', { step, stream: 'stdout', text });

  window.webContents.send('wizard:step-status', { step, status: 'running' });

  // 1. Build TypeScript so dist/ is current.
  emit('Building TypeScript...\n');
  const build = await stepRunner.runCommand(
    step, 'npm', ['run', 'build'], { cwd: nanoClawPath },
  );
  if (build.code !== 0) {
    const msg = 'TypeScript build failed — check terminal output for details.';
    window.webContents.send('wizard:step-status', { step, status: 'failed', error: msg });
    throw new Error(msg);
  }
  emit('Build succeeded.\n\n');

  // 2. Start the process.
  emit('Starting NanoClaw...\n');
  try {
    await spawnNanoclawWindows(nanoClawPath);
    emit('NanoClaw started.\n');
  } catch (err: unknown) {
    const msg = (err as Error).message ?? String(err);
    const fullMsg = `Failed to start NanoClaw: ${msg}`;
    window.webContents.send('wizard:step-status', { step, status: 'failed', error: fullMsg });
    throw new Error(fullMsg);
  }

  stateManager.markStepComplete(step, { serviceType: 'native-windows' });
  window.webContents.send('wizard:step-status', { step, status: 'success' });
  emit('\n✓ NanoClaw is running.\n');
  emit('Re-run this step after a reboot to restart it (or add it to Task Scheduler manually).\n');
}

// ─── IPC handler registration ─────────────────────────────────────────────────

export function registerIpcHandlers(
  window: BrowserWindow,
  stateManager: StateManager,
): void {
  const stepRunner = new StepRunner(window);

  // -- State --
  ipcMain.handle('wizard:get-state', () => stateManager.get());

  ipcMain.handle('wizard:reset-state', () => {
    stateManager.reset();
    window.webContents.send('wizard:state-update', stateManager.get());
  });

  // -- Prerequisites --
  ipcMain.handle('wizard:check-prereqs', async () => {
    const status = await checkAllPrereqs();
    window.webContents.send('wizard:prereq-status', status);
    return status;
  });

  ipcMain.handle('wizard:install-prereq', async (_event, name: string) => {
    const onOutput = (text: string) => {
      window.webContents.send('wizard:output', {
        step: 'prerequisites',
        stream: 'stdout',
        text,
      });
    };

    window.webContents.send('wizard:step-status', {
      step: 'prerequisites',
      status: 'running',
    });

    const success = await installPrereq(name, onOutput);

    const status = await checkAllPrereqs();
    window.webContents.send('wizard:prereq-status', status);

    window.webContents.send('wizard:step-status', {
      step: 'prerequisites',
      status: success ? 'success' : 'failed',
      ...(success ? {} : { error: `Failed to install ${name}` }),
    });

    return success;
  });

  // -- Steps --
  ipcMain.handle(
    'wizard:start-step',
    async (_event, step: string, args?: Record<string, string>) => {
      const state = stateManager.get();
      const nanoClawPath = state.nanoClawPath;

      const skipPathCheck = [
        'clone',
        'prerequisites',
        'claude-auth',
        'credentials',
      ];
      if (!nanoClawPath && !skipPathCheck.includes(step)) {
        const error = 'NanoClaw path not set. Go back to "Get NanoClaw" step.';
        window.webContents.send('wizard:step-status', {
          step,
          status: 'failed',
          error,
        });
        throw new Error(error);
      }

      // ---- Claude OAuth sign-in ----
      if (step === 'claude-auth') {
        window.webContents.send('wizard:step-status', {
          step,
          status: 'running',
        });

        let capturedToken: string | null = null;

        const onOutput = (text: string) => {
          window.webContents.send('wizard:output', {
            step,
            stream: 'stdout',
            text,
          });
        };

        // Validate token format — must start with sk-ant-
        const isValidToken = (t: string): boolean =>
          /^sk-ant-[a-zA-Z0-9]/.test(t) && t.length > 30;

        const { promise } = runSetupToken(onOutput, (token) => {
          if (isValidToken(token)) {
            capturedToken = token;
          }
        });
        const success = await promise;

        if (success && capturedToken && isValidToken(capturedToken)) {
          if (nanoClawPath) {
            const envPath = path.join(nanoClawPath, '.env');
            writeEnvVar(envPath, 'CLAUDE_CODE_OAUTH_TOKEN', capturedToken);
          }
          stateManager.markStepComplete(step, { type: 'subscription' });
          window.webContents.send('wizard:step-status', {
            step,
            status: 'success',
          });
          window.webContents.send('wizard:state-update', stateManager.get());
          return { success: true, token: capturedToken };
        }

        // Token not captured — don't save garbage to .env
        throw new Error(
          'Could not capture the authentication token automatically. ' +
          'Please use the "Paste Token" option: open Terminal, run `claude setup-token`, ' +
          'and paste the token (starts with sk-ant-) into the wizard.',
        );
      }

      // ---- API key / credential save ----
      if (step === 'credentials') {
        const tokenValue = args?.token?.trim();
        const credType = args?.type;

        // Validate before saving
        if (!tokenValue || !tokenValue.startsWith('sk-ant-')) {
          throw new Error(
            'Invalid credential. API keys start with "sk-ant-api" and tokens start with "sk-ant-oat". Please check and try again.',
          );
        }

        if (tokenValue && nanoClawPath) {
          const envPath = path.join(nanoClawPath, '.env');
          const key =
            credType === 'subscription'
              ? 'CLAUDE_CODE_OAUTH_TOKEN'
              : 'ANTHROPIC_API_KEY';
          writeEnvVar(envPath, key, tokenValue);
        }
        stateManager.markStepComplete(step, { type: credType || 'api-key' });
        window.webContents.send('wizard:step-status', {
          step,
          status: 'success',
        });
        window.webContents.send('wizard:state-update', stateManager.get());
        return { success: true };
      }

      // ---- Bootstrap (setup.sh) ----
      if (step === 'bootstrap') {
        // Windows-only: repair CRLF-damaged shell scripts before handing off
        // to bash. No-op on macOS/Linux. See helper for the full rationale.
        if (process.platform === 'win32') {
          normalizeShellScriptsForBash(nanoClawPath!, window, step);
        }

        // Windows-only: preflight the Node version. setup.sh runs `npm ci`
        // which pulls in `better-sqlite3`; on Windows with Node 23+ there's
        // no prebuilt binary, so npm falls back to `node-gyp rebuild` which
        // needs a specific VS version node-gyp recognizes. Rather than let
        // the user hit a 50-line node-gyp stack trace deep inside
        // setup.log, catch it here and tell them exactly what to do.
        if (process.platform === 'win32') {
          try {
            const raw = execSync('node --version', {
              encoding: 'utf-8',
              timeout: 3000,
            }).trim();
            const major = parseInt(raw.replace('v', '').split('.')[0], 10);
            if (!isNaN(major) && major > 22) {
              const msg =
                `\nFound Node.js ${raw}, which is too new for NanoClaw on Windows.\n\n` +
                `NanoClaw uses better-sqlite3, a native module. Node 23+ has no\n` +
                `prebuilt Windows binary yet, so npm falls back to compiling from\n` +
                `source — which needs a specific Visual Studio version that\n` +
                `node-gyp can recognize. Most people hit a dead end there.\n\n` +
                `Fix: install Node.js 22 LTS from https://nodejs.org/ (uninstall\n` +
                `Node ${raw} first, or use nvm-windows / fnm to switch between\n` +
                `versions). Then restart this wizard and run bootstrap again.\n`;
              window.webContents.send('wizard:output', {
                step,
                stream: 'stderr',
                text: msg,
              });
              throw new Error(
                `Node.js ${raw} is incompatible with NanoClaw on Windows — please install Node 22 LTS`,
              );
            }
          } catch (err) {
            // Re-throw our own preflight error; swallow anything else
            // (e.g. `node --version` failing, which setup.sh will report
            // via its own checks).
            if (
              err instanceof Error &&
              err.message.includes('incompatible with NanoClaw')
            ) {
              throw err;
            }
          }
        }

        const { code } = await stepRunner.runCommand(step, 'bash', ['setup.sh'], {
          cwd: nanoClawPath!,
        });
        if (code !== 0) {
          throw new Error('Bootstrap failed — check terminal output for details');
        }

        // Apply the native credential proxy so containers can use .env credentials
        await ensureCredentialProxy(nanoClawPath!, stepRunner, step, window);

        stateManager.markStepComplete(step, {});
        window.webContents.send('wizard:state-update', stateManager.get());
        return { success: true };
      }

      // ---- Git clone ----
      if (step === 'clone') {
        const targetPath = args?.path || nanoClawPath!;
        // Force LF line endings regardless of the user's global
        // core.autocrlf setting. On Windows, Git for Windows defaults to
        // core.autocrlf=true, which silently rewrites setup.sh and every
        // other shell script to CRLF on checkout. bash then chokes on
        // `set -o pipefail\r` with "invalid option name". The `-c` flag
        // applies the setting to this clone's initial checkout.
        const { code } = await stepRunner.runCommand(step, 'git', [
          '-c',
          'core.autocrlf=false',
          'clone',
          'https://github.com/qwibitai/nanoclaw.git',
          targetPath,
        ]);
        if (code !== 0) {
          throw new Error(
            'Git clone failed — check terminal output for details',
          );
        }
        // Persist core.autocrlf=false in the cloned repo's local config so
        // future operations (merges, channel pulls, dependency repairs)
        // don't re-introduce CRLF when touching the working tree.
        await stepRunner
          .runCommand(
            step,
            'git',
            ['config', 'core.autocrlf', 'false'],
            { cwd: targetPath },
          )
          .catch(() => {
            // Non-fatal: the -c flag above already handled the initial
            // checkout. If config write fails, clone still succeeded.
          });
        stateManager.update({ nanoClawPath: targetPath });
        stateManager.markStepComplete(step, { path: targetPath });
        window.webContents.send('wizard:state-update', stateManager.get());
        return { success: true };
      }

      // ---- Apply channel skill (merge from channel repo) ----
      if (step === 'apply-channel') {
        const channel = args?.channel;
        if (!channel || !CHANNEL_REPOS[channel]) {
          throw new Error(`Unknown channel: ${channel}`);
        }
        const repoUrl = CHANNEL_REPOS[channel];

        window.webContents.send('wizard:step-status', {
          step,
          status: 'running',
        });

        // Clean up any leftover state from a previous failed merge.
        // Three possible bad states to handle:
        //   1. `.git/MERGE_HEAD` exists — a merge is in progress (may or may
        //      not have unmerged files — if conflicts were resolved but never
        //      committed, MERGE_HEAD exists with no unmerged files).
        //   2. Unmerged files (`--diff-filter=U`) — conflicts still present.
        //   3. Staged-but-uncommitted changes left over from a previous
        //      dependency-repair or partial-merge attempt (e.g. a manually
        //      patched package.json). `git merge` refuses to start with
        //      "Your local changes would be overwritten by merge" in this
        //      case, so the new merge silently never runs and the final
        //      verify fails with a misleading "source file not found".
        const staleMergeHead = fs.existsSync(
          path.join(nanoClawPath!, '.git', 'MERGE_HEAD'),
        );
        const unmergedCheck = await stepRunner.runCommand(step, 'git', [
          'diff', '--name-only', '--diff-filter=U',
        ], { cwd: nanoClawPath! });

        if (staleMergeHead || unmergedCheck.stdout.trim()) {
          window.webContents.send('wizard:output', {
            step, stream: 'stdout',
            text: 'Aborting unfinished previous merge...\n',
          });
          await stepRunner.runCommand(step, 'git', ['merge', '--abort'], {
            cwd: nanoClawPath!,
          }).catch(() => {});
          // `merge --abort` can fail if the index is too broken; fall back to
          // a hard reset to HEAD so we start from a clean slate.
          if (fs.existsSync(path.join(nanoClawPath!, '.git', 'MERGE_HEAD'))) {
            await stepRunner.runCommand(step, 'git', [
              'reset', '--hard', 'HEAD',
            ], { cwd: nanoClawPath! }).catch(() => {});
          }
        }

        // Commit any staged changes left over from previous steps
        // (e.g. package.json patched by ensureChannelDependencies but never
        // committed). Without this, the next `git merge` aborts before it
        // even starts and the failure mode is opaque.
        const stagedCheck = await stepRunner.runCommand(step, 'git', [
          'diff', '--cached', '--name-only',
        ], { cwd: nanoClawPath! });
        const unstagedCheck = await stepRunner.runCommand(step, 'git', [
          'diff', '--name-only',
        ], { cwd: nanoClawPath! });
        if (stagedCheck.stdout.trim() || unstagedCheck.stdout.trim()) {
          window.webContents.send('wizard:output', {
            step, stream: 'stdout',
            text: 'Committing pending local changes before merge...\n',
          });
          await stepRunner.runCommand(step, 'git', ['add', '-A'], {
            cwd: nanoClawPath!,
          });
          await stepRunner.runCommand(step, 'git', [
            'commit', '--no-verify',
            '-m', 'chore: commit pending changes before channel merge',
          ], { cwd: nanoClawPath! }).catch(() => {});
        }

        window.webContents.send('wizard:output', {
          step,
          stream: 'stdout',
          text: `Adding ${channel} channel...\n`,
        });

        // Check if the channel is already fully merged (channel source file exists)
        const channelFile = path.join(nanoClawPath!, 'src', 'channels', `${channel}.ts`);
        const alreadyMerged = fs.existsSync(channelFile);

        if (alreadyMerged) {
          window.webContents.send('wizard:output', {
            step, stream: 'stdout',
            text: `${channel} channel code already present — skipping merge.\n`,
          });
          // Dep repair runs unconditionally below via ensureChannelDependencies.
        } else {
          // Add the channel as a git remote (ignore error if already exists)
          await stepRunner.runCommand(step, 'git', [
            'remote', 'add', channel, repoUrl,
          ], { cwd: nanoClawPath! }).catch(() => {});

          // Fetch the channel repo's main branch
          window.webContents.send('wizard:output', {
            step, stream: 'stdout',
            text: `Fetching ${channel} channel code...\n`,
          });
          const fetchResult = await stepRunner.runCommand(step, 'git', [
            'fetch', channel, 'main',
          ], { cwd: nanoClawPath! });
          if (fetchResult.code !== 0) {
            throw new Error(
              `Failed to fetch ${channel} channel — check terminal output`,
            );
          }

          // Merge the channel code, auto-resolve package-lock conflicts
          window.webContents.send('wizard:output', {
            step, stream: 'stdout',
            text: `Merging ${channel} channel code...\n`,
          });

          // Try the merge — wrapped in try/catch to abort on any failure
          try {
            const mergeResult = await stepRunner.runCommand(step, 'git', [
              'merge', `${channel}/main`, '--no-edit', '--no-verify',
            ], { cwd: nanoClawPath! });

            // Special case: "Already up to date" when the channel was
            // previously merged then the source file deleted (e.g. by an
            // earlier `wizard:remove-channel` call). Git refuses to re-merge
            // because the channel commit is already in our ancestry, but the
            // working tree and HEAD are missing the actual file. Detect by
            // probing for the source file *after* the merge — if the file
            // still doesn't exist, restore it directly from the channel branch.
            const channelSrcAfterMerge = path.join(
              nanoClawPath!, 'src', 'channels', `${channel}.ts`,
            );
            const isAlreadyUpToDate =
              mergeResult.code === 0 &&
              /Already up to date/i.test(mergeResult.stdout);
            if (isAlreadyUpToDate && !fs.existsSync(channelSrcAfterMerge)) {
              window.webContents.send('wizard:output', {
                step, stream: 'stdout',
                text: `Channel was previously merged but files were removed — restoring from ${channel}/main...\n`,
              });
              // Restore the channel source + test file + barrel from the
              // remote branch. We use `git checkout <ref> -- <paths>` so only
              // these specific paths are touched (not the whole tree).
              await stepRunner.runCommand(step, 'git', [
                'checkout', `${channel}/main`, '--',
                `src/channels/${channel}.ts`,
                `src/channels/${channel}.test.ts`,
              ], { cwd: nanoClawPath! }).catch(() => {});
              // Barrel file: re-add the import via the safety net below.
              // Stage and commit the restoration.
              await stepRunner.runCommand(step, 'git', [
                'add', `src/channels/${channel}.ts`,
                `src/channels/${channel}.test.ts`,
              ], { cwd: nanoClawPath! }).catch(() => {});
              await stepRunner.runCommand(step, 'git', [
                'commit', '--no-verify',
                '-m', `Restore ${channel} channel files`,
              ], { cwd: nanoClawPath! }).catch(() => {});
            }

            if (mergeResult.code !== 0) {
              window.webContents.send('wizard:output', {
                step, stream: 'stdout',
                text: `Resolving merge conflicts...\n`,
              });
              await resolveConflicts(nanoClawPath!, channel, stepRunner, step);
              await stepRunner.runCommand(step, 'git', ['add', '-A'], { cwd: nanoClawPath! });
            }

            // If a merge is still in progress, commit it.
            // Always use --no-verify to bypass the pre-commit prettier hook
            // (which can fail on the merge commit and leave git in a broken state).
            const mergeHeadPath = path.join(nanoClawPath!, '.git', 'MERGE_HEAD');
            if (fs.existsSync(mergeHeadPath)) {
              const commitResult = await stepRunner.runCommand(step, 'git', [
                'commit', '--no-edit', '--no-verify',
                '-m', `Add ${channel} channel - auto resolved`,
              ], { cwd: nanoClawPath! });

              if (commitResult.code !== 0 || fs.existsSync(mergeHeadPath)) {
                throw new Error(
                  `git commit failed after resolving conflicts: ${commitResult.stderr || 'unknown error'}`,
                );
              }
            }
          } catch (mergeErr: any) {
            // Merge/resolve failed — clean up so git isn't left in a broken state
            await stepRunner.runCommand(step, 'git', ['merge', '--abort'], { cwd: nanoClawPath! }).catch(() => {});
            await stepRunner.runCommand(step, 'git', ['reset', '--hard', 'HEAD'], { cwd: nanoClawPath! }).catch(() => {});
            throw new Error(
              `Failed to merge ${channel} channel: ${mergeErr.message}. ` +
              `The merge has been aborted. Try again.`,
            );
          }
        } // end else (not alreadyMerged)

        // Verify: no in-progress merge, and channel source file exists.
        // The file check alone is insufficient — staged-but-uncommitted files
        // also pass fs.existsSync, masking a stuck merge.
        const mergeHeadPath = path.join(nanoClawPath!, '.git', 'MERGE_HEAD');
        if (fs.existsSync(mergeHeadPath)) {
          await stepRunner.runCommand(step, 'git', ['merge', '--abort'], { cwd: nanoClawPath! }).catch(() => {});
          throw new Error(
            `Failed to add ${channel}: merge left in progress after commit. ` +
            `The merge has been aborted. Try again.`,
          );
        }
        const channelSrcFile = path.join(nanoClawPath!, 'src', 'channels', `${channel}.ts`);
        if (!fs.existsSync(channelSrcFile)) {
          // Diagnostic: list what IS in src/channels so the user can see which
          // channels survived and narrow down whether the merge actually ran.
          let present: string[] = [];
          try {
            present = fs
              .readdirSync(path.join(nanoClawPath!, 'src', 'channels'))
              .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
          } catch { /* */ }
          // Also reset any partial state so the next attempt starts clean.
          await stepRunner.runCommand(step, 'git', ['merge', '--abort'], {
            cwd: nanoClawPath!,
          }).catch(() => {});
          await stepRunner.runCommand(step, 'git', [
            'reset', '--hard', 'HEAD',
          ], { cwd: nanoClawPath! }).catch(() => {});
          throw new Error(
            `Failed to add ${channel}: source file not found after merge. ` +
            `Channels currently present: ${present.join(', ') || '(none)'}. ` +
            `The git merge may have finalized a stale previous merge. ` +
            `State has been reset — try again.`,
          );
        }

        // Safety net: ensure the barrel file has this channel's import
        // Only add if the source file actually exists (verified above)
        const barrelPath = path.join(nanoClawPath!, 'src', 'channels', 'index.ts');
        try {
          let barrelContent = fs.readFileSync(barrelPath, 'utf-8');

          // Also remove any phantom imports for channels whose source files don't exist
          const channelSlots = ['discord', 'gmail', 'slack', 'telegram', 'whatsapp'];
          let cleaned = false;
          for (const slot of channelSlots) {
            const slotImport = `import './${slot}.js';`;
            const slotFile = path.join(nanoClawPath!, 'src', 'channels', `${slot}.ts`);
            if (barrelContent.includes(slotImport) && !fs.existsSync(slotFile)) {
              barrelContent = barrelContent.replace(slotImport + '\n', '');
              barrelContent = barrelContent.replace(slotImport, '');
              cleaned = true;
            }
          }

          // Ensure current channel's import is present
          const importLine = `import './${channel}.js';`;
          if (!barrelContent.includes(importLine)) {
            const commentLine = `// ${channel}`;
            if (barrelContent.includes(commentLine)) {
              barrelContent = barrelContent.replace(
                commentLine,
                `${commentLine}\n${importLine}`,
              );
            } else {
              barrelContent += `\n// ${channel}\n${importLine}\n`;
            }
            cleaned = true;
          }

          if (cleaned) {
            fs.writeFileSync(barrelPath, barrelContent);
            window.webContents.send('wizard:output', {
              step, stream: 'stdout',
              text: `Fixed channel barrel file.\n`,
            });
            await stepRunner.runCommand(step, 'git', ['add', barrelPath], { cwd: nanoClawPath! });
            await stepRunner.runCommand(step, 'bash', ['-c',
              `git commit -m "Fix: sync barrel file with installed channels" 2>/dev/null || true`,
            ], { cwd: nanoClawPath! });
          }
        } catch (barrelErr: any) {
          if (barrelErr.message?.includes('Failed to add')) throw barrelErr;
          // Best effort for barrel cleanup
        }

        // Repair package.json for ALL installed channels. Git can auto-merge
        // package.json in a way that drops dependencies from earlier merges
        // (e.g. adding discord on top of gmail previously dropped googleapis).
        // This runs unconditionally so it catches silent auto-merge losses as
        // well as explicit conflict resolution mistakes.
        await ensureChannelDependencies(
          nanoClawPath!,
          CHANNEL_REPOS,
          stepRunner,
          step,
          window,
        );

        // Install new dependencies from the merged package.json
        window.webContents.send('wizard:output', {
          step, stream: 'stdout',
          text: `Installing ${channel} dependencies...\n`,
        });
        const install = await stepRunner.runCommand(step, 'npm', ['install'], {
          cwd: nanoClawPath!,
        });
        if (install.code !== 0) {
          throw new Error('npm install failed after merging channel code');
        }

        // Build to compile the new TypeScript
        window.webContents.send('wizard:output', {
          step, stream: 'stdout',
          text: `Building project...\n`,
        });
        await stepRunner.runCommand(step, 'npm', ['run', 'build'], {
          cwd: nanoClawPath!,
        });

        // Re-apply credential proxy if the merge lost it
        await ensureCredentialProxy(nanoClawPath!, stepRunner, step, window);

        stateManager.markStepComplete(`channel-${channel}-applied`, {});
        window.webContents.send('wizard:step-status', {
          step,
          status: 'success',
        });
        window.webContents.send('wizard:state-update', stateManager.get());
        return { success: true };
      }

      // ---- WhatsApp auth (QR code / pairing code) ----
      if (step === 'whatsapp-auth') {
        // On Windows, nanoclaw's whatsapp-auth.ts spawns a nested `npx` process
        // with shell:false. Node.js on Windows does not try .cmd extensions for
        // non-shell spawns, so `npx` → ENOENT even when `npx.cmd` is on PATH.
        // Patch the source file in-place before tsx compiles it so the nested
        // spawn uses `npx.cmd` + shell:true. The patch is idempotent.
        if (process.platform === 'win32') {
          const waFile = path.join(nanoClawPath!, 'setup', 'whatsapp-auth.ts');
          if (fs.existsSync(waFile)) {
            try {
              let src = fs.readFileSync(waFile, 'utf-8');
              if (!src.includes('_npxCmd')) {
                // Replace: spawn('npx', ['tsx', ...authArgs], {
                src = src.replace(
                  /const authProc = spawn\('npx',\s*\['tsx',/,
                  "const _npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';\n  const authProc = spawn(_npxCmd, ['tsx',",
                );
                // Add shell:true for Windows inside the spawn options object
                src = src.replace(
                  /detached: false,\s*\}\);/,
                  'detached: false,\n    shell: process.platform === \'win32\',\n  });',
                );
                fs.writeFileSync(waFile, src, 'utf-8');
              }
            } catch {
              // Non-fatal — the step will still attempt to run; worst case it
              // fails with the same ENOENT and the user sees the terminal output.
            }
          }
        }
        const method = args?.method || 'qr-browser';

        window.webContents.send('wizard:step-status', {
          step,
          status: 'running',
        });

        // After apply-channel merges the whatsapp skill repo, two scripts exist:
        // - setup/whatsapp-auth.ts — full setup step with browser QR page (preferred)
        // - src/whatsapp-auth.ts — standalone, terminal-only QR
        // Prefer the setup step since it opens a nice browser QR page.
        const setupScript = path.join(nanoClawPath!, 'setup', 'whatsapp-auth.ts');
        const directScript = path.join(nanoClawPath!, 'src', 'whatsapp-auth.ts');

        let scriptCmd: string;
        let scriptArgs: string[];

        // On Windows use npx.cmd so the shell resolves it; runCommand also
        // wraps with shell:true on Windows, so this is belt-and-suspenders.
        const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

        if (fs.existsSync(setupScript)) {
          // Use the setup step — supports qr-browser, qr-terminal, pairing-code
          scriptCmd = npxCmd;
          scriptArgs = ['tsx', 'setup/index.ts', '--step', 'whatsapp-auth',
            '--method', method];
          if (method === 'pairing-code' && args?.phone) {
            scriptArgs.push('--phone', args.phone);
          }
        } else if (fs.existsSync(directScript)) {
          // Fall back to standalone script (terminal QR only)
          scriptCmd = npxCmd;
          scriptArgs = ['tsx', 'src/whatsapp-auth.ts'];
          if (method === 'pairing-code') {
            scriptArgs.push('--pairing-code');
            if (args?.phone) {
              scriptArgs.push('--phone', args.phone);
            }
          }
        } else {
          throw new Error(
            'WhatsApp auth scripts not found. The WhatsApp channel code may not have been added correctly. Go back to "Channel Setup" and retry adding WhatsApp.',
          );
        }

        // On Windows the nanoclaw setup script's openBrowser() call fails
        // (it uses 'open' / 'xdg-open' which don't exist). The HTML QR page
        // is still written to store/qr-auth.html — poll for it and open it
        // via Electron's shell so the user can scan without any extra steps.
        let qrOpened = false;
        const qrHtmlPath = path.join(nanoClawPath!, 'store', 'qr-auth.html');
        const qrPollInterval = process.platform === 'win32'
          ? setInterval(() => {
              if (!qrOpened && fs.existsSync(qrHtmlPath)) {
                qrOpened = true;
                shell.openExternal(`file://${qrHtmlPath}`).catch(() => {});
              }
            }, 500)
          : null;

        const result = await stepRunner.runCommand(
          step,
          scriptCmd,
          scriptArgs,
          { cwd: nanoClawPath! },
        );

        if (qrPollInterval) clearInterval(qrPollInterval);

        if (result.code === 0) {
          stateManager.markStepComplete(step, {});
          window.webContents.send('wizard:state-update', stateManager.get());
          return { success: true };
        } else {
          throw new Error(
            'WhatsApp authentication failed — check terminal output for details',
          );
        }
      }

      // ---- Gmail auth (OAuth credentials file + browser authorize) ----
      if (step === 'gmail-auth') {
        window.webContents.send('wizard:step-status', {
          step,
          status: 'running',
        });

        const gmailConfigDir = path.join(
          process.env.HOME || process.env.USERPROFILE || '',
          '.gmail-mcp',
        );
        const keysFile = path.join(gmailConfigDir, 'gcp-oauth.keys.json');
        const credentialsFile = path.join(gmailConfigDir, 'credentials.json');

        try {
          // Phase 1: save the gcp-oauth.keys.json if provided
          if (args?.credentials) {
            // Validate JSON
            try {
              JSON.parse(args.credentials);
            } catch {
              throw new Error(
                'The OAuth credentials file is not valid JSON. Paste the exact contents of gcp-oauth.keys.json.',
              );
            }

            if (!fs.existsSync(gmailConfigDir)) {
              fs.mkdirSync(gmailConfigDir, { recursive: true });
            }
            fs.writeFileSync(keysFile, args.credentials);
            window.webContents.send('wizard:output', {
              step, stream: 'stdout',
              text: `Saved OAuth keys to ${keysFile}\n`,
            });
          }

          if (!fs.existsSync(keysFile)) {
            throw new Error(
              'No OAuth credentials file found. Provide your gcp-oauth.keys.json contents first.',
            );
          }

          // Phase 2: run the authorize command — opens a browser window
          // The command blocks until the user completes the OAuth flow.
          window.webContents.send('wizard:output', {
            step, stream: 'stdout',
            text: 'Starting OAuth flow — a browser window should open shortly.\n' +
                  'Sign in with your Google account and grant access.\n' +
                  'If you see an "app not verified" warning, click Advanced → Go to (app) (unsafe).\n\n',
          });

          const authResult = await stepRunner.runCommand(step, 'npx', [
            '-y', '@gongrzhe/server-gmail-autoauth-mcp', 'auth',
          ], { cwd: nanoClawPath! });

          // Some versions of the package don't have an 'auth' subcommand and
          // start the MCP server instead. If credentials.json appears during
          // that run (the server auto-auths on first start), we still succeed.
          if (!fs.existsSync(credentialsFile)) {
            // Retry without the 'auth' subcommand
            window.webContents.send('wizard:output', {
              step, stream: 'stdout',
              text: 'Retrying without auth subcommand...\n',
            });
            await stepRunner.runCommand(step, 'bash', [
              '-c',
              'timeout 120 npx -y @gongrzhe/server-gmail-autoauth-mcp || true',
            ], { cwd: nanoClawPath! });
          }

          if (!fs.existsSync(credentialsFile)) {
            throw new Error(
              `Gmail authorization did not complete. credentials.json was not created at ${credentialsFile}. ` +
              `Make sure you completed the OAuth flow in the browser.`,
            );
          }

          window.webContents.send('wizard:output', {
            step, stream: 'stdout',
            text: `\nGmail authorization successful. Credentials saved to ${credentialsFile}\n`,
          });

          stateManager.markStepComplete(step, { channel: 'gmail' });
          window.webContents.send('wizard:step-status', {
            step,
            status: 'success',
          });
          window.webContents.send('wizard:state-update', stateManager.get());
          return { success: true };
        } catch (err: any) {
          window.webContents.send('wizard:step-status', {
            step,
            status: 'failed',
            error: err.message,
          });
          throw err;
        }
      }

      // ---- Token-based channel auth (Telegram, Slack, Discord) ----
      if (step.endsWith('-auth') && !step.startsWith('claude')) {
        const channel = step.replace('-auth', '');
        const envKeys = CHANNEL_ENV_KEYS[channel];

        if (!envKeys) {
          throw new Error(`Unknown channel auth: ${channel}`);
        }

        const envPath = path.join(nanoClawPath!, '.env');

        // For channels with multiple tokens (like Slack), args may have
        // token, token2, etc. For single-token channels, just 'token'.
        if (args?.token) {
          writeEnvVar(envPath, envKeys[0], args.token);
        }
        if (args?.token2 && envKeys[1]) {
          writeEnvVar(envPath, envKeys[1], args.token2);
        }

        // Sync to data/env/env for container access
        const dataEnvDir = path.join(nanoClawPath!, 'data', 'env');
        if (!fs.existsSync(dataEnvDir)) {
          fs.mkdirSync(dataEnvDir, { recursive: true });
        }
        try {
          fs.copyFileSync(envPath, path.join(dataEnvDir, 'env'));
        } catch {
          // Best effort
        }

        stateManager.markStepComplete(step, { channel });
        window.webContents.send('wizard:step-status', {
          step,
          status: 'success',
        });
        window.webContents.send('wizard:state-update', stateManager.get());
        return { success: true };
      }

      // ---- Telegram chat ID detection ----
      if (step === 'telegram-chatid') {
        window.webContents.send('wizard:step-status', {
          step,
          status: 'running',
        });

        const envPath = path.join(nanoClawPath!, '.env');
        const botToken = readEnvVar(envPath, 'TELEGRAM_BOT_TOKEN');

        if (!botToken) {
          throw new Error('No Telegram bot token found. Please complete the Telegram auth step first.');
        }

        try {
          const result = await detectTelegramChatId(
            botToken,
            90000, // 90 seconds
            (msg) => {
              window.webContents.send('wizard:output', {
                step,
                stream: 'stdout',
                text: msg + '\n',
              });
            },
          );

          const chatJid = `tg:${result.chatId}`;

          window.webContents.send('wizard:output', {
            step,
            stream: 'stdout',
            text: `Detected: ${result.chatName} (${result.chatType}) — ${chatJid}\n`,
          });

          stateManager.markStepComplete(step, {
            chatId: String(result.chatId),
            chatJid,
            chatName: result.chatName,
            chatType: result.chatType,
          });
          window.webContents.send('wizard:step-status', {
            step,
            status: 'success',
            data: {
              chatId: String(result.chatId),
              chatJid,
              chatName: result.chatName,
              chatType: result.chatType,
            },
          });
          window.webContents.send('wizard:state-update', stateManager.get());
          return { success: true, chatJid, chatName: result.chatName };
        } catch (err: any) {
          window.webContents.send('wizard:step-status', {
            step,
            status: 'failed',
            error: err.message,
          });
          throw err;
        }
      }

      // ---- Slack channel detection ----
      if (step === 'slack-chatid') {
        window.webContents.send('wizard:step-status', {
          step,
          status: 'running',
        });

        const envPath = path.join(nanoClawPath!, '.env');
        const botToken = readEnvVar(envPath, 'SLACK_BOT_TOKEN');

        if (!botToken) {
          throw new Error('No Slack bot token found. Please complete the Slack auth step first.');
        }

        try {
          // If args.channelId is provided, user already picked — just store it
          if (args?.channelId) {
            const chatJid = `slack:${args.channelId}`;
            stateManager.markStepComplete(step, {
              chatId: args.channelId,
              chatJid,
              chatName: args.channelName || args.channelId,
              chatType: 'channel',
            });
            window.webContents.send('wizard:step-status', {
              step,
              status: 'success',
              data: {
                chatId: args.channelId,
                chatJid,
                chatName: args.channelName || args.channelId,
                chatType: 'channel',
              },
            });
            window.webContents.send('wizard:state-update', stateManager.get());
            return { success: true, chatJid, chatName: args.channelName };
          }

          // Otherwise, fetch channels for picker
          const channels = await detectSlackChannels(
            botToken,
            (msg) => {
              window.webContents.send('wizard:output', {
                step,
                stream: 'stdout',
                text: msg + '\n',
              });
            },
          );

          if (channels.length === 0) {
            window.webContents.send('wizard:step-status', {
              step,
              status: 'needs_input',
              data: { channels: [], message: 'Bot is not a member of any channels. Invite it to a channel first, then retry.' },
            });
            return { success: false, needsInput: true, channels: [] };
          }

          // Send back channel list for the UI to present as a picker
          window.webContents.send('wizard:step-status', {
            step,
            status: 'needs_input',
            data: { channels },
          });
          return { success: true, channels };
        } catch (err: any) {
          window.webContents.send('wizard:step-status', {
            step,
            status: 'failed',
            error: err.message,
          });
          throw err;
        }
      }

      // ---- Discord channel detection ----
      if (step === 'discord-chatid') {
        window.webContents.send('wizard:step-status', {
          step,
          status: 'running',
        });

        const envPath = path.join(nanoClawPath!, '.env');
        const botToken = readEnvVar(envPath, 'DISCORD_BOT_TOKEN');

        if (!botToken) {
          throw new Error('No Discord bot token found. Please complete the Discord auth step first.');
        }

        try {
          // If args.channelId is provided, user already picked — just store it
          if (args?.channelId) {
            const chatJid = `dc:${args.channelId}`;
            stateManager.markStepComplete(step, {
              chatId: args.channelId,
              chatJid,
              chatName: args.channelName || args.channelId,
              chatType: 'channel',
            });
            window.webContents.send('wizard:step-status', {
              step,
              status: 'success',
              data: {
                chatId: args.channelId,
                chatJid,
                chatName: args.channelName || args.channelId,
                chatType: 'channel',
              },
            });
            window.webContents.send('wizard:state-update', stateManager.get());
            return { success: true, chatJid, chatName: args.channelName };
          }

          // Otherwise, fetch channels for picker
          const channels = await detectDiscordChannels(
            botToken,
            (msg) => {
              window.webContents.send('wizard:output', {
                step,
                stream: 'stdout',
                text: msg + '\n',
              });
            },
          );

          if (channels.length === 0) {
            window.webContents.send('wizard:step-status', {
              step,
              status: 'needs_input',
              data: { channels: [], message: 'Bot has no accessible text channels. Invite it to a server first, then retry.' },
            });
            return { success: false, needsInput: true, channels: [] };
          }

          // Send back channel list for the UI to present as a picker
          window.webContents.send('wizard:step-status', {
            step,
            status: 'needs_input',
            data: { channels },
          });
          return { success: true, channels };
        } catch (err: any) {
          window.webContents.send('wizard:step-status', {
            step,
            status: 'failed',
            error: err.message,
          });
          throw err;
        }
      }

      // ---- Mount allowlist ----
      if (step === 'mounts') {
        window.webContents.send('wizard:step-status', {
          step,
          status: 'running',
        });

        const cliArgs: string[] = [];
        if (args?.empty === 'true') {
          cliArgs.push('--empty');
        } else if (args?.json) {
          cliArgs.push('--json', args.json);
        }
        cliArgs.push('--force'); // Always overwrite during wizard setup

        try {
          const result = await stepRunner.runSetupStep(step, nanoClawPath!, cliArgs);
          stateManager.markStepComplete(step, result?.fields || {});
          window.webContents.send('wizard:step-status', {
            step,
            status: 'success',
          });
          window.webContents.send('wizard:state-update', stateManager.get());
          return { success: true };
        } catch (err: any) {
          window.webContents.send('wizard:step-status', {
            step,
            status: 'failed',
            error: err.message,
          });
          throw err;
        }
      }

      // ---- Chat/group registration ----
      if (step === 'register') {
        window.webContents.send('wizard:step-status', {
          step,
          status: 'running',
        });

        const triggerPattern = args?.['trigger-pattern'] || '@Andy';
        const assistantName = args?.['assistant-name'] || 'Andy';
        const selectedChannels = stateManager.get().selectedChannels || [];
        // Allow explicit channel override (used by Dashboard "Add Channel")
        const primaryChannel = args?.channel || selectedChannels[0] || 'whatsapp';

        // Generate a simple folder name based on channel
        const folderName = `my-${primaryChannel}`;
        // Resolve the real JID from channel credentials
        let jid = args?.jid || '';
        if (!jid) {
          if (primaryChannel === 'whatsapp') {
            // Read the authenticated user's JID from WhatsApp creds
            try {
              const credsPath = path.join(nanoClawPath!, 'store', 'auth', 'creds.json');
              if (fs.existsSync(credsPath)) {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
                if (creds?.me?.id) {
                  // Format: "14086036996:3@s.whatsapp.net" → "14086036996@s.whatsapp.net"
                  jid = creds.me.id.replace(/:\d+@/, '@');
                }
              }
            } catch {
              // Fall through to fallback
            }
            if (!jid) jid = 'self@s.whatsapp.net';
          } else if (primaryChannel === 'telegram') {
            // Use chat ID from telegram-chatid detection step
            const telegramData = stateManager.get().completedSteps?.['telegram-chatid'];
            if (telegramData?.chatJid) {
              jid = telegramData.chatJid;
            } else {
              jid = 'self@telegram';
            }
          } else if (primaryChannel === 'slack') {
            // Use channel ID from slack-chatid detection step
            const slackData = stateManager.get().completedSteps?.['slack-chatid'];
            if (slackData?.chatJid) {
              jid = slackData.chatJid;
            } else {
              jid = 'self@slack';
            }
          } else if (primaryChannel === 'discord') {
            // Use channel ID from discord-chatid detection step
            const discordData = stateManager.get().completedSteps?.['discord-chatid'];
            if (discordData?.chatJid) {
              jid = discordData.chatJid;
            } else {
              jid = 'self@discord';
            }
          } else if (primaryChannel === 'gmail') {
            // Gmail emails are routed to whichever group is marked isMain —
            // the JID is just a placeholder that matches gmail's ownsJid check.
            jid = 'gmail:main';
          } else {
            jid = `self@${primaryChannel}`;
          }
        }

        const cliArgs = [
          '--jid', jid,
          '--name', assistantName,
          '--trigger', triggerPattern,
          '--folder', folderName,
          '--channel', primaryChannel,
          '--assistant-name', assistantName,
          '--is-main',
        ];

        try {
          const result = await stepRunner.runSetupStep(step, nanoClawPath!, cliArgs);
          stateManager.markStepComplete(step, result?.fields || {});
          window.webContents.send('wizard:step-status', {
            step,
            status: 'success',
          });
          window.webContents.send('wizard:state-update', stateManager.get());
          return { success: true };
        } catch (err: any) {
          window.webContents.send('wizard:step-status', {
            step,
            status: 'failed',
            error: err.message,
          });
          throw err;
        }
      }

      // ---- Docker container build -----------------------------------------------
      // nanoclaw's container.ts uses `command -v docker` to verify Docker is
      // present. That is a bash/sh builtin — it doesn't exist in cmd.exe, so on
      // Windows the check always returns false and the step fails immediately
      // with the opaque "runtime_not_available" error.
      //
      // On Windows we run the docker build ourselves, bypassing nanoclaw's
      // container.ts entirely. On Linux/macOS we run a quick `docker info`
      // pre-check so we can surface the real error instead of the opaque one,
      // then fall through to nanoclaw's step as normal.
      if (step === 'container' && args?.runtime === 'docker') {
        if (process.platform === 'win32') {
          // Run docker build + test directly — mirrors what nanoclaw's
          // container.ts does, but without the bash-only commandExists check.
          window.webContents.send('wizard:step-status', { step, status: 'running' });

          const containerDir = path.join(nanoClawPath!, 'container');
          const image = 'nanoclaw-agent:latest';

          const emit = (text: string) =>
            window.webContents.send('wizard:output', { step, stream: 'stdout', text });

          // Verify Docker daemon is reachable first
          emit('Checking Docker daemon...\n');
          try {
            execSync('docker info', { stdio: 'pipe' });
          } catch (err: unknown) {
            const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString() ?? '';
            const msg = `Docker is not accessible: ${stderr.trim() || 'daemon not running'}.\nMake sure Docker Desktop is running.`;
            window.webContents.send('wizard:step-status', { step, status: 'failed', error: msg });
            throw new Error(msg);
          }

          // Build
          emit(`Building container image ${image}...\n`);
          const build = await stepRunner.runCommand(
            step, 'docker', ['build', '-t', image, '.'],
            { cwd: containerDir },
          );
          if (build.code !== 0) {
            const msg = 'Docker build failed — check terminal output for details.';
            window.webContents.send('wizard:step-status', { step, status: 'failed', error: msg });
            throw new Error(msg);
          }

          // Smoke test
          emit('\nTesting container...\n');
          const test = await stepRunner.runCommand(
            step, 'docker',
            ['run', '-i', '--rm', '--entrypoint', '/bin/echo', image, 'Container OK'],
            { cwd: nanoClawPath! },
          );
          const testOk = test.stdout.includes('Container OK');

          if (!testOk) {
            const msg = 'Container test failed — image built but could not run.';
            window.webContents.send('wizard:step-status', { step, status: 'failed', error: msg });
            throw new Error(msg);
          }

          emit('\n✓ Container image built and tested successfully.\n');
          stateManager.markStepComplete(step, { runtime: 'docker', image });
          window.webContents.send('wizard:step-status', { step, status: 'success' });
          window.webContents.send('wizard:state-update', stateManager.get());
          return { success: true };
        }

        // Linux / macOS — pre-check docker info so we surface the real error
        // rather than nanoclaw's opaque "runtime_not_available".
        try {
          execSync('docker info', { stdio: 'pipe' });
        } catch (err: unknown) {
          const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString() ?? '';
          const lower = stderr.toLowerCase();
          let message: string;
          if (lower.includes('permission denied') && lower.includes('docker.sock')) {
            message =
              'Docker permission denied. Run in your terminal:\n' +
              '  sudo usermod -aG docker $USER && newgrp docker\n' +
              'Then relaunch wizclaw.';
          } else if (lower.includes('cannot connect') || lower.includes('is the docker daemon running')) {
            message = 'Cannot connect to Docker daemon. Start Docker Desktop and try again.';
          } else {
            message = `Docker is not accessible: ${stderr.trim() || 'daemon not running'}.`;
          }
          window.webContents.send('wizard:output', { step, stream: 'stderr', text: message + '\n' });
          window.webContents.send('wizard:step-status', { step, status: 'failed', error: message });
          throw new Error(message);
        }
        // docker info passed — fall through to nanoclaw's container step below
      }

      // ---- Docker AI Sandbox container setup (Windows / WSL) ----
      if (step === 'container' && args?.runtime === 'docker-sandbox') {
        window.webContents.send('wizard:step-status', { step, status: 'running' });
        try {
          await setupDockerSandbox(nanoClawPath!, window, stateManager, step);
          window.webContents.send('wizard:step-status', { step, status: 'success' });
          window.webContents.send('wizard:state-update', stateManager.get());
          return { success: true };
        } catch (err: any) {
          window.webContents.send('wizard:step-status', {
            step,
            status: 'failed',
            error: err.message,
          });
          throw err;
        }
      }

      // ---- Service start — ensure proxy is applied first ----
      if (step === 'service') {
        // nanoclaw's service.ts only handles 'macos' and 'linux'. On Windows
        // getPlatform() returns 'unknown' → unsupported_platform. We intercept
        // before runSetupStep and install the service ourselves using the Windows
        // Task Scheduler, then start the process immediately.
        if (process.platform === 'win32') {
          await setupServiceWindows(nanoClawPath!, stepRunner, step, window, stateManager);
          window.webContents.send('wizard:state-update', stateManager.get());
          return { success: true };
        }

        // Last chance: make sure credential proxy is applied before starting
        await ensureCredentialProxy(nanoClawPath!, stepRunner, step, window);

        // Now run the actual service setup step
        const result = await stepRunner.runSetupStep(step, nanoClawPath!);
        stateManager.markStepComplete(step, result?.fields || {});
        window.webContents.send('wizard:state-update', stateManager.get());
        return { success: true };
      }

      // ---- All other steps go through setup/index.ts ----
      const cliArgs = args
        ? Object.entries(args).flatMap(([k, v]) => [`--${k}`, v])
        : [];

      const result = await stepRunner.runSetupStep(
        step,
        nanoClawPath!,
        cliArgs,
      );
      stateManager.markStepComplete(step, result?.fields || {});
      window.webContents.send('wizard:state-update', stateManager.get());
      return { success: true };
    },
  );

  ipcMain.handle('wizard:retry-step', async (_event, step: string) => {
    ipcMain.emit('wizard:start-step', step);
  });

  ipcMain.handle('wizard:cancel-step', (_event, step: string) => {
    stepRunner.cancel(step);
  });

  // -- User Input --
  ipcMain.handle(
    'wizard:user-input',
    async (_event, step: string, field: string, value: string) => {
      const state = stateManager.get();

      if (step === 'clone' && field === 'path') {
        stateManager.update({ nanoClawPath: value });
        window.webContents.send('wizard:state-update', stateManager.get());
        return;
      }

      if (step === 'channels' && field === 'selected') {
        stateManager.update({ selectedChannels: value.split(',').filter(Boolean) });
        window.webContents.send('wizard:state-update', stateManager.get());
        return;
      }

      // Append a channel without replacing existing selections (used by Dashboard "Add Channel")
      if (step === 'channels' && field === 'add') {
        const existing = stateManager.get().selectedChannels || [];
        const merged = [...new Set([...existing, ...value.split(',').filter(Boolean)])];
        stateManager.update({ selectedChannels: merged });
        window.webContents.send('wizard:state-update', stateManager.get());
        return;
      }

      // Save current step for resume
      if (step === 'navigation' && field === 'currentStep') {
        stateManager.update({ currentStep: parseInt(value, 10) });
        return;
      }

      const stepData = state.completedSteps[step] || {};
      stepData[field] = value;
      stateManager.markStepComplete(step, stepData);
      window.webContents.send('wizard:state-update', stateManager.get());
    },
  );

  ipcMain.handle(
    'wizard:user-choice',
    async (_event, step: string, choice: string) => {
      const state = stateManager.get();
      const stepData = state.completedSteps[step] || {};
      stepData.choice = choice;
      stateManager.markStepComplete(step, stepData);
      window.webContents.send('wizard:state-update', stateManager.get());
    },
  );

  // -- File Dialogs --
  ipcMain.handle('wizard:select-directory', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Directory',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('wizard:select-nanoclaw-path', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select NanoClaw Installation Folder',
      message: 'Choose where to install NanoClaw',
    });

    if (!result.canceled && result.filePaths[0]) {
      const selectedPath = result.filePaths[0];
      stateManager.update({ nanoClawPath: selectedPath });
      window.webContents.send('wizard:state-update', stateManager.get());
      return selectedPath;
    }
    return null;
  });

  // =============================================
  //  Dashboard IPC Handlers
  // =============================================

  ipcMain.handle('wizard:service-status', async () => {
    const nanoClawPath = stateManager.get().nanoClawPath;
    const isMac = process.platform === 'darwin';

    try {
      if (process.platform === 'win32') {
        // Read PID file written by spawnNanoclawWindows; use signal 0 to
        // probe liveness without sending an actual signal.
        const pid = nanoClawPath ? readNanoclawPid(nanoClawPath) : null;
        const running = pid !== null && isProcessAlive(pid);
        return { running, pid: running ? pid : null, uptime: null, nanoClawPath };

      } else if (isMac) {
            const list = execSync('launchctl list 2>/dev/null | grep nanoclaw || true', {
          encoding: 'utf-8',
        }).trim();

        if (list) {
          const parts = list.split(/\s+/);
          const pid = parts[0] !== '-' ? parseInt(parts[0], 10) : null;
          let uptime: string | null = null;

          if (pid) {
            try {
              const elapsed = execSync(`ps -p ${pid} -o etime= 2>/dev/null`, {
                encoding: 'utf-8',
              }).trim();
              uptime = elapsed || null;
            } catch { /* process may have just died */ }
          }

          return { running: pid !== null && pid > 0, pid, uptime, nanoClawPath };
        }
      } else {
            const active = execSync(
          'systemctl --user is-active nanoclaw 2>/dev/null || true',
          { encoding: 'utf-8' },
        ).trim();
        const running = active === 'active';

        let pid: number | null = null;
        if (running) {
          try {
            const pidStr = execSync(
              'systemctl --user show nanoclaw --property=MainPID --value 2>/dev/null',
              { encoding: 'utf-8' },
            ).trim();
            pid = parseInt(pidStr, 10) || null;
          } catch { /* ignore */ }
        }

        return { running, pid, uptime: null, nanoClawPath };
      }
    } catch { /* ignore */ }

    return { running: false, pid: null, uptime: null, nanoClawPath };
  });

  ipcMain.handle('wizard:start-service', async () => {
    const ncp = stateManager.get().nanoClawPath;
    // Ensure credential proxy is applied before starting
    if (ncp) {
      try {
        await ensureCredentialProxy(ncp, stepRunner, 'service', window);
      } catch { /* best effort */ }
    }

    if (process.platform === 'win32') {
      if (!ncp) return { success: false };
      const pid = readNanoclawPid(ncp);
      if (!pid || !isProcessAlive(pid)) {
        await spawnNanoclawWindows(ncp);
      }
    } else if (process.platform === 'darwin') {
      execSync('launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null || true');
      execSync(`launchctl kickstart gui/$(id -u)/com.nanoclaw 2>/dev/null || true`);
    } else {
      execSync('systemctl --user start nanoclaw');
    }
    return { success: true };
  });

  ipcMain.handle('wizard:stop-service', async () => {
    if (process.platform === 'win32') {
      const ncp = stateManager.get().nanoClawPath;
      if (ncp) {
        const pid = readNanoclawPid(ncp);
        if (pid && isProcessAlive(pid)) {
          try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' }); } catch { /* already dead */ }
        }
        try { fs.unlinkSync(nanoclawPidFile(ncp)); } catch { /* no pid file */ }
      }
    } else if (process.platform === 'darwin') {
      execSync('launchctl kill SIGTERM gui/$(id -u)/com.nanoclaw 2>/dev/null || true');
    } else {
      execSync('systemctl --user stop nanoclaw');
    }
    return { success: true };
  });

  ipcMain.handle('wizard:restart-service', async () => {
    const ncp = stateManager.get().nanoClawPath;
    // Ensure credential proxy is applied before restarting
    if (ncp) {
      try {
        await ensureCredentialProxy(ncp, stepRunner, 'service', window);
      } catch { /* best effort */ }
    }

    if (process.platform === 'win32') {
      if (ncp) await spawnNanoclawWindows(ncp);
    } else if (process.platform === 'darwin') {
      execSync(`launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null || true`);
    } else {
      execSync('systemctl --user restart nanoclaw');
    }
    return { success: true };
  });

  ipcMain.handle('wizard:get-groups', async () => {
    const nanoClawPath = stateManager.get().nanoClawPath;
    if (!nanoClawPath) return [];

    try {
      // nanoclaw stores its DB at store/messages.db (not data/nanoclaw.db).
      // Use better-sqlite3 from nanoclaw's own node_modules so we don't need
      // the sqlite3 CLI (which is not on Windows PATH by default).
      const dbPath = path.join(nanoClawPath, 'store', 'messages.db');
      if (!fs.existsSync(dbPath)) return [];

      const BetterSqlite = require(
        path.join(nanoClawPath, 'node_modules', 'better-sqlite3'),
      );
      const db = new BetterSqlite(dbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare(
          `SELECT jid, name, folder, trigger_pattern,
            COALESCE(json_extract(container_config, '$.channel'), 'whatsapp') AS channel
           FROM registered_groups ORDER BY is_main DESC`,
        ).all() as Array<{
          jid: string; name: string; folder: string;
          trigger_pattern: string; channel: string;
        }>;
        return rows;
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  });

  ipcMain.handle('wizard:remove-group', async (_event, jid: string) => {
    const nanoClawPath = stateManager.get().nanoClawPath;
    if (!nanoClawPath) throw new Error('NanoClaw path not set');

    const dbPath = path.join(nanoClawPath, 'store', 'messages.db');
    const BetterSqlite = require(
      path.join(nanoClawPath, 'node_modules', 'better-sqlite3'),
    );
    const db = new BetterSqlite(dbPath, { fileMustExist: true });
    try {
      db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    } finally {
      db.close();
    }
    return { success: true };
  });

  ipcMain.handle('wizard:get-logs', async (_event, lines: number = 80) => {
    const nanoClawPath = stateManager.get().nanoClawPath;
    if (!nanoClawPath) return 'No NanoClaw path configured.';

    try {
      /**
       * Read the last `lines` lines from a file without requiring `tail`
       * (which is not available on Windows).
       */
      const readTail = (filePath: string, n: number): string => {
        const content = fs.readFileSync(filePath, 'utf-8');
        const allLines = content.split('\n');
        return allLines.slice(-n).join('\n');
      };

      // 1. Service stdout logs — check several locations used by different
      //    launch paths (Windows spawn → nanoclaw.log at repo root;
      //    macOS/Linux bat launcher → logs/nanoclaw.log).
      const svcLogCandidates = [
        path.join(nanoClawPath, 'nanoclaw.log'),
        path.join(nanoClawPath, 'logs', 'nanoclaw.log'),
      ];
      const svcErr = path.join(nanoClawPath, 'logs', 'nanoclaw.error.log');
      for (const svcLog of svcLogCandidates) {
        if (fs.existsSync(svcLog) && fs.statSync(svcLog).size > 0) {
          return readTail(svcLog, lines);
        }
      }
      if (fs.existsSync(svcErr) && fs.statSync(svcErr).size > 0) {
        return readTail(svcErr, lines);
      }

      // 2. Collect recent container logs from all group folders.
      //    These are the per-task Claude execution logs — most informative for the user.
      const groupsDir = path.join(nanoClawPath, 'groups');
      if (fs.existsSync(groupsDir)) {
        const logEntries: Array<{ mtime: number; file: string }> = [];
        for (const groupFolder of fs.readdirSync(groupsDir)) {
          const logsDir = path.join(groupsDir, groupFolder, 'logs');
          if (!fs.existsSync(logsDir)) continue;
          for (const logFile of fs.readdirSync(logsDir)) {
            if (!logFile.endsWith('.log')) continue;
            const full = path.join(logsDir, logFile);
            try {
              logEntries.push({ mtime: fs.statSync(full).mtimeMs, file: full });
            } catch { /* ignore */ }
          }
        }
        // Sort newest-first and read the most recent few
        logEntries.sort((a, b) => b.mtime - a.mtime);
        const combined: string[] = [];
        for (const entry of logEntries.slice(0, 5)) {
          combined.push(`\n--- ${path.relative(nanoClawPath, entry.file)} ---`);
          try {
            combined.push(readTail(entry.file, Math.ceil(lines / logEntries.slice(0, 5).length)));
          } catch { /* ignore */ }
        }
        if (combined.length > 0) return combined.join('\n');
      }

      // 3. launchd stdout/stderr logs (macOS only)
      if (process.platform === 'darwin') {
        const home = process.env.HOME || '';
        const stdoutLog = path.join(home, '.local', 'share', 'nanoclaw', 'stdout.log');
        const stderrLog = path.join(home, '.local', 'share', 'nanoclaw', 'stderr.log');
        const logFile = fs.existsSync(stderrLog) ? stderrLog :
          fs.existsSync(stdoutLog) ? stdoutLog : null;
        if (logFile) return readTail(logFile, lines);
      }

      return 'No log files found yet. Logs appear here after NanoClaw processes a message.';
    } catch (err: any) {
      return `Error reading logs: ${err.message}`;
    }
  });

  ipcMain.handle('wizard:get-channels', async () => {
    const nanoClawPath = stateManager.get().nanoClawPath;
    if (!nanoClawPath) return [];

    const channelsDir = path.join(nanoClawPath, 'src', 'channels');
    if (!fs.existsSync(channelsDir)) return [];

    try {
      const files = fs.readdirSync(channelsDir);
      return files
        .filter((f: string) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts' && f !== 'registry.ts')
        .map((f: string) => f.replace('.ts', ''));
    } catch {
      return [];
    }
  });

  ipcMain.handle('wizard:remove-channel', async (_event, channel: string) => {
    // Destructive: removes both the source and test files, fixes the barrel
    // file, and COMMITS the deletion so the working tree stays clean. Without
    // the commit, the deletions sit as pending changes and the next merge
    // attempt either picks them up via auto-stage or breaks because git
    // refuses to start the merge with dirty paths.
    const nanoClawPath = stateManager.get().nanoClawPath;
    if (!nanoClawPath) throw new Error('NanoClaw path not set');


    // Remove both source and test files.
    for (const suffix of ['.ts', '.test.ts']) {
      const f = path.join(nanoClawPath, 'src', 'channels', `${channel}${suffix}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    // Remove the channel's import line(s) from the barrel file.
    const indexPath = path.join(nanoClawPath, 'src', 'channels', 'index.ts');
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf-8');
      const filtered = content
        .split('\n')
        .filter((line: string) => !line.includes(`./${channel}.js`))
        .join('\n');
      fs.writeFileSync(indexPath, filtered);
    }

    // Stage and commit the removal so future merges start from a clean tree.
    // --no-verify bypasses the husky/prettier pre-commit hook.
    try {
      execSync('git add -A src/channels/', { cwd: nanoClawPath });
      execSync(
        `git commit --no-verify -m "chore: remove ${channel} channel"`,
        { cwd: nanoClawPath },
      );
    } catch {
      // Best-effort: if there's nothing to commit, ignore.
    }

    // Rebuild
    try {
      execSync('npm run build', { cwd: nanoClawPath });
    } catch {
      // Build may fail if other files still reference the removed channel —
      // surface the error to the user via the next dashboard refresh.
    }

    return { success: true };
  });

  ipcMain.handle('wizard:open-folder', async (_event, folderPath: string) => {
    const { shell } = await import('electron');
    shell.openPath(folderPath);
  });

  ipcMain.handle('wizard:open-url', async (_event, url: string) => {
    const { shell } = await import('electron');
    shell.openExternal(url);
  });
}
