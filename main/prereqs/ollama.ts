import { execSync, spawn } from 'child_process';
import http from 'http';
import https from 'https';
import path from 'path';
import os from 'os';
import fs from 'fs';

/**
 * Ollama prereq. Mirrors main/prereqs/claude.ts in structure.
 *
 * Two exported entry points:
 *  - checkOllama()   → { installed, running, version }
 *  - installOllama() → installs if missing, starts the daemon, returns true/false
 *
 * Windows install uses the official OllamaSetup.exe silent installer.
 * macOS/Linux use the one-liner install.sh from ollama.com.
 */

const OLLAMA_WIN_INSTALLER_URL =
  'https://ollama.com/download/OllamaSetup.exe';
const OLLAMA_POSIX_INSTALLER_URL = 'https://ollama.com/install.sh';
const OLLAMA_PORT = 11434;

function getOllamaSearchPaths(): string[] {
  if (process.platform === 'win32') {
    const home = os.homedir();
    const localAppData =
      process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(home, 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
    ];
  }
  return ['/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama'];
}

function findOllamaBinary(): string | null {
  try {
    const lookupCmd = process.platform === 'win32' ? 'where ollama' : 'which ollama';
    const output = execSync(lookupCmd, {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (output) {
      const first = output.split(/\r?\n/)[0]?.trim();
      if (first) return first;
    }
  } catch {
    // not on PATH
  }

  for (const p of getOllamaSearchPaths()) {
    try {
      fs.accessSync(
        p,
        process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK,
      );
      return p;
    } catch {
      // not here
    }
  }

  return null;
}

/**
 * Probe the Ollama daemon. Returns true if it responds on localhost:11434
 * within 500 ms.
 */
function isOllamaRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: OLLAMA_PORT, path: '/api/tags', timeout: 500 },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function checkOllama(): Promise<{
  installed: boolean;
  running?: boolean;
  version?: string;
}> {
  const binary = findOllamaBinary();
  if (!binary) {
    return { installed: false };
  }

  let version = 'unknown';
  try {
    version = execSync(`"${binary}" --version`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    // ollama --version may print to stderr and exit nonzero on some installs;
    // binary existence alone is proof enough of "installed".
  }

  const running = await isOllamaRunning();
  return { installed: true, running, version };
}

/**
 * Spawn `ollama serve` as a detached background process. No-op if the daemon
 * is already responding. We use detached + unref so the daemon outlives this
 * wizard session — the user probably wants it up anyway.
 */
async function ensureOllamaDaemon(
  onOutput: (text: string) => void,
): Promise<boolean> {
  if (await isOllamaRunning()) {
    onOutput('Ollama daemon is already running.\n');
    return true;
  }

  const binary = findOllamaBinary();
  if (!binary) {
    onOutput('Cannot start ollama: binary not found.\n');
    return false;
  }

  onOutput('Starting ollama daemon...\n');
  try {
    const child = spawn(binary, ['serve'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onOutput(`Failed to spawn ollama serve: ${msg}\n`);
    return false;
  }

  // Poll briefly for the daemon to come up.
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 300));
    if (await isOllamaRunning()) {
      onOutput('Ollama daemon is up.\n');
      return true;
    }
  }
  onOutput('Warning: ollama daemon did not respond after 6s. Try again in a moment.\n');
  return false;
}

/**
 * Download a URL to a local file. Follows one level of 3xx redirect
 * (the ollama.com installer URL redirects to a CDN).
 */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (targetUrl: string, hops: number) => {
      if (hops > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      https
        .get(targetUrl, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            request(res.headers.location, hops + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} fetching ${targetUrl}`));
            res.resume();
            return;
          }
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
        })
        .on('error', reject);
    };
    request(url, 0);
  });
}

async function installOllamaWindows(
  onOutput: (text: string) => void,
): Promise<boolean> {
  onOutput('Installing Ollama (Windows)...\n');
  const installerPath = path.join(os.tmpdir(), `OllamaSetup-${Date.now()}.exe`);
  onOutput(`Downloading ${OLLAMA_WIN_INSTALLER_URL}\n`);
  try {
    await downloadFile(OLLAMA_WIN_INSTALLER_URL, installerPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onOutput(`Download failed: ${msg}\n`);
    return false;
  }
  onOutput(`Downloaded to ${installerPath}\n`);
  onOutput('Running silent installer...\n');

  const success = await runCommand(installerPath, ['/SILENT'], onOutput);
  try {
    fs.unlinkSync(installerPath);
  } catch {
    // leave it; user can clean up
  }
  if (!success) {
    onOutput('Ollama installer exited with a non-zero code.\n');
    return false;
  }

  // The installer puts ollama.exe in %LOCALAPPDATA%\Programs\Ollama but does
  // not always update PATH for the current process. Prepend it manually so
  // subsequent commands in this wizard session can find `ollama`.
  const home = os.homedir();
  const localAppData =
    process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const ollamaDir = path.join(localAppData, 'Programs', 'Ollama');
  const currentPath = process.env.PATH || '';
  if (
    !currentPath
      .split(path.delimiter)
      .some((p) => p.toLowerCase() === ollamaDir.toLowerCase())
  ) {
    process.env.PATH = [ollamaDir, ...currentPath.split(path.delimiter)].join(
      path.delimiter,
    );
    onOutput(`Added ${ollamaDir} to PATH for this session.\n`);
  }

  const binary = findOllamaBinary();
  if (!binary) {
    onOutput('Installer finished but ollama.exe was not found.\n');
    return false;
  }
  onOutput(`Ollama installed at ${binary}\n`);
  return ensureOllamaDaemon(onOutput);
}

async function installOllamaPosix(
  onOutput: (text: string) => void,
): Promise<boolean> {
  onOutput('Installing Ollama...\n');
  const success = await runCommand(
    'curl',
    ['-fsSL', OLLAMA_POSIX_INSTALLER_URL, '|', 'sh'],
    onOutput,
  );
  if (!success) {
    onOutput('Ollama installer failed.\n');
    return false;
  }
  const binary = findOllamaBinary();
  if (!binary) {
    onOutput('Installer finished but ollama binary was not found on PATH.\n');
    return false;
  }
  onOutput(`Ollama installed at ${binary}\n`);
  return ensureOllamaDaemon(onOutput);
}

export async function installOllama(
  onOutput: (text: string) => void,
): Promise<boolean> {
  if (process.platform === 'win32') {
    return installOllamaWindows(onOutput);
  }
  return installOllamaPosix(onOutput);
}

/**
 * Convenience wrapper used by the credentials flow: check, install if
 * missing, make sure the daemon is up. Returns true if Ollama is ready
 * to serve requests when the function resolves.
 */
export async function ensureOllama(
  onOutput: (text: string) => void,
): Promise<boolean> {
  const current = await checkOllama();
  if (!current.installed) {
    onOutput('Ollama not found — installing...\n');
    const installed = await installOllama(onOutput);
    if (!installed) return false;
  } else {
    onOutput(`Ollama found (${current.version || 'unknown version'}).\n`);
    if (!current.running) {
      const started = await ensureOllamaDaemon(onOutput);
      if (!started) return false;
    } else {
      onOutput('Ollama daemon is already running.\n');
    }
  }
  return true;
}

/**
 * Same pattern as claude.ts:runCommand — shell-quoted, streams stdout/stderr
 * through `onOutput`. Separate copy here because there's no shared helpers
 * module and we prefer self-contained prereq files.
 */
function runCommand(
  cmd: string,
  args: string[],
  onOutput: (text: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const fullCommand = [cmd, ...args].join(' ');
    const child = spawn(fullCommand, [], {
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
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
