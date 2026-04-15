import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

const CHANNEL_INFO = {
  whatsapp: {
    label: 'WhatsApp',
    desc: 'Connect via QR code or pairing code',
    color: '#25D366',
  },
  telegram: {
    label: 'Telegram',
    desc: 'Connect with a bot token from @BotFather',
    color: '#2AABEE',
  },
  slack: {
    label: 'Slack',
    desc: 'Connect with Socket Mode app tokens',
    color: '#4A154B',
  },
  discord: {
    label: 'Discord',
    desc: 'Connect with a bot from Developer Portal',
    color: '#5865F2',
  },
  gmail: {
    label: 'Gmail',
    desc: 'Connect with Google OAuth credentials',
    color: '#EA4335',
  },
};

export function ChannelCard({ channelId, selected, onToggle }) {
  const info = CHANNEL_INFO[channelId] || {
    label: channelId,
    desc: '',
    color: '#666',
  };

  return html`
    <button
      class="channel-card ${selected ? 'selected' : ''}"
      onClick=${() => onToggle(channelId)}
      style="--channel-color: ${info.color}"
    >
      <div class="channel-icon-area">
        <span class="channel-icon">${info.label[0]}</span>
      </div>
      <div class="channel-info">
        <h3 class="channel-name">${info.label}</h3>
        <p class="channel-desc">${info.desc}</p>
      </div>
      <div class="channel-toggle">
        <div class="toggle-track ${selected ? 'on' : ''}">
          <div class="toggle-thumb" />
        </div>
      </div>
    </button>
  `;
}
