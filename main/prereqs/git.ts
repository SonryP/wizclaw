import { execSync, spawn } from 'child_process';

export async function checkGit(): Promise<{
  installed: boolean;
  version?: string;
}> {
  try {
    const version = execSync('git --version', { encoding: 'utf-8' }).trim();
    return { installed: true, version };
  } catch {
    return { installed: false };
  }
}

export async function installGit(
  onOutput: (text: string) => void,
): Promise<boolean> {
  if (process.platform === 'darwin') {
    onOutput('Installing Xcode Command Line Tools (includes git)...\n');
    onOutput('A system dialog may appear — please click "Install" when prompted.\n');

    return new Promise((resolve) => {
      const child = spawn('xcode-select', ['--install'], { shell: true });

      child.stdout?.on('data', (data: Buffer) => onOutput(data.toString()));
      child.stderr?.on('data', (data: Buffer) => onOutput(data.toString()));

      child.on('close', (code) => {
        if (code === 0) {
          onOutput('Xcode Command Line Tools installation started.\n');
          onOutput('Waiting for installation to complete...\n');
          waitForXcodeInstall(onOutput).then(resolve);
        } else {
          // code 1 can mean already installed
          try {
            execSync('xcode-select -p', { encoding: 'utf-8' });
            onOutput('Xcode Command Line Tools already installed.\n');
            resolve(true);
          } catch {
            onOutput('Failed to install Xcode Command Line Tools.\n');
            resolve(false);
          }
        }
      });
    });
  }

  onOutput('Please install git manually for your platform.\n');
  return false;
}

async function waitForXcodeInstall(
  onOutput: (text: string) => void,
): Promise<boolean> {
  // Poll for up to 10 minutes (xcode-select can take a while)
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      execSync('xcode-select -p', { encoding: 'utf-8', stdio: 'pipe' });
      onOutput('\nXcode Command Line Tools installed successfully!\n');
      return true;
    } catch {
      if (i % 6 === 0) onOutput('Still installing...\n');
    }
  }
  onOutput('\nInstallation timed out. Please complete manually.\n');
  return false;
}
