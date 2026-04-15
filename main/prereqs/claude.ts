import { execSync, spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

/**
 * Common locations where claude might be installed.
 * We check these explicitly because the Electron process may not have
 * an updated PATH after installation.
 */
const CLAUDE_SEARCH_PATHS = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/usr/local/bin/claude',
  path.join(os.homedir(), '.claude', 'bin', 'claude'),
];

/**
 * Find the claude binary, checking PATH and known install locations.
 */
function findClaudeBinary(): string | null {
  // First try PATH (works if already installed and PATH is set)
  try {
    const which = execSync('which claude', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (which) return which;
  } catch {
    // Not in PATH
  }

  // Check known install locations
  for (const p of CLAUDE_SEARCH_PATHS) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // Not here
    }
  }

  return null;
}

/**
 * Build a PATH that includes common claude install locations,
 * so spawned processes can find claude even if the user hasn't
 * sourced their shell profile yet.
 */
function getEnhancedPath(): string {
  const existing = process.env.PATH || '';
  const extraDirs = [
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    path.join(os.homedir(), '.claude', 'bin'),
  ];
  const parts = existing.split(':');
  for (const dir of extraDirs) {
    if (!parts.includes(dir)) {
      parts.unshift(dir);
    }
  }
  return parts.join(':');
}

export async function checkClaude(): Promise<{
  installed: boolean;
  version?: string;
}> {
  const binary = findClaudeBinary();
  if (!binary) {
    return { installed: false };
  }

  try {
    const version = execSync(`"${binary}" --version`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, PATH: getEnhancedPath() },
    }).trim();
    return { installed: true, version };
  } catch {
    // Binary exists but can't get version — still installed
    return { installed: true, version: 'unknown' };
  }
}

export async function installClaude(
  onOutput: (text: string) => void,
): Promise<boolean> {
  onOutput('Installing Claude Code CLI...\n');
  onOutput('Using the official Anthropic installer.\n\n');

  // Use the official install script — this is the recommended way
  // It handles everything: downloads the binary, puts it in ~/.local/bin,
  // and updates shell profile (bashrc/zshrc)
  const success = await runCommand(
    'curl',
    ['-fsSL', 'https://claude.ai/install.sh', '|', 'bash'],
    onOutput,
  );

  if (!success) {
    onOutput('\nOfficial installer failed. Trying Homebrew...\n');
    if (process.platform === 'darwin') {
      try {
        execSync('which brew', { encoding: 'utf-8' });
        const brewSuccess = await runCommand('brew', ['install', 'claude'], onOutput);
        if (brewSuccess) {
          onOutput('\nClaude Code installed via Homebrew!\n');
          return true;
        }
      } catch {
        // No homebrew
      }
    }

    onOutput('\nTrying npm global install...\n');
    const npmSuccess = await runCommand(
      'npm',
      ['install', '-g', '@anthropic-ai/claude-code'],
      onOutput,
    );
    if (npmSuccess) {
      onOutput('\nClaude Code installed via npm!\n');
      return true;
    }

    onOutput('\nAll installation methods failed.\n');
    return false;
  }

  // After install, add ~/.local/bin to the current process PATH
  // so subsequent steps (like claude setup-token) can find it immediately
  // without requiring a shell restart
  const localBin = path.join(os.homedir(), '.local', 'bin');
  if (!process.env.PATH?.includes(localBin)) {
    process.env.PATH = `${localBin}:${process.env.PATH}`;
    onOutput(`\nAdded ${localBin} to PATH for this session.\n`);
  }

  // Verify installation
  const binary = findClaudeBinary();
  if (binary) {
    onOutput(`\nClaude Code installed successfully at ${binary}\n`);
    return true;
  }

  onOutput('\nInstallation completed but could not find claude binary.\n');
  return false;
}

/**
 * Run `claude setup-token` in a real terminal (Terminal.app / xterm).
 * The Ink TUI needs a real TTY that Electron can't provide.
 *
 * Strategy: run setup-token interactively (no pipes — the TUI needs the real TTY),
 * then after it exits, capture the token by running setup-token a second time
 * (which just prints the existing token) or by reading the auth status.
 * We detect completion by watching for the script's "done" marker file.
 */
