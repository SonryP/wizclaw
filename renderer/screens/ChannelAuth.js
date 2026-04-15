import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import { ProgressBar } from '../components/ProgressBar.js';

const html = htm.bind(h);

/**
 * Per-channel setup wrapper. Handles:
 * 1. Applying the channel skill repo (git merge)
 * 2. Only shows the auth UI after the skill is merged
 */
function ChannelSetupWrapper({ channel, children, clearTerminal }) {
  // Start in "loading" state — don't show children until skill is confirmed applied
  const [state, setState] = useState('loading'); // 'loading' | 'applying' | 'applied' | 'error'
  const [error, setError] = useState(null);

  const applySkill = async () => {
    setState('applying');
    setError(null);
    clearTerminal();
    try {
      await window.wizard.startStep('apply-channel', { channel });
      setState('applied');
    } catch (err) {
      setError(err.message || `Failed to add ${channel}`);
      setState('error');
    }
  };

  // Auto-apply on mount
  useEffect(() => {
    applySkill();
  }, []);

  const label = channel[0].toUpperCase() + channel.slice(1);

  if (state === 'loading' || state === 'applying') {
    return html`
      <div class="channel-auth-section">
        <h3>${label}</h3>
        <${ProgressBar} indeterminate label="Adding ${label} channel code..." />
        <p style="font-size: 13px; color: var(--text-secondary); margin-top: 8px;">
          Downloading and merging channel code, installing dependencies...
        </p>
      </div>
    `;
  }

  if (state === 'error') {
    return html`
      <div class="channel-auth-section">
        <h3>${label}</h3>
        <div class="error-box">
          <p>${error}</p>
        </div>
        <button class="btn btn-primary btn-sm" style="margin-top: 8px;" onClick=${applySkill}>
          Retry
        </button>
      </div>
    `;
  }

  // state === 'applied' — show the auth UI
  return children;
}

