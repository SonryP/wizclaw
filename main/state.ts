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
      }
    } catch {
      this.state = defaultState();
    }
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
