import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { PrereqCard } from '../components/PrereqCard.js';

const html = htm.bind(h);

const PREREQS = [
  {
    name: 'node',
    label: 'Node.js',
    description: 'JavaScript runtime (version 20 or higher)',
  },
  {
    name: 'docker',
    label: 'Docker',
    description: 'Container runtime for running AI agents securely',
  },
  {
    name: 'git',
    label: 'Git',
    description: 'Version control (included with Xcode Command Line Tools)',
  },
  {
    name: 'claude',
    label: 'Claude Code',
    description: 'Claude CLI tool (needed to authenticate your account)',
  },
];

export function Prerequisites({ onNext, onBack, prereqStatus }) {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    setChecking(true);
    window.wizard.checkPrereqs().then(() => setChecking(false));
  }, []);

  const handleInstall = async (name) => {
    await window.wizard.installPrereq(name);
  };

  const handleInstallAll = async () => {
    for (const prereq of PREREQS) {
      const status = prereqStatus?.[prereq.name];
      if (!status?.installed) {
        await window.wizard.installPrereq(prereq.name);
      } else if (prereq.name === 'docker' && status?.installed && !status?.running) {
        await window.wizard.installPrereq('docker-start');
      }
    }
  };

  const allReady =
    prereqStatus &&
    prereqStatus.node?.installed &&
    prereqStatus.docker?.installed &&
    prereqStatus.docker?.running &&
    prereqStatus.git?.installed &&
    prereqStatus.claude?.installed;

  const someMissing =
    prereqStatus &&
    (!prereqStatus.node?.installed ||
      !prereqStatus.docker?.installed ||
      !prereqStatus.docker?.running ||
      !prereqStatus.git?.installed ||
      !prereqStatus.claude?.installed);

  return html`
    <div class="screen prerequisites-screen">
      <h2 class="screen-title">Prerequisites</h2>
      <p class="screen-desc">
        NanoClaw needs a few things installed on your computer. We'll check
        for them and install anything that's missing.
      </p>

      <div class="prereq-list">
        ${PREREQS.map(
          (p) => html`
            <${PrereqCard}
              key=${p.name}
              name=${p.name}
              label=${p.label}
              description=${p.description}
              status=${prereqStatus?.[p.name]}
              onInstall=${handleInstall}
            />
          `,
        )}
      </div>

      <div class="screen-actions">
        <button class="btn btn-ghost" onClick=${onBack}>Back</button>
        <div class="actions-right">
          ${someMissing && html`
            <button class="btn btn-secondary" onClick=${handleInstallAll}>
              Install All Missing
            </button>
          `}
          <button
            class="btn btn-primary"
            onClick=${onNext}
            disabled=${!allReady}
          >
            ${allReady ? 'Continue' : checking ? 'Checking...' : 'Fix issues above to continue'}
          </button>
        </div>
      </div>
    </div>
  `;
}
