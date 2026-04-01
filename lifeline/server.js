// ═══════════════════════════════════════════════════════════════
//  Claude Remote — LIFELINE Server
//  NEVER MODIFY THIS FILE — it is the fallback if everything breaks
//  Port 3034, standalone, zero imports from ../server/
// ═══════════════════════════════════════════════════════════════

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import crypto from 'crypto';
import os from 'os';
import { spawn } from 'node-pty';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(__dirname, '..', 'data', 'server-settings.json');
const LIFELINE_HOME = join(__dirname, '..', 'data', 'lifeline-home');
const PORT = 3034;

// ── Auth ────────────────────────────────────────────────────

function loadAuth() {
  try {
    const raw = readFileSync(SETTINGS_PATH, 'utf8');
    const s = JSON.parse(raw);
    return { token: s.authToken || null, password: s.password || null };
  } catch {
    return { token: null, password: null };
  }
}

function verifyPassword(password, stored) {
  if (!stored || !stored.hash || !stored.salt) return false;
  const hash = crypto.scryptSync(password, stored.salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(stored.hash));
}

function authCheck(req, res, next) {
  const auth = loadAuth();
  if (!auth.token) return res.status(500).json({ error: 'No auth configured' });
  const t = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (t !== auth.token) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Sessions ────────────────────────────────────────────────

const sessions = new Map();

function createSession(cwd) {
  const id = 'll_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  const shell = process.env.SHELL || '/bin/bash';
  const resolvedCwd = cwd ? resolve(cwd) : LIFELINE_HOME;
  if (!existsSync(resolvedCwd)) mkdirSync(resolvedCwd, { recursive: true });

  const pty = spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80, rows: 24,
    cwd: resolvedCwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const session = { id, pty, cwd: resolvedCwd, outputBuffer: '', subscribers: new Set(), createdAt: Date.now() };

  pty.onData((data) => {
    session.outputBuffer += data;
    if (session.outputBuffer.length > 50000) session.outputBuffer = session.outputBuffer.slice(-30000);
    const msg = JSON.stringify({ type: 'output', sessionId: id, data });
    for (const ws of session.subscribers) {
      if (ws.readyState === 1) ws.send(msg);
    }
  });

  pty.onExit(() => {
    const msg = JSON.stringify({ type: 'session:exit', sessionId: id });
    for (const ws of session.subscribers) {
      if (ws.readyState === 1) ws.send(msg);
    }
    sessions.delete(id);
  });

  sessions.set(id, session);
  return { id, cwd: resolvedCwd, createdAt: session.createdAt };
}

function listSessions() {
  return Array.from(sessions.values()).map(s => ({ id: s.id, cwd: s.cwd, createdAt: s.createdAt }));
}

// ── Express ─────────────────────────────────────────────────

const app = express();
const server = createServer(app);
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve client
app.get('/', (req, res) => res.sendFile(join(__dirname, 'client.html')));

// Login (unauthenticated)
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const auth = loadAuth();
  if (!auth.password) return res.status(400).json({ error: 'No password set' });
  if (!verifyPassword(password, auth.password)) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: auth.token });
});

// Info
app.get('/api/info', authCheck, (req, res) => {
  res.json({ hostname: os.hostname(), uptime: process.uptime(), lifeline: true, home: LIFELINE_HOME });
});

// Sessions
app.get('/api/sessions', authCheck, (req, res) => res.json(listSessions()));

app.post('/api/sessions', authCheck, (req, res) => {
  try {
    const session = createSession(req.body?.cwd);
    res.status(201).json(session);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/sessions/:id', authCheck, (req, res) => {
  const s = sessions.get(req.params.id);
  if (s) { s.pty.kill(); sessions.delete(req.params.id); }
  res.json({ ok: true });
});

// ── WebSocket ───────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const auth = loadAuth();
  if (url.searchParams.get('token') !== auth.token) {
    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    ws.close(4001);
    return;
  }

  let subscribedSession = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'subscribe': {
          if (subscribedSession) {
            const prev = sessions.get(subscribedSession);
            if (prev) prev.subscribers.delete(ws);
          }
          const s = sessions.get(msg.sessionId);
          if (s) {
            s.subscribers.add(ws);
            subscribedSession = msg.sessionId;
            if (s.outputBuffer) ws.send(JSON.stringify({ type: 'output', sessionId: msg.sessionId, data: s.outputBuffer }));
            ws.send(JSON.stringify({ type: 'subscribed', sessionId: msg.sessionId }));
          }
          break;
        }
        case 'input': {
          const s = sessions.get(msg.sessionId);
          if (s) s.pty.write(msg.data);
          break;
        }
        case 'list': {
          ws.send(JSON.stringify({ type: 'sessions', data: listSessions() }));
          break;
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    for (const [, s] of sessions) s.subscribers.delete(ws);
  });

  ws.send(JSON.stringify({ type: 'sessions', data: listSessions() }));
});

// ── Start ───────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[lifeline] Running on port ${PORT}`);
});
