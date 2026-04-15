import { execSync, spawn } from 'child_process';

const MIN_NODE_VERSION = 20;

export async function checkNode(): Promise<{
  installed: boolean;
  version?: string;
}> {
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    const major = parseInt(version.replace('v', '').split('.')[0], 10);
    return { installed: major >= MIN_NODE_VERSION, version };
  } catch {
    return { installed: false };
  }
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
