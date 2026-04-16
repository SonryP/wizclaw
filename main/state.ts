import fs from 'fs';
import path from 'path';
import os from 'os';

export interface WizardState {
  currentStep: number;
  completedSteps: Record<string, Record<string, string>>;
  nanoClawPath: string | null;
  selectedChannels: string[];
  timestamp: string;
}

const STATE_DIR = path.join(os.homedir(), '.nanoclaw-wizard');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

function defaultState(): WizardState {
  return {
    currentStep: 0,
    completedSteps: {},
    nanoClawPath: null,
    selectedChannels: [],
    timestamp: new Date().toISOString(),
  };
}

export class StateManager {
  private state: WizardState = defaultState();

  async load(): Promise<void> {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        this.state = { ...defaultState(), ...JSON.parse(raw) };
        this.reconcileWithFilesystem();
      }
    } catch {
      this.state = defaultState();
    }
  }

  /**
   * Invalidate any persisted state that no longer matches reality.
   *
   * Specifically: if `nanoClawPath` points to a directory the user has
   * deleted (or to a folder that's no longer a git repo), drop it along
   * with any `completedSteps` entries that depended on it. Otherwise the
   * wizard will happily skip the clone step on the next run and then try
   * to `cwd` into the missing directory during bootstrap — which surfaces
   * on Windows as the confusing `spawn cmd.exe ENOENT` error (Node blames
   * the shell executable instead of the missing cwd).
   *
   * No-op when the state is consistent, so it's safe to call on every load.
   */
  private reconcileWithFilesystem(): void {
    const p = this.state.nanoClawPath;
    if (!p) return;
    const dirExists = fs.existsSync(p);
    const isRepo = dirExists && fs.existsSync(path.join(p, '.git'));
    if (isRepo) return;

    // Stale — the cloned repo is gone. Clear the path and every step that
    // was completed against it. Prereq-check results live outside
    // completedSteps, so the user doesn't lose their Node/Docker/Git/Claude
    // install progress from this reset.
    this.state.nanoClawPath = null;
    this.state.completedSteps = {};
    this.state.currentStep = 0;
    this.state.timestamp = new Date().toISOString();
    this.save();
  }

  get(): WizardState {
    return { ...this.state };
  }

  update(partial: Partial<WizardState>): void {
    this.state = { ...this.state, ...partial, timestamp: new Date().toISOString() };
    this.save();
  }

  markStepComplete(step: string, data: Record<string, string> = {}): void {
    this.state.completedSteps[step] = data;
    this.state.timestamp = new Date().toISOString();
    this.save();
  }

  reset(): void {
    this.state = defaultState();
    this.save();
  }

  private save(): void {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error('Failed to save wizard state:', err);
    }
  }
}
