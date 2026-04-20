import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const MIN_NODE_VERSION = 20;

/**
 * Maximum supported Node major version. Only enforced on Windows, where
 * `better-sqlite3` (a nanoclaw dependency) doesn't publish prebuilt
 * binaries for Node 23+ yet. Without a prebuild, npm falls back to
 * `node-gyp rebuild`, which needs a specific vintage of Visual Studio
 * that node-gyp's version table knows about — users with newer VS (e.g.
 * the 2024 preview) hit an "unknown version" rejection and bootstrap
 * dies inside `npm ci`. Capping at 22 (current LTS) routes Windows users
 * to the prebuild path and avoids the compile-from-source trap entirely.
 *
 * macOS and Linux are uncapped: `better-sqlite3` has wider prebuild
 * coverage on those platforms, and this cap would be an unnecessary
 * regression for existing macOS users on Node 24.
 *
 * Bump this when better-sqlite3 ships newer prebuilds for Windows.
 */
function getMaxNodeVersion(): number {
  return process.platform === 'win32' ? 22 : Infinity;
}

/**
 * Directories to scan when `node` is not on the inherited PATH.
 *
 * This handles the common case where the user installed Node *after* the
 * Electron process was already running, so `process.env.PATH` doesn't
 * include the new install directory yet. Scanning known locations lets us
 * find the binary anyway and then patch `process.env.PATH` in place so the
 * rest of the session works without a restart.
 *
 * Platform notes:
 *  - Linux/WSL: apt puts node at /usr/bin; nvm puts each version under
 *    ~/.nvm/versions/node/<version>/bin — we enumerate those newest-first.
 *  - macOS: Homebrew arm64 → /opt/homebrew/bin; x64 → /usr/local/bin.
 *    nvm same as Linux.
 *  - Windows: standard MSI installer writes to C:\Program Files\nodejs;
 *    nvm-windows to %APPDATA%\nvm\<version>. We include both.
 */
function getNodeFallbackDirs(): string[] {
  const platform = process.platform;

  if (platform === 'win32') {
    const dirs: string[] = [
      'C:\\Program Files\\nodejs',
      'C:\\Program Files (x86)\\nodejs',
    ];
    // nvm-windows: %APPDATA%\nvm\<version>
    const appData = process.env.APPDATA;
    if (appData) {
      const nvmRoot = path.join(appData, 'nvm');
      if (fs.existsSync(nvmRoot)) {
        try {
          const versions = fs.readdirSync(nvmRoot)
            .filter((v) => v.startsWith('v'))
            .sort()
            .reverse(); // newest first
          for (const v of versions) {
            dirs.push(path.join(nvmRoot, v));
          }
        } catch { /* ignore */ }
      }
    }
    return dirs;
  }

  // Linux / macOS
  const dirs: string[] = [
    '/usr/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',       // macOS arm64
    '/usr/local/homebrew/bin', // macOS x64 (rare)
  ];

  // nvm — walk ~/.nvm/versions/node/*, newest first
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  const nvmVersionsDir = path.join(nvmDir, 'versions', 'node');
  if (fs.existsSync(nvmVersionsDir)) {
    try {
      const versions = fs.readdirSync(nvmVersionsDir)
        .filter((v) => v.startsWith('v'))
        .sort()
        .reverse();
      for (const v of versions) {
        dirs.push(path.join(nvmVersionsDir, v, 'bin'));
      }
    } catch { /* ignore */ }
  }

  return dirs;
}

/**
 * Scan known install locations for a `node` binary when it isn't on PATH.
 * Returns the full path to the executable, or null if nothing found.
 */
function findNodeBinaryOffPath(): string | null {
  const binary = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of getNodeFallbackDirs()) {
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* not here, keep scanning */ }
  }
  return null;
}

/**
 * Prepend `dir` to `process.env.PATH` (using the platform delimiter) so
 * that child processes spawned later in this session can find binaries in
 * that directory. No-op if `dir` is already present (case-insensitive on
 * Windows, case-sensitive elsewhere).
 */
function prependToProcessPath(dir: string): void {
  const current = process.env.PATH || '';
  const sep = path.delimiter;
  const parts = current.split(sep);
  const alreadyPresent =
    process.platform === 'win32'
      ? parts.some((p) => p.toLowerCase() === dir.toLowerCase())
      : parts.includes(dir);
  if (!alreadyPresent) {
    process.env.PATH = dir + sep + current;
  }
}

export async function checkNode(): Promise<{
  installed: boolean;
  version?: string;
}> {
  // ── Primary check: use whatever is on the inherited PATH ─────────────────
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    const major = parseInt(version.replace('v', '').split('.')[0], 10);
    const compatible =
      major >= MIN_NODE_VERSION && major <= getMaxNodeVersion();
    // Return installed:false for out-of-range versions so the prereqs UI
    // prompts the user to fix it. `version` is still reported so the UI
    // can show what they currently have.
    return { installed: compatible, version };
  } catch {
    // PATH-based lookup failed — fall through to the off-PATH scan below.
  }

  // ── Fallback: scan well-known install locations ───────────────────────────
  // This fires when the user installed Node *after* Electron launched (so the
  // new directory was never added to the inherited PATH), or when a version
  // manager (nvm, nvm-windows) adds its shim directory only to the login
  // shell's PATH and not to GUI app environments.
  const nodeBin = findNodeBinaryOffPath();
  if (nodeBin) {
    try {
      const version = execSync(`"${nodeBin}" --version`, {
        encoding: 'utf-8',
      }).trim();
      const major = parseInt(version.replace('v', '').split('.')[0], 10);
      const compatible =
        major >= MIN_NODE_VERSION && major <= getMaxNodeVersion();

      if (compatible) {
        // Patch the running process's PATH so subsequent tool invocations
        // (npm ci, npx, etc.) can also find this Node without a restart.
        prependToProcessPath(path.dirname(nodeBin));
      }

      return { installed: compatible, version };
    } catch { /* binary exists but version query failed — treat as not found */ }
  }

  return { installed: false };
}

export async function installNode(
  onOutput: (text: string) => void,
): Promise<boolean> {
  const platform = process.platform;

  if (platform === 'darwin') {
    return installNodeMac(onOutput);
  } else if (platform === 'win32') {
    onOutput('Windows Node.js installation not yet implemented.\n');
    onOutput('Please install Node.js 22 from https://nodejs.org\n');
    return false;
  } else {
    onOutput('Linux Node.js installation not yet implemented.\n');
    onOutput('Please install Node.js 22 using your package manager.\n');
    return false;
  }
}

async function installNodeMac(onOutput: (text: string) => void): Promise<boolean> {
  // Try Homebrew first
  try {
    execSync('which brew', { encoding: 'utf-8' });
    onOutput('Found Homebrew. Installing Node.js 22...\n');
    return runCommand('brew', ['install', 'node@22'], onOutput);
  } catch {
    // No Homebrew — try installing Homebrew first
    onOutput('Homebrew not found. Installing Homebrew first...\n');
    const brewInstalled = await runCommand(
      '/bin/bash',
      ['-c', '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'],
      onOutput,
    );

    if (!brewInstalled) {
      onOutput('Failed to install Homebrew.\n');
      onOutput('Please install Node.js 22 manually from https://nodejs.org\n');
      return false;
    }

    onOutput('Homebrew installed. Now installing Node.js 22...\n');
    return runCommand('brew', ['install', 'node@22'], onOutput);
  }
}

function runCommand(
  cmd: string,
  args: string[],
  onOutput: (text: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      shell: true,
      env: { ...process.env, NONINTERACTIVE: '1' },
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
