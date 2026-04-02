const { app, Tray, Menu, BrowserWindow, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

// Tray monitor — launched by the server, not the other way around.
// Reads port/token from args or settings, health-checks, shows tray icon.

const DATA_DIR = process.env.CLAUDE_REMOTE_DATA || path.join(os.homedir(), '.claude-remote');
const SETTINGS_PATH = path.join(DATA_DIR, 'server-settings.json');
// Fallback to old data dir location if new one doesn't exist
const LEGACY_SETTINGS = path.join(__dirname, '..', 'data', 'server-settings.json');

let tray = null;
let adminWindow = null;
let serverPort = 3033;
let serverToken = '';
let serverHealthy = false;
let healthInterval = null;

function readSettings() {
  try {
    const p = fs.existsSync(SETTINGS_PATH) ? SETTINGS_PATH : LEGACY_SETTINGS;
    const raw = fs.readFileSync(p, 'utf8');
    const settings = JSON.parse(raw);
    serverPort = settings.port || 3033;
    serverToken = settings.authToken || '';
  } catch {}
}

// Read settings early so we know the port for the instance lock
readSettings();

// Use a unique user-data dir per port so prod (3033) and dev (3034) don't conflict
app.setPath('userData', path.join(app.getPath('userData'), '..', `claude-remote-${serverPort}`));

function getConnectionInfoPath() {
  const p = path.join(DATA_DIR, 'connection-info.json');
  if (fs.existsSync(p)) return p;
  return path.join(__dirname, '..', 'data', 'connection-info.json');
}

// ── Health check ────────────────────────────────────────────

function checkHealth() {
  if (!serverToken) readSettings();

  const req = http.get(`http://localhost:${serverPort}/api/info?token=${serverToken}`, (res) => {
    let body = '';
    res.on('data', (d) => body += d);
    res.on('end', () => {
      const healthy = res.statusCode === 200;
      if (healthy !== serverHealthy) {
        serverHealthy = healthy;
        updateTrayIcon(healthy);
      }
    });
  });
  req.on('error', () => {
    if (serverHealthy) {
      serverHealthy = false;
      updateTrayIcon(false);
    }
  });
  req.setTimeout(5000, () => req.destroy());
}

// ── Tray ────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.resize({ width: 22, height: 22 }));
  tray.setToolTip('Claude Remote');
  updateTrayMenu();

  tray.on('click', () => openAdmin());
}

function updateTrayIcon(healthy) {
  if (!tray) return;
  const iconName = healthy ? 'tray-icon.png' : 'tray-icon-red.png';
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', iconName));
  tray.setImage(icon.resize({ width: 22, height: 22 }));
  tray.setToolTip(healthy ? 'Claude Remote — Running' : 'Claude Remote — Offline');
  updateTrayMenu();
}

function updateTrayMenu() {
  const template = [
    {
      label: serverHealthy ? `Running — port ${serverPort}` : 'Offline',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open Admin Panel',
      click: () => openAdmin(),
    },
    {
      label: 'Copy Token',
      click: () => {
        readSettings();
        if (serverToken) clipboard.writeText(serverToken);
      },
    },
    {
      label: 'Copy Phone URL',
      click: () => {
        readSettings();
        try {
          const connInfo = JSON.parse(fs.readFileSync(getConnectionInfoPath(), 'utf8'));
          clipboard.writeText(connInfo.bestUrl || `http://localhost:${serverPort}?token=${serverToken}`);
        } catch {
          clipboard.writeText(`http://localhost:${serverPort}?token=${serverToken}`);
        }
      },
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

// ── Admin window ────────────────────────────────────────────

function openAdmin() {
  if (adminWindow) {
    adminWindow.show();
    adminWindow.focus();
    return;
  }

  readSettings();
  adminWindow = new BrowserWindow({
    width: 800,
    height: 700,
    title: 'Claude Remote — Admin',
    backgroundColor: '#0b0c10',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  adminWindow.loadURL(`http://localhost:${serverPort}/admin?token=${serverToken}`);

  adminWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      adminWindow.hide();
    }
  });

  adminWindow.on('closed', () => { adminWindow = null; });
}

// ── App lifecycle ───────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another tray instance is already running — silently exit.
  // The server will try to respawn us, but the existing instance is fine.
  app.quit();
}

app.on('ready', () => {
  if (process.platform === 'darwin') app.dock.hide();

  createTray();

  // Start health checking
  setTimeout(() => {
    checkHealth();
    healthInterval = setInterval(checkHealth, 10000);
  }, 2000);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  clearInterval(healthInterval);
});

app.on('window-all-closed', () => {
  // Don't quit — tray app
});
