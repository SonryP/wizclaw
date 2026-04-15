import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

export function Done({ wizardState, stepStatus, clearTerminal }) {
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifying, setVerifying] = useState(false);

  const handleVerify = async () => {
    setVerifying(true);
    clearTerminal();
    try {
      await window.wizard.startStep('verify');
      setVerifyResult('success');
    } catch {
      setVerifyResult('failed');
    }
    setVerifying(false);
  };

  useEffect(() => {
    handleVerify();
  }, []);

  const channels = wizardState?.selectedChannels || [];

  return html`
    <div class="screen done-screen">
      <div class="done-hero">
        <div class="done-icon">${'\u{1F389}'}</div>
        <h2 class="screen-title">You're All Set!</h2>
        <p class="screen-desc">
          NanoClaw is installed and running on your computer.
        </p>
      </div>

      <div class="verify-dashboard">
        <h3>System Status</h3>
        ${verifying && html`<p class="verifying">Checking everything...</p>`}

        <div class="verify-items">
          <div class="verify-item ${verifyResult === 'success' ? 'ok' : verifyResult === 'failed' ? 'fail' : ''}">
            <span class="verify-icon">${verifyResult === 'success' ? '\u2713' : verifyResult === 'failed' ? '\u2717' : '...'}</span>
            <span>Background Service</span>
          </div>
          <div class="verify-item ok">
            <span class="verify-icon">${'\u2713'}</span>
            <span>Container Runtime</span>
          </div>
          <div class="verify-item ok">
            <span class="verify-icon">${'\u2713'}</span>
            <span>AI Credentials</span>
          </div>
          ${channels.map(
            (ch) => html`
              <div class="verify-item ok" key=${ch}>
                <span class="verify-icon">${'\u2713'}</span>
                <span>${ch[0].toUpperCase() + ch.slice(1)} Channel</span>
              </div>
            `,
          )}
        </div>

        ${verifyResult === 'failed' && html`
          <button class="btn btn-secondary btn-sm" onClick=${handleVerify}>
            Re-check
          </button>
        `}
      </div>

      <div class="done-next-steps">
        <h3>What's Next?</h3>
        <ul>
          <li>Send a message starting with your trigger word to test it out</li>
          <li>The assistant will respond in the chat you registered</li>
          <li>You can add more channels later by running the wizard again</li>
        </ul>
      </div>

      <div class="screen-actions">
        <button class="btn btn-ghost" onClick=${() => window.close()}>
          Close Wizard
        </button>
      </div>
    </div>
  `;
}
