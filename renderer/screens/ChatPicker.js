import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';
import { ProgressBar } from '../components/ProgressBar.js';

const html = htm.bind(h);

export function ChatPicker({ onNext, onBack, wizardState, stepStatus, clearTerminal }) {
  const [triggerWord, setTriggerWord] = useState('@Andy');
  const [assistantName, setAssistantName] = useState('Andy');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  const channels = wizardState?.selectedChannels || [];
  const primaryChannel = channels[0] || 'whatsapp';
  const channelLabel = primaryChannel[0].toUpperCase() + primaryChannel.slice(1);

  const handleNameChange = (name) => {
    setAssistantName(name);
    if (name.trim()) {
      setTriggerWord(`@${name.trim()}`);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    clearTerminal();

    try {
      await window.wizard.startStep('register', {
        'trigger-pattern': triggerWord,
        'assistant-name': assistantName,
      });
      setDone(true);
    } catch (err) {
      setError(err.message || 'Failed to register chat');
    } finally {
      setSaving(false);
    }
  };

  const isSuccess = done;

  return html`
    <div class="screen chat-picker-screen">
      <h2 class="screen-title">Name Your Assistant</h2>
      <p class="screen-desc">
        Choose a name for your AI assistant and how to call it in your chats.
      </p>

      <div class="form-group">
        <label class="form-label">Assistant Name</label>
        <input
          type="text"
          class="form-input"
          value=${assistantName}
          onInput=${(e) => handleNameChange(e.target.value)}
          placeholder="Andy"
          disabled=${saving || isSuccess}
        />
        <p class="form-hint">This is what your assistant will be called</p>
      </div>

      <div class="form-group">
        <label class="form-label">Trigger Word</label>
        <input
          type="text"
          class="form-input"
          value=${triggerWord}
          onInput=${(e) => setTriggerWord(e.target.value)}
          placeholder="@Andy"
          disabled=${saving || isSuccess}
        />
        <p class="form-hint">
          Messages starting with "${triggerWord}" will activate the assistant
        </p>
      </div>

      <div class="instruction-box" style="margin-top: 16px;">
        <p style="margin: 0; font-size: 13px;">
          Your assistant will be set up on <strong>${channelLabel}</strong>.
          Once NanoClaw is running, just send a message starting with
          <strong>${triggerWord}</strong> and the assistant will respond!
        </p>
      </div>

      ${saving && html`
        <${ProgressBar} indeterminate label="Registering assistant..." />
      `}

      ${isSuccess && html`
        <div class="success-box">
          <span class="success-icon">${'\u2713'}</span>
          <p>Assistant "${assistantName}" registered successfully!</p>
        </div>
      `}

      ${error && !saving && html`
        <div class="error-box">
          <p>${error}</p>
        </div>
      `}

      <div class="screen-actions">
        <button class="btn btn-ghost" onClick=${onBack} disabled=${saving}>Back</button>
        ${!isSuccess && html`
          <button
            class="btn btn-primary"
            onClick=${handleSave}
            disabled=${saving || !assistantName.trim() || !triggerWord.trim()}
          >
            ${saving ? 'Registering...' : 'Register Assistant'}
          </button>
        `}
        ${isSuccess && html`
          <button class="btn btn-primary" onClick=${onNext}>Continue</button>
        `}
      </div>
    </div>
  `;
}
