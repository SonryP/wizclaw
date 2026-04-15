import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';
import { ProgressBar } from '../components/ProgressBar.js';

const html = htm.bind(h);

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
            <p>${error}</p>
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
