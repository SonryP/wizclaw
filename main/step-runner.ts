import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow } from 'electron';

interface StatusBlock {
  step: string;
  fields: Record<string, string>;
}

/**
 * Shell-escape a string for use as a POSIX sh argument.
 * When spawn is called with shell: true, Node concatenates the command and
 * args with spaces and passes them to /bin/sh -c. Any shell metacharacters
 * (parens, spaces, quotes, etc.) in args will be interpreted by the shell
 * unless properly quoted. This wraps the arg in single quotes and escapes
 * any embedded single quotes.
 */
function shellQuote(arg: string): string {
  if (arg === '') return "''";
  // If it's already safe (alphanumerics, dash, underscore, slash, dot), leave it
  if (/^[A-Za-z0-9_\-\/.=:@+]+$/.test(arg)) return arg;
  // Wrap in single quotes, escape any embedded single quotes
  return "'" + arg.replace(/'/g, "'\\''") + "'";
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

      const child = spawn(
        'npx',
        ['tsx', 'setup/index.ts', '--step', step, ...args],
        {
          cwd: nanoClawPath,
          env: { ...process.env, FORCE_COLOR: '0' },
          shell: true,
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

      // Build a single shell command string with each arg properly quoted.
      // spawn(cmdString, [], { shell: true }) is safer than
      // spawn(cmd, args, { shell: true }) because the latter concatenates
      // command + args with spaces, causing shell metacharacters in args
      // (parens, spaces, quotes) to be interpreted by the shell.
      const quoted = [command, ...args.map(shellQuote)].join(' ');
      const child = spawn(quoted, [], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, FORCE_COLOR: '0' },
        shell: true,
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
