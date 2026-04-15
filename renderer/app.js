import { h, render } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import htm from 'htm';
import { Stepper } from './components/Stepper.js';
import { Terminal } from './components/Terminal.js';
import { Welcome } from './screens/Welcome.js';
import { Prerequisites } from './screens/Prerequisites.js';
import { GetNanoClaw } from './screens/GetNanoClaw.js';
import { Dependencies } from './screens/Dependencies.js';
import { ContainerSetup } from './screens/ContainerSetup.js';
import { Credentials } from './screens/Credentials.js';
import { ChannelSelect } from './screens/ChannelSelect.js';
import { ChannelAuth } from './screens/ChannelAuth.js';
import { ChatPicker } from './screens/ChatPicker.js';
import { Security } from './screens/Security.js';
import { StartService } from './screens/StartService.js';
import { Dashboard } from './screens/Dashboard.js';
// Done screen replaced by Dashboard

const html = htm.bind(h);

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'prerequisites', label: 'Prerequisites' },
  { id: 'get-nanoclaw', label: 'Get NanoClaw' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'container', label: 'Container' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'channels', label: 'Channels' },
  { id: 'channel-auth', label: 'Channel Setup' },
  { id: 'chat-picker', label: 'Pick Chat' },
  { id: 'security', label: 'Security' },
  { id: 'service', label: 'Start Service' },
  { id: 'dashboard', label: 'Dashboard' },
];

const SCREEN_COMPONENTS = {
  'welcome': Welcome,
  'prerequisites': Prerequisites,
  'get-nanoclaw': GetNanoClaw,
  'dependencies': Dependencies,
  'container': ContainerSetup,
  'credentials': Credentials,
  'channels': ChannelSelect,
  'channel-auth': ChannelAuth,
  'chat-picker': ChatPicker,
  'security': Security,
  'service': StartService,
  'dashboard': Dashboard,
};

function App() {
  const [currentStep, setCurrentStep] = useState(0);
  const [wizardState, setWizardState] = useState(null);
  const [terminalLines, setTerminalLines] = useState([]);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [stepStatuses, setStepStatuses] = useState({});
  const [prereqStatus, setPrereqStatus] = useState(null);
  const [showResume, setShowResume] = useState(false);
  const [savedStep, setSavedStep] = useState(0);

  // Load saved state on mount
  useEffect(() => {
    window.wizard.getState().then((state) => {
      setWizardState(state);
      if (state.currentStep > 0) {
        setSavedStep(state.currentStep);
        setShowResume(true);
      }
    });
  }, []);

  // Listen for IPC events
  useEffect(() => {
    const cleanups = [
      window.wizard.onStepStatus((data) => {
        setStepStatuses((prev) => ({ ...prev, [data.step]: data }));
        // Auto-show terminal when a step starts running
        if (data.status === 'running') {
          setTerminalVisible(true);
        }
      }),
      window.wizard.onOutput((data) => {
        setTerminalLines((prev) => {
          const lines = [...prev, { stream: data.stream, text: data.text }];
          // Keep last 500 lines
          return lines.length > 500 ? lines.slice(-500) : lines;
        });
        // Auto-show terminal when output arrives
        setTerminalVisible(true);
      }),
      window.wizard.onPrereqStatus((data) => {
        setPrereqStatus(data);
      }),
      window.wizard.onStateUpdate((data) => {
        setWizardState(data);
      }),
    ];

    return () => cleanups.forEach((fn) => fn());
  }, []);

  const navigateTo = useCallback((step) => {
    setCurrentStep(step);
    setTerminalLines([]);
    window.wizard.sendInput('navigation', 'currentStep', String(step));
  }, []);

  const goNext = useCallback(() => {
    navigateTo(Math.min(currentStep + 1, STEPS.length - 1));
  }, [currentStep, navigateTo]);

  const goBack = useCallback(() => {
    navigateTo(Math.max(currentStep - 1, 0));
  }, [currentStep, navigateTo]);

  const clearTerminal = useCallback(() => {
    setTerminalLines([]);
  }, []);

  const stepId = STEPS[currentStep].id;
  const ScreenComponent = SCREEN_COMPONENTS[stepId];
  const isRunning = stepStatuses[stepId]?.status === 'running';

  // Resume dialog
  const handleResume = useCallback(() => {
    setCurrentStep(savedStep);
    setShowResume(false);
  }, [savedStep]);

  const handleStartOver = useCallback(() => {
    setCurrentStep(0);
    setShowResume(false);
    window.wizard.resetState();
  }, []);

  return html`
    <div class="wizard-app">
      <div class="wizard-titlebar" />

      ${showResume && html`
        <div class="resume-overlay">
          <div class="resume-dialog">
            <h2>Welcome Back!</h2>
            <p>You were on step ${savedStep + 1} of ${STEPS.length}: <strong>${STEPS[savedStep]?.label}</strong></p>
            <div class="resume-actions">
              <button class="btn btn-primary" onClick=${handleResume}>
                Resume Where I Left Off
              </button>
              <button class="btn btn-ghost" onClick=${handleStartOver}>
                Start Over
              </button>
            </div>
          </div>
        </div>
      `}

      ${stepId !== 'dashboard' && html`
        <${Stepper}
          steps=${STEPS}
          currentStep=${currentStep}
          stepStatuses=${stepStatuses}
        />
      `}
      <div class="wizard-content ${stepId === 'dashboard' ? 'dashboard-mode' : ''}">
        <${ScreenComponent}
          wizardState=${wizardState}
          stepStatus=${stepStatuses[stepId]}
          prereqStatus=${prereqStatus}
          onNext=${goNext}
          onBack=${goBack}
          clearTerminal=${clearTerminal}
        />
      </div>
      <div class="wizard-footer">
        <button
          class="terminal-toggle"
          onClick=${() => setTerminalVisible(!terminalVisible)}
        >
          ${terminalVisible ? 'Hide' : 'Show'} terminal output
          <span class="terminal-toggle-icon">${terminalVisible ? '▼' : '▲'}</span>
        </button>
        ${terminalVisible && html`
          <${Terminal} lines=${terminalLines} />
        `}
      </div>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
