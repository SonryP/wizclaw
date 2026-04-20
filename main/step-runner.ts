import { spawn, execSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BrowserWindow } from 'electron';

interface StatusBlock {
  step: string;
  fields: Record<string, string>;
}

/**
 * Windows-only: resolve `bash` to git-bash.exe (Git for Windows), not the
 * WSL launcher at C:\Windows\System32\bash.exe.
 *
 * On a typical Windows box with both Git for Windows and WSL installed,
 * a bare `bash` on PATH hits System32 first and launches the script inside
 * a Linux distro. That distro has its own /usr/bin/node, /usr/bin/docker,
 * etc. — none of which see the Windows-side tools the user installed via
 * the wizard's prereq step. Git-bash, by contrast, shares the host
 * environment and runs Windows binaries natively.
 *
 * Resolution order:
 *   1. %ProgramFiles%\Git\bin\bash.exe          (standard 64-bit install)
 *   2. %ProgramFiles(x86)%\Git\bin\bash.exe     (32-bit install)
 *   3. Derived from `where git` — walk up one dir from git.exe's dir,
 *      then try bin\bash.exe. Covers non-default install paths and
 *      portable Git installs.
 *
 * Returns null if git-bash isn't found; the caller falls back to bare
 * `bash`, which is still better than nothing on a machine that only has
 * WSL bash (setup.sh will tell the user what's wrong via its own checks).
 *
 * Cached at module level — the lookup cost isn't huge, but every step
 * that spawns bash would otherwise pay it redundantly.
 */
let cachedGitBashPath: string | null | undefined = undefined;

function findGitBashExe(): string | null {
  if (cachedGitBashPath !== undefined) return cachedGitBashPath;

  const candidates: string[] = [];

  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    candidates.push(path.join(programFiles, 'Git', 'bin', 'bash.exe'));
  }
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (programFilesX86) {
    candidates.push(path.join(programFilesX86, 'Git', 'bin', 'bash.exe'));
  }

  // Derive from git.exe's location for non-default installs.
  try {
    const gitWhere = execSync('where git', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const gitPath = gitWhere.split(/\r?\n/)[0]?.trim();
    if (gitPath) {
      // git.exe lives at <install>\cmd\git.exe (default) or
      // <install>\bin\git.exe. In either case, git-bash is at
      // <install>\bin\bash.exe — so go up one dir and dive into bin.
      const installRoot = path.dirname(path.dirname(gitPath));
      candidates.push(path.join(installRoot, 'bin', 'bash.exe'));
    }
  } catch {
    // `where git` not available or git not on PATH.
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.F_OK);
      cachedGitBashPath = candidate;
      return candidate;
    } catch {
      // Not here, try next.
    }
  }

  cachedGitBashPath = null;
  return null;
}

/**
 * If the caller asked for `bash` on Windows, swap in git-bash.exe when
 * available. No-op on every other (command, platform) combination.
 */
function resolveCommandForPlatform(command: string): string {
  if (process.platform === 'win32' && command === 'bash') {
    const gitBash = findGitBashExe();
    if (gitBash) return gitBash;
  }
  return command;
}

/**
 * Shell-escape a string for use as an argument when spawn is called with
 * shell: true. Platform-specific because POSIX sh and Windows cmd.exe have
 * completely different quoting rules:
 *
 * - POSIX: single quotes are literal delimiters; anything inside is verbatim
 *   except another single quote (handled with the '\'' dance).
 * - Windows cmd.exe: single quotes are literal characters, not delimiters.
 *   Arguments with spaces or backslashes must be wrapped in double quotes.
 *   The child process's argv parser (Microsoft CRT / CommandLineToArgvW)
 *   interprets backslashes specially when they're followed by `"`:
 *     - 2n backslashes + `"`  → n backslashes, end-quote
 *     - 2n+1 backslashes + `"` → n backslashes, literal `"`
 *   A trailing run of backslashes before the closing `"` of a quoted arg
 *   must be doubled so it doesn't escape the closing quote.
 *
 * The old POSIX-only implementation wrapped Windows paths like
 * `C:\Users\foo\nanoclaw` in single quotes, which cmd.exe passed through
 * literally — git then tried to clone into a dir named `'C:\Users\...'`
 * and failed.
 */
