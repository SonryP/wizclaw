import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

export function ProgressBar({ progress, indeterminate, label }) {
  return html`
    <div class="progress-container">
      ${label && html`<p class="progress-label">${label}</p>`}
      <div class="progress-track">
        <div
          class="progress-bar ${indeterminate ? 'indeterminate' : ''}"
          style=${indeterminate ? '' : `width: ${Math.min(100, Math.max(0, progress))}%`}
        />
      </div>
    </div>
  `;
}
