import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { join, resolve as resolvePath, basename } from 'path';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import crypto from 'crypto';
import os from 'os';
import archiver from 'archiver';
import { SessionManager } from './sessions.js';
import { Updater } from './updater.js';
import * as whisperMgr from './whisper-manager.js';
import * as ttsMgr from './tts-manager.js';
import { loadServerSettings, saveServerSettings, hashPassword, verifyPassword } from './settings.js';
import {
  PACKAGE_ROOT, getClientWwwDir, getConnectionInfoPath, getDataDir, ensureDataDir,
} from '../lib/paths.js';

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
const sessions = new SessionManager({ port: PORT });
const updater = new Updater({ autoCheck: AUTO_UPDATE });

// Forward update events to all WS clients
updater.on('update-available', (info) => {
  const msg = JSON.stringify({ type: 'update:available', data: info });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
});

app.use(express.json({ limit: '10mb' }));  // allow base64 audio blobs for /api/voice/transcribe

// CORS — allow Capacitor WebView (capacitor://localhost) and any origin
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve client from sibling directory
app.use(express.static(getClientWwwDir()));

// Admin page (clean URL)
app.get('/admin', (req, res) => {
  res.sendFile(join(getClientWwwDir(), 'admin.html'));
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

// ── Hook events from Claude Code (localhost only, no auth) ─────────────
app.post('/api/hooks/event', (req, res) => {
  const ip = req.socket.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { hookType, sessionId, data } = req.body;
  sessions.handleHookEvent(hookType, sessionId, data);
  res.json({ ok: true });
});

// ── PreToolUse preauth (localhost only, no auth) ─────────────────────
// Synchronous decision endpoint. The PreToolUse hook calls this and prints
// the JSON response to stdout, which Claude Code honors as an approve/deny decision.
// Returns an "allow" decision if the session has autoAccept enabled, otherwise {}.
app.post('/api/hooks/preauth', (req, res) => {
  const ip = req.socket.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { sessionId } = req.body || {};
  if (sessionId && sessions.getAutoAccept(sessionId)) {
    return res.json({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Claude Remote auto-accept enabled',
      },
    });
  }
  res.json({});
});

// ── Claude-driven slash-command queue (localhost only, no auth) ────────
// Called by `scripts/cmd` from inside a Claude Remote pty.
// Queued commands are flushed into the pty when the Stop hook fires.
app.post('/api/cmd/queue', (req, res) => {
  const ip = req.socket.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { sessionId, command } = req.body || {};
  if (!sessionId || !command) return res.status(400).json({ error: 'sessionId and command required' });
  sessions.queueCommand(sessionId, command);
  res.json({ ok: true });
});

// ── Voice speak relay (localhost only, no auth) ────────────────────────
// Called by `scripts/speak` from inside a Claude Remote pty.
// Forwards text to the app for TTS via a dedicated WS message.
app.post('/api/voice/speak', async (req, res) => {
  const ip = req.socket.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { sessionId, text } = req.body || {};
  if (!sessionId || !text) return res.status(400).json({ error: 'sessionId and text required' });

  // Prefer server-side Kokoro TTS when available; fall back to client-side Android TTS.
  if (settings.tts?.enabled && ttsMgr.tts.isRunning()) {
    try {
      const result = await ttsMgr.tts.synthesize(text);
      sessions.emitSpeakAudio(sessionId, result.audio_b64, result.format || 'wav');
      return res.json({ ok: true, engine: 'kokoro', ms: result.ms });
    } catch (e) {
      console.error('[tts] synth failed, falling back to Android TTS:', e.message);
      // fall through to text broadcast
    }
  }
  sessions.emitSpeak(sessionId, text);
  res.json({ ok: true, engine: 'android' });
});

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
    const resumeClaude = req.body?.resumeClaude ?? false;
    const claudeSessionId = req.body?.claudeSessionId || null;
    const session = sessions.reconnect(req.params.id, { resumeClaude, claudeSessionId });
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

// Open session in a local terminal window
app.post('/api/sessions/:id/open-terminal', authCheck, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Detect available terminal emulator
  const terminals = ['gnome-terminal', 'kitty', 'alacritty', 'xfce4-terminal', 'konsole', 'xterm'];
  let termCmd = null;
  for (const t of terminals) {
    try { execSync(`which ${t}`, { stdio: 'pipe' }); termCmd = t; break; } catch {}
  }
  if (!termCmd) return res.status(500).json({ error: 'No terminal emulator found' });

  // Build the command to run inside the terminal
  const resumeFlag = session.claudeSessionId ? `--resume ${session.claudeSessionId}` : '--resume';
  const innerCmd = `cd ${JSON.stringify(session.cwd)} && claude ${resumeFlag}`;

  // Spawn the terminal (detached so it outlives any request)
  let spawnArgs;
  switch (termCmd) {
    case 'gnome-terminal': spawnArgs = ['--', 'bash', '-c', innerCmd]; break;
    case 'kitty':          spawnArgs = ['bash', '-c', innerCmd]; break;
    case 'alacritty':      spawnArgs = ['-e', 'bash', '-c', innerCmd]; break;
    case 'xfce4-terminal': spawnArgs = ['-e', `bash -c ${JSON.stringify(innerCmd)}`]; break;
    case 'konsole':        spawnArgs = ['-e', 'bash', '-c', innerCmd]; break;
    case 'xterm':          spawnArgs = ['-e', 'bash', '-c', innerCmd]; break;
    default:               spawnArgs = ['-e', 'bash', '-c', innerCmd];
  }

  const child = cpSpawn(termCmd, spawnArgs, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
  });
  child.unref();

  res.json({ ok: true, terminal: termCmd, cwd: session.cwd });
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

// Download a single file
app.get('/api/files/download', authCheck, (req, res) => {
  const raw = req.query.path;
  if (!raw) return res.status(400).json({ error: 'path required' });
  const resolved = resolvePath(raw);
  let st;
  try {
    st = statSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    if (err.code === 'EACCES') return res.status(403).json({ error: 'permission denied' });
    return res.status(400).json({ error: err.message });
  }
  if (!st.isFile()) return res.status(400).json({ error: 'not a file' });
  res.download(resolved, basename(resolved));
});

// Download a folder as a zip stream
app.get('/api/files/download-zip', authCheck, (req, res) => {
  const raw = req.query.path;
  if (!raw) return res.status(400).json({ error: 'path required' });
  const resolved = resolvePath(raw);
  let st;
  try {
    st = statSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    if (err.code === 'EACCES') return res.status(403).json({ error: 'permission denied' });
    return res.status(400).json({ error: err.message });
  }
  if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });

  const name = basename(resolved) || 'root';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') console.warn('[zip] warning:', err.message);
  });
  archive.on('error', (err) => {
    console.error('[zip] error:', err.message);
    try { res.status(500).end(); } catch {}
  });
  archive.pipe(res);
  archive.directory(resolved, name);
  archive.finalize();
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

