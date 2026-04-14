import { spawn } from 'node-pty';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { getSessionsPath, ensureDataDir, PACKAGE_ROOT } from '../lib/paths.js';

const SCRIPTS_DIR = path.join(PACKAGE_ROOT, 'scripts');

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
        if (!fs.existsSync(s.cwd)) continue;

        const session = {
          id: s.id,
          name: s.name || 'Restored Session',
          cwd: s.cwd,
          shell: s.shell || process.env.SHELL || '/bin/bash',
          cols: s.cols || 120,
          rows: s.rows || 40,
          status: 'dead',
          createdAt: s.createdAt || Date.now(),
          lastActivity: s.lastActivity || Date.now(),
          attentionPreview: null,
          claudeSessionId: s.claudeSessionId || null,
          tabs: new Map(),
        };

        // Restore tab metadata (ptys are gone, marked dead)
        if (Array.isArray(s.tabs)) {
          for (const t of s.tabs) {
            session.tabs.set(t.id, {
              id: t.id,
              name: t.name || 'Terminal',
              pty: null,
              pid: null,
              outputBuffer: '',
              lastOutput: '',
              subscribers: new Set(),
            });
          }
        }
        // If no tabs saved, create a default placeholder
        if (session.tabs.size === 0) {
          session.tabs.set('main', {
            id: 'main',
            name: 'Terminal',
            pty: null,
            pid: null,
            outputBuffer: '',
            lastOutput: '',
            subscribers: new Set(),
          });
        }

        this.sessions.set(s.id, session);
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
        claudeSessionId: s.claudeSessionId || null,
        tabs: Array.from(s.tabs.values()).map(t => ({ id: t.id, name: t.name })),
      }));
      ensureDataDir();
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch {}
  }

  _makePtyEnv(sessionId) {
    const env = { ...process.env, TERM: 'xterm-256color', CLAUDE_REMOTE_SESSION_ID: sessionId, CLAUDE_REMOTE_PORT: this.port };
    delete env.npm_config_prefix;
    delete env.npm_config_local_prefix;
    // Prepend scripts dir so `speak`, etc. are directly callable from the pty
    env.PATH = `${SCRIPTS_DIR}:${env.PATH || ''}`;
    return env;
  }

  emitSpeak(sessionId, text) {
    this.emit('session:speak', sessionId, text);
  }

  // Queue a slash command to be injected into the pty on the next Stop hook.
  // Used by `scripts/cmd` so Claude can fire slash commands at end of turn.
  queueCommand(sessionId, command) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!session._queuedCommands) session._queuedCommands = [];
    session._queuedCommands.push(command);
    console.log(`[cmd] queued for session=${sessionId}: ${command}`);
  }

  _flushQueuedCommands(session) {
    if (!session._queuedCommands?.length) return;
    const mainTab = session.tabs.get('main') || session.tabs.values().next().value;
    if (!mainTab?.pty) return;
    const queued = session._queuedCommands;
    session._queuedCommands = [];
    // Small delay so Claude Code's TUI fully draws the prompt before we type.
    setTimeout(() => {
      for (const cmd of queued) {
        if (!mainTab.pty) return;
        console.log(`[cmd] flushing to pty: ${cmd}`);
        mainTab.pty.write(`${cmd}\r`);
      }
    }, 300);
  }

  _generateTabId() {
    return 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 4);
  }

  // Reconnect a dead session — spawns new ptys for all tabs.
  // If resumeClaude is true, auto-launches `claude --resume <id>` using the
  // caller-supplied claudeSessionId (preferred), then the stored one,
  // falling back to a bare `claude --resume` (picks the latest conversation).
  reconnect(id, { cols = 120, rows = 40, resumeClaude = false, claudeSessionId = null } = {}) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    if (session.status !== 'dead') throw new Error('Session is already alive');

    // If the client provided a claudeSessionId and the server doesn't have one,
    // adopt it so future revives work without the client needing to re-supply it.
    if (claudeSessionId && !session.claudeSessionId) {
      session.claudeSessionId = claudeSessionId;
    }
    const resumeId = claudeSessionId || session.claudeSessionId;

    const ptyEnv = this._makePtyEnv(id);
    let isFirstTab = true;

    for (const tab of session.tabs.values()) {
      const pty = spawn(session.shell, ['-l'], {
        name: 'xterm-256color',
        cols, rows,
        cwd: session.cwd,
        env: ptyEnv,
      });
      tab.pty = pty;
      tab.pid = pty.pid;
      tab.outputBuffer = '';
      tab.lastOutput = '';
      this._attachTabHandlers(session, tab);

      // Auto-launch claude on the first tab if requested.
      // Use --resume <id> when we have one, else bare --resume (picks latest).
      if (isFirstTab && resumeClaude) {
        const cmd = resumeId ? `claude --resume ${resumeId}` : 'claude --resume';
        setTimeout(() => {
          if (tab.pty) tab.pty.write(`${cmd}\r`);
        }, 500);
      }
      isFirstTab = false;
    }

    session.status = 'idle';
    session.cols = cols;
    session.rows = rows;
    session.lastActivity = Date.now();

    this._saveSessions();
    this.emit('session:reconnected', id);
    return this.serialize(session);
  }

  create({ name, cwd, shell = process.env.SHELL || '/bin/bash', cols = 120, rows = 40 }) {
    const id = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

    const resolvedCwd = cwd ? path.resolve(cwd) : (process.env.HOME || '/');
    if (!fs.existsSync(resolvedCwd)) {
      fs.mkdirSync(resolvedCwd, { recursive: true });
    }

    const ptyEnv = this._makePtyEnv(id);

    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols, rows,
      cwd: resolvedCwd,
      env: ptyEnv,
    });

    const mainTab = {
      id: 'main',
      name: 'Terminal',
      pty,
      pid: pty.pid,
      outputBuffer: '',
      lastOutput: '',
      subscribers: new Set(),
    };

    const session = {
      id,
      name: name || `Session ${this.sessions.size + 1}`,
      cwd: resolvedCwd,
      shell,
      cols, rows,
      status: 'idle',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      attentionPreview: null,
      tabs: new Map([['main', mainTab]]),
    };

    this._attachTabHandlers(session, mainTab);

    this.sessions.set(id, session);
    this._saveSessions();
    this.emit('session:created', id);
    return this.serialize(session);
  }

  // Create a new tab within a session
  createTab(sessionId, { name = 'Terminal' } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const tabId = this._generateTabId();
    const ptyEnv = this._makePtyEnv(sessionId);

    const pty = spawn(session.shell, ['-l'], {
      name: 'xterm-256color',
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      env: ptyEnv,
    });

    const tab = {
      id: tabId,
      name,
      pty,
      pid: pty.pid,
      outputBuffer: '',
      lastOutput: '',
      subscribers: new Set(),
    };

    session.tabs.set(tabId, tab);
    this._attachTabHandlers(session, tab);
    this._saveSessions();
    this.emit('session:tabCreated', sessionId, tabId);
    return { sessionId, tab: { id: tabId, name, pid: pty.pid } };
  }

  // Kill a specific tab
  killTab(sessionId, tabId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const tab = session.tabs.get(tabId);
    if (!tab) return;

    // Don't allow killing the last tab — kill the session instead
    if (session.tabs.size <= 1) {
      this.kill(sessionId);
      return;
    }

    if (tab.pty) {
      try { tab.pty.kill(); } catch {}
    }

    const msg = JSON.stringify({ type: 'tab:killed', sessionId, tabId });
    for (const ws of tab.subscribers) {
      if (ws.readyState === 1) ws.send(msg);
    }

    tab.subscribers.clear();
    session.tabs.delete(tabId);
    this._saveSessions();
    this.emit('session:tabKilled', sessionId, tabId);
  }

  _attachTabHandlers(session, tab) {
    const sessionId = session.id;
    const tabId = tab.id;

    tab.pty.onData((data) => {
      session.lastActivity = Date.now();
      tab.outputBuffer += data;
      tab.lastOutput = data;

      if (tab.outputBuffer.length > 100_000) {
        tab.outputBuffer = tab.outputBuffer.slice(-60_000);
      }

      const msg = JSON.stringify({ type: 'output', sessionId, tabId, data });
      for (const ws of tab.subscribers) {
        if (ws.readyState === 1) ws.send(msg);
      }
    });

    tab.pty.onExit(({ exitCode }) => {
      tab.pty = null;
      tab.pid = null;

      // Check if all tabs are dead
      const allDead = Array.from(session.tabs.values()).every(t => !t.pty);
      if (allDead) {
        session.status = 'done';
      }

      this._saveSessions();
      const msg = JSON.stringify({ type: 'tab:exit', sessionId, tabId, exitCode });
      for (const ws of tab.subscribers) {
        if (ws.readyState === 1) ws.send(msg);
      }
      this.emit('session:tabExit', sessionId, tabId, exitCode);
    });
  }

  // ── Auto-accept management ───────────────────────────────────────
  setAutoAccept(sessionId, enabled) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.autoAccept = !!enabled;
    console.log(`[auto-accept] session=${sessionId} enabled=${session.autoAccept}`);
  }

  getAutoAccept(sessionId) {
    const session = this.sessions.get(sessionId);
    return session?.autoAccept || false;
  }

  // ── Hook-based status detection (from Claude Code hooks) ──────────
  handleHookEvent(hookType, sessionId, hookData) {
    console.log(`[hook] type=${hookType} session=${sessionId} data=${JSON.stringify(hookData)?.slice(0, 200)}`);
    const session = this.sessions.get(sessionId);
    if (!session) { console.log(`[hook] session not found: ${sessionId}`); return; }

    session.lastActivity = Date.now();

    // Capture the Claude Code conversation session ID for resume support.
    // Persist on change so it survives a server restart (otherwise revive can't resume).
    if (hookData?.session_id && session.claudeSessionId !== hookData.session_id) {
      session.claudeSessionId = hookData.session_id;
      this._saveSessions();
    }

    switch (hookType) {
      case 'notification': {
        const notifType = hookData?.notification_type;
        console.log(`[hook] notification_type=${notifType} keys=${Object.keys(hookData || {}).join(',')}`);

        if (notifType === 'permission_prompt' || notifType === 'idle_prompt') {
          if (notifType === 'permission_prompt') {
            session.status = 'waiting';
            session.attentionPreview = hookData.message || 'Claude needs permission';

            // Server-side auto-accept: immediately send Enter to the first tab's pty
            if (session.autoAccept) {
              const mainTab = session.tabs.get('main') || session.tabs.values().next().value;
              if (mainTab?.pty) {
                console.log(`[auto-accept] sending Enter for session=${sessionId}`);
                mainTab.pty.write('\r');
                session.status = 'working';
                session.attentionPreview = null;
                return; // Don't emit attention — handled automatically
              }
            }

            // Emit attention event for every permission prompt (no dedup for prompts)
            const now = Date.now();
            session._lastAttention = now;
            session._attentionReason = 'prompt';
            this.emit('session:attention', session.id, 'prompt', session.attentionPreview);
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
        // Inject any slash commands Claude queued during this turn.
        this._flushQueuedCommands(session);
        break;
      }
      case 'user_prompt_submit':
        session.status = 'working';
        session.attentionPreview = null;
        session._attentionReason = null;
        break;
    }
  }

  write(id, data, tabId) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');

    // Resolve tab — default to main, fall back to first tab
    const tab = session.tabs.get(tabId) || session.tabs.get('main') || session.tabs.values().next().value;
    if (!tab?.pty) throw new Error('Tab not found or dead');

    // Clear waiting status on input
    if (session.status === 'waiting') {
      session.status = 'working';
      session.attentionPreview = null;
      session._attentionReason = null;
    }

    tab.pty.write(data);
    session.lastActivity = Date.now();
  }

  resize(id, cols, rows, tabId) {
    const session = this.sessions.get(id);
    if (!session) return;
    const tab = session.tabs.get(tabId) || session.tabs.get('main') || session.tabs.values().next().value;
    if (!tab?.pty) return;
    tab.pty.resize(cols, rows);
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

    // Kill all tabs
    for (const tab of session.tabs.values()) {
      if (tab.pty) {
        try { tab.pty.kill(); } catch {}
      }
      tab.subscribers.clear();
    }

    const msg = JSON.stringify({ type: 'session:killed', sessionId: id });
    // Broadcast to any subscriber of any tab
    const notified = new Set();
    for (const tab of session.tabs.values()) {
      for (const ws of tab.subscribers) {
        if (!notified.has(ws) && ws.readyState === 1) {
          ws.send(msg);
          notified.add(ws);
        }
      }
    }

    this.sessions.delete(id);
    this._saveSessions();
    this.emit('session:killed', id);
  }

  subscribe(id, ws, tabId) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');

    // Resolve tab
    const tab = session.tabs.get(tabId) || session.tabs.get('main') || session.tabs.values().next().value;
    if (!tab) throw new Error('Tab not found');

    tab.subscribers.add(ws);

    // Send buffered output
    if (tab.outputBuffer) {
      ws.send(JSON.stringify({ type: 'output', sessionId: id, tabId: tab.id, data: tab.outputBuffer, replay: true }));
    }

    return tab.id;
  }

  unsubscribe(id, ws, tabId) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (tabId) {
      const tab = session.tabs.get(tabId);
      if (tab) tab.subscribers.delete(ws);
    } else {
      // Unsubscribe from all tabs in this session
      for (const tab of session.tabs.values()) {
        tab.subscribers.delete(ws);
      }
    }
  }

  unsubscribeAll(ws) {
    for (const session of this.sessions.values()) {
      for (const tab of session.tabs.values()) {
        tab.subscribers.delete(ws);
      }
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
    // Build tab list for client
    const tabs = Array.from(session.tabs.values()).map(t => ({
      id: t.id,
      name: t.name,
      pid: t.pid,
      alive: !!t.pty,
    }));

    return {
      id: session.id,
      name: session.name,
      pid: tabs[0]?.pid || null, // backward compat: pid of first tab
      cwd: session.cwd,
      status: session.status,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      attentionPreview: session.attentionPreview,
      attentionReason: session._attentionReason || null,
      attentionAt: session._lastAttention || null,
      claudeSessionId: session.claudeSessionId || null,
      subscriberCount: tabs.reduce((sum, t) => sum + (session.tabs.get(t.id)?.subscribers.size || 0), 0),
      tabs,
    };
  }
}
