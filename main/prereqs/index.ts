import { checkNode, installNode } from './node.js';
import { checkDocker, installDocker, startDocker } from './docker.js';
import { checkGit, installGit } from './git.js';
import { checkClaude, installClaude } from './claude.js';

export interface PrereqStatus {
  node: { installed: boolean; version?: string };
  docker: { installed: boolean; running?: boolean; version?: string };
  git: { installed: boolean; version?: string };
  claude: { installed: boolean; version?: string };
}

export async function checkAllPrereqs(): Promise<PrereqStatus> {
  const [node, docker, git, claude] = await Promise.all([
    checkNode(),
    checkDocker(),
    checkGit(),
    checkClaude(),
  ]);
  return { node, docker, git, claude };
}

export async function installPrereq(
  name: string,
  onOutput: (text: string) => void,
): Promise<boolean> {
  switch (name) {
    case 'node':
      return installNode(onOutput);
    case 'docker':
      return installDocker(onOutput);
    case 'docker-start':
      return startDocker(onOutput);
    case 'git':
      return installGit(onOutput);
    case 'claude':
      return installClaude(onOutput);
    default:
      onOutput(`Unknown prerequisite: ${name}\n`);
      return false;
  }
}