function WhatsAppAuth({ clearTerminal }) {
  const [method, setMethod] = useState('qr'); // 'qr' | 'pairing'
  const [phone, setPhone] = useState('');
  const [authenticating, setAuthenticating] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState(null);

  const startAuth = async () => {
    setAuthenticating(true);
    setError(null);
    clearTerminal();
    try {
      await window.wizard.startStep('whatsapp-auth', {
        method: method === 'qr' ? 'qr-browser' : 'pairing-code',
        ...(method === 'pairing' && phone ? { phone } : {}),
      });
      setAuthenticated(true);
    } catch (err) {
      setError(err.message || 'Authentication failed');
    }
    setAuthenticating(false);
  };

  if (authenticated) {
    return html`
      <div class="channel-auth-section">
        <h3>WhatsApp</h3>
        <div class="success-box">
          <span class="success-icon">${'\u2713'}</span>
          <p>WhatsApp connected successfully!</p>
        </div>
      </div>
    `;
  }

  return html`
    <${ChannelSetupWrapper} channel="whatsapp" clearTerminal=${clearTerminal}>
      <div class="channel-auth-section">
        <h3>WhatsApp</h3>

        <div class="option-cards compact">
          <button
            class="option-card ${method === 'qr' ? 'selected' : ''}"
            onClick=${() => setMethod('qr')}
            disabled=${authenticating}
          >
            <h4>QR Code</h4>
            <p>Opens a page — scan with your phone</p>
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
            onClick=${startAuth}
            disabled=${method === 'pairing' && !phone}
          >
            Connect WhatsApp
          </button>
        `}

        ${authenticating && html`
          <div>
            <${ProgressBar} indeterminate label="Waiting for WhatsApp authentication..." />
            <p style="text-align: center; color: var(--text-secondary); font-size: 13px; margin-top: 12px;">
              ${method === 'qr'
                ? 'A browser page should have opened with a QR code. Open WhatsApp > Settings > Linked Devices > Link a Device, then scan the code.'
                : 'Check the terminal output below for your pairing code. Enter it in WhatsApp > Settings > Linked Devices > Link a Device.'}
            </p>
          </div>
        `}

        ${error && !authenticating && html`
          <div class="error-box" style="margin-top: 12px;">
            <p>${error}</p>
          </div>
          <button class="btn btn-primary btn-sm" style="margin-top: 8px;" onClick=${startAuth}>
            Retry
          </button>
        `}
      </div>
    <//>
  `;
}

// ---- Telegram Auth: 3 sub-views ----

function TelegramAuthDone(chatInfo) {
  return html`
    <div class="channel-auth-section">
      <h3>Telegram</h3>
      <div class="success-box">
        <span class="success-icon">${'\u2713'}</span>
        <div>
          <p>Telegram connected successfully!</p>
          <p style="font-size: 12px; color: var(--text-secondary); margin: 4px 0 0;">
            Chat: ${chatInfo.chatName || 'Detected'} (${chatInfo.chatJid || 'linked'})
          </p>
        </div>
      </div>
    </div>
  `;
}

function TelegramAuthDetect({ detecting, error, handleDetectChat }) {
  if (detecting) {
    return html`
      <div class="channel-auth-section">
        <h3>Telegram</h3>
        <div class="success-box" style="margin-bottom: 16px;">
          <span class="success-icon">${'\u2713'}</span>
          <p>Bot token saved!</p>
        </div>
        <${ProgressBar} indeterminate label="Listening for messages... Send something to your bot in Telegram!" />
        <p style="text-align: center; color: var(--text-secondary); font-size: 13px; margin-top: 8px;">
          The wizard is polling your bot for incoming messages.
          Send <strong>/start</strong> or any text to the bot now.
        </p>
      </div>
    `;
  }

  return html`
    <div class="channel-auth-section">
      <h3>Telegram</h3>
      <div class="success-box" style="margin-bottom: 16px;">
        <span class="success-icon">${'\u2713'}</span>
        <p>Bot token saved!</p>
      </div>

      <div class="instruction-box">
        <p style="margin: 0 0 8px; font-weight: 600;">Now link your chat:</p>
        <ol>
          <li>Open Telegram on your phone or desktop</li>
          <li>Find your bot by searching its username</li>
          <li>Send <strong>/start</strong> or any message to the bot</li>
          <li>Click "Detect Chat" below ${'—'} the wizard will capture your chat ID automatically</li>
        </ol>
        <p style="margin: 8px 0 0; font-size: 12px; color: var(--text-secondary);">
          ${'\u{1F4A1}'} For group chats: add the bot to the group first, then send a message there.
          Make sure "Group Privacy" is disabled in BotFather (/mybots > Bot Settings > Group Privacy > Turn off).
        </p>
      </div>

      <button
        class="btn btn-primary"
        onClick=${handleDetectChat}
      >
        ${'\u{1F50D}'} Detect Chat
      </button>

      ${error && html`
        <div class="error-box" style="margin-top: 12px;">
          <p>${error}</p>
        </div>
        <button class="btn btn-primary btn-sm" style="margin-top: 8px;" onClick=${handleDetectChat}>
          Retry
        </button>
      `}
    </div>
  `;
}

function TelegramAuthToken({ token, setToken, saving, error, handleSaveToken, clearTerminal }) {
  return html`
    <${ChannelSetupWrapper} channel="telegram" clearTerminal=${clearTerminal}>
      <div class="channel-auth-section">
        <h3>Telegram</h3>
        <div class="instruction-box">
          <ol>
            <li>Open Telegram and search for <strong>@BotFather</strong></li>
            <li>Send <strong>/newbot</strong> and follow the prompts</li>
            <li>Choose a name and username (must end in "bot")</li>
            <li>Copy the bot token BotFather gives you</li>
          </ol>
        </div>
        <div class="form-group">
          <label class="form-label">Bot Token</label>
          <input
            type="password"
            class="form-input"
            value=${token}
            onInput=${(e) => setToken(e.target.value)}
            placeholder="123456789:ABCdefGHIjklMNO..."
            disabled=${saving}
          />
        </div>
        <button
          class="btn btn-primary"
          onClick=${handleSaveToken}
          disabled=${!token.trim() || saving}
        >
          ${saving ? 'Saving...' : 'Save Token'}
        </button>
        ${error && html`
          <div class="error-box" style="margin-top: 12px;">
            <p>${error}</p>
          </div>
        `}
      </div>
    <//>
  `;
}

function TelegramAuth({ clearTerminal }) {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [chatInfo, setChatInfo] = useState(null);
  const [error, setError] = useState(null);

  const handleSaveToken = async () => {
    if (!token.trim()) return;
    setSaving(true);
    setError(null);
    clearTerminal();
    try {
      await window.wizard.startStep('telegram-auth', { token: token.trim() });
      setTokenSaved(true);
    } catch (err) {
      setError(err.message || 'Failed to save token');
    }
    setSaving(false);
  };

  const handleDetectChat = async () => {
    setDetecting(true);
    setError(null);
    clearTerminal();
    try {
      const result = await window.wizard.startStep('telegram-chatid');
      setChatInfo(result || { detected: true });
    } catch (err) {
      setError(err.message || 'Failed to detect chat');
    }
    setDetecting(false);
  };

  useEffect(() => {
    const unsub = window.wizard.onStepStatus((data) => {
      if (data.step === 'telegram-chatid' && data.status === 'success' && data.data) {
        setChatInfo(data.data);
      }
    });
    return unsub;
  }, []);

  if (chatInfo) {
    return TelegramAuthDone(chatInfo);
  }
  if (tokenSaved) {
    return TelegramAuthDetect({ detecting, error, handleDetectChat });
  }
  return TelegramAuthToken({ token, setToken, saving, error, handleSaveToken, clearTerminal });
}

function TokenAuth({ channel, label, placeholder, placeholder2, instructions, envKeys, clearTerminal }) {
  const [token, setToken] = useState('');
  const [token2, setToken2] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  const needsTwo = envKeys && envKeys.length > 1;

  const handleSave = async () => {
    if (!token.trim()) return;
    if (needsTwo && !token2.trim()) return;
    setSaving(true);
    setError(null);
    clearTerminal();
    try {
      const args = { token: token.trim() };
      if (needsTwo) args.token2 = token2.trim();
      await window.wizard.startStep(`${channel}-auth`, args);
      setDone(true);
    } catch (err) {
      setError(err.message || 'Failed to save');
    }
    setSaving(false);
  };

  if (done) {
    return html`
      <div class="channel-auth-section">
        <h3>${label}</h3>
        <div class="success-box">
          <span class="success-icon">${'\u2713'}</span>
          <p>${label} connected successfully!</p>
        </div>
      </div>
    `;
  }

  return html`
    <${ChannelSetupWrapper} channel=${channel} clearTerminal=${clearTerminal}>
      <div class="channel-auth-section">
        <h3>${label}</h3>
        <div class="instruction-box">
          <ol>
            ${instructions.map((inst) => html`<li key=${inst}>${inst}</li>`)}
          </ol>
        </div>
        <div class="form-group">
          <label class="form-label">${envKeys ? envKeys[0] : `${label} Token`}</label>
          <input
            type="password"
            class="form-input"
            value=${token}
            onInput=${(e) => setToken(e.target.value)}
            placeholder=${placeholder}
          />
        </div>
        ${needsTwo && html`
          <div class="form-group">
            <label class="form-label">${envKeys[1]}</label>
            <input
              type="password"
              class="form-input"
              value=${token2}
              onInput=${(e) => setToken2(e.target.value)}
              placeholder=${placeholder2 || 'Paste token here'}
            />
          </div>
        `}
        <button
          class="btn btn-primary"
          onClick=${handleSave}
          disabled=${!token.trim() || (needsTwo && !token2.trim()) || saving}
        >
          ${saving ? 'Saving...' : `Connect ${label}`}
        </button>

        ${error && html`
          <div class="error-box" style="margin-top: 12px;">
            <p>${error}</p>
          </div>
        `}
      </div>
    <//>
  `;
}

/**
 * Slack Auth: token input → channel picker → done.
 * After saving the bot + app tokens, fetches channels via REST API and lets user pick one.
 */
function SlackAuth({ clearTerminal }) {
  const [token, setToken] = useState('');
  const [token2, setToken2] = useState('');
  const [saving, setSaving] = useState(false);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [channelList, setChannelList] = useState([]);
  const [chatInfo, setChatInfo] = useState(null);
  const [error, setError] = useState(null);

  // Listen for slack-chatid results
  useEffect(() => {
    const unsub = window.wizard.onStepStatus((data) => {
      if (data.step === 'slack-chatid' && data.status === 'needs_input' && data.data) {
        setChannelList(data.data.channels || []);
        setFetching(false);
      }
      if (data.step === 'slack-chatid' && data.status === 'success' && data.data) {
        setChatInfo(data.data);
      }
    });
    return unsub;
  }, []);

  const handleSaveToken = async () => {
    if (!token.trim() || !token2.trim()) return;
    setSaving(true);
    setError(null);
    clearTerminal();
    try {
      await window.wizard.startStep('slack-auth', { token: token.trim(), token2: token2.trim() });
      setTokenSaved(true);
    } catch (err) {
      setError(err.message || 'Failed to save token');
    }
    setSaving(false);
  };

  const handleFetchChannels = async () => {
    setFetching(true);
    setError(null);
    setChannelList([]);
    clearTerminal();
    try {
      await window.wizard.startStep('slack-chatid');
    } catch (err) {
      setError(err.message || 'Failed to fetch channels');
      setFetching(false);
    }
  };

  const handlePickChannel = async (picked) => {
    setFetching(true);
    setError(null);
    try {
      await window.wizard.startStep('slack-chatid', {
        channelId: picked.id,
        channelName: picked.name,
      });
    } catch (err) {
      setError(err.message || 'Failed to select channel');
      setFetching(false);
    }
  };

  if (chatInfo) {
    return html`
      <div class="channel-auth-section">
        <h3>Slack</h3>
        <div class="success-box">
          <span class="success-icon">${'\u2713'}</span>
          <div>
            <p>Slack connected successfully!</p>
            <p style="font-size: 12px; color: var(--text-secondary); margin: 4px 0 0;">
              Channel: #${chatInfo.chatName} (${chatInfo.chatJid})
            </p>
          </div>
        </div>
      </div>
    `;
  }

  if (tokenSaved) {
    return html`
      <div class="channel-auth-section">
        <h3>Slack</h3>
        <div class="success-box" style="margin-bottom: 16px;">
          <span class="success-icon">${'\u2713'}</span>
          <p>Slack tokens saved!</p>
        </div>

        ${!fetching && channelList.length === 0 && html`
          <div class="instruction-box" style="margin-bottom: 12px;">
            <p style="margin: 0 0 8px; font-weight: 600;">Select a channel to monitor:</p>
            <ol>
              <li>Make sure the bot has been <strong>invited to a channel</strong> in Slack (/invite @botname)</li>
              <li>Click "Fetch Channels" to see channels the bot can access</li>
            </ol>
          </div>
          <button class="btn btn-primary" onClick=${handleFetchChannels}>
            ${'\u{1F50D}'} Fetch Channels
          </button>
        `}

        ${fetching && html`
          <${ProgressBar} indeterminate label="Fetching Slack channels..." />
        `}

        ${channelList.length > 0 && html`
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
                ${ch.num_members != null && html`
                  <span class="channel-picker-meta">${ch.num_members} members</span>
                `}
              </button>
            `)}
          </div>
          <button class="btn btn-ghost btn-sm" style="margin-top: 8px;" onClick=${handleFetchChannels}>
            ${'\u{1F504}'} Refresh
          </button>
        `}

        ${error && html`
          <div class="error-box" style="margin-top: 12px;"><p>${error}</p></div>
          <button class="btn btn-primary btn-sm" style="margin-top: 8px;" onClick=${handleFetchChannels}>
            Retry
          </button>
        `}
      </div>
    `;
  }

  return html`
    <${ChannelSetupWrapper} channel="slack" clearTerminal=${clearTerminal}>
      <div class="channel-auth-section">
        <h3>Slack</h3>
        <div class="instruction-box">
          <ol>
            <li>Go to <strong>api.slack.com/apps</strong> and create a new app</li>
            <li>Enable Socket Mode and copy the App Token (starts with xapp-)</li>
            <li>Add OAuth scopes: <strong>chat:write, channels:history, groups:history, im:history</strong></li>
            <li>
              Under <strong>Event Subscriptions</strong>, subscribe to bot events:
              <strong>message.channels</strong>, <strong>message.groups</strong>, <strong>message.im</strong>
              <br/>
              <span style="font-size: 12px; color: var(--text-secondary);">
                (required — without this the bot won't receive any messages)
              </span>
            </li>
            <li>Install to workspace and copy the Bot Token (starts with xoxb-)</li>
          </ol>
        </div>
        <div class="form-group">
          <label class="form-label">SLACK_BOT_TOKEN</label>
          <input
            type="password"
            class="form-input"
            value=${token}
            onInput=${(e) => setToken(e.target.value)}
            placeholder="xoxb-..."
            disabled=${saving}
          />
        </div>
        <div class="form-group">
          <label class="form-label">SLACK_APP_TOKEN</label>
          <input
            type="password"
            class="form-input"
            value=${token2}
            onInput=${(e) => setToken2(e.target.value)}
            placeholder="xapp-..."
            disabled=${saving}
          />
        </div>
        <button
          class="btn btn-primary"
          onClick=${handleSaveToken}
          disabled=${!token.trim() || !token2.trim() || saving}
        >
          ${saving ? 'Saving...' : 'Save Tokens'}
        </button>
        ${error && html`
          <div class="error-box" style="margin-top: 12px;"><p>${error}</p></div>
        `}
      </div>
    <//>
  `;
}

