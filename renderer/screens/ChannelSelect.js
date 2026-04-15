import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import { ChannelCard } from '../components/ChannelCard.js';

const html = htm.bind(h);

const CHANNELS = ['whatsapp', 'telegram', 'slack', 'discord', 'gmail'];

export function ChannelSelect({ onNext, onBack, wizardState }) {
  const [selected, setSelected] = useState(
    wizardState?.selectedChannels || [],
  );

  const handleToggle = (channelId) => {
    setSelected((prev) =>
      prev.includes(channelId)
        ? prev.filter((c) => c !== channelId)
        : [...prev, channelId],
    );
  };

  const handleContinue = async () => {
    await window.wizard.sendInput('channels', 'selected', selected.join(','));
    onNext();
  };

  return html`
    <div class="screen channel-select-screen">
      <h2 class="screen-title">Choose Your Channels</h2>
      <p class="screen-desc">
        Select the messaging apps you want to connect to NanoClaw.
        You can always add more later.
      </p>

      <div class="channel-grid">
        ${CHANNELS.map(
          (ch) => html`
            <${ChannelCard}
              key=${ch}
              channelId=${ch}
              selected=${selected.includes(ch)}
              onToggle=${handleToggle}
            />
          `,
        )}
      </div>

      <div class="screen-actions">
        <button class="btn btn-ghost" onClick=${onBack}>Back</button>
        <button
          class="btn btn-primary"
          onClick=${handleContinue}
          disabled=${selected.length === 0}
        >
          Continue with ${selected.length} channel${selected.length !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
  `;
}
