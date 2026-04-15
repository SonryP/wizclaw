# WizClaw

Visual setup wizard for [NanoClaw](https://github.com/qwibitai/nanoclaw) — a
native desktop installer that turns the CLI setup into a point-and-click
experience for non-technical users.

Double-click the app, click through the steps, and you end up with a running
NanoClaw instance connected to WhatsApp, Telegram, Slack, Discord, or Gmail
— no terminal required.

## What it does

- **Detects and installs prerequisites** — Node.js, Docker, git, Xcode CLI
  tools. Green check or one-click install for each.
- **Clones NanoClaw** or points at an existing checkout.
- **Runs the full setup pipeline** — `setup.sh`, `npm ci`, container build,
  credential configuration — with streaming terminal output so you can see
  what's happening.
- **Handles channel auth** — QR code in-app for WhatsApp, token forms for
  Telegram / Slack / Discord, pasted JSON credentials for Gmail.
- **Registers the chat** — detects the chat ID for each channel (polling
  getUpdates for Telegram, picker for Slack/Discord) and writes the
  registered group to NanoClaw's database.
- **Installs and starts the service** — launchd on macOS, systemd user unit
  on Linux.
- **Post-install dashboard** — add/remove channels, manage groups, tail
  logs, and restart the service without leaving the app.

## Stack

- **Electron** (main + renderer, secure preload bridge)
- **TypeScript** for the main process
- **Preact + HTM** loaded via CDN in the renderer (no bundler, no build step
  for the UI)
- **electron-builder** for `.dmg` / `.exe` packaging

NanoClaw itself is spawned as child processes — WizClaw never imports
NanoClaw code directly, so it stays decoupled from NanoClaw's versioning.

## Layout

```
main/                 Electron main process (TypeScript)
  index.ts            App entry, window creation
  ipc-handlers.ts     All IPC handlers — setup orchestration,
                      channel auth, service control, dashboard ops
  step-runner.ts      Child process spawning with stdout streaming
  state.ts            Wizard state persistence (~/.nanoclaw-wizard/state.json)
  preload.ts          Secure main↔renderer bridge
  prereqs/            Prerequisite detection and installation
    node.ts / docker.ts / git.ts / claude.ts

renderer/             Preact SPA (plain JS, no build)
  index.html          Shell with import maps
  app.js              Router + state
  components/         Reusable UI (Stepper, Terminal, ChannelCard, ...)
  screens/            One file per wizard screen
    Welcome / Prerequisites / GetNanoClaw / Dependencies /
    ContainerSetup / Credentials / ChannelSelect / ChannelAuth /
    ChatPicker / Security / StartService / Done / Dashboard
```

## Running locally

```bash
npm install
npm run dev
```

This compiles the TypeScript main process (`tsc`) and launches Electron.
Renderer files are loaded as-is — edit and reload the window to see
changes.

## Packaging

```bash
npm run dist
```

Produces a `.dmg` (macOS) or `.exe` installer (Windows) in `release/` via
electron-builder.

## State

WizClaw persists progress to `~/.nanoclaw-wizard/state.json`:

```json
{
  "currentStep": 5,
  "completedSteps": { "prerequisites": { "node": "22.5.0", ... }, ... },
  "nanoClawPath": "/Users/you/nanoclaw",
  "selectedChannels": ["whatsapp", "telegram"],
  "timestamp": "2026-04-15T..."
}
```

On relaunch, the wizard resumes from the last completed step.

## Platform support

- **macOS** — primary target, fully working (launchd service install)
- **Linux** — service step uses systemd user units; other steps are
  portable
- **Windows** — `npx.cmd` resolution is in place but full flow is
  untested

## License

[MIT](LICENSE) © Víctor Vásquez
