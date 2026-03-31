import { spawn } from 'node-pty';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

// ── Question / attention detection patterns ─────────────────────────
const QUESTION_PATTERNS = [
  /\?\s*$/m,
  /\(y\/n\)/i, /\[Y\/n\]/i, /\[y\/N\]/i,
  /press enter/i,
  /do you want/i,
  /please (choose|select|pick|confirm)/i,
  /which (one|option)/i,
  /enter .*(path|name|number|value)/i,
  /approve|reject|accept|deny/i,
  /continue\?/i,
  /proceed\?/i,
];

// Patterns that indicate Claude is actively working
const WORKING_PATTERNS = [
  /reading|writing|editing|creating|updating|searching/i,
  /running|executing|installing|compiling|building/i,
  /analyzing|processing|generating|thinking/i,
  /\.\.\./,
];

export class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  create({ name, cwd, shell = process.env.SHELL || '/bin/bash', cols = 120, rows = 40 }) {
    const id = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

    // Resolve and validate cwd
    const resolvedCwd = cwd ? path.resolve(cwd) : (process.env.HOME || '/');
    if (!fs.existsSync(resolvedCwd)) {
      throw new Error(`Directory not found: ${resolvedCwd}`);
    }

    const pty = spawn(shell, [], {
      name: 'xterm-256color',
      cols, rows,
      cwd: resolvedCwd,
      env: { ...process.env, TERM: 'xterm-256color' },
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

    // ── Output handler ──────────────────────────────────────────
    pty.onData((data) => {
      session.lastActivity = Date.now();
      session.outputBuffer += data;
      session.lastOutput = data;

      // Cap buffer at 100KB
      if (session.outputBuffer.length > 100_000) {
        session.outputBuffer = session.outputBuffer.slice(-60_000);
      }

      // Detect status from output
      const clean = stripAnsi(data);
      this._detectStatus(session, clean);

      // Broadcast to subscribers
      const msg = JSON.stringify({ type: 'output', sessionId: id, data });
      for (const ws of session.subscribers) {
        if (ws.readyState === 1) ws.send(msg);
      }
    });

    pty.onExit(({ exitCode }) => {
      session.status = 'done';
      const msg = JSON.stringify({ type: 'session:exit', sessionId: id, exitCode });
      for (const ws of session.subscribers) {
        if (ws.readyState === 1) ws.send(msg);
      }
      this.emit('session:exit', id, exitCode);
    });

    this.sessions.set(id, session);
    this.emit('session:created', id);
    return this.serialize(session);
  }

  _detectStatus(session, cleanText) {
    const recent = stripAnsi(session.outputBuffer.slice(-600));

    // Check for question/waiting patterns
    for (const pat of QUESTION_PATTERNS) {
      if (pat.test(recent)) {
        const prev = session.status;
        session.status = 'waiting';
        session.attentionPreview = recent.slice(-200).trim();

        if (prev !== 'waiting') {
          const msg = JSON.stringify({
            type: 'session:attention',
            sessionId: session.id,
            preview: session.attentionPreview,
          });
          for (const ws of session.subscribers) {
            if (ws.readyState === 1) ws.send(msg);
          }
          this.emit('session:attention', session.id, session.attentionPreview);
        }
        return;
      }
    }

    // Check for working patterns
    for (const pat of WORKING_PATTERNS) {
      if (pat.test(cleanText)) {
        session.status = 'working';
        return;
      }
    }

    // Default: if output is flowing, it's working
    if (cleanText.trim().length > 0) {
      session.status = 'working';
    }
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (!session?.pty) throw new Error('Session not found');

    // Clear waiting status on input
    if (session.status === 'waiting') {
      session.status = 'working';
      session.attentionPreview = null;
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
    this.emit('session:updated', id);
    return this.serialize(session);
  }

  kill(id) {
    const session = this.sessions.get(id);
    if (!session) return;

    try { session.pty.kill(); } catch {}

    const msg = JSON.stringify({ type: 'session:killed', sessionId: id });
    for (const ws of session.subscribers) {
      if (ws.readyState === 1) ws.send(msg);
    }

    session.subscribers.clear();
    this.sessions.delete(id);
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
      subscriberCount: session.subscribers.size,
    };
  }
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '');
}
