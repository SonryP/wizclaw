import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';
import { ProgressBar } from '../components/ProgressBar.js';

const html = htm.bind(h);

/**
 * Turn raw error codes from nanoclaw's container setup into sentences a
 * non-technical user can act on.
 */
function friendlyError(error, runtime) {
  if (error === 'runtime_not_available') {
    const platform = window.wizard.platform;
    if (runtime === 'docker') {
      if (platform === 'linux') {
        // Likely WSL — Docker Desktop WSL integration is the usual culprit
        return (
          'Docker is not accessible. If you are using WSL, open Docker Desktop on ' +
          'Windows → Settings → Resources → WSL Integration and enable it for your ' +
          'distro, then click Retry. Alternatively, run "sudo service docker start" ' +
          'in your WSL terminal and click Retry.'
        );
      }
      if (platform === 'win32') {
        return (
          'Docker Desktop is not running. Open Docker Desktop from the Start menu, ' +
          'wait for it to finish starting, then click Retry.'
        );
      }
      // macOS
      return (
        'Docker Desktop is not running. Open Docker Desktop from your Applications ' +
        'folder, wait for the whale icon to appear in the menu bar, then click Retry.'
      );
    }
    if (runtime === 'apple-container') {
      return (
        'Apple Container is not installed. Install it from the Apple developer portal ' +
        'and try again.'
      );
    }
  }
  // Fallback: show the raw error but still readable
  return error || 'Container build failed. Check the terminal output for details.';
}

export function ContainerSetup({ onNext, onBack, stepStatus, clearTerminal }) {
  const [runtime, setRuntime] = useState('docker');
  const [building, setBuilding] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  const handleBuild = async () => {
    setBuilding(true);
    setError(null);
    clearTerminal();

    try {
      await window.wizard.sendChoice('container', runtime);
      await window.wizard.startStep('container', { runtime });
      setDone(true);
    } catch (err) {
      setError(err.message || 'Container build failed');
    } finally {
      setBuilding(false);
    }
  };

  const isRunning = stepStatus?.status === 'running' || building;
  const isSuccess = stepStatus?.status === 'success' || done;

  return html`
    <div class="screen container-screen">
      <h2 class="screen-title">Container Runtime</h2>
      <p class="screen-desc">
        NanoClaw runs AI agents in secure containers. Choose your container runtime
        and we'll build the agent image.
      </p>

      <div class="option-cards">
        <button
          class="option-card ${runtime === 'docker' ? 'selected' : ''}"
          onClick=${() => setRuntime('docker')}
          disabled=${isRunning}
        >
          <h3>Docker</h3>
          <p>Recommended. Works on all platforms.</p>
        </button>
        ${window.wizard.platform === 'darwin' && html`
          <button
            class="option-card ${runtime === 'apple-container' ? 'selected' : ''}"
            onClick=${() => setRuntime('apple-container')}
            disabled=${isRunning}
          >
            <h3>Apple Container</h3>
            <p>Experimental. Native macOS containers.</p>
          </button>
        `}
      </div>

      <div class="status-area">
        ${!isRunning && !isSuccess && !error && html`
          <button class="btn btn-primary btn-lg" onClick=${handleBuild}>
            Build Container Image
          </button>
        `}

        ${isRunning && html`
          <${ProgressBar} indeterminate label="Building container image... this may take a few minutes" />
        `}

        ${isSuccess && html`
          <div class="success-box">
            <span class="success-icon">${'\u2713'}</span>
            <p>Container image built successfully!</p>
          </div>
        `}

        ${error && html`
          <div class="error-box">
            <p>${friendlyError(error, runtime)}</p>
            <button class="btn btn-sm btn-primary" onClick=${handleBuild}>
              Retry
            </button>
          </div>
        `}
      </div>

      <div class="screen-actions">
        <button class="btn btn-ghost" onClick=${onBack} disabled=${isRunning}>Back</button>
        <button class="btn btn-primary" onClick=${onNext} disabled=${!isSuccess}>
          Continue
        </button>
      </div>
    </div>
  `;
}
