import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

export function PrereqCard({ name, label, description, status, onInstall }) {
  const [installing, setInstalling] = useState(false);

  const handleInstall = async () => {
    setInstalling(true);
    await onInstall(name);
    setInstalling(false);
  };

  const isInstalled = status?.installed;
  const isRunning = name === 'docker' ? status?.running : true;
  const version = status?.version;

  let statusIcon = '';
  let statusClass = '';
  let statusText = '';

  if (!status) {
    statusIcon = '...';
    statusClass = 'checking';
    statusText = 'Checking...';
  } else if (isInstalled && isRunning) {
    statusIcon = '\u2713';
    statusClass = 'ok';
    statusText = version || 'Installed';
  } else if (isInstalled && !isRunning) {
    statusIcon = '!';
    statusClass = 'warning';
    statusText = 'Installed but not running';
  } else {
    statusIcon = '\u2717';
    statusClass = 'missing';
    statusText = 'Not installed';
  }

  return html`
    <div class="prereq-card ${statusClass}">
      <div class="prereq-icon-area">
        <span class="prereq-status-icon ${statusClass}">${statusIcon}</span>
      </div>
      <div class="prereq-info">
        <h3 class="prereq-name">${label}</h3>
        <p class="prereq-desc">${description}</p>
        <p class="prereq-version">${statusText}</p>
      </div>
      <div class="prereq-action">
        ${!isInstalled && html`
          <button
            class="btn btn-sm btn-primary"
            onClick=${handleInstall}
            disabled=${installing}
          >
            ${installing ? 'Installing...' : 'Install'}
          </button>
        `}
        ${isInstalled && !isRunning && html`
          <button
            class="btn btn-sm btn-secondary"
            onClick=${() => onInstall('docker-start')}
            disabled=${installing}
          >
            ${installing ? 'Starting...' : 'Start'}
          </button>
        `}
      </div>
    </div>
  `;
}
