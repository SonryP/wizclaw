import { h } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import htm from 'htm';
import { ProgressBar } from '../components/ProgressBar.js';

const html = htm.bind(h);

const ALL_CHANNELS = ['whatsapp', 'telegram', 'slack', 'discord', 'gmail'];

const CHANNEL_INFO = {
  whatsapp: { label: 'WhatsApp', icon: '\u{1F4AC}', color: '#25D366' },
  telegram: { label: 'Telegram', icon: '\u{2708}\uFE0F', color: '#2AABEE' },
  slack:    { label: 'Slack',    icon: '\u{1F4E6}', color: '#4A154B' },
  discord:  { label: 'Discord',  icon: '\u{1F3AE}', color: '#5865F2' },
  gmail:    { label: 'Gmail',    icon: '\u{2709}\uFE0F', color: '#EA4335' },
};

function StatusDot({ running }) {
  return html`
    <span class="status-dot ${running ? 'running' : 'stopped'}" />
  `;
}

function ServiceCard({ serviceInfo, onStart, onStop, onRestart, loading }) {
  const { running, pid, uptime } = serviceInfo || {};

  return html`
    <div class="dash-card">
      <div class="dash-card-header">
        <h3><${StatusDot} running=${running} /> Service</h3>
        <span class="dash-badge ${running ? 'badge-success' : 'badge-error'}">
          ${running ? 'Running' : 'Stopped'}
        </span>
      </div>
      <div class="dash-card-body">
        ${running && html`
          <div class="dash-meta">
            ${pid && html`<span>PID: <strong>${pid}</strong></span>`}
            ${uptime && html`<span>Uptime: <strong>${uptime}</strong></span>`}
          </div>
        `}
        <div class="dash-actions">
          ${!running && html`
            <button class="btn btn-primary btn-sm" onClick=${onStart} disabled=${loading}>
              ${loading ? 'Starting...' : 'Start'}
            </button>
          `}
          ${running && html`
            <button class="btn btn-secondary btn-sm" onClick=${onRestart} disabled=${loading}>
              ${loading ? 'Restarting...' : 'Restart'}
            </button>
            <button class="btn btn-danger btn-sm" onClick=${onStop} disabled=${loading}>
              Stop
            </button>
          `}
        </div>
      </div>
    </div>
  `;
}

function GroupsCard({ groups, onRemove, onOpenFolder, nanoClawPath }) {
  const [removing, setRemoving] = useState(null);

  const handleRemove = async (jid, name) => {
    if (!confirm(`Remove "${name}" from registered groups?`)) return;
    setRemoving(jid);
    try {
      await onRemove(jid);
    } finally {
      setRemoving(null);
    }
  };

  return html`
    <div class="dash-card">
      <div class="dash-card-header">
        <h3>Registered Groups</h3>
        <span class="dash-badge badge-neutral">${groups.length}</span>
      </div>
      <div class="dash-card-body">
        ${groups.length === 0 && html`
          <p class="dash-empty">No groups registered yet.</p>
        `}
        ${groups.map((g) => html`
          <div class="dash-group-row" key=${g.jid}>
            <div class="dash-group-info">
              <span class="dash-group-name">${g.name}</span>
              <span class="dash-group-detail">
                ${g.channel} ${'\u00B7'} trigger: <code>${g.trigger_pattern}</code>
              </span>
            </div>
            <div class="dash-group-actions">
              ${nanoClawPath && html`
                <button
                  class="btn btn-ghost btn-xs"
                  title="Open folder"
                  onClick=${() => onOpenFolder(`${nanoClawPath}/groups/${g.folder}`)}
                >
                  Open
                </button>
              `}
              <button
                class="btn btn-ghost btn-xs btn-danger-text"
                onClick=${() => handleRemove(g.jid, g.name)}
                disabled=${removing === g.jid}
              >
                ${removing === g.jid ? '...' : 'Remove'}
              </button>
            </div>
          </div>
        `)}
      </div>
    </div>
  `;
}

