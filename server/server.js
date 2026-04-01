import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import crypto from 'crypto';
import os from 'os';
import { SessionManager } from './sessions.js';
import { Updater } from './updater.js';
import { loadServerSettings, saveServerSettings, hashPassword, verifyPassword } from './settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config (persistent) ────────────────────────────────────────────
const settings = loadServerSettings();

// Generate and persist auth token on first run
if (!settings.authToken) {
  settings.authToken = crypto.randomBytes(16).toString('hex');
  saveServerSettings(settings);
}

const PORT = settings.port;
const AUTH_TOKEN = settings.authToken;
const AUTO_UPDATE = settings.autoUpdate;

// ── App Setup ───────────────────────────────────────────────────────
const app = express();
const server = createServer(app);
const sessions = new SessionManager();
const updater = new Updater({ autoCheck: AUTO_UPDATE });

// Forward update events to all WS clients
updater.on('update-available', (info) => {
  const msg = JSON.stringify({ type: 'update:available', data: info });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
});

app.use(express.json());

// CORS — allow Capacitor WebView (capacitor://localhost) and any origin
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve client from sibling directory
app.use(express.static(join(__dirname, '..', 'client', 'www')));

// Admin page (clean URL)
app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, '..', 'client', 'www', 'admin.html'));
});

// ── Auth middleware ──────────────────────────────────────────────────
function authCheck(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') ||
                req.query.token;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Auth endpoints (no authCheck — these exchange password for token) ──

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }
  if (!settings.password) {
    return res.status(400).json({ error: 'No password set — use token auth or set a password from the admin panel' });
  }
  if (!verifyPassword(password, settings.password)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: AUTH_TOKEN });
});

// ── REST API ────────────────────────────────────────────────────────

// List all sessions
app.get('/api/sessions', authCheck, (req, res) => {
  res.json(sessions.list());
});

