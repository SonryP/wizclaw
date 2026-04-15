import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';
import { ProgressBar } from '../components/ProgressBar.js';

const html = htm.bind(h);

export function Dependencies({ onNext, onBack, stepStatus, clearTerminal }) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  const isRunning = running;
  const isSuccess = done;

  const handleInstall = async () => {
    setRunning(true);
    setDone(false);
    setError(null);
    clearTerminal();

    try {
      await window.wizard.startStep('bootstrap');
      setDone(true);
    } catch (err) {
      setError(err.message || 'Installation failed');
    } finally {
      setRunning(false);
    }
  };

  return html`
    <div class="screen dependencies-screen">
      <h2 class="screen-title">Install Dependencies</h2>
      <p class="screen-desc">
        NanoClaw needs to install its Node.js packages. This may take a minute.
      </p>

      <div class="status-area">
        ${!isRunning && !isSuccess && !error && html`
          <div class="ready-prompt">
            <p>Ready to install dependencies.</p>
            <button class="btn btn-primary btn-lg" onClick=${handleInstall}>
              Install Dependencies
            </button>
          </div>
        `}

        ${isRunning && html`
          <${ProgressBar} indeterminate label="Installing packages..." />
        `}

        ${isSuccess && html`
          <div class="success-box">
            <span class="success-icon">${'\u2713'}</span>
            <p>All dependencies installed successfully!</p>
          </div>
        `}

        ${error && !isRunning && html`
          <div class="error-box">
            <p>${error}</p>
            <button class="btn btn-sm btn-primary" onClick=${handleInstall}>
              Retry
            </button>
          </div>
        `}
      </div>

      <div class="screen-actions">
        <button class="btn btn-ghost" onClick=${onBack} disabled=${isRunning}>Back</button>
        <button
          class="btn btn-primary"
          onClick=${onNext}
          disabled=${!isSuccess}
        >
          Continue
        </button>
      </div>
    </div>
  `;
}
