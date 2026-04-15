import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

export function Welcome({ onNext }) {
  return html`
    <div class="screen welcome-screen">
      <div class="welcome-hero">
        <div class="welcome-logo">
          <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
            <rect width="80" height="80" rx="20" fill="#6c5ce7"/>
            <path d="M25 55 L40 25 L55 55 M30 45 H50" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h1 class="welcome-title">NanoClaw</h1>
        <p class="welcome-subtitle">Set up your personal AI assistant</p>
        <p class="welcome-desc">
          NanoClaw connects Claude to your favorite messaging apps — WhatsApp,
          Telegram, Slack, Discord, and more. This wizard will guide you through
          the entire setup process.
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