// Create session
app.post('/api/sessions', authCheck, (req, res) => {
  try {
    const { name, cwd } = req.body;
    const session = sessions.create({ name, cwd });
    res.status(201).json(session);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get session
app.get('/api/sessions/:id', authCheck, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  res.json(session);
});

// Rename session
app.patch('/api/sessions/:id', authCheck, (req, res) => {
  try {
    const session = sessions.rename(req.params.id, req.body.name);
    res.json(session);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Reconnect a dead session (spawns new pty in same directory)
app.post('/api/sessions/:id/reconnect', authCheck, (req, res) => {
  try {
    const session = sessions.reconnect(req.params.id);
    res.json(session);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Kill session
app.delete('/api/sessions/:id', authCheck, (req, res) => {
  sessions.kill(req.params.id);
  res.json({ ok: true });
});

// List directory
app.get('/api/files', authCheck, (req, res) => {
  try {
    const dir = req.query.path || os.homedir();
    const entries = sessions.listDirectory(dir);
    res.json({ path: dir, entries });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Server info
app.get('/api/info', authCheck, (req, res) => {
  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    home: os.homedir(),
    uptime: process.uptime(),
  });
});

// ── Version & Update API ────────────────────────────────────────────

// Current version + git info
app.get('/api/version', authCheck, (req, res) => {
  res.json({
    ...updater.getVersion(),
    git: updater.getGitInfo(),
    updateAvailable: updater.updateAvailable,
    lastCheck: updater.lastCheck,
  });
});

// Check for updates
app.post('/api/update/check', authCheck, async (req, res) => {
  try {
    const result = await updater.check();
    res.json({ updateAvailable: !!result, details: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apply update (git pull + install deps)
app.post('/api/update/apply', authCheck, async (req, res) => {
  try {
    const result = await updater.apply();
    res.json(result);
    // Schedule restart so the response gets sent first
    if (result.needsRestart) {
      updater.scheduleRestart(2000);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force restart server (no update, just restart)
app.post('/api/restart', authCheck, (req, res) => {
  res.json({ ok: true, message: 'Restarting in 2s...' });
  updater.scheduleRestart(2000);
});

// ── APK distribution ───────────────────────────────────────────────

const APK_PATH = join(__dirname, '..', 'client', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

// Check app version (unauthenticated — so the bootstrap screen can check)
app.get('/api/app/version', (req, res) => {
  try {
    const ver = JSON.parse(readFileSync(join(__dirname, '..', 'version.json'), 'utf8'));
    const hasApk = existsSync(APK_PATH);
    let apkSize = null;
    if (hasApk) {
      apkSize = statSync(APK_PATH).size;
    }
    res.json({ version: ver.version, hasApk, apkSize });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download APK
app.get('/api/app/download', (req, res) => {
  if (!existsSync(APK_PATH)) {
    return res.status(404).json({ error: 'APK not built. Run: cd client/android && ./gradlew assembleDebug' });
  }
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="claude-remote.apk"');
  res.download(APK_PATH, 'claude-remote.apk');
});

// ── Admin API ──────────────────────────────────────────────────────

// Set or change password
app.post('/api/admin/password', authCheck, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 1) {
    return res.status(400).json({ error: 'Password required' });
  }
  settings.password = hashPassword(password);
  saveServerSettings(settings);
  res.json({ ok: true, message: 'Password set' });
});

// Remove password (revert to token-only auth)
app.delete('/api/admin/password', authCheck, (req, res) => {
  settings.password = null;
  saveServerSettings(settings);
  res.json({ ok: true, message: 'Password removed' });
});

// Get current auth token (for sharing with new devices)
app.get('/api/admin/token', authCheck, (req, res) => {
  res.json({ token: AUTH_TOKEN });
});

// Client settings schema (for migrations)
app.get('/api/settings-schema', authCheck, (req, res) => {
  try {
    const versionData = updater.getVersion();
    res.json({
      settingsVersion: versionData.settingsVersion,
      appVersion: versionData.version,
    });
  } catch (err) {
    res.json({ settingsVersion: 1, appVersion: '0.0.0' });
  }
});

// ── WebSocket ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const connectedClients = new Map(); // ws → { ip, connectedAt, subscribedSession }

// Admin status endpoint
app.get('/api/admin/status', authCheck, (req, res) => {
  const clients = [];
  for (const [, info] of connectedClients) {
    clients.push({ ip: info.ip, connectedAt: info.connectedAt, subscribedSession: info.subscribedSession });
  }
  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: process.uptime(),
    port: PORT,
    version: updater.getVersion(),
    passwordSet: !!settings.password,
    clients,
    sessions: sessions.list(),
    ips: detectIPs(),
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (token !== AUTH_TOKEN) {
    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    ws.close(4001, 'Unauthorized');
    return;
  }

  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  connectedClients.set(ws, { ip: clientIp, connectedAt: Date.now(), subscribedSession: null });

  let subscribedSession = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        // Subscribe to a session's output stream
        case 'subscribe': {
          // Unsub from previous
          if (subscribedSession) {
            sessions.unsubscribe(subscribedSession, ws);
          }
          sessions.subscribe(msg.sessionId, ws);
          subscribedSession = msg.sessionId;
          const clientInfo = connectedClients.get(ws);
          if (clientInfo) clientInfo.subscribedSession = msg.sessionId;
          console.log(`[ws] client subscribed to ${msg.sessionId}`);
          ws.send(JSON.stringify({ type: 'subscribed', sessionId: msg.sessionId }));
          break;
        }

        // Unsubscribe
        case 'unsubscribe': {
          if (subscribedSession) {
            sessions.unsubscribe(subscribedSession, ws);
            subscribedSession = null;
          }
          break;
        }

        // Send input to a session
        case 'input': {
          console.log(`[ws] input to ${msg.sessionId}: ${JSON.stringify(msg.data).slice(0, 50)}`);
          sessions.write(msg.sessionId, msg.data);
          break;
        }

        // Resize terminal
        case 'resize': {
          sessions.resize(msg.sessionId, msg.cols, msg.rows);
          break;
        }

        // Get fresh session list (push over WS)
        case 'list': {
          ws.send(JSON.stringify({ type: 'sessions', data: sessions.list() }));
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    sessions.unsubscribeAll(ws);
    connectedClients.delete(ws);
  });

  // Send initial session list
  ws.send(JSON.stringify({ type: 'sessions', data: sessions.list() }));
});

// Broadcast session list changes to all connected clients
function broadcastSessionList() {
  const list = sessions.list();
  const msg = JSON.stringify({ type: 'sessions', data: list });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

sessions.on('session:created', broadcastSessionList);
sessions.on('session:killed', broadcastSessionList);
sessions.on('session:exit', broadcastSessionList);
sessions.on('session:reconnected', broadcastSessionList);

// Broadcast attention events to ALL connected clients (not just session subscribers)
// so phones get notifications even when on the dashboard or recently reconnected
sessions.on('session:attention', (sessionId, reason, preview) => {
  const msg = JSON.stringify({ type: 'session:attention', sessionId, reason, preview });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
});

// Periodic status broadcast (so dashboard stays fresh)
setInterval(() => {
  if (wss.clients.size > 0) broadcastSessionList();
}, 3000);

// ── Network detection ───────────────────────────────────────────────
function detectIPs() {
  const nets = os.networkInterfaces();
  let lanIp = null;
  let tailscaleIp = null;

  for (const [name, addrs] of Object.entries(nets)) {
    for (const net of addrs) {
      if (net.family !== 'IPv4' || net.internal) continue;

      // Tailscale uses 100.x.x.x (CGNAT range) on interface tailscale0 / utun*
      const isTailscale = name.startsWith('tailscale') ||
                          name.startsWith('utun') ||      // macOS Tailscale
                          net.address.startsWith('100.');  // Tailscale CGNAT range

      if (isTailscale && net.address.startsWith('100.')) {
        tailscaleIp = net.address;
      } else if (!lanIp) {
        lanIp = net.address;
      }
    }
  }

  return { lanIp: lanIp || 'unknown', tailscaleIp };
}

// ── Start ───────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const { lanIp, tailscaleIp } = detectIPs();

  const lines = [
    '',
    '┌──────────────────────────────────────────────────────────┐',
    '│  ⌘  Claude Remote Server                                │',
    '├──────────────────────────────────────────────────────────┤',
    `│  Local:      http://localhost:${PORT}`,
    `│  LAN:        http://${lanIp}:${PORT}`,
  ];

  if (tailscaleIp) {
    lines.push(`│  Tailscale:  http://${tailscaleIp}:${PORT}   ← use this from anywhere`);
  } else {
    lines.push('│  Tailscale:  not detected (install: https://tailscale.com)');
  }

  lines.push('│');
  lines.push(`│  Token:      ${AUTH_TOKEN}`);
  lines.push('│');

  // Show ready-to-copy full URLs
  const bestIp = tailscaleIp || lanIp;
  const fullUrl = `http://${bestIp}:${PORT}?token=${AUTH_TOKEN}`;
  lines.push('│  ── Copy this URL to your phone ──────────────────────');
  lines.push(`│  ${fullUrl}`);
  lines.push('│');
  lines.push('│  Ctrl+C to stop');
  lines.push('└──────────────────────────────────────────────────────────┘');
  lines.push('');

  console.log(lines.join('\n'));

  // Write connection info file
  const connInfo = JSON.stringify({
    lanIp,
    tailscaleIp,
    port: PORT,
    token: AUTH_TOKEN,
    lanUrl: `http://${lanIp}:${PORT}?token=${AUTH_TOKEN}`,
    tailscaleUrl: tailscaleIp ? `http://${tailscaleIp}:${PORT}?token=${AUTH_TOKEN}` : null,
    bestUrl: fullUrl,
  }, null, 2);

  try {
    writeFileSync(join(__dirname, '..', 'data', 'connection-info.json'), connInfo);
  } catch {
    try { writeFileSync(join(__dirname, '.connection-info.json'), connInfo); } catch {}
  }
});
