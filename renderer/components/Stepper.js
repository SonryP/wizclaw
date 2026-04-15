import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

export function Stepper({ steps, currentStep, stepStatuses }) {
  return html`
    <div class="stepper">
      ${steps.map((step, i) => {
        const status = stepStatuses[step.id]?.status;
        let stateClass = '';
        if (i < currentStep || status === 'success') stateClass = 'completed';
        else if (i === currentStep) stateClass = 'active';
        if (status === 'failed') stateClass = 'failed';
        if (status === 'running') stateClass = 'running';

        return html`
          <div class="stepper-item ${stateClass}" key=${step.id}>
            <div class="stepper-dot">
              ${stateClass === 'completed' ? html`<span class="check">${'\u2713'}</span>` : ''}
              ${stateClass === 'failed' ? html`<span class="cross">${'\u2717'}</span>` : ''}
              ${stateClass === 'running' ? html`<span class="spinner" />` : ''}
            </div>
            ${i < steps.length - 1 && html`<div class="stepper-line" />`}
          </div>
        `;
      })}
    </div>
  `;
}
