import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';
import { ProgressBar } from '../components/ProgressBar.js';

const html = htm.bind(h);

export function GetNanoClaw({ onNext, onBack, wizardState, stepStatus, clearTerminal }) {
  const [mode, setMode] = useState('clone'); // 'clone' | 'existing'
  const [clonePath, setClonePath] = useState(
    wizardState?.nanoClawPath || '',
  );
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState(null);

  const handleBrowse = async () => {
    const path = await window.wizard.selectNanoClawPath();
    if (path) setClonePath(path);
  };

  const handleClone = async () => {
    if (!clonePath) return;
    setCloning(true);
    setError(null);
    clearTerminal();

    try {
      await window.wizard.sendInput('clone', 'path', clonePath);
      await window.wizard.startStep('clone', { path: clonePath });
      onNext();
    } catch (err) {
      setError(err.message || 'Clone failed');
    } finally {
      setCloning(false);
    }
  };

  const handleExisting = async () => {
    if (!clonePath) return;
    setError(null);
    await window.wizard.sendInput('clone', 'path', clonePath);
    onNext();
  };

  const isRunning = stepStatus?.status === 'running';

  return html`
    <div class="screen get-nanoclaw-screen">
      <h2 class="screen-title">Get NanoClaw</h2>
      <p class="screen-desc">
        Choose how to set up NanoClaw on your computer.
      </p>

      <div class="option-cards">
        <button
          class="option-card ${mode === 'clone' ? 'selected' : ''}"
          onClick=${() => setMode('clone')}
        >
          <h3>Download Fresh Copy</h3>
          <p>Clone NanoClaw from GitHub to a folder on your computer</p>
        </button>
        <button
          class="option-card ${mode === 'existing' ? 'selected' : ''}"
          onClick=${() => setMode('existing')}
        >
          <h3>Use Existing Installation</h3>
          <p>Point to a NanoClaw folder you've already downloaded</p>
        </button>
      </div>

      <div class="form-group">
        <label class="form-label">
          ${mode === 'clone' ? 'Where to install:' : 'NanoClaw folder:'}
        </label>
        <div class="input-with-button">
          <input
            type="text"
            class="form-input"
            value=${clonePath}
            onInput=${(e) => setClonePath(e.target.value)}
            placeholder=${mode === 'clone'
              ? '/Users/you/nanoclaw'
              : '/path/to/existing/nanoclaw'}
          />
          <button class="btn btn-secondary" onClick=${handleBrowse}>
            Browse
          </button>
        </div>
      </div>

      ${isRunning && html`
        <${ProgressBar} indeterminate label="Cloning repository..." />
      `}

      ${error && html`
        <div class="error-box">
          <p>${error}</p>
          <button class="btn btn-sm btn-ghost" onClick=${() => setError(null)}>Dismiss</button>
        </div>
      `}

      <div class="screen-actions">
        <button class="btn btn-ghost" onClick=${onBack}>Back</button>
        <button
          class="btn btn-primary"
          onClick=${mode === 'clone' ? handleClone : handleExisting}
          disabled=${!clonePath || cloning || isRunning}
        >
          ${cloning ? 'Downloading...' : mode === 'clone' ? 'Download & Continue' : 'Continue'}
        </button>
      </div>
    </div>
  `;
}
