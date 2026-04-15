import { execSync, spawn } from 'child_process';

export async function checkDocker(): Promise<{
  installed: boolean;
  running?: boolean;
  version?: string;
}> {
  try {
    const version = execSync('docker --version', { encoding: 'utf-8' }).trim();
    // Check if Docker daemon is running
    try {
      execSync('docker info', { encoding: 'utf-8', stdio: 'pipe' });
      return { installed: true, running: true, version };
    } catch {
      return { installed: true, running: false, version };
    }
  } catch {
    return { installed: false };
  }
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

  onOutput('Please start Docker manually.\n');
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