function ChannelsCard({ channels, onRemove, onAddChannel }) {
  const [removing, setRemoving] = useState(null);

  const handleRemove = async (ch) => {
    if (!confirm(`Remove the ${ch} channel? This will delete its source file and rebuild.`)) return;
    setRemoving(ch);
    try {
      await onRemove(ch);
    } finally {
      setRemoving(null);
    }
  };

  const available = ALL_CHANNELS.filter((ch) => !channels.includes(ch));

  return html`
    <div class="dash-card">
      <div class="dash-card-header">
        <h3>Installed Channels</h3>
        ${available.length > 0 && html`
          <button class="btn btn-primary btn-xs" onClick=${onAddChannel}>
            + Add Channel
          </button>
        `}
      </div>
      <div class="dash-card-body">
        ${channels.length === 0 && html`
          <p class="dash-empty">No channels installed.</p>
        `}
        ${channels.map((ch) => {
          const info = CHANNEL_INFO[ch] || { icon: '\u{1F517}', label: ch };
          return html`
            <div class="dash-channel-row" key=${ch}>
              <span class="dash-channel-name">${info.icon} ${info.label}</span>
              <button
                class="btn btn-ghost btn-xs btn-danger-text"
                onClick=${() => handleRemove(ch)}
                disabled=${removing === ch}
              >
                ${removing === ch ? 'Removing...' : 'Remove'}
              </button>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function LogsCard({ logs, onRefresh, loading }) {
  return html`
    <div class="dash-card dash-card-logs">
      <div class="dash-card-header">
        <h3>Recent Logs</h3>
        <button class="btn btn-ghost btn-xs" onClick=${onRefresh} disabled=${loading}>
          ${loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      <div class="dash-card-body">
        <pre class="dash-log-output">${logs || 'Click Refresh to load logs...'}</pre>
      </div>
    </div>
  `;
}

// ---- Add Channel Flow (inline within Dashboard) ----

const TOKEN_CHANNELS = {
  telegram: { envKey: 'TELEGRAM_BOT_TOKEN', placeholder: '123456789:ABCdefGHIjklMNO...', instructions: [
    'Open Telegram and search for @BotFather',
    'Send /newbot and follow the prompts',
    'Choose a name and username (must end in "bot")',
    'Copy the bot token BotFather gives you',
  ]},
  slack: { envKey: 'SLACK_BOT_TOKEN', envKey2: 'SLACK_APP_TOKEN', placeholder: 'xoxb-...', placeholder2: 'xapp-...', instructions: [
    'Go to api.slack.com/apps and create a new app',
    'Enable Socket Mode and copy the App Token (starts with xapp-)',
    'Add OAuth scopes: chat:write, channels:history, groups:history, im:history',
    'Under Event Subscriptions, subscribe to bot events: message.channels, message.groups, message.im (required — without this the bot won\u2019t receive messages)',
    'Install to workspace and copy the Bot Token (starts with xoxb-)',
  ]},
  discord: { envKey: 'DISCORD_BOT_TOKEN', placeholder: 'Bot token...', instructions: [
    'Go to discord.com/developers/applications',
    'Create a new application and go to Bot tab',
    'Click "Reset Token" and copy it (shown only once!)',
    'Enable "Message Content Intent" under Privileged Intents',
    'Use OAuth2 URL Generator (scope: bot) to invite to your server',
  ]},
  gmail: { envKey: 'gcp-oauth.keys.json', placeholder: 'Paste JSON file contents...', instructions: [
    'Go to console.cloud.google.com and create/select a project',
    'Enable the Gmail API (APIs & Services > Library)',
    'Create OAuth credentials: APIs & Services > Credentials > Create > OAuth client ID > Desktop app',
    'Download the JSON file (click the download icon next to your credential)',
    'Paste the entire file contents below',
  ]},
};

function AddChannelFlow({ installedChannels, onDone, onCancel, clearTerminal }) {
  const [phase, setPhase] = useState('select'); // select | apply | auth | detect | register | done
  const [channel, setChannel] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Token auth state
  const [token, setToken] = useState('');
  const [token2, setToken2] = useState('');

  // Chat detect state (Telegram, Slack, Discord)
  const [chatInfo, setChatInfo] = useState(null);
  const [channelList, setChannelList] = useState([]); // Slack/Discord channel picker

  // Register state
  const [assistantName, setAssistantName] = useState('Andy');
  const [triggerWord, setTriggerWord] = useState('@Andy');

  const available = ALL_CHANNELS.filter((ch) => !installedChannels.includes(ch));

  // Listen for chat detection results (Telegram, Slack, Discord)
  useEffect(() => {
    const unsub = window.wizard.onStepStatus((data) => {
      if (data.step === 'telegram-chatid' && data.status === 'success' && data.data) {
        setChatInfo(data.data);
      }
      if ((data.step === 'slack-chatid' || data.step === 'discord-chatid') && data.status === 'needs_input' && data.data) {
        setChannelList(data.data.channels || []);
        setLoading(false);
      }
      if ((data.step === 'slack-chatid' || data.step === 'discord-chatid') && data.status === 'success' && data.data) {
        setChatInfo(data.data);
      }
    });
    return unsub;
  }, []);

  const handleSelectChannel = async (ch) => {
    setChannel(ch);
    setError(null);
    setPhase('apply');
    setLoading(true);
    if (clearTerminal) clearTerminal();

    // Append to wizard state so registration knows the channel (don't replace existing)
    await window.wizard.sendInput('channels', 'add', ch);

    try {
      await window.wizard.startStep('apply-channel', { channel: ch });
      if (ch === 'whatsapp') {
        // WhatsApp needs its own auth flow — go to auth phase
        setPhase('auth');
      } else {
        setPhase('auth');
      }
    } catch (err) {
      setError(err.message || 'Failed to add channel code');
      setPhase('select');
    }
    setLoading(false);
  };

  const handleSaveToken = async () => {
    setLoading(true);
    setError(null);
    if (clearTerminal) clearTerminal();
    try {
      // Gmail uses pasted JSON credentials instead of a token
      const args = channel === 'gmail'
        ? { credentials: token.trim() }
        : { token: token.trim() };
      if (channel !== 'gmail' && token2.trim()) args.token2 = token2.trim();

      await window.wizard.startStep(`${channel}-auth`, args);

      // Telegram, Slack, Discord need chat detection after token
      if (channel === 'telegram' || channel === 'slack' || channel === 'discord') {
        setPhase('detect');
      } else {
        // Gmail and others go directly to register
        setPhase('register');
      }
    } catch (err) {
      setError(err.message || 'Failed to save token');
    }
    setLoading(false);
  };

  const handleWhatsAppAuth = async (method, phone) => {
    setLoading(true);
    setError(null);
    if (clearTerminal) clearTerminal();
    try {
      await window.wizard.startStep('whatsapp-auth', {
        method: method === 'qr' ? 'qr-browser' : 'pairing-code',
        ...(phone ? { phone } : {}),
      });
      setPhase('register');
    } catch (err) {
      setError(err.message || 'WhatsApp authentication failed');
    }
    setLoading(false);
  };

  const handleDetectChat = async () => {
    setLoading(true);
    setError(null);
    setChannelList([]);
    if (clearTerminal) clearTerminal();
    try {
      const stepName = channel === 'slack' ? 'slack-chatid'
        : channel === 'discord' ? 'discord-chatid'
        : 'telegram-chatid';
      await window.wizard.startStep(stepName);
      // For Telegram: chatInfo set by listener, move to register
      // For Slack/Discord: channelList set by listener (needs_input), stay in detect for picker
      if (channel === 'telegram') {
        setPhase('register');
      }
      // Slack/Discord: loading is cleared by the needs_input listener
    } catch (err) {
      setError(err.message || 'Failed to detect chat');
      setLoading(false);
    }
  };

  const handlePickChannel = async (picked) => {
    setLoading(true);
    setError(null);
    try {
      const stepName = channel === 'slack' ? 'slack-chatid' : 'discord-chatid';
      await window.wizard.startStep(stepName, {
        channelId: picked.id,
        channelName: picked.name,
      });
      // chatInfo set by listener
      setPhase('register');
    } catch (err) {
      setError(err.message || 'Failed to select channel');
    }
    setLoading(false);
  };

  const handleRegister = async () => {
    setLoading(true);
    setError(null);
    if (clearTerminal) clearTerminal();
    try {
      await window.wizard.startStep('register', {
        'trigger-pattern': triggerWord,
        'assistant-name': assistantName,
        'channel': channel,
      });
      setPhase('done');
    } catch (err) {
      setError(err.message || 'Failed to register');
    }
    setLoading(false);
  };

  const handleNameChange = (name) => {
    setAssistantName(name);
    if (name.trim()) setTriggerWord(`@${name.trim()}`);
  };

  const info = channel ? (CHANNEL_INFO[channel] || { label: channel }) : null;
  const tokenInfo = channel ? TOKEN_CHANNELS[channel] : null;

  // ---- SELECT PHASE ----
  if (phase === 'select') {
    return html`
      <div class="dash-card add-channel-card">
        <div class="dash-card-header">
          <h3>Add a Channel</h3>
          <button class="btn btn-ghost btn-xs" onClick=${onCancel}>${'\u2715'} Close</button>
        </div>
        <div class="dash-card-body">
          ${available.length === 0 && html`
            <p class="dash-empty">All channels are already installed.</p>
          `}
          <div class="add-channel-grid">
            ${available.map((ch) => {
              const ci = CHANNEL_INFO[ch] || { icon: '\u{1F517}', label: ch, color: '#666' };
              return html`
                <button
                  class="add-channel-option"
                  onClick=${() => handleSelectChannel(ch)}
                  style="--channel-color: ${ci.color}"
                >
                  <span class="add-channel-icon">${ci.icon}</span>
                  <span class="add-channel-label">${ci.label}</span>
                </button>
              `;
            })}
          </div>
          ${error && html`
            <div class="error-box" style="margin-top: 12px;"><p>${error}</p></div>
          `}
        </div>
      </div>
    `;
  }

  // ---- APPLY PHASE ----
  if (phase === 'apply') {
    return html`
      <div class="dash-card add-channel-card">
        <div class="dash-card-header">
          <h3>${info.icon} Adding ${info.label}...</h3>
        </div>
        <div class="dash-card-body">
          <${ProgressBar} indeterminate label="Downloading and merging channel code..." />
        </div>
      </div>
    `;
  }

  // ---- AUTH PHASE ----
  if (phase === 'auth') {
    // WhatsApp — special QR/pairing flow
    if (channel === 'whatsapp') {
      return html`<${WhatsAppAddFlow}
        info=${info} loading=${loading} error=${error}
        onAuth=${handleWhatsAppAuth} onCancel=${onCancel}
      />`;
    }

    // Token-based channels
    const isGmail = channel === 'gmail';
    return html`
      <div class="dash-card add-channel-card">
        <div class="dash-card-header">
          <h3>${info.icon} Connect ${info.label}</h3>
          <button class="btn btn-ghost btn-xs" onClick=${onCancel}>${'\u2715'}</button>
        </div>
        <div class="dash-card-body">
          ${tokenInfo && html`
            <div class="instruction-box" style="margin-bottom: 12px;">
              <ol>
                ${tokenInfo.instructions.map((inst) => html`<li key=${inst}>${inst}</li>`)}
              </ol>
            </div>
          `}
          ${isGmail && html`
            <div class="instruction-box" style="margin-bottom: 12px; background: var(--warning-bg, rgba(255, 200, 0, 0.08));">
              <p style="margin: 0; font-size: 12px;">
                ${'\u26A0\uFE0F'} After you click Connect, a browser window will open for Google sign-in.
                Complete the OAuth flow there — this step may take a minute.
              </p>
            </div>
          `}
          <div class="form-group">
            <label class="form-label">${tokenInfo ? tokenInfo.envKey : 'Token'}</label>
            ${isGmail ? html`
              <textarea
                class="form-input"
                rows="8"
                value=${token}
                onInput=${(e) => setToken(e.target.value)}
                placeholder='{"installed": {"client_id": "...", "client_secret": "..."}}'
                disabled=${loading}
                style="font-family: monospace; font-size: 12px;"
              ></textarea>
              <p class="form-hint">Paste the full contents of gcp-oauth.keys.json</p>
            ` : html`
              <input
                type="password"
                class="form-input"
                value=${token}
                onInput=${(e) => setToken(e.target.value)}
                placeholder=${tokenInfo ? tokenInfo.placeholder : 'Paste token...'}
                disabled=${loading}
              />
            `}
          </div>
          ${tokenInfo && tokenInfo.envKey2 && !isGmail && html`
            <div class="form-group">
              <label class="form-label">${tokenInfo.envKey2}</label>
              <input
                type="password"
                class="form-input"
                value=${token2}
                onInput=${(e) => setToken2(e.target.value)}
                placeholder=${tokenInfo.placeholder2 || 'Paste token...'}
                disabled=${loading}
              />
            </div>
          `}
          ${loading && isGmail && html`
            <${ProgressBar} indeterminate label="Running OAuth flow — check your browser..." />
          `}
          <button
            class="btn btn-primary"
            onClick=${handleSaveToken}
            disabled=${!token.trim() || (!isGmail && tokenInfo?.envKey2 && !token2.trim()) || loading}
          >
            ${loading ? (isGmail ? 'Authorizing...' : 'Saving...') : `Connect ${info.label}`}
          </button>
          ${error && html`
            <div class="error-box" style="margin-top: 12px;"><p>${error}</p></div>
          `}
        </div>
      </div>
    `;
  }

  // ---- DETECT PHASE (Telegram, Slack, Discord) ----
  if (phase === 'detect') {
    // Telegram: send-and-detect flow
    if (channel === 'telegram') {
      return html`
        <div class="dash-card add-channel-card">
          <div class="dash-card-header">
            <h3>${info.icon} Link Telegram Chat</h3>
            <button class="btn btn-ghost btn-xs" onClick=${onCancel}>${'\u2715'}</button>
          </div>
          <div class="dash-card-body">
            ${!loading && !chatInfo && html`
              <div class="success-box" style="margin-bottom: 12px;">
                <span class="success-icon">${'\u2713'}</span>
                <p>Bot token saved!</p>
              </div>
              <div class="instruction-box" style="margin-bottom: 12px;">
                <p style="margin: 0 0 8px; font-weight: 600;">Now link your chat:</p>
                <ol>
                  <li>Open Telegram and find your bot by its username</li>
                  <li>Send <strong>/start</strong> or any message to the bot</li>
                  <li>Click "Detect Chat" below</li>
                </ol>
                <p style="margin: 8px 0 0; font-size: 12px; color: var(--text-secondary);">
                  ${'\u{1F4A1}'} For group chats: add the bot to the group first, disable Group Privacy in BotFather.
                </p>
              </div>
              <button class="btn btn-primary" onClick=${handleDetectChat}>
                ${'\u{1F50D}'} Detect Chat
              </button>
            `}
            ${loading && html`
              <${ProgressBar} indeterminate label="Listening for messages... Send something to your bot now!" />
            `}
            ${chatInfo && html`
              <div class="success-box">
                <span class="success-icon">${'\u2713'}</span>
                <p>Chat detected: ${chatInfo.chatName} (${chatInfo.chatJid})</p>
              </div>
            `}
            ${error && html`
              <div class="error-box" style="margin-top: 12px;"><p>${error}</p></div>
              <button class="btn btn-primary btn-sm" style="margin-top: 8px;" onClick=${handleDetectChat}>
                Retry
              </button>
            `}
          </div>
        </div>
      `;
    }

    // Slack / Discord: fetch channels then show picker
    const isSlack = channel === 'slack';
    const channelLabel = isSlack ? 'Slack' : 'Discord';

    return html`
      <div class="dash-card add-channel-card">
        <div class="dash-card-header">
          <h3>${info.icon} Pick ${channelLabel} Channel</h3>
          <button class="btn btn-ghost btn-xs" onClick=${onCancel}>${'\u2715'}</button>
        </div>
        <div class="dash-card-body">
          ${!loading && channelList.length === 0 && !chatInfo && !error && html`
            <div class="success-box" style="margin-bottom: 12px;">
              <span class="success-icon">${'\u2713'}</span>
              <p>Bot token saved!</p>
            </div>
            <div class="instruction-box" style="margin-bottom: 12px;">
              <p style="margin: 0 0 8px; font-weight: 600;">Select a channel to monitor:</p>
              ${isSlack ? html`
                <ol>
                  <li>Make sure the bot has been <strong>invited to a channel</strong> in Slack</li>
                  <li>Click "Fetch Channels" to see channels the bot can access</li>
                  <li>Pick the channel where the assistant should listen</li>
                </ol>
              ` : html`
                <ol>
                  <li>Make sure the bot has been <strong>invited to your server</strong> via OAuth2 URL</li>
                  <li>Click "Fetch Channels" to see available text channels</li>
                  <li>Pick the channel where the assistant should listen</li>
                </ol>
              `}
            </div>
            <button class="btn btn-primary" onClick=${handleDetectChat}>
              ${'\u{1F50D}'} Fetch Channels
            </button>
          `}
          ${loading && html`
            <${ProgressBar} indeterminate label=${`Fetching ${channelLabel} channels...`} />
          `}
          ${channelList.length > 0 && !chatInfo && html`
            <p style="margin: 0 0 8px; font-weight: 600;">Select a channel:</p>
            <div class="channel-picker-list">
              ${channelList.map((ch) => html`
                <button
                  key=${ch.id}
                  class="channel-picker-item"
                  onClick=${() => handlePickChannel(ch)}
                >
                  <span class="channel-picker-hash">#</span>
                  <span class="channel-picker-name">${ch.name}</span>
                  ${ch.guildName ? html`
                    <span class="channel-picker-meta">${ch.guildName}</span>
                  ` : ch.num_members != null ? html`
                    <span class="channel-picker-meta">${ch.num_members} members</span>
                  ` : null}
                </button>
              `)}
            </div>
            <button class="btn btn-ghost btn-sm" style="margin-top: 8px;" onClick=${handleDetectChat}>
              ${'\u{1F504}'} Refresh
            </button>
          `}
          ${chatInfo && html`
            <div class="success-box">
              <span class="success-icon">${'\u2713'}</span>
              <p>Channel selected: #${chatInfo.chatName} (${chatInfo.chatJid})</p>
            </div>
          `}
          ${error && html`
            <div class="error-box" style="margin-top: 12px;"><p>${error}</p></div>
            <button class="btn btn-primary btn-sm" style="margin-top: 8px;" onClick=${handleDetectChat}>
              Retry
            </button>
          `}
        </div>
      </div>
    `;
  }

  // ---- REGISTER PHASE ----
  if (phase === 'register') {
    return html`
      <div class="dash-card add-channel-card">
        <div class="dash-card-header">
          <h3>${info.icon} Register ${info.label} Assistant</h3>
          <button class="btn btn-ghost btn-xs" onClick=${onCancel}>${'\u2715'}</button>
        </div>
        <div class="dash-card-body">
          <div class="form-group">
            <label class="form-label">Assistant Name</label>
            <input
              type="text"
              class="form-input"
              value=${assistantName}
              onInput=${(e) => handleNameChange(e.target.value)}
              placeholder="Andy"
              disabled=${loading}
            />
          </div>
          <div class="form-group">
            <label class="form-label">Trigger Word</label>
            <input
              type="text"
              class="form-input"
              value=${triggerWord}
              onInput=${(e) => setTriggerWord(e.target.value)}
              placeholder="@Andy"
              disabled=${loading}
            />
            <p class="form-hint">Messages starting with "${triggerWord}" activate the assistant</p>
          </div>
          <button
            class="btn btn-primary"
            onClick=${handleRegister}
            disabled=${!assistantName.trim() || !triggerWord.trim() || loading}
          >
            ${loading ? 'Registering...' : 'Register Assistant'}
          </button>
          ${error && html`
            <div class="error-box" style="margin-top: 12px;"><p>${error}</p></div>
          `}
        </div>
      </div>
    `;
  }

  // ---- DONE PHASE ----
  if (phase === 'done') {
    return html`
      <div class="dash-card add-channel-card">
        <div class="dash-card-header">
          <h3>${info.icon} ${info.label} Added!</h3>
        </div>
        <div class="dash-card-body">
          <div class="success-box">
            <span class="success-icon">${'\u2713'}</span>
            <div>
              <p>${info.label} has been added and registered.</p>
              <p style="font-size: 12px; color: var(--text-secondary); margin: 4px 0 0;">
                Restart the service to activate the new channel.
              </p>
            </div>
          </div>
          <button class="btn btn-primary" style="margin-top: 12px;" onClick=${onDone}>
            Done
          </button>
        </div>
      </div>
    `;
  }

  return null;
}

function WhatsAppAddFlow({ info, loading, error, onAuth, onCancel }) {
  const [method, setMethod] = useState('qr');
  const [phone, setPhone] = useState('');
  const [authenticating, setAuthenticating] = useState(false);

  const handleAuth = async () => {
    setAuthenticating(true);
    await onAuth(method, method === 'pairing' ? phone : null);
    setAuthenticating(false);
  };

  return html`
    <div class="dash-card add-channel-card">
      <div class="dash-card-header">
        <h3>${info.icon} Connect WhatsApp</h3>
        <button class="btn btn-ghost btn-xs" onClick=${onCancel}>${'\u2715'}</button>
      </div>
      <div class="dash-card-body">
        <div class="option-cards compact" style="margin-bottom: 12px;">
          <button
            class="option-card ${method === 'qr' ? 'selected' : ''}"
            onClick=${() => setMethod('qr')}
            disabled=${authenticating}
          >
            <h4>QR Code</h4>
            <p>Opens a page ${'—'} scan with your phone</p>
          </button>
          <button
            class="option-card ${method === 'pairing' ? 'selected' : ''}"
            onClick=${() => setMethod('pairing')}
            disabled=${authenticating}
          >
            <h4>Pairing Code</h4>
            <p>Enter a code on your phone</p>
          </button>
        </div>

        ${method === 'pairing' && !authenticating && html`
          <div class="form-group">
            <label class="form-label">Phone number (with country code, no +)</label>
            <input
              type="text"
              class="form-input"
              value=${phone}
              onInput=${(e) => setPhone(e.target.value)}
              placeholder="14155551234"
            />
          </div>
        `}

        ${!authenticating && html`
          <button
            class="btn btn-primary"
            onClick=${handleAuth}
            disabled=${method === 'pairing' && !phone}
          >
            Connect WhatsApp
          </button>
        `}

        ${authenticating && html`
          <${ProgressBar} indeterminate label="Waiting for WhatsApp authentication..." />
        `}

        ${error && !authenticating && html`
          <div class="error-box" style="margin-top: 12px;"><p>${error}</p></div>
        `}
      </div>
    </div>
  `;
}

// ---- Main Dashboard ----

export function Dashboard({ wizardState, onBack, clearTerminal }) {
  const [serviceInfo, setServiceInfo] = useState(null);
  const [groups, setGroups] = useState([]);
  const [channels, setChannels] = useState([]);
  const [logs, setLogs] = useState('');
  const [svcLoading, setSvcLoading] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [addingChannel, setAddingChannel] = useState(false);

  const nanoClawPath = wizardState?.nanoClawPath || null;

  const refreshStatus = useCallback(async () => {
    try {
      const info = await window.wizard.getServiceStatus();
      setServiceInfo(info);
    } catch { /* ignore */ }
  }, []);

  const refreshGroups = useCallback(async () => {
    try {
      const g = await window.wizard.getGroups();
      setGroups(g);
    } catch { /* ignore */ }
  }, []);

  const refreshChannels = useCallback(async () => {
    try {
      const c = await window.wizard.getInstalledChannels();
      setChannels(c);
    } catch { /* ignore */ }
  }, []);

  const refreshLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const text = await window.wizard.getRecentLogs(100);
      setLogs(text);
    } catch (err) {
      setLogs(`Error: ${err.message}`);
    }
    setLogsLoading(false);
  }, []);

  // Load everything on mount + poll service status
  useEffect(() => {
    refreshStatus();
    refreshGroups();
    refreshChannels();

    const interval = setInterval(refreshStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleStart = async () => {
    setSvcLoading(true);
    try {
      await window.wizard.startService();
      setTimeout(refreshStatus, 1500);
    } catch { /* ignore */ }
    setSvcLoading(false);
  };

  const handleStop = async () => {
    setSvcLoading(true);
    try {
      await window.wizard.stopService();
      setTimeout(refreshStatus, 1000);
    } catch { /* ignore */ }
    setSvcLoading(false);
  };

  const handleRestart = async () => {
    setSvcLoading(true);
    try {
      await window.wizard.restartService();
      setTimeout(refreshStatus, 1500);
    } catch { /* ignore */ }
    setSvcLoading(false);
  };

  const handleRemoveGroup = async (jid) => {
    await window.wizard.removeGroup(jid);
    refreshGroups();
  };

  const handleRemoveChannel = async (ch) => {
    await window.wizard.removeChannel(ch);
    refreshChannels();
  };

  const handleOpenFolder = (folderPath) => {
    window.wizard.openFolder(folderPath);
  };

  const handleAddChannelDone = () => {
    setAddingChannel(false);
    refreshChannels();
    refreshGroups();
  };

  return html`
    <div class="screen dashboard-screen">
      <div class="dash-header">
        <h2 class="screen-title">NanoClaw Dashboard</h2>
        <div class="dash-tabs">
          <button
            class="dash-tab ${activeTab === 'overview' ? 'active' : ''}"
            onClick=${() => setActiveTab('overview')}
          >Overview</button>
          <button
            class="dash-tab ${activeTab === 'logs' ? 'active' : ''}"
            onClick=${() => { setActiveTab('logs'); refreshLogs(); }}
          >Logs</button>
        </div>
      </div>

      ${activeTab === 'overview' && html`
        ${addingChannel && html`
          <${AddChannelFlow}
            installedChannels=${channels}
            onDone=${handleAddChannelDone}
            onCancel=${() => { setAddingChannel(false); refreshChannels(); }}
            clearTerminal=${clearTerminal}
          />
        `}

        <div class="dash-grid">
          <${ServiceCard}
            serviceInfo=${serviceInfo}
            onStart=${handleStart}
            onStop=${handleStop}
            onRestart=${handleRestart}
            loading=${svcLoading}
          />

          <${ChannelsCard}
            channels=${channels}
            onRemove=${handleRemoveChannel}
            onAddChannel=${() => setAddingChannel(true)}
          />

          <${GroupsCard}
            groups=${groups}
            onRemove=${handleRemoveGroup}
            onOpenFolder=${handleOpenFolder}
            nanoClawPath=${nanoClawPath}
          />
        </div>

        ${nanoClawPath && html`
          <div class="dash-path-bar">
            <span>Installed at:</span>
            <code>${nanoClawPath}</code>
            <button
              class="btn btn-ghost btn-xs"
              onClick=${() => handleOpenFolder(nanoClawPath)}
            >Open</button>
          </div>
        `}
      `}

      ${activeTab === 'logs' && html`
        <${LogsCard}
          logs=${logs}
          onRefresh=${refreshLogs}
          loading=${logsLoading}
        />
      `}

      <div class="screen-actions">
        <button class="btn btn-ghost" onClick=${onBack}>
          Back to Setup
        </button>
        <button class="btn btn-ghost" onClick=${() => window.close()}>
          Close
        </button>
      </div>
    </div>
  `;
}
