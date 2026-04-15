import { ipcMain, BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { StateManager } from './state.js';
import { StepRunner } from './step-runner.js';
import { checkAllPrereqs, installPrereq } from './prereqs/index.js';
import { runSetupToken } from './prereqs/claude.js';

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
    const { execSync } = require('child_process');
    oursContent = execSync('git show :2:src/channels/index.ts', {
      cwd: nanoClawPath, encoding: 'utf-8',
    });
  } catch {
    try { oursContent = fs.readFileSync(barrelPath, 'utf-8'); } catch { /* */ }
  }

  // Read "theirs" (incoming channel branch)
  let theirsContent = '';
  try {
    const { execSync } = require('child_process');
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
  const { execSync } = require('child_process');

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
  const { execSync } = require('child_process');
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
        const { code } = await stepRunner.runCommand(step, 'git', [
          'clone',
          'https://github.com/qwibitai/nanoclaw.git',
          targetPath,
        ]);
        if (code !== 0) {
          throw new Error(
            'Git clone failed — check terminal output for details',
          );
        }
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

        // Clean up any leftover unmerged state from a previous failed merge
        const unmergedCheck = await stepRunner.runCommand(step, 'git', [
          'diff', '--name-only', '--diff-filter=U',
        ], { cwd: nanoClawPath! });
        if (unmergedCheck.stdout.trim()) {
          window.webContents.send('wizard:output', {
            step, stream: 'stdout',
            text: 'Cleaning up unfinished previous merge...\n',
          });
          await resolveConflicts(nanoClawPath!, channel, stepRunner, step);
          await stepRunner.runCommand(step, 'git', ['add', '-A'], { cwd: nanoClawPath! });
          await stepRunner.runCommand(step, 'git', [
            'commit', '--no-edit', '--no-verify',
            '-m', 'Resolve stale merge',
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
          throw new Error(
            `Failed to add ${channel}: source file not found after merge. ` +
            `The git merge may have failed. Check terminal output and try again.`,
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

        if (fs.existsSync(setupScript)) {
          // Use the setup step — supports qr-browser, qr-terminal, pairing-code
          scriptCmd = 'npx';
          scriptArgs = ['tsx', 'setup/index.ts', '--step', 'whatsapp-auth',
            '--method', method];
          if (method === 'pairing-code' && args?.phone) {
            scriptArgs.push('--phone', args.phone);
          }
        } else if (fs.existsSync(directScript)) {
          // Fall back to standalone script (terminal QR only)
          scriptCmd = 'npx';
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

        const result = await stepRunner.runCommand(
          step,
          scriptCmd,
          scriptArgs,
          { cwd: nanoClawPath! },
        );

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

      // ---- Service start — ensure proxy is applied first ----
      if (step === 'service') {
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
      if (isMac) {
        const { execSync } = await import('child_process');
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
        const { execSync } = await import('child_process');
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

    const { execSync } = await import('child_process');
    if (process.platform === 'darwin') {
      execSync('launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null || true');
      execSync(`launchctl kickstart gui/$(id -u)/com.nanoclaw 2>/dev/null || true`);
    } else {
      execSync('systemctl --user start nanoclaw');
    }
    return { success: true };
  });

  ipcMain.handle('wizard:stop-service', async () => {
    const { execSync } = await import('child_process');
    if (process.platform === 'darwin') {
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

    const { execSync } = await import('child_process');
    if (process.platform === 'darwin') {
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
      const dbPath = path.join(nanoClawPath, 'data', 'nanoclaw.db');
      if (!fs.existsSync(dbPath)) return [];

      const { execSync } = await import('child_process');
      const rows = execSync(
        `sqlite3 "${dbPath}" "SELECT jid, name, folder, trigger_pattern, COALESCE(json_extract(container_config,'$.channel'),'whatsapp') as channel FROM registered_groups ORDER BY is_main DESC;"`,
        { encoding: 'utf-8' },
      ).trim();

      if (!rows) return [];

      return rows.split('\n').map((row: string) => {
        const [jid, name, folder, trigger_pattern, channel] = row.split('|');
        return { jid, name, folder, trigger_pattern, channel: channel || 'whatsapp' };
      });
    } catch {
      return [];
    }
  });

  ipcMain.handle('wizard:remove-group', async (_event, jid: string) => {
    const nanoClawPath = stateManager.get().nanoClawPath;
    if (!nanoClawPath) throw new Error('NanoClaw path not set');

    const dbPath = path.join(nanoClawPath, 'data', 'nanoclaw.db');
    const { execSync } = await import('child_process');
    execSync(
      `sqlite3 "${dbPath}" "DELETE FROM registered_groups WHERE jid='${jid.replace(/'/g, "''")}';"`,
    );
    return { success: true };
  });

  ipcMain.handle('wizard:get-logs', async (_event, lines: number = 80) => {
    const nanoClawPath = stateManager.get().nanoClawPath;
    if (!nanoClawPath) return 'No NanoClaw path configured.';

    try {
      // Try the most common log locations
      const logPaths = [
        path.join(nanoClawPath, 'logs', 'nanoclaw.log'),
        path.join(nanoClawPath, 'nanoclaw.log'),
      ];

      for (const logPath of logPaths) {
        if (fs.existsSync(logPath)) {
          const { execSync } = await import('child_process');
          return execSync(`tail -n ${lines} "${logPath}"`, { encoding: 'utf-8' });
        }
      }

      // Try launchd stdout/stderr logs
      if (process.platform === 'darwin') {
        const home = process.env.HOME || '';
        const stdoutLog = path.join(home, '.local', 'share', 'nanoclaw', 'stdout.log');
        const stderrLog = path.join(home, '.local', 'share', 'nanoclaw', 'stderr.log');
        const logFile = fs.existsSync(stderrLog) ? stderrLog :
          fs.existsSync(stdoutLog) ? stdoutLog : null;
        if (logFile) {
          const { execSync } = await import('child_process');
          return execSync(`tail -n ${lines} "${logFile}"`, { encoding: 'utf-8' });
        }
      }

      return 'No log files found.';
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
    // This is destructive — we just remove the channel file
    // A proper implementation would revert the git merge, but that's complex
    const nanoClawPath = stateManager.get().nanoClawPath;
    if (!nanoClawPath) throw new Error('NanoClaw path not set');

    const channelFile = path.join(nanoClawPath, 'src', 'channels', `${channel}.ts`);
    if (fs.existsSync(channelFile)) {
      fs.unlinkSync(channelFile);
    }

    // Remove from channels/index.ts exports
    const indexPath = path.join(nanoClawPath, 'src', 'channels', 'index.ts');
    if (fs.existsSync(indexPath)) {
      let content = fs.readFileSync(indexPath, 'utf-8');
      content = content
        .split('\n')
        .filter((line: string) => !line.includes(`./${channel}`))
        .join('\n');
      fs.writeFileSync(indexPath, content);
    }

    // Rebuild
    const { execSync } = await import('child_process');
    execSync('npm run build', { cwd: nanoClawPath });

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
