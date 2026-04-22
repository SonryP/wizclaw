import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

export function Credentials({ onNext, onBack, stepStatus, clearTerminal }) {
  const isWindows = window.wizard.platform === 'win32';
  const [credType, setCredType] = useState(null); // 'subscription' | 'api-key' | 'ollama'
  const [token, setToken] = useState('');
  const [ollamaModel, setOllamaModel] = useState('llama3.1:8b');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [step, setStep] = useState(1); // tracks sub-step within a flow

  const handleSave = async () => {
    const trimmed = token.replace(/\s+/g, '').trim(); // strip whitespace/newlines from paste
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    clearTerminal();

    const type = trimmed.startsWith('sk-ant-oat') ? 'subscription' : 'api-key';

    try {
      await window.wizard.startStep('credentials', { type, token: trimmed });
      setDone(true);
    } catch (err) {
      setError(err.message || 'Failed to save credentials');
    } finally {
      setSaving(false);
    }
  };

  const handleOllamaSetup = async () => {
    setSaving(true);
    setError(null);
    clearTerminal();
    try {
      await window.wizard.startStep('credentials', {
        type: 'ollama',
        model: ollamaModel,
      });
      setDone(true);
    } catch (err) {
      setError(err.message || 'Failed to set up local model');
    } finally {
      setSaving(false);
    }
  };

  const openConsole = () => {
    window.wizard.openUrl('https://console.anthropic.com/settings/keys');
    setStep(2);
  };

  const openSetupToken = () => {
    window.wizard.openUrl('https://console.anthropic.com/settings/keys');
    // Also open Terminal with setup-token for subscription users
    window.wizard.startStep('claude-auth').catch(() => {});
    setStep(2);
  };

  const goBack = () => {
    if (step > 1) {
      setStep(1);
    } else if (credType) {
      setCredType(null);
      setToken('');
      setError(null);
      setStep(1);
    } else {
      onBack();
    }
  };

  return html`
    <div class="screen credentials-screen">
      <h2 class="screen-title">AI Credentials</h2>
      <p class="screen-desc">
        NanoClaw needs a Claude API key or token to power your assistant.
      </p>

      ${!credType && !done && html`
        <div class="option-cards">
          <button
            class="option-card"
            onClick=${() => setCredType('subscription')}
          >
            <h3>Claude Subscription</h3>
            <p>
              I have a Claude Pro, Team, or Max subscription.
              I'll generate a token and paste it here.
            </p>
            <span class="option-tag">Most common</span>
          </button>
          <button
            class="option-card"
            onClick=${() => setCredType('api-key')}
          >
            <h3>API Key</h3>
            <p>
              I have (or will create) an Anthropic API key
              from the developer console.
            </p>
            <span class="option-tag">Pay per use</span>
          </button>
          <button
            class="option-card"
            onClick=${() => setCredType('ollama')}
          >
            <h3>Run locally (Ollama)</h3>
            <p>
              Run a local model on your computer. Free and private,
              but quality varies.
            </p>
            <span class="option-tag">Experimental</span>
          </button>
        </div>
      `}

      ${credType === 'subscription' && !done && html`
        <div class="credential-form">
          <div class="instruction-box">
            <h3>Get your Claude token</h3>
            <ol>
              ${isWindows ? html`
                <li>
                  Open <strong>Command Prompt</strong> or <strong>PowerShell</strong>
                  <span class="hint">(press Win + R ${'→'} type "cmd" ${'→'} Enter)</span>
                </li>
              ` : html`
                <li>
                  Open <strong>Terminal</strong> on your Mac
                  <span class="hint">(Spotlight ${'→'} type "Terminal" ${'→'} Enter)</span>
                </li>
              `}
              <li>
                Type this command and press Enter:
                <div class="code-block">
                  <code>claude setup-token</code>
                  <button
                    class="btn btn-ghost btn-xs copy-btn"
                    onClick=${() => navigator.clipboard.writeText('claude setup-token')}
                  >Copy</button>
                </div>
              </li>
              <li>Your browser will open — sign in with your Claude account</li>
              <li>A token will appear in the terminal (starts with <code>sk-ant-oat</code>)</li>
              <li>Copy the token and paste it below</li>
            </ol>
          </div>

          <div class="form-group">
            <label class="form-label">Claude Token</label>
            <textarea
              class="form-input form-textarea"
              value=${token}
              onInput=${(e) => setToken(e.target.value)}
              placeholder="sk-ant-oat01-..."
              rows="3"
            />
            <p class="form-hint">
              Paste the full token here — it's OK if it wraps to multiple lines
            </p>
          </div>

          ${error && html`
            <div class="error-box">
              <p>${error}</p>
            </div>
          `}

          <div style="display: flex; gap: 10px;">
            <button
              class="btn btn-primary"
              onClick=${handleSave}
              disabled=${!token.trim() || saving}
            >
              ${saving ? 'Saving...' : 'Save Token'}
            </button>
            <button class="btn btn-ghost" onClick=${() => { setCredType(null); setToken(''); setError(null); }}>
              Other methods
            </button>
          </div>
        </div>
      `}

      ${credType === 'api-key' && !done && html`
        <div class="credential-form">
          <div class="instruction-box">
            <h3>Get your API key</h3>
            <ol>
              <li>
                Click the button below to open the Anthropic Console
              </li>
              <li>Sign in or create an account</li>
              <li>Click <strong>"Create Key"</strong></li>
              <li>Copy the key and paste it below</li>
            </ol>
            <div style="margin-top: 12px;">
              <button class="btn btn-secondary btn-sm" onClick=${openConsole}>
                ${'🔗'} Open Anthropic Console
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">API Key</label>
            <textarea
              class="form-input form-textarea"
              value=${token}
              onInput=${(e) => setToken(e.target.value)}
              placeholder="sk-ant-api03-..."
              rows="3"
            />
            <p class="form-hint">
              Paste the full key here — starts with <code>sk-ant-api</code>
            </p>
          </div>

          ${error && html`
            <div class="error-box">
              <p>${error}</p>
            </div>
          `}

          <div style="display: flex; gap: 10px;">
            <button
              class="btn btn-primary"
              onClick=${handleSave}
              disabled=${!token.trim() || saving}
            >
              ${saving ? 'Saving...' : 'Save Key'}
            </button>
            <button class="btn btn-ghost" onClick=${() => { setCredType(null); setToken(''); setError(null); }}>
              Other methods
            </button>
          </div>
        </div>
      `}

      ${credType === 'ollama' && !done && html`
        <div class="credential-form">
          <div class="instruction-box">
            <h3>Run a model locally</h3>
            <ol>
              <li>WizClaw installs Ollama if it's not already on your machine.</li>
              <li>Downloads the model you pick below (first time only — several GB).</li>
              <li>Starts a small translation proxy so NanoClaw can talk to it.</li>
            </ol>
            <p class="form-hint">
              <strong>Experimental:</strong> local models can misfire on complex
              agent tasks. You can switch back to Claude any time from this screen.
            </p>
          </div>

          <div class="form-group">
            <label class="form-label">Model</label>
            <select
              class="form-input"
              value=${ollamaModel}
              onChange=${(e) => setOllamaModel(e.target.value)}
            >
              <option value="llama3.1:8b">llama3.1:8b — recommended, native tool calling (~5 GB)</option>
              <option value="mistral-nemo:12b">mistral-nemo:12b — function-calling tuned (~7 GB)</option>
              <option value="qwen2.5:14b">qwen2.5:14b — highest quality, better reasoning (~9 GB)</option>
            </select>
            <p class="form-hint">
              These models have been tested with NanoClaw's tool-calling flow.
              Other Ollama models may work but quality varies — you can switch
              by editing <code>NANOCLAW_LOCAL_MODEL</code> in <code>.env</code>
              and restarting the service.
            </p>
          </div>

          ${error && html`
            <div class="error-box">
              <p>${error}</p>
            </div>
          `}

          <div style="display: flex; gap: 10px;">
            <button
              class="btn btn-primary"
              onClick=${handleOllamaSetup}
              disabled=${saving}
            >
              ${saving ? 'Setting up...' : 'Install & start'}
            </button>
            <button class="btn btn-ghost" onClick=${() => { setCredType(null); setError(null); }}>
              Other methods
            </button>
          </div>
        </div>
      `}

      ${done && html`
        <div class="success-box">
          <span class="success-icon">${'\u2713'}</span>
          <div>
            <p>Credentials saved successfully!</p>
            <p class="success-detail">
              ${credType === 'ollama'
                ? `Local model (${ollamaModel}) configured via Ollama proxy.`
                : (credType === 'subscription' || token.startsWith('sk-ant-oat'))
                  ? 'Claude subscription token configured.'
                  : 'API key configured.'}
            </p>
          </div>
        </div>
      `}

      <div class="screen-actions">
        <button class="btn btn-ghost" onClick=${goBack}>Back</button>
        <button class="btn btn-primary" onClick=${onNext} disabled=${!done}>
          Continue
        </button>
      </div>
    </div>
  `;
}