export function runSetupToken(
  onOutput: (text: string) => void,
  onToken: (token: string) => void,
): { process: ReturnType<typeof spawn>; promise: Promise<boolean> } {
  const binary = findClaudeBinary() || 'claude';
  const ts = Date.now();
  const tokenFile = path.join(os.tmpdir(), `nanoclaw-token-${ts}.txt`);
  const doneFile = path.join(os.tmpdir(), `nanoclaw-done-${ts}`);

  // The script runs setup-token interactively (no pipes),
  // then after it exits, captures the token separately.
  const script = `#!/bin/bash
export PATH="${getEnhancedPath()}"
echo ""
echo "=== NanoClaw Setup ==="
echo "This will connect your Claude account for NanoClaw to use."
echo "Follow the prompts below."
echo ""
"${binary}" setup-token
EXIT_CODE=$?
echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "Authentication complete! Capturing token..."
  # setup-token stores the token — run it again to print it (non-interactive)
  # or read from the auth system
  TOKEN=$("${binary}" setup-token --print 2>/dev/null || true)
  if [ -z "$TOKEN" ]; then
    # Try to get it from auth status
    TOKEN=$("${binary}" auth status --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('oauthToken',''))" 2>/dev/null || true)
  fi
  if [ -n "$TOKEN" ]; then
    echo "$TOKEN" > "${tokenFile}"
    echo "Token captured!"
  else
    echo "MANUAL_PASTE_NEEDED" > "${tokenFile}"
    echo "Could not capture token automatically."
    echo "You may need to paste it manually in the wizard."
  fi
else
  echo "Authentication was cancelled or failed."
fi
# Signal that the script is done
touch "${doneFile}"
echo ""
echo "You can close this window now."
sleep 3
`;

  const scriptPath = path.join(os.tmpdir(), `nanoclaw-setup-${ts}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  let child: ReturnType<typeof spawn>;

  if (process.platform === 'darwin') {
    child = spawn('open', ['-a', 'Terminal', scriptPath], {
      env: { ...process.env, PATH: getEnhancedPath() },
    });
  } else {
    child = spawn('x-terminal-emulator', ['-e', scriptPath], {
      shell: true,
      env: { ...process.env, PATH: getEnhancedPath() },
    });
  }

  onOutput('A terminal window has opened for Claude authentication.\n');
  onOutput('Follow the prompts there, then come back here.\n\n');

  const promise = new Promise<boolean>((resolve) => {
    let elapsed = 0;
    const maxWait = 300000; // 5 minutes
    const pollInterval = 2000;

    const poll = setInterval(() => {
      elapsed += pollInterval;

      // Check if the script finished (done marker exists)
      if (fs.existsSync(doneFile)) {
        clearInterval(poll);

        // Read the token
        let token = '';
        try {
          token = fs.readFileSync(tokenFile, 'utf-8').trim();
        } catch { /* no token file */ }

        // Clean up temp files
        try { fs.unlinkSync(tokenFile); } catch {}
        try { fs.unlinkSync(doneFile); } catch {}
        try { fs.unlinkSync(scriptPath); } catch {}

        if (token && token !== 'MANUAL_PASTE_NEEDED' && token.length > 20) {
          onToken(token);
          onOutput('Token captured successfully!\n');
          resolve(true);
        } else {
          onOutput('Could not capture token automatically.\n');
          onOutput('Please use the "Paste Token" option instead — run `claude setup-token` in Terminal and paste the result.\n');
          resolve(false);
        }
        return;
      }

      if (elapsed >= maxWait) {
        clearInterval(poll);
        onOutput('\nTimed out waiting for authentication.\n');
        try { fs.unlinkSync(scriptPath); } catch {}
        resolve(false);
      }
    }, pollInterval);

    child.on('error', (err) => {
      clearInterval(poll);
      onOutput(`Error opening terminal: ${err.message}\n`);
      onOutput('Please use the "Paste Token" option instead.\n');
      try { fs.unlinkSync(scriptPath); } catch {}
      resolve(false);
    });
  });

  return { process: child, promise };
}

function runCommand(
  cmd: string,
  args: string[],
  onOutput: (text: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    // Join command for shell execution (needed for piped commands like curl | bash)
    const fullCommand = [cmd, ...args].join(' ');

    const child = spawn(fullCommand, [], {
      shell: true,
      env: {
        ...process.env,
        PATH: getEnhancedPath(),
        // Don't prompt for input during install
        NONINTERACTIVE: '1',
      },
    });

    child.stdout?.on('data', (data: Buffer) => onOutput(data.toString()));
    child.stderr?.on('data', (data: Buffer) => onOutput(data.toString()));
    child.on('close', (code) => resolve(code === 0));
    child.on('error', (err) => {
      onOutput(`Error: ${err.message}\n`);
      resolve(false);
    });
  });
}
