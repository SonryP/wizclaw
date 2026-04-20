import { execSync, spawn } from 'child_process';
import fs from 'fs';

/** True when running inside Windows Subsystem for Linux. */
function isWSL(): boolean {
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8');
    return /microsoft|wsl/i.test(release);
  } catch {
    return false;
  }
}

export async function checkDocker(): Promise<{
  installed: boolean;
  running?: boolean;
  version?: string;
  hint?: string;
}> {
  try {
    const version = execSync('docker --version', { encoding: 'utf-8' }).trim();

    // Check if Docker daemon is accessible — capture stderr so we can give
    // a specific hint instead of a generic "not running" message.
    try {
      execSync('docker info', { encoding: 'utf-8', stdio: 'pipe' });
      return { installed: true, running: true, version };
    } catch (err: unknown) {
      const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString() ?? '';
      const hint = dockerDaemonHint(stderr);
      return { installed: true, running: false, version, hint };
    }
  } catch {
    // Binary not found at all
    if (isWSL()) {
      return {
        installed: false,
        hint:
          'Docker not found in WSL. Enable Docker Desktop WSL integration ' +
          '(Docker Desktop → Settings → Resources → WSL Integration → enable for this distro) ' +
          'and restart this wizard, or install Docker Engine: sudo apt-get install docker.io',
      };
    }
    return { installed: false };
  }
}

/**
 * Inspect `docker info` stderr and return an actionable hint.
 * Falls back to a generic message when the error text isn't recognised.
 */
function dockerDaemonHint(stderr: string): string {
  const lower = stderr.toLowerCase();

  // "permission denied while trying to connect to the Docker daemon socket"
  if (lower.includes('permission denied') && lower.includes('docker.sock')) {
    return (
      'Permission denied connecting to the Docker socket. ' +
      'Your user is not in the "docker" group. Fix it by running these two commands ' +
      'in your WSL terminal, then close and reopen WSL:\n' +
      '  sudo usermod -aG docker $USER\n' +
      '  newgrp docker'
    );
  }

  // "cannot connect to the docker daemon" / "is the docker daemon running?"
  if (lower.includes('cannot connect') || lower.includes('is the docker daemon running')) {
    if (isWSL()) {
      return (
        'Cannot reach the Docker daemon. Make sure Docker Desktop is running on Windows ' +
        'and WSL integration is enabled for this distro ' +
        '(Docker Desktop → Settings → Resources → WSL Integration).'
      );
    }
    return 'Docker daemon is not running. Start Docker Desktop and try again.';
  }

  // Socket file missing
  if (lower.includes('no such file') && lower.includes('docker.sock')) {
    if (isWSL()) {
      return (
        'Docker socket not found. Restart Docker Desktop on Windows, wait for it to ' +
        'finish starting, then click Re-check.'
      );
    }
    return 'Docker socket not found. Restart Docker Desktop and try again.';
  }

  // Generic fallback — include the raw error so the user can Google it
  if (isWSL()) {
    return (
      'Docker daemon is not accessible in WSL. ' +
      (stderr ? `Error: ${stderr.trim()}` : '') +
      '\nTry: sudo usermod -aG docker $USER && newgrp docker'
    );
  }
  return 'Docker is installed but the daemon is not responding. ' +
    (stderr ? `Error: ${stderr.trim()}` : 'Start Docker Desktop and try again.');
}

export async function installDocker(
  onOutput: (text: string) => void,
): Promise<boolean> {
  const platform = process.platform;

  if (platform === 'darwin') {
    return installDockerMac(onOutput);
  } else if (platform === 'win32') {
    onOutput('Windows Docker installation not yet implemented.\n');
    onOutput('Please install Docker Desktop from https://docker.com/products/docker-desktop\n');
    return false;
  } else {
    onOutput('Linux Docker installation not yet implemented.\n');
    onOutput('Please install Docker using your distribution package manager.\n');
    return false;
  }
}

async function installDockerMac(onOutput: (text: string) => void): Promise<boolean> {
  try {
    execSync('which brew', { encoding: 'utf-8' });
    onOutput('Installing Docker Desktop via Homebrew...\n');
    return runCommand('brew', ['install', '--cask', 'docker'], onOutput);
  } catch {
    onOutput('Homebrew not found.\n');
    onOutput('Please install Docker Desktop from https://docker.com/products/docker-desktop\n');
    return false;
  }
}

export async function startDocker(
  onOutput: (text: string) => void,
): Promise<boolean> {
  if (process.platform === 'darwin') {
    onOutput('Starting Docker Desktop...\n');
    try {
      execSync('open -a Docker', { encoding: 'utf-8' });
      onOutput('Docker Desktop is starting. This may take a moment...\n');

      // Wait for Docker daemon to become available (up to 60 seconds)
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          execSync('docker info', { encoding: 'utf-8', stdio: 'pipe' });
          onOutput('Docker is ready!\n');
          return true;
        } catch {
          onOutput('.');
        }
      }
      onOutput('\nDocker did not start in time. Please start it manually.\n');
      return false;
    } catch (err) {
      onOutput(`Failed to start Docker: ${err}\n`);
      return false;
    }
  }

  if (process.platform === 'linux') {
    return startDockerLinux(onOutput);
  }

  onOutput('Please start Docker manually.\n');
  return false;
}

async function startDockerLinux(onOutput: (text: string) => void): Promise<boolean> {
  const wsl = isWSL();

  if (wsl) {
    onOutput(
      'Running inside WSL. Docker Desktop on Windows must be running and ' +
      'have WSL integration enabled for this distro.\n' +
      '  → Open Docker Desktop → Settings → Resources → WSL Integration\n' +
      '  → Enable the toggle for your Ubuntu/distro, then click Apply & Restart.\n\n' +
      'If you prefer Docker Engine inside WSL instead, install it with:\n' +
      '  sudo apt-get update && sudo apt-get install -y docker.io\n' +
      '  sudo service docker start\n\n' +
      'Attempting to start Docker service...\n',
    );
  } else {
    onOutput('Attempting to start Docker service...\n');
  }

  // Try `sudo service docker start` (works on Ubuntu/Debian without systemd, e.g. WSL default)
  try {
    execSync('sudo service docker start', { stdio: 'pipe' });
    onOutput('Docker service started via service manager.\n');
  } catch {
    // Try systemctl (distros with systemd)
    try {
      execSync('sudo systemctl start docker', { stdio: 'pipe' });
      onOutput('Docker service started via systemctl.\n');
    } catch {
      if (wsl) {
        onOutput(
          'Could not start Docker automatically.\n' +
          'Please enable Docker Desktop WSL integration (see instructions above) ' +
          'and click Retry.\n',
        );
      } else {
        onOutput('Could not start Docker automatically. Please start it manually.\n');
      }
      return false;
    }
  }

  // Poll until daemon is ready (up to 30 s)
  onOutput('Waiting for Docker daemon...\n');
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      execSync('docker info', { encoding: 'utf-8', stdio: 'pipe' });
      onOutput('Docker is ready!\n');
      return true;
    } catch {
      onOutput('.');
    }
  }

  onOutput('\nDocker did not become ready in time. Please try again.\n');
  return false;
}

function runCommand(
  cmd: string,
  args: string[],
  onOutput: (text: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: true });
    child.stdout?.on('data', (data: Buffer) => onOutput(data.toString()));
    child.stderr?.on('data', (data: Buffer) => onOutput(data.toString()));
    child.on('close', (code) => resolve(code === 0));
    child.on('error', (err) => {
      onOutput(`Error: ${err.message}\n`);
      resolve(false);
    });
  });
}