const APK_PATH_BUILD = join(PACKAGE_ROOT, 'client', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const APK_PATH_DATA = join(getDataDir(), 'claude-remote.apk');
// Check build output first (git clone), then data dir (npm install / manual download)
const getApkPath = () => existsSync(APK_PATH_BUILD) ? APK_PATH_BUILD : existsSync(APK_PATH_DATA) ? APK_PATH_DATA : null;

// Check app version (unauthenticated — so the bootstrap screen can check)
app.get('/api/app/version', (req, res) => {
  try {
    const ver = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'version.json'), 'utf8'));
    const apkPath = getApkPath();
    const hasApk = !!apkPath;
    let apkSize = null;
    if (hasApk) {
      apkSize = statSync(apkPath).size;
    }
    res.json({ version: ver.version, hasApk, apkSize });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download APK
app.get('/api/app/download', (req, res) => {
  const apkPath = getApkPath();
  if (!apkPath) {
    return res.status(404).json({ error: 'APK not available. Download from GitHub releases.' });
  }
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="claude-remote.apk"');
  res.download(apkPath, 'claude-remote.apk');
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

// ── Whisper (server-side STT) ──────────────────────────────────────

app.post('/api/voice/transcribe', authCheck, async (req, res) => {
  try {
    if (!settings.whisper?.enabled) {
      console.log('[transcribe] rejected: whisper disabled');
      return res.status(503).json({ error: 'whisper disabled' });
    }
    if (!whisperMgr.whisper.isRunning()) {
      console.log('[transcribe] rejected: whisper not running');
      return res.status(503).json({ error: 'whisper not running' });
    }
    const { audio_b64, language } = req.body || {};
    if (!audio_b64) return res.status(400).json({ error: 'audio_b64 required' });
    const buf = Buffer.from(audio_b64, 'base64');
    console.log(`[transcribe] received ${buf.length} bytes`);
    const result = await whisperMgr.whisper.transcribe(buf, { language: language || 'en', timeoutMs: 5000 });
    console.log(`[transcribe] result: text="${result.text}" ms=${result.ms}`);
    res.json(result);
  } catch (e) {
    console.log(`[transcribe] error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/whisper/status', authCheck, (req, res) => {
  res.json({
    enabled: !!settings.whisper?.enabled,
    model: settings.whisper?.model || null,
    device: settings.whisper?.device || 'auto',
    pythonAvailable: !!whisperMgr.findPython3(),
    cudaAvailable: whisperMgr.isCudaAvailable(),
    ffmpegAvailable: whisperMgr.isFfmpegAvailable(),
    venvReady: whisperMgr.isVenvReady(),
    fasterWhisperInstalled: whisperMgr.isFasterWhisperInstalled(),
    running: whisperMgr.whisper.isRunning(),
    currentConfig: whisperMgr.whisper.currentConfig(),
    knownModels: whisperMgr.KNOWN_MODELS,
    installedModels: whisperMgr.listInstalledModels(),
  });
});

// Bootstrap dependencies (venv + faster-whisper). Long-running; streams lines over WS.
app.post('/api/admin/whisper/bootstrap', authCheck, async (req, res) => {
  if (!whisperMgr.findPython3()) return res.status(400).json({ error: 'Python 3 not found on PATH. Install python3 and retry.' });
  res.json({ ok: true, message: 'Bootstrap started — watch whisper:bootstrap-progress WS messages.' });
  // Run async after response
  const broadcast = (line) => {
    const msg = JSON.stringify({ type: 'whisper:bootstrap-progress', line: line.toString().trim() });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };
  try {
    await whisperMgr.bootstrap(broadcast);
    broadcast('__DONE__');
  } catch (e) {
    broadcast(`__ERROR__ ${e.message}`);
  }
});

app.post('/api/admin/whisper/install', authCheck, async (req, res) => {
  const { model } = req.body || {};
  if (!model) return res.status(400).json({ error: 'model required' });
  if (!whisperMgr.KNOWN_MODELS.includes(model)) return res.status(400).json({ error: 'unknown model' });
  if (!whisperMgr.isFasterWhisperInstalled()) return res.status(400).json({ error: 'faster-whisper not installed — bootstrap first' });
  res.json({ ok: true, message: `Installing ${model} — watch whisper:install-progress WS messages.` });

  const broadcast = (line) => {
    const msg = JSON.stringify({ type: 'whisper:install-progress', model, line: line.toString().trim() });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };
  try {
    await whisperMgr.installModel(model, broadcast);
    broadcast('__DONE__');
  } catch (e) {
    broadcast(`__ERROR__ ${e.message}`);
  }
});

app.delete('/api/admin/whisper/models/:name', authCheck, (req, res) => {
  try {
    const name = req.params.name;
    // If this model is currently loaded, stop the helper first.
    if (whisperMgr.whisper.currentConfig()?.model === name) {
      whisperMgr.whisper.stop();
    }
    whisperMgr.deleteModel(name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/whisper/config', authCheck, async (req, res) => {
  const { enabled, model, device } = req.body || {};
  const nextWhisper = {
    enabled: !!enabled,
    model: model || null,
    device: ['auto', 'cpu', 'cuda'].includes(device) ? device : 'auto',
  };
  settings.whisper = nextWhisper;
  saveServerSettings(settings);

  // Sync helper state
  try {
    if (nextWhisper.enabled && nextWhisper.model) {
      await whisperMgr.whisper.start({ model: nextWhisper.model, device: nextWhisper.device });
    } else {
      await whisperMgr.whisper.stop();
    }
    res.json({ ok: true, running: whisperMgr.whisper.isRunning(), config: whisperMgr.whisper.currentConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message, running: whisperMgr.whisper.isRunning() });
  }
});

// ── Kokoro TTS (server-side neural voice) ──────────────────────────

app.get('/api/admin/tts/status', authCheck, (req, res) => {
  res.json({
    enabled: !!settings.tts?.enabled,
    voice: settings.tts?.voice || null,
    device: settings.tts?.device || 'auto',
    speed: settings.tts?.speed ?? 1.0,
    pythonAvailable: !!ttsMgr.findPython3(),
    cudaAvailable: ttsMgr.isCudaAvailable(),
    venvReady: ttsMgr.isVenvReady(),
    kokoroInstalled: ttsMgr.isKokoroInstalled(),
    assetsInstalled: ttsMgr.areAssetsInstalled(),
    bootstrapped: ttsMgr.isBootstrapped(),
    running: ttsMgr.tts.isRunning(),
    currentConfig: ttsMgr.tts.currentConfig(),
    knownVoices: ttsMgr.KNOWN_VOICES,
  });
});

// Bootstrap: venv + kokoro-onnx + model/voices download. Streams progress.
app.post('/api/admin/tts/bootstrap', authCheck, async (req, res) => {
  if (!ttsMgr.findPython3()) return res.status(400).json({ error: 'Python 3 not found on PATH. Install python3 and retry.' });
  res.json({ ok: true, message: 'Bootstrap started — watch tts:bootstrap-progress WS messages.' });
  const broadcast = (line) => {
    const msg = JSON.stringify({ type: 'tts:bootstrap-progress', line: line.toString().trim() });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };
  try {
    await ttsMgr.bootstrap(broadcast);
    broadcast('__DONE__');
  } catch (e) {
    broadcast(`__ERROR__ ${e.message}`);
  }
});

app.post('/api/admin/tts/config', authCheck, async (req, res) => {
  const { enabled, voice, device, speed } = req.body || {};
  let numericSpeed = parseFloat(speed);
  if (!Number.isFinite(numericSpeed)) numericSpeed = 1.0;
  numericSpeed = Math.max(0.5, Math.min(2.0, numericSpeed));
  const nextTts = {
    enabled: !!enabled,
    voice: voice && ttsMgr.KNOWN_VOICES.includes(voice) ? voice : null,
    device: ['auto', 'cpu', 'cuda'].includes(device) ? device : 'auto',
    speed: numericSpeed,
  };
  settings.tts = nextTts;
  saveServerSettings(settings);

  try {
    if (nextTts.enabled && nextTts.voice) {
      await ttsMgr.tts.start({ voice: nextTts.voice, device: nextTts.device, speed: nextTts.speed });
    } else {
      await ttsMgr.tts.stop();
    }
    res.json({ ok: true, running: ttsMgr.tts.isRunning(), config: ttsMgr.tts.currentConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message, running: ttsMgr.tts.isRunning() });
  }
});

// Synthesize a short sample and return the audio blob for admin-panel preview.
// Starts the helper on demand (or restarts with a different voice) so users can
// audition voices before committing to "Save & apply".
app.post('/api/admin/tts/preview', authCheck, async (req, res) => {
  try {
    if (!ttsMgr.isBootstrapped()) return res.status(400).json({ error: 'not bootstrapped — install TTS dependencies first' });
    const { text, voice, device, speed } = req.body || {};
    const sample = (text && String(text).slice(0, 400)) || 'The quick brown fox jumps over the lazy dog.';

    const requestedVoice = voice && ttsMgr.KNOWN_VOICES.includes(voice) ? voice : settings.tts?.voice;
    if (!requestedVoice) return res.status(400).json({ error: 'voice required — select one first' });
    const requestedDevice = ['auto', 'cpu', 'cuda'].includes(device) ? device : (settings.tts?.device || 'auto');
    let requestedSpeed = parseFloat(speed);
    if (!Number.isFinite(requestedSpeed)) requestedSpeed = settings.tts?.speed ?? 1.0;
    requestedSpeed = Math.max(0.5, Math.min(2.0, requestedSpeed));

    // Start helper if not running, or restart if the config differs.
    const current = ttsMgr.tts.currentConfig();
    const configMatches = current
      && current.voice === requestedVoice
      && current.device === (requestedDevice === 'auto' ? (ttsMgr.isCudaAvailable() ? 'cuda' : 'cpu') : requestedDevice)
      && current.speed === requestedSpeed;
    if (!ttsMgr.tts.isRunning() || !configMatches) {
      await ttsMgr.tts.start({ voice: requestedVoice, device: requestedDevice, speed: requestedSpeed });
    }

    const result = await ttsMgr.tts.synthesize(sample);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Client-facing: light status so app.js knows whether to record audio / expect audio playback.
app.get('/api/voice/status', authCheck, (req, res) => {
  res.json({
    whisperEnabled: !!settings.whisper?.enabled && whisperMgr.whisper.isRunning(),
    ttsEnabled: !!settings.tts?.enabled && ttsMgr.tts.isRunning(),
  });
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
  let subscribedTab = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        // Subscribe to a session tab's output stream
        case 'subscribe': {
          // Unsub from previous
          if (subscribedSession) {
            sessions.unsubscribe(subscribedSession, ws, subscribedTab);
          }
          const actualTabId = sessions.subscribe(msg.sessionId, ws, msg.tabId);
          subscribedSession = msg.sessionId;
          subscribedTab = actualTabId;
          const clientInfo = connectedClients.get(ws);
          if (clientInfo) clientInfo.subscribedSession = msg.sessionId;
          console.log(`[ws] client subscribed to ${msg.sessionId} tab=${actualTabId}`);
          ws.send(JSON.stringify({ type: 'subscribed', sessionId: msg.sessionId, tabId: actualTabId }));
          break;
        }

        // Unsubscribe
        case 'unsubscribe': {
          if (subscribedSession) {
            sessions.unsubscribe(subscribedSession, ws, subscribedTab);
            subscribedSession = null;
            subscribedTab = null;
          }
          break;
        }

        // Send input to a session tab
        case 'input': {
          console.log(`[ws] input to ${msg.sessionId}/${msg.tabId || 'main'}: ${JSON.stringify(msg.data).slice(0, 50)}`);
          sessions.write(msg.sessionId, msg.data, msg.tabId);
          break;
        }

        // Resize terminal
        case 'resize': {
          sessions.resize(msg.sessionId, msg.cols, msg.rows, msg.tabId);
          break;
        }

        // Create a new tab in a session
        case 'createTab': {
          const result = sessions.createTab(msg.sessionId, { name: msg.name });
          ws.send(JSON.stringify({ type: 'tab:created', ...result }));
          break;
        }

        // Kill a tab
        case 'killTab': {
          sessions.killTab(msg.sessionId, msg.tabId);
          break;
        }

        // Toggle server-side auto-accept for a session
        case 'autoAccept': {
          sessions.setAutoAccept(msg.sessionId, msg.enabled);
          ws.send(JSON.stringify({ type: 'autoAccept', sessionId: msg.sessionId, enabled: sessions.getAutoAccept(msg.sessionId) }));
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

// Broadcast voice speak requests to all connected clients; client filters by active session
sessions.on('session:speak', (sessionId, text) => {
  const msg = JSON.stringify({ type: 'speak', sessionId, text });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
});

// Server-synthesized Kokoro audio; client plays the WAV blob directly.
sessions.on('session:speakAudio', (sessionId, audio_b64, format) => {
  const msg = JSON.stringify({ type: 'speak-audio', sessionId, audio_b64, format });
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

// ── Tray icon (desktop only) ────────────────────────────────────────

import { spawn as cpSpawn, execSync } from 'child_process';

let trayProcess = null;

function launchTray() {
  // Skip on headless systems (no display server)
  const hasDisplay = process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform === 'darwin' || process.platform === 'win32';
  if (!hasDisplay) return;

  // Check if Electron is installed in the desktop directory
  const desktopDir = join(PACKAGE_ROOT, 'desktop');
  const electronBin = join(desktopDir, 'node_modules', '.bin', 'electron');
  if (!existsSync(electronBin) && !existsSync(electronBin + '.cmd')) return;

  // Don't launch if already running (single instance lock in Electron handles this)
  if (trayProcess) return;

  const env = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' };
  if (process.env.CLAUDE_REMOTE_DATA) {
    env.CLAUDE_REMOTE_DATA = process.env.CLAUDE_REMOTE_DATA;
  }

  let trayLastSpawn = 0;

  function spawnTray() {
    const now = Date.now();
    // If it crashed within 5s of spawning, it's probably a lock conflict — back off
    if (trayProcess === null && now - trayLastSpawn < 5000) {
      setTimeout(spawnTray, 30000);
      return;
    }
    trayLastSpawn = now;

    trayProcess = cpSpawn(electronBin, [desktopDir], {
      stdio: 'ignore',
      env,
    });

    trayProcess.on('exit', () => {
      trayProcess = null;
      // Re-launch — tray must stay alive while server is running
      setTimeout(spawnTray, 3000);
    });
  }

  spawnTray();
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
    ensureDataDir();
    writeFileSync(getConnectionInfoPath(), connInfo);
  } catch {
  }

  // Launch tray icon if on a desktop (has DISPLAY/WAYLAND) and Electron is installed
  launchTray();

  // Start the Whisper helper if configured (best-effort; fall back to Android STT on failure)
  if (settings.whisper?.enabled && settings.whisper?.model) {
    whisperMgr.whisper
      .start({ model: settings.whisper.model, device: settings.whisper.device || 'auto' })
      .then(() => console.log(`[whisper] ready model=${settings.whisper.model} device=${settings.whisper.device}`))
      .catch((e) => console.error('[whisper] failed to start:', e.message));
  }

  // Start the Kokoro TTS helper if configured (best-effort; fall back to Android TTS on failure)
  if (settings.tts?.enabled && settings.tts?.voice) {
    ttsMgr.tts
      .start({ voice: settings.tts.voice, device: settings.tts.device || 'auto', speed: settings.tts.speed || 1.0 })
      .then(() => console.log(`[tts] ready voice=${settings.tts.voice} device=${settings.tts.device}`))
      .catch((e) => console.error('[tts] failed to start:', e.message));
  }
});
