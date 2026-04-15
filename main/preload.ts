import { contextBridge, ipcRenderer } from 'electron';

export interface ServiceInfo {
  running: boolean;
  pid: number | null;
  uptime: string | null;
  nanoClawPath: string | null;
}

export interface GroupInfo {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  channel: string;
}

export interface WizardAPI {
  // Platform
  platform: string;

  // State
  getState(): Promise<WizardState>;
  resetState(): Promise<void>;

  // Steps
  startStep(step: string, args?: Record<string, string>): Promise<void>;
  retryStep(step: string): Promise<void>;
  cancelStep(step: string): Promise<void>;

  // User input
  sendInput(step: string, field: string, value: string): Promise<void>;
  sendChoice(step: string, choice: string): Promise<void>;

  // Prerequisites
  checkPrereqs(): Promise<PrereqStatus>;
  installPrereq(name: string): Promise<void>;

  // File dialogs
  selectDirectory(): Promise<string | null>;
  selectNanoClawPath(): Promise<string | null>;

  // Dashboard
  getServiceStatus(): Promise<ServiceInfo>;
  startService(): Promise<{ success: boolean }>;
  stopService(): Promise<{ success: boolean }>;
  restartService(): Promise<{ success: boolean }>;
  getGroups(): Promise<GroupInfo[]>;
  removeGroup(jid: string): Promise<{ success: boolean }>;
  getRecentLogs(lines?: number): Promise<string>;
  getInstalledChannels(): Promise<string[]>;
  removeChannel(channel: string): Promise<{ success: boolean }>;
  openFolder(folderPath: string): Promise<void>;
  openUrl(url: string): Promise<void>;

  // Listeners
  onStepStatus(callback: (data: StepStatusEvent) => void): () => void;
  onOutput(callback: (data: OutputEvent) => void): () => void;
  onQrCode(callback: (data: { data: string }) => void): () => void;
  onPrereqStatus(callback: (data: PrereqStatus) => void): () => void;
  onStateUpdate(callback: (data: WizardState) => void): () => void;
}

export interface WizardState {
  currentStep: number;
  completedSteps: Record<string, Record<string, string>>;
  nanoClawPath: string | null;
  selectedChannels: string[];
  timestamp: string;
}

export interface StepStatusEvent {
  step: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'needs_input';
  data?: Record<string, string>;
  error?: string;
}

export interface OutputEvent {
  step: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface PrereqStatus {
  node: { installed: boolean; version?: string };
  docker: { installed: boolean; running?: boolean; version?: string };
  git: { installed: boolean; version?: string };
  claude: { installed: boolean; version?: string };
}

function createListener(channel: string) {
  return (callback: (...args: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

const api: WizardAPI = {
  platform: process.platform as string,

  getState: () => ipcRenderer.invoke('wizard:get-state'),
  resetState: () => ipcRenderer.invoke('wizard:reset-state'),

  startStep: (step, args) => ipcRenderer.invoke('wizard:start-step', step, args),
  retryStep: (step) => ipcRenderer.invoke('wizard:retry-step', step),
  cancelStep: (step) => ipcRenderer.invoke('wizard:cancel-step', step),

  sendInput: (step, field, value) =>
    ipcRenderer.invoke('wizard:user-input', step, field, value),
  sendChoice: (step, choice) =>
    ipcRenderer.invoke('wizard:user-choice', step, choice),

  checkPrereqs: () => ipcRenderer.invoke('wizard:check-prereqs'),
  installPrereq: (name) => ipcRenderer.invoke('wizard:install-prereq', name),

  selectDirectory: () => ipcRenderer.invoke('wizard:select-directory'),
  selectNanoClawPath: () => ipcRenderer.invoke('wizard:select-nanoclaw-path'),

  // Dashboard
  getServiceStatus: () => ipcRenderer.invoke('wizard:service-status'),
  startService: () => ipcRenderer.invoke('wizard:start-service'),
  stopService: () => ipcRenderer.invoke('wizard:stop-service'),
  restartService: () => ipcRenderer.invoke('wizard:restart-service'),
  getGroups: () => ipcRenderer.invoke('wizard:get-groups'),
  removeGroup: (jid) => ipcRenderer.invoke('wizard:remove-group', jid),
  getRecentLogs: (lines) => ipcRenderer.invoke('wizard:get-logs', lines),
  getInstalledChannels: () => ipcRenderer.invoke('wizard:get-channels'),
  removeChannel: (channel) => ipcRenderer.invoke('wizard:remove-channel', channel),
  openFolder: (folderPath) => ipcRenderer.invoke('wizard:open-folder', folderPath),
  openUrl: (url) => ipcRenderer.invoke('wizard:open-url', url),

  onStepStatus: createListener('wizard:step-status') as WizardAPI['onStepStatus'],
  onOutput: createListener('wizard:output') as WizardAPI['onOutput'],
  onQrCode: createListener('wizard:qr-code') as WizardAPI['onQrCode'],
  onPrereqStatus: createListener('wizard:prereq-status') as WizardAPI['onPrereqStatus'],
  onStateUpdate: createListener('wizard:state-update') as WizardAPI['onStateUpdate'],
};

contextBridge.exposeInMainWorld('wizard', api);
