import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerIpcHandlers } from './ipc-handlers.js';
import { StateManager } from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set the product name as early as possible so menus, dock, and userData path
// all use "WizClaw" instead of the package.json "name" field.
app.setName('WizClaw');

let mainWindow: BrowserWindow | null = null;
let ipcRegistered = false;

function createWindow(): void {
  // Platform-appropriate icon for the BrowserWindow (affects taskbar on
  // Windows/Linux during dev). macOS gets its icon from the .app bundle,
  // so this is mostly a no-op there — see package.json "build.mac.icon".
  const iconDir = path.join(__dirname, '..', 'images');
  const iconPath =
    process.platform === 'win32'
      ? path.join(iconDir, 'icon.ico')
      : path.join(iconDir, 'icon.png');

  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 780,
    minHeight: 580,
    title: 'WizClaw',
    icon: iconPath,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#1c1e20',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const rendererPath = path.join(__dirname, '..', 'renderer', 'index.html');
  mainWindow.loadFile(rendererPath);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  const stateManager = new StateManager();
  await stateManager.load();

  createWindow();

  if (!ipcRegistered) {
    registerIpcHandlers(mainWindow!, stateManager);
    ipcRegistered = true;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
