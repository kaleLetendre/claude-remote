import { spawn } from 'node-pty';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = path.join(__dirname, '..', 'data', 'sessions.json');

// ── Claude Code detection ───────────────────────────────────────────
// Patterns that indicate Claude Code is the active process in this session.
// Use \s* between words because terminal rendering can collapse/strip spaces.
const CLAUDE_PRESENCE_PATTERNS = [
  /\?\s*for\s*shortcuts/,        // Claude Code's idle prompt
  /\(Y\)es\s*\/\s*\(N\)o/,      // Tool approval dialog
  /esc\s*to\s*interrupt/,        // Claude Code working status bar
  /plan\s*mode\s*on/,            // Plan mode active
];

// Patterns that mean Claude Code is waiting for user input (blocked).
const CLAUDE_INPUT_PATTERNS = [
  /\(Y\)es\s*\/\s*\(N\)o/,      // Tool approval
  /Yes\s*\/\s*No/,               // Simpler Yes / No variant
  /\(y\/n\)/i, /\[Y\/n\]/i, /\[y\/N\]/i,
  /\(yes\/no\)/i,
  /press enter to continue/i,
  /Do you want to proceed/i,
  /Enter\s*to\s*select.*to\s*navigate/,  // Claude Code menu selection (plan mode, etc.)
];

// Patterns that mean Claude Code finished and returned to its idle prompt.
const CLAUDE_IDLE_PATTERNS = [
  /\?\s*for\s*shortcuts/,        // Claude's main idle prompt (normal mode)
  /shift\+tab\s*to\s*cycle/,     // Plan mode idle prompt
];