function shellQuote(arg: string): string {
  if (process.platform === 'win32') {
    return windowsQuote(arg);
  }
  return posixQuote(arg);
}

function posixQuote(arg: string): string {
  if (arg === '') return "''";
  // If it's already safe (alphanumerics, dash, underscore, slash, dot), leave it
  if (/^[A-Za-z0-9_\-\/.=:@+]+$/.test(arg)) return arg;
  // Wrap in single quotes, escape any embedded single quotes
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function windowsQuote(arg: string): string {
  if (arg === '') return '""';
  // Safe: plain alphanumerics + a few characters that are harmless to cmd.exe
  // and the child argv parser. Backslash is NOT in this set — any path with
  // `\` must be quoted.
  if (/^[A-Za-z0-9_\-.=:@+]+$/.test(arg)) return arg;

  // Build a CRT-escaped, double-quoted form.
  let escaped = '';
  let i = 0;
  while (i < arg.length) {
    let backslashes = 0;
    while (i < arg.length && arg[i] === '\\') {
      backslashes++;
      i++;
    }
    if (i === arg.length) {
      // Trailing backslashes before the closing quote — double them so the
      // closing quote isn't escaped.
      escaped += '\\'.repeat(backslashes * 2);
    } else if (arg[i] === '"') {
      // Backslashes before " must be doubled, then escape the " itself.
      escaped += '\\'.repeat(backslashes * 2 + 1) + '"';
      i++;
    } else {
      // Backslashes not followed by " are literal.
      escaped += '\\'.repeat(backslashes) + arg[i];
      i++;
    }
  }
  return '"' + escaped + '"';
}

export class StepRunner {
  private activeProcesses = new Map<string, ChildProcess>();
  private window: BrowserWindow;

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  /**
   * Run a NanoClaw setup step as a child process.
   * Streams stdout/stderr to the renderer and parses status blocks.
   */
  async runSetupStep(
    step: string,
    nanoClawPath: string,
    args: string[] = [],
  ): Promise<StatusBlock | null> {
    return new Promise((resolve, reject) => {
      this.emit('step-status', { step, status: 'running' });

      // Guard against stale state pointing at a deleted clone — see the
      // matching comment in runCommand for why this check exists.
      if (!fs.existsSync(nanoClawPath)) {
        const err = new Error(
          `NanoClaw directory does not exist: ${nanoClawPath}. ` +
            `If you deleted the NanoClaw folder between runs, restart wizclaw to reset state.`,
        );
        this.emit('step-status', { step, status: 'failed', error: err.message });
        reject(err);
        return;
      }

      // IMPORTANT: do NOT use shell: true here (on POSIX). With shell: true
      // Node runs `sh -c "cmd arg1 arg2..."` which (a) lets shell
      // metacharacters in args (@, parens, quotes) break parsing, and
      // (b) inherits an open stdin pipe that some children can block on.
      // Passing args directly to execvp avoids both problems, and
      // stdin: 'ignore' guarantees the child can never hang waiting for
      // input. On Windows we still need shell: true so that `npx` resolves
      // to `npx.cmd`.
      const isWin = process.platform === 'win32';
      const child = spawn(
        isWin ? 'npx.cmd' : 'npx',
        ['tsx', 'setup/index.ts', '--step', step, ...args],
        {
          cwd: nanoClawPath,
          env: { ...process.env, FORCE_COLOR: '0' },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: isWin,
        },
      );

      this.activeProcesses.set(step, child);

      let statusBlock: StatusBlock | null = null;
      let stdout = '';

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        this.emit('output', { step, stream: 'stdout', text });

        // Parse status blocks as they arrive
        const parsed = this.parseStatusBlocks(stdout);
        if (parsed.length > 0) {
          statusBlock = parsed[parsed.length - 1];
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        this.emit('output', { step, stream: 'stderr', text: data.toString() });
      });

      child.on('close', (code) => {
        this.activeProcesses.delete(step);
        if (code === 0) {
          this.emit('step-status', {
            step,
            status: 'success',
            data: statusBlock?.fields,
          });
          resolve(statusBlock);
        } else {
          const error = statusBlock?.fields?.ERROR || `Process exited with code ${code}`;
          this.emit('step-status', { step, status: 'failed', error });
          reject(new Error(error));
        }
      });

      child.on('error', (err) => {
        this.activeProcesses.delete(step);
        this.emit('step-status', { step, status: 'failed', error: err.message });
        reject(err);
      });
    });
  }

  /**
   * Run an arbitrary shell command, streaming output.
   */
  async runCommand(
    step: string,
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      this.emit('step-status', { step, status: 'running' });

      // If the caller passed a cwd that doesn't exist, bail with a clear
      // error instead of letting spawn fail deep in libuv. On Windows,
      // spawn with a missing cwd produces the misleading
      //   Error: spawn C:\Windows\system32\cmd.exe ENOENT
      // because Node reports the failure against the shell executable
      // rather than the directory that was missing.
      if (options.cwd && !fs.existsSync(options.cwd)) {
        const err = new Error(
          `Working directory does not exist: ${options.cwd}. ` +
            `If you deleted the NanoClaw folder between runs, restart wizclaw to reset state.`,
        );
        this.emit('step-status', { step, status: 'failed', error: err.message });
        reject(err);
        return;
      }

      // Build a single shell command string with each arg properly quoted.
      // spawn(cmdString, [], { shell: true }) is safer than
      // spawn(cmd, args, { shell: true }) because the latter concatenates
      // command + args with spaces, causing shell metacharacters in args
      // (parens, spaces, quotes) to be interpreted by the shell.
      //
      // resolveCommandForPlatform swaps bare `bash` for git-bash.exe on
      // Windows so scripts don't end up in a WSL distro that can't see
      // the user's Windows-installed tools. It's a no-op elsewhere.
      const resolvedCommand = resolveCommandForPlatform(command);
      const quoted = [shellQuote(resolvedCommand), ...args.map(shellQuote)].join(' ');
      const child = spawn(quoted, [], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, FORCE_COLOR: '0' },
        shell: true,
        // Never leave stdin open — some git subcommands (credential helper,
        // editor prompts) will block on stdin forever if it's a pipe.
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.activeProcesses.set(step, child);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        this.emit('output', { step, stream: 'stdout', text });
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        this.emit('output', { step, stream: 'stderr', text });
      });

      child.on('close', (code) => {
        this.activeProcesses.delete(step);
        const exitCode = code ?? 1;
        if (exitCode === 0) {
          this.emit('step-status', { step, status: 'success' });
        } else {
          this.emit('step-status', {
            step,
            status: 'failed',
            error: `Command exited with code ${exitCode}`,
          });
        }
        resolve({ code: exitCode, stdout, stderr });
      });

      child.on('error', (err) => {
        this.activeProcesses.delete(step);
        this.emit('step-status', { step, status: 'failed', error: err.message });
        reject(err);
      });
    });
  }

  cancel(step: string): void {
    const proc = this.activeProcesses.get(step);
    if (proc) {
      proc.kill('SIGTERM');
      this.activeProcesses.delete(step);
      this.emit('step-status', { step, status: 'failed', error: 'Cancelled by user' });
    }
  }

  cancelAll(): void {
    for (const [step, proc] of this.activeProcesses) {
      proc.kill('SIGTERM');
      this.emit('step-status', { step, status: 'failed', error: 'Cancelled' });
    }
    this.activeProcesses.clear();
  }

  private parseStatusBlocks(text: string): StatusBlock[] {
    const blocks: StatusBlock[] = [];
    const regex = /=== NANOCLAW SETUP: (.+?) ===\n([\s\S]*?)=== END ===/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const stepName = match[1];
      const body = match[2];
      const fields: Record<string, string> = {};

      for (const line of body.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          if (key) fields[key] = value;
        }
      }

      blocks.push({ step: stepName, fields });
    }

    return blocks;
  }

  private emit(channel: string, data: unknown): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(`wizard:${channel}`, data);
    }
  }
}
