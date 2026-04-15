import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';
import { ProgressBar } from '../components/ProgressBar.js';

const html = htm.bind(h);

export function StartService({ onNext, onBack, stepStatus, clearTerminal }) {
  const [starting, setStarting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    clearTerminal();

    try {
      await window.wizard.startStep('service');
      setDone(true);
    } catch (err) {
      setError(err.message || 'Failed to start service');
    } finally {
      setStarting(false);
    }
  };

  const isRunning = stepStatus?.status === 'running' || starting;
  const isSuccess = stepStatus?.status === 'success' || done;

  return html`
    <div class="screen start-service-screen">
      <h2 class="screen-title">Launch NanoClaw</h2>
      <p class="screen-desc">
        NanoClaw will run as a background service on your computer.
        It starts automatically when you log in and restarts if it crashes.
      </p>

      <div class="service-info">
        <div class="info-item">
          <span class="info-label">Service type:</span>
          <span class="info-value">
            ${window.wizard.platform === 'darwin' ? 'macOS Launch Agent' : 'Systemd Service'}
          </span>
        </div>
        <div class="info-item">
          <span class="info-label">Auto-start:</span>
          <span class="info-value">Yes, on login</span>
        </div>
        <div class="info-item">
          <span class="info-label">Auto-restart:</span>
          <span class="info-value">Yes, on crash</span>
        </div>
      </div>

      <div class="status-area">
        ${!isRunning && !isSuccess && !error && html`
          <button class="btn btn-primary btn-lg" onClick=${handleStart}>
            Install & Start Service
          </button>
        `}

        ${isRunning && html`
          <${ProgressBar} indeterminate label="Installing and starting NanoClaw service..." />
        `}

        ${isSuccess && html`
          <div class="success-box">
            <span class="success-icon">${'\u2713'}</span>
            <div>
              <p>NanoClaw is running!</p>
              <p class="success-detail">The service has been installed and started.</p>
            </div>
          </div>
        `}

        ${error && html`
          <div class="error-box">
            <p>${error}</p>
            <button class="btn btn-sm btn-primary" onClick=${handleStart}>
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