export class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this._restoreSessions();
  }

  // Restore saved sessions from disk after server restart
  _restoreSessions() {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) return;
      const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      if (!Array.isArray(saved)) return;

      for (const s of saved) {
        if (!s.id || !s.cwd) continue;
        // Skip if cwd no longer exists
        if (!fs.existsSync(s.cwd)) continue;

        // Create a placeholder session marked as 'dead' — pty is gone but metadata preserved
        this.sessions.set(s.id, {
          id: s.id,
          name: s.name || 'Restored Session',
          pid: null,
          pty: null,
          cwd: s.cwd,
          shell: s.shell || process.env.SHELL || '/bin/bash',
          cols: s.cols || 120,
          rows: s.rows || 40,
          status: 'dead',
          createdAt: s.createdAt || Date.now(),
          lastActivity: s.lastActivity || Date.now(),
          outputBuffer: '',
          lastOutput: '',
          attentionPreview: null,
          subscribers: new Set(),
        });
      }
    } catch {}
  }

  _saveSessions() {
    try {
      const data = Array.from(this.sessions.values()).map(s => ({
        id: s.id,
        name: s.name,
        cwd: s.cwd,
        shell: s.shell,
        cols: s.cols,
        rows: s.rows,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
      }));
      const dir = path.dirname(SESSIONS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch {}
  }

  // Reconnect a dead session — spawns a new pty in the same directory
  reconnect(id, { cols = 120, rows = 40 } = {}) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    if (session.pty) throw new Error('Session is already alive');

    const ptyEnv = { ...process.env, TERM: 'xterm-256color' };
    delete ptyEnv.npm_config_prefix;
    delete ptyEnv.npm_config_local_prefix;

    const pty = spawn(session.shell, ['-l'], {
      name: 'xterm-256color',
      cols, rows,
      cwd: session.cwd,
      env: ptyEnv,
    });

    session.pty = pty;
    session.pid = pty.pid;
    session.status = 'idle';
    session.cols = cols;
    session.rows = rows;
    session.outputBuffer = '';
    session.lastOutput = '';
    session.lastActivity = Date.now();

    this._attachPtyHandlers(session);
    this._saveSessions();
    this.emit('session:reconnected', id);
    return this.serialize(session);
  }

  create({ name, cwd, shell = process.env.SHELL || '/bin/bash', cols = 120, rows = 40 }) {
    const id = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

    // Resolve cwd, create if it doesn't exist
    const resolvedCwd = cwd ? path.resolve(cwd) : (process.env.HOME || '/');
    if (!fs.existsSync(resolvedCwd)) {
      fs.mkdirSync(resolvedCwd, { recursive: true });
    }

    // Clean env for pty — remove npm_config_prefix which breaks NVM
    const ptyEnv = { ...process.env, TERM: 'xterm-256color' };
    delete ptyEnv.npm_config_prefix;
    delete ptyEnv.npm_config_local_prefix;

    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols, rows,
      cwd: resolvedCwd,
      env: ptyEnv,
    });

    const session = {
      id,
      name: name || `Session ${this.sessions.size + 1}`,
      pid: pty.pid,
      pty,
      cwd: resolvedCwd,
      shell,
      cols, rows,
      status: 'idle',           // idle | working | waiting | done
      createdAt: Date.now(),
      lastActivity: Date.now(),
      outputBuffer: '',          // rolling buffer for history
      lastOutput: '',            // last chunk for attention detection
      attentionPreview: null,    // what Claude is asking about
      subscribers: new Set(),    // WebSocket clients watching this session
    };

    this._attachPtyHandlers(session);

    this.sessions.set(id, session);
    this._saveSessions();
    this.emit('session:created', id);
    return this.serialize(session);
  }

  _attachPtyHandlers(session) {
    const id = session.id;
    session.pty.onData((data) => {
      session.lastActivity = Date.now();
      session.outputBuffer += data;
      session.lastOutput = data;

      if (session.outputBuffer.length > 100_000) {
        session.outputBuffer = session.outputBuffer.slice(-60_000);
      }

      const clean = stripAnsi(data);
      this._detectStatus(session, clean);

      const msg = JSON.stringify({ type: 'output', sessionId: id, data });
      for (const ws of session.subscribers) {
        if (ws.readyState === 1) ws.send(msg);
      }
    });

    session.pty.onExit(({ exitCode }) => {
      session.status = 'done';
      session.pty = null;
      session.pid = null;
      this._saveSessions();
      const msg = JSON.stringify({ type: 'session:exit', sessionId: id, exitCode });
      for (const ws of session.subscribers) {
        if (ws.readyState === 1) ws.send(msg);
      }
      this.emit('session:exit', id, exitCode);
    });
  }

  _detectStatus(session, cleanText) {
    if (cleanText.trim().length === 0) return;

    // Detect Claude Code presence in this session
    if (!session._claudeActive) {
      for (const pat of CLAUDE_PRESENCE_PATTERNS) {
        if (pat.test(cleanText)) {
          session._claudeActive = true;
          break;
        }
      }
    }

    // Check the tail of the buffer for known patterns
    const tail = stripAnsi(session.outputBuffer.slice(-600)).replace(/\r+/g, '\n');
    const lastLines = tail.split('\n').filter(l => l.trim()).slice(-8).join('\n');

    // 1. Check for Claude waiting for input (tool approval, y/n, etc.)
    for (const pat of CLAUDE_INPUT_PATTERNS) {
      if (pat.test(lastLines)) {
        const prev = session.status;
        session.status = 'waiting';
        // Find a meaningful preview line — skip UI chrome like "cancel", "navigate", etc.
        const previewLines = lastLines.trim().split('\n').filter(l =>
          l.trim() && !/^(cancel|Enter\s*to\s*select|to\s*navigate|Esc\s*to)/.test(l.trim())
        );
        session.attentionPreview = previewLines.pop() || 'Claude has a question';
        if (session._idleTimer) clearTimeout(session._idleTimer);

        const now = Date.now();
        if (prev !== 'waiting' && (!session._lastAttention || now - session._lastAttention > 10000)) {
          session._lastAttention = now;
          session._attentionReason = 'prompt';
          this.emit('session:attention', session.id, 'prompt', session.attentionPreview);
        }
        return;
      }
    }

    // 2. Check if Claude returned to its idle prompt (finished working)
    if (session._claudeActive) {
      for (const pat of CLAUDE_IDLE_PATTERNS) {
        if (pat.test(lastLines)) {
          // Claude's idle prompt appeared — schedule notification after debounce
          if (session.status === 'working') {
            this._scheduleIdleNotification(session);
          }
          return;
        }
      }
    }

    // 3. If none of the above matched, session is actively producing output
    session.status = 'working';
    if (session._idleTimer) clearTimeout(session._idleTimer);
  }

  // Notify after Claude's idle prompt settles (debounce to avoid false triggers during streaming)
  _scheduleIdleNotification(session) {
    if (session._idleTimer) clearTimeout(session._idleTimer);
    session._idleTimer = setTimeout(() => {
      if (session.status !== 'working') return;
      session.status = 'idle';
      const now = Date.now();
      if (!session._lastAttention || now - session._lastAttention > 10000) {
        session._lastAttention = now;
        session._attentionReason = 'idle';
        this.emit('session:attention', session.id, 'idle', null);
      }
    }, 2000);
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (!session?.pty) throw new Error('Session not found');

    // Clear waiting status on input
    if (session.status === 'waiting') {
      session.status = 'working';
      session.attentionPreview = null;
      session._attentionReason = null;
    }

    session.pty.write(data);
    session.lastActivity = Date.now();
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session?.pty) return;
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
  }

  rename(id, name) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    session.name = name;
    this._saveSessions();
    this.emit('session:updated', id);
    return this.serialize(session);
  }

  kill(id) {
    const session = this.sessions.get(id);
    if (!session) return;

    if (session.pty) {
      try { session.pty.kill(); } catch {}
    }

    const msg = JSON.stringify({ type: 'session:killed', sessionId: id });
    for (const ws of session.subscribers) {
      if (ws.readyState === 1) ws.send(msg);
    }

    session.subscribers.clear();
    this.sessions.delete(id);
    this._saveSessions();
    this.emit('session:killed', id);
  }

  subscribe(id, ws) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    session.subscribers.add(ws);

    // Send buffered output
    if (session.outputBuffer) {
      ws.send(JSON.stringify({ type: 'output', sessionId: id, data: session.outputBuffer }));
    }
  }

  unsubscribe(id, ws) {
    const session = this.sessions.get(id);
    if (session) session.subscribers.delete(ws);
  }

  unsubscribeAll(ws) {
    for (const session of this.sessions.values()) {
      session.subscribers.delete(ws);
    }
  }

  get(id) {
    const session = this.sessions.get(id);
    return session ? this.serialize(session) : null;
  }

  list() {
    return Array.from(this.sessions.values()).map(s => this.serialize(s));
  }

  listDirectory(dirPath) {
    const resolved = path.resolve(dirPath);
    if (!fs.existsSync(resolved)) throw new Error('Directory not found');

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith('.') || e.name === '.env')
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        path: path.join(resolved, e.name),
        size: e.isFile() ? fs.statSync(path.join(resolved, e.name)).size : null,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  serialize(session) {
    return {
      id: session.id,
      name: session.name,
      pid: session.pid,
      cwd: session.cwd,
      status: session.status,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      attentionPreview: session.attentionPreview,
      attentionReason: session._attentionReason || null,
      attentionAt: session._lastAttention || null,
      subscriberCount: session.subscribers.size,
    };
  }
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')  // All CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC sequences
    .replace(/\x1b[()][AB012]/g, '')             // Character set selection
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, '') // Other escape sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');  // Control characters
}
