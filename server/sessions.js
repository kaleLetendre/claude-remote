import { spawn } from 'node-pty';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { getSessionsPath, ensureDataDir } from '../lib/paths.js';

const SESSIONS_FILE = getSessionsPath();

export class SessionManager extends EventEmitter {
  constructor({ port = 3033 } = {}) {
    super();
    this.port = String(port);
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
      ensureDataDir();
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch {}
  }

  // Reconnect a dead session — spawns a new pty in the same directory
  reconnect(id, { cols = 120, rows = 40 } = {}) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    if (session.pty) throw new Error('Session is already alive');

    const ptyEnv = { ...process.env, TERM: 'xterm-256color', CLAUDE_REMOTE_SESSION_ID: id, CLAUDE_REMOTE_PORT: this.port };
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
    const ptyEnv = { ...process.env, TERM: 'xterm-256color', CLAUDE_REMOTE_SESSION_ID: id, CLAUDE_REMOTE_PORT: this.port };
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

  // ── Hook-based status detection (from Claude Code hooks) ──────────
  handleHookEvent(hookType, sessionId, hookData) {
    console.log(`[hook] type=${hookType} session=${sessionId} data=${JSON.stringify(hookData)?.slice(0, 200)}`);
    const session = this.sessions.get(sessionId);
    if (!session) { console.log(`[hook] session not found: ${sessionId}`); return; }

    session.lastActivity = Date.now();

    switch (hookType) {
      case 'notification': {
        const notifType = hookData?.notification_type;
        if (notifType === 'permission_prompt' || notifType === 'idle_prompt') {
          if (notifType === 'permission_prompt') {
            const prev = session.status;
            session.status = 'waiting';
            session.attentionPreview = hookData.message || 'Claude needs permission';
            const now = Date.now();
            if (prev !== 'waiting' && (!session._lastAttention || now - session._lastAttention > 10000)) {
              session._lastAttention = now;
              session._attentionReason = 'prompt';
              this.emit('session:attention', session.id, 'prompt', session.attentionPreview);
            }
          } else {
            // idle_prompt — Claude returned to idle
            const wasWorking = session.status === 'working';
            session.status = 'idle';
            if (wasWorking) {
              const now = Date.now();
              if (!session._lastAttention || now - session._lastAttention > 10000) {
                session._lastAttention = now;
                session._attentionReason = 'idle';
                this.emit('session:attention', session.id, 'idle', null);
              }
            }
          }
        }
        break;
      }
      case 'stop': {
        const wasWorking = session.status === 'working';
        session.status = 'idle';
        if (wasWorking) {
          const now = Date.now();
          if (!session._lastAttention || now - session._lastAttention > 10000) {
            session._lastAttention = now;
            session._attentionReason = 'idle';
            this.emit('session:attention', session.id, 'idle', null);
          }
        }
        break;
      }
      case 'user_prompt_submit':
        session.status = 'working';
        session.attentionPreview = null;
        session._attentionReason = null;
        break;
    }
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

