import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

export function Security({ onNext, onBack, stepStatus, clearTerminal }) {
  const [allowMounts, setAllowMounts] = useState(false);
  const [paths, setPaths] = useState([]);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  const addPath = async () => {
    const dir = await window.wizard.selectDirectory();
    if (dir && !paths.find((p) => p.path === dir)) {
      setPaths([...paths, { path: dir, readOnly: true }]);
    }
  };

  const removePath = (idx) => {
    setPaths(paths.filter((_, i) => i !== idx));
  };

  const toggleReadOnly = (idx) => {
    setPaths(
      paths.map((p, i) =>
        i === idx ? { ...p, readOnly: !p.readOnly } : p,
      ),
    );
  };

  const handleSave = async () => {
    setSaving(true);
    clearTerminal();

    try {
      if (!allowMounts || paths.length === 0) {
        await window.wizard.startStep('mounts', { empty: 'true' });
      } else {
        const config = {
          allowedRoots: paths.map((p) => ({
            path: p.path,
            readOnly: p.readOnly,
          })),
          blockedPatterns: [],
          nonMainReadOnly: true,
        };
        await window.wizard.startStep('mounts', {
          json: JSON.stringify(config),
        });
      }
      setDone(true);
    } catch (err) {
      setError(err.message || 'Failed to save security settings');
    }
    setSaving(false);
  };

  const isSuccess = stepStatus?.status === 'success' || done;

  return html`
    <div class="screen security-screen">
      <h2 class="screen-title">Security Settings</h2>
      <p class="screen-desc">
        Control which folders on your computer the AI agent can access.
        By default, agents can only see their own workspace.
      </p>

      <div class="toggle-row">
        <label class="toggle-label">
          <input
            type="checkbox"
            checked=${allowMounts}
            onChange=${(e) => setAllowMounts(e.target.checked)}
            disabled=${isSuccess}
          />
          <span>Allow agent access to additional folders</span>
        </label>
      </div>

      ${allowMounts && html`
        <div class="mount-list">
          ${paths.map(
            (p, idx) => html`
              <div class="mount-item" key=${idx}>
                <span class="mount-path">${p.path}</span>
                <label class="mount-readonly">
                  <input
                    type="checkbox"
                    checked=${p.readOnly}
                    onChange=${() => toggleReadOnly(idx)}
                  />
                  Read-only
                </label>
                <button
                  class="btn btn-sm btn-ghost"
                  onClick=${() => removePath(idx)}
                >
                  Remove
                </button>
              </div>
            `,
          )}
          <button class="btn btn-secondary btn-sm" onClick=${addPath}>
            + Add Folder
          </button>
        </div>
      `}

      ${isSuccess && html`
        <div class="success-box">
          <span class="success-icon">${'\u2713'}</span>
          <p>Security settings saved!</p>
        </div>
      `}

      ${error && !saving && html`
        <div class="error-box">
          <p>${error}</p>
        </div>
      `}

      <div class="screen-actions">
        <button class="btn btn-ghost" onClick=${onBack}>Back</button>
        ${!isSuccess && html`
          <button class="btn btn-primary" onClick=${handleSave} disabled=${saving}>
            ${saving ? 'Saving...' : 'Save & Continue'}
          </button>
        `}
        ${isSuccess && html`
          <button class="btn btn-primary" onClick=${onNext}>Continue</button>
        `}
      </div>
    </div>
  `;
}
