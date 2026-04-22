import { checkNode, installNode } from './node.js';
import { checkDocker, installDocker, startDocker } from './docker.js';
import { checkGit, installGit } from './git.js';
import { checkClaude, installClaude } from './claude.js';
import { checkOllama, installOllama } from './ollama.js';

export interface PrereqStatus {
  node: { installed: boolean; version?: string };
  docker: { installed: boolean; running?: boolean; version?: string; hint?: string };
  git: { installed: boolean; version?: string };
  claude: { installed: boolean; version?: string };
  ollama: { installed: boolean; running?: boolean; version?: string };
}

export async function checkAllPrereqs(): Promise<PrereqStatus> {
  const [node, docker, git, claude, ollama] = await Promise.all([
    checkNode(),
    checkDocker(),
    checkGit(),
    checkClaude(),
    checkOllama(),
  ]);
  return { node, docker, git, claude, ollama };
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
    case 'ollama':
      return installOllama(onOutput);
    default:
      onOutput(`Unknown prerequisite: ${name}\n`);
      return false;
  }
}