/**
 * Discord Auth: token input → channel picker → done.
 * After saving the bot token, fetches servers/channels via REST API and lets user pick one.
 */
function DiscordAuth({ clearTerminal }) {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [channelList, setChannelList] = useState([]);
  const [chatInfo, setChatInfo] = useState(null);
  const [error, setError] = useState(null);

  // Listen for discord-chatid results
  useEffect(() => {
    const unsub = window.wizard.onStepStatus((data) => {
      if (data.step === 'discord-chatid' && data.status === 'needs_input' && data.data) {
        setChannelList(data.data.channels || []);
        setFetching(false);
      }
      if (data.step === 'discord-chatid' && data.status === 'success' && data.data) {
        setChatInfo(data.data);
      }
    });
    return unsub;
  }, []);

  const handleSaveToken = async () => {
    if (!token.trim()) return;
    setSaving(true);
    setError(null);
    clearTerminal();
    try {
      await window.wizard.startStep('discord-auth', { token: token.trim() });
      setTokenSaved(true);
    } catch (err) {
      setError(err.message || 'Failed to save token');
    }
    setSaving(false);
  };

  const handleFetchChannels = async () => {
    setFetching(true);
    setError(null);
    setChannelList([]);
    clearTerminal();
    try {
      await window.wizard.startStep('discord-chatid');
    } catch (err) {
      setError(err.message || 'Failed to fetch channels');
      setFetching(false);
    }
  };

  const handlePickChannel = async (picked) => {
    setFetching(true);
    setError(null);
    try {
      await window.wizard.startStep('discord-chatid', {
        channelId: picked.id,
        channelName: picked.name,
      });
    } catch (err) {
      setError(err.message || 'Failed to select channel');
      setFetching(false);
    }
  };

  if (chatInfo) {
    return html`
      <div class="channel-auth-section">
        <h3>Discord</h3>
        <div class="success-box">
          <span class="success-icon">${'\u2713'}</span>
          <div>
            <p>Discord connected successfully!</p>
            <p style="font-size: 12px; color: var(--text-secondary); margin: 4px 0 0;">
              Channel: #${chatInfo.chatName} (${chatInfo.chatJid})
            </p>
          </div>
        </div>
      </div>
    `;
  }

  if (tokenSaved) {
    return html`
      <div class="channel-auth-section">
        <h3>Discord</h3>
        <div class="success-box" style="margin-bottom: 16px;">
          <span class="success-icon">${'\u2713'}</span>
          <p>Discord bot token saved!</p>
        </div>

        ${!fetching && channelList.length === 0 && html`
          <div class="instruction-box" style="margin-bottom: 12px;">
            <p style="margin: 0 0 8px; font-weight: 600;">Select a channel to monitor:</p>
            <ol>
              <li>Make sure the bot has been <strong>invited to your server</strong> via the OAuth2 URL</li>
              <li>Click "Fetch Channels" to see available text channels</li>
            </ol>
          </div>
          <button class="btn btn-primary" onClick=${handleFetchChannels}>
            ${'\u{1F50D}'} Fetch Channels
          </button>
        `}

        ${fetching && html`
          <${ProgressBar} indeterminate label="Fetching Discord channels..." />
        `}

        ${channelList.length > 0 && html`
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
                ${ch.guildName && html`
                  <span class="channel-picker-meta">${ch.guildName}</span>
                `}
              </button>
            `)}
          </div>
          <button class="btn btn-ghost btn-sm" style="margin-top: 8px;" onClick=${handleFetchChannels}>
            ${'\u{1F504}'} Refresh
          </button>
        `}

        ${error && html`
          <div class="error-box" style="margin-top: 12px;"><p>${error}</p></div>
          <button class="btn btn-primary btn-sm" style="margin-top: 8px;" onClick=${handleFetchChannels}>
            Retry
          </button>
        `}
      </div>
    `;
  }

  return html`
    <${ChannelSetupWrapper} channel="discord" clearTerminal=${clearTerminal}>
      <div class="channel-auth-section">
        <h3>Discord</h3>
        <div class="instruction-box">
          <ol>
            <li>Go to <strong>discord.com/developers/applications</strong></li>
            <li>Create a new application and go to Bot tab</li>
            <li>Click "Reset Token" and copy it (shown only once!)</li>
            <li>Enable "Message Content Intent" under Privileged Intents</li>
            <li>Use OAuth2 URL Generator (scope: bot) to invite to your server</li>
          </ol>
        </div>
        <div class="form-group">
          <label class="form-label">DISCORD_BOT_TOKEN</label>
          <input
            type="password"
            class="form-input"
            value=${token}
            onInput=${(e) => setToken(e.target.value)}
            placeholder="Bot token..."
            disabled=${saving}
          />
        </div>
        <button
          class="btn btn-primary"
          onClick=${handleSaveToken}
          disabled=${!token.trim() || saving}
        >
          ${saving ? 'Saving...' : 'Save Token'}
        </button>
        ${error && html`
          <div class="error-box" style="margin-top: 12px;"><p>${error}</p></div>
        `}
      </div>
    <//>
  `;
}

/**
 * Gmail Auth: paste gcp-oauth.keys.json JSON → run OAuth flow (browser opens) → done.
 * Different from the others because Gmail doesn't use env tokens.
 */
function GmailAuth({ clearTerminal }) {
  const [credentials, setCredentials] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async () => {
    if (!credentials.trim()) return;
    // Quick JSON validation on the client
    try {
      JSON.parse(credentials);
    } catch {
      setError('The credentials file is not valid JSON. Paste the exact file contents.');
      return;
    }
    setSaving(true);
    setError(null);
    clearTerminal();
    try {
      await window.wizard.startStep('gmail-auth', { credentials: credentials.trim() });
      setDone(true);
    } catch (err) {
      setError(err.message || 'Failed to authorize Gmail');
    }
    setSaving(false);
  };

  if (done) {
    return html`
      <div class="channel-auth-section">
        <h3>Gmail</h3>
        <div class="success-box">
          <span class="success-icon">${'\u2713'}</span>
          <p>Gmail authorized successfully!</p>
        </div>
      </div>
    `;
  }

  return html`
    <${ChannelSetupWrapper} channel="gmail" clearTerminal=${clearTerminal}>
      <div class="channel-auth-section">
        <h3>Gmail</h3>
        <div class="instruction-box">
          <ol>
            <li>Go to <strong>console.cloud.google.com</strong> and create or select a project</li>
            <li>Enable the Gmail API (APIs & Services → Library → "Gmail API" → Enable)</li>
            <li>Create OAuth credentials: APIs & Services → Credentials → Create → OAuth client ID → Desktop app</li>
            <li>Download the JSON file (click the download icon next to your credential)</li>
            <li>Paste the entire file contents below</li>
          </ol>
          <p style="margin: 8px 0 0; font-size: 12px; color: var(--text-secondary);">
            ${'\u26A0\uFE0F'} After you click Authorize, a browser window will open for Google sign-in.
            If you see an "app not verified" warning, click Advanced → Go to (app) (unsafe) — normal for personal OAuth apps.
          </p>
        </div>
        <div class="form-group">
          <label class="form-label">gcp-oauth.keys.json contents</label>
          <textarea
            class="form-input"
            rows="8"
            value=${credentials}
            onInput=${(e) => setCredentials(e.target.value)}
            placeholder='{"installed": {"client_id": "...", "client_secret": "..."}}'
            disabled=${saving}
            style="font-family: monospace; font-size: 12px;"
          ></textarea>
        </div>
        ${saving && html`
          <${ProgressBar} indeterminate label="Running OAuth flow — check your browser..." />
          <p style="text-align: center; color: var(--text-secondary); font-size: 13px; margin-top: 8px;">
            A browser window should have opened. Sign in with your Google account and grant access.
          </p>
        `}
        ${!saving && html`
          <button
            class="btn btn-primary"
            onClick=${handleSave}
            disabled=${!credentials.trim()}
          >
            Authorize Gmail
          </button>
        `}
        ${error && !saving && html`
          <div class="error-box" style="margin-top: 12px;"><p>${error}</p></div>
          <button class="btn btn-primary btn-sm" style="margin-top: 8px;" onClick=${handleSave}>
            Retry
          </button>
        `}
      </div>
    <//>
  `;
}

export function ChannelAuth({ onNext, onBack, wizardState, stepStatus, clearTerminal }) {
  const channels = wizardState?.selectedChannels || [];

  if (channels.length === 0) {
    return html`
      <div class="screen channel-auth-screen">
        <h2 class="screen-title">Connect Your Channels</h2>
        <p class="screen-desc">No channels selected. Go back to add some.</p>
        <div class="screen-actions">
          <button class="btn btn-ghost" onClick=${onBack}>Back</button>
          <button class="btn btn-primary" onClick=${onNext}>Skip</button>
        </div>
      </div>
    `;
  }

  return html`
    <div class="screen channel-auth-screen">
      <h2 class="screen-title">Connect Your Channels</h2>
      <p class="screen-desc">
        Each channel will be added to your NanoClaw and then authenticated.
        Follow the instructions for each one below.
      </p>

      <div class="auth-sections">
        ${channels.includes('whatsapp') && html`
          <${WhatsAppAuth} clearTerminal=${clearTerminal} />
        `}

        ${channels.includes('telegram') && html`
          <${TelegramAuth} clearTerminal=${clearTerminal} />
        `}

        ${channels.includes('slack') && html`
          <${SlackAuth} clearTerminal=${clearTerminal} />
        `}

        ${channels.includes('discord') && html`
          <${DiscordAuth} clearTerminal=${clearTerminal} />
        `}

        ${channels.includes('gmail') && html`
          <${GmailAuth} clearTerminal=${clearTerminal} />
        `}
      </div>

      <div class="screen-actions">
        <button class="btn btn-ghost" onClick=${onBack}>Back</button>
        <button class="btn btn-primary" onClick=${onNext}>
          Continue
        </button>
      </div>
    </div>
  `;
}
