const { app, Tray, Menu, BrowserWindow, nativeImage, clipboard, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const LIFELINE_DIR = path.join(__dirname, '..', 'lifeline');
const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'server-settings.json');

let tray = null;
let adminWindow = null;
let serverProcess = null;
let lifelineProcess = null;
let serverPort = 3033;
let serverToken = '';
let serverHealthy = false;
let healthInterval = null;

// ── Read settings to get port/token ─────────────────────────

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw);
    serverPort = settings.port || 3033;
    serverToken = settings.authToken || '';
  } catch {
    // Settings file may not exist yet (first run)
  }
}

// ── Server management ───────────────────────────────────────

function startServer() {
  if (serverProcess) return;

  const nodePath = process.execPath.includes('electron')
    ? 'node'  // Use system node when running via Electron
    : process.execPath;

  serverProcess = spawn(nodePath, ['server.js'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  serverProcess.stdout.on('data', (data) => {
    const text = data.toString();
    process.stdout.write(text);
    // Parse token from startup banner
    const tokenMatch = text.match(/Token:\s+([a-f0-9]+)/);
    if (tokenMatch) {
      serverToken = tokenMatch[1];
    }
    const portMatch = text.match(/localhost:(\d+)/);
    if (portMatch) {
      serverPort = parseInt(portMatch[1]);
    }
  });

  serverProcess.stderr.on('data', (data) => {
    console.error('[server]', data.toString());
  });

  serverProcess.on('exit', (code) => {
    console.log(`Server exited with code ${code}`);
    serverProcess = null;
    updateTrayIcon(false);

    // Restart on crash (non-zero exit), but not on clean shutdown
    if (code && code !== 0) {
      console.log('Server crashed, restarting in 3s...');
      setTimeout(startServer, 3000);
    }
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

function restartServer() {
  stopServer();
  setTimeout(startServer, 1000);
}

// ── Lifeline (independent process, never updated) ───────────

function startLifeline() {
  if (lifelineProcess) return;
  const lifelineServer = path.join(LIFELINE_DIR, 'server.js');
  if (!fs.existsSync(lifelineServer)) return;

  lifelineProcess = spawn('node', ['server.js'], {
    cwd: LIFELINE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  lifelineProcess.stdout.on('data', (data) => {
    console.log('[lifeline]', data.toString().trim());
  });
  lifelineProcess.stderr.on('data', (data) => {
    console.error('[lifeline]', data.toString().trim());
  });
  lifelineProcess.on('exit', (code) => {
    console.log(`[lifeline] exited with code ${code}`);
    lifelineProcess = null;
  });
}

function stopLifeline() {
  if (lifelineProcess) {
    lifelineProcess.kill('SIGTERM');
    lifelineProcess = null;
  }
}

// ── Health check ────────────────────────────────────────────

function checkHealth() {
  if (!serverToken) {
    readSettings();
  }

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

  tray.on('click', () => {
    openAdmin();
  });
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
      label: serverHealthy ? 'Status: Running' : 'Status: Offline',
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
        if (serverToken) {
          clipboard.writeText(serverToken);
        }
      },
    },
    {
      label: 'Copy Phone URL',
      click: () => {
        readSettings();
        // Read connection info for best URL
        try {
          const connInfo = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'connection-info.json'), 'utf8'));
          clipboard.writeText(connInfo.bestUrl || `http://localhost:${serverPort}?token=${serverToken}`);
        } catch {
          clipboard.writeText(`http://localhost:${serverPort}?token=${serverToken}`);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Restart Server',
      click: () => restartServer(),
    },
    {
      label: 'Start on Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        stopServer();
        stopLifeline();
        app.quit();
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

  const adminUrl = `http://localhost:${serverPort}/admin?token=${serverToken}`;
  adminWindow.loadURL(adminUrl);

  // Minimize to tray instead of closing
  adminWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      adminWindow.hide();
    }
  });

  adminWindow.on('closed', () => {
    adminWindow = null;
  });
}

// ── App lifecycle ───────────────────────────────────────────

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openAdmin();
  });
}

app.on('ready', () => {
  // Don't show in dock on macOS (tray-only app)
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  readSettings();
  createTray();
  startLifeline();
  startServer();

  // Start health checking after a short delay
  setTimeout(() => {
    checkHealth();
    healthInterval = setInterval(checkHealth, 10000);
  }, 3000);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  clearInterval(healthInterval);
  stopServer();
  stopLifeline();
});

// Keep app running when all windows are closed (tray app)
app.on('window-all-closed', (e) => {
  // Don't quit — we live in the tray
});
