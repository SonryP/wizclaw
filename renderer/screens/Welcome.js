import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

export function Welcome({ onNext }) {
  return html`
    <div class="screen welcome-screen">
      <div class="welcome-hero">
        <div class="welcome-logo">
          <img src="../images/icon.png" alt="WizClaw" width="96" height="96" class="welcome-logo-img" />
        </div>
        <h1 class="welcome-title">WizClaw</h1>
        <p class="welcome-subtitle">The setup wizard for NanoClaw</p>
        <p class="welcome-desc">
          WizClaw guides you step-by-step through installing and configuring
          NanoClaw — your personal AI assistant that connects Claude to WhatsApp,
          Telegram, Slack, Discord, and more.
        </p>
      </div>

      <div class="welcome-features">
        <div class="feature-item">
          <span class="feature-icon">${'\u{1F4AC}'}</span>
          <div>
            <h3>Multi-channel</h3>
            <p>Connect to WhatsApp, Telegram, Slack, Discord, Gmail</p>
          </div>
        </div>
        <div class="feature-item">
          <span class="feature-icon">${'\u{1F512}'}</span>
          <div>
            <h3>Secure</h3>
            <p>Runs locally on your machine, credentials never leave your computer</p>
          </div>
        </div>
        <div class="feature-item">
          <span class="feature-icon">${'\u26A1'}</span>
          <div>
            <h3>Powerful</h3>
            <p>Powered by Claude with full agent capabilities and memory</p>
          </div>
        </div>
      </div>

      <div class="screen-actions">
        <button class="btn btn-primary btn-lg" onClick=${onNext}>
          Get Started
        </button>
      </div>
    </div>
  `;
}
