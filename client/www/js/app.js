// ═══════════════════════════════════════════════════════════════
//  Claude Remote — App
// ═══════════════════════════════════════════════════════════════

// ── Config / State ──────────────────────────────────────────

const state = {
  // Connection (persisted)
  serverUrl: '',     // e.g. 'http://100.64.1.5:3033'
  token: '',

  ws: null,
  connected: false,
  sessions: [],
  activeSessionId: null,
  currentView: 'dashboard',

  // Settings (persisted to localStorage)
  ttsEnabled: false,
  smartTts: false,
  alertsEnabled: true,
  speechRate: 1.1,
  selectedVoiceURI: null,
  sttLang: 'en-US',

  // Runtime
  recording: false,
  recognition: null,
  xterm: null,
  fitAddon: null,
  cleanBuffer: '',
  ttsAccum: '',
  ttsTimer: null,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('claude-remote-settings') || '{}');
    Object.assign(state, saved);
  } catch {}

  // URL params override saved settings (for first-time setup via QR/link)
  const params = new URLSearchParams(location.search);
  if (params.get('token')) {
    state.token = params.get('token');
    // If we arrived via a full URL with token, save the origin as serverUrl
    state.serverUrl = location.origin;
    saveSettings();
    // Clean the URL so token isn't visible in history
    history.replaceState(null, '', location.pathname);
  }
}

function saveSettings() {
  const keys = [
    'ttsEnabled', 'smartTts', 'alertsEnabled', 'speechRate',
    'selectedVoiceURI', 'sttLang', 'serverUrl', 'token',
  ];
  const obj = {};
  keys.forEach(k => obj[k] = state[k]);
  localStorage.setItem('claude-remote-settings', JSON.stringify(obj));
}

loadSettings();

// ── Helpers ─────────────────────────────────────────────────

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function cloneTemplate(id) {
  const tpl = $(`#${id}`);
  return tpl.content.firstElementChild.cloneNode(true);
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + 'h ago';
  return Math.floor(diff / 86400_000) + 'd ago';
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '');
}

function shortenPath(p) {
  const home = '/home/';
  if (p.includes(home)) {
    const after = p.slice(p.indexOf(home) + home.length);
    const parts = after.split('/');
    return '~/' + parts.slice(1).join('/');
  }
  return p;
}

// ── API Layer ───────────────────────────────────────────────

const api = {
  get baseUrl() {
    // When running inside Capacitor pointing at remote server, use serverUrl
    // When served directly by the server, use relative paths
    return state.serverUrl || '';
  },

  headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.token}`,
    };
  },

  async get(path) {
    const res = await fetch(`${this.baseUrl}${path}?token=${state.token}`, { headers: this.headers() });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async post(path, body) {
    const res = await fetch(`${this.baseUrl}${path}?token=${state.token}`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async patch(path, body) {
    const res = await fetch(`${this.baseUrl}${path}?token=${state.token}`, {
      method: 'PATCH', headers: this.headers(), body: JSON.stringify(body),
    });
    return res.json();
  },

  async del(path) {
    await fetch(`${this.baseUrl}${path}?token=${state.token}`, {
      method: 'DELETE', headers: this.headers(),
    });
  },
};

// ── WebSocket ───────────────────────────────────────────────

function connectWS() {
  if (!state.token) return; // No connection info yet
  if (state.ws?.readyState === WebSocket.OPEN) return;

  // Determine WebSocket host from serverUrl or current location
  let wsHost;
  if (state.serverUrl) {
    try {
      const url = new URL(state.serverUrl);
      const proto = url.protocol === 'https:' ? 'wss' : 'ws';
      wsHost = `${proto}://${url.host}`;
    } catch {
      wsHost = `ws://${location.host}`;
    }
  } else {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    wsHost = `${proto}://${location.host}`;
  }

  const ws = new WebSocket(`${wsHost}?token=${state.token}`);
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    updateConnectionUI();
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleWSMessage(msg);
  };

  ws.onclose = () => {
    state.connected = false;
    updateConnectionUI();
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => {};
}

function wsSend(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'sessions':
      state.sessions = msg.data;
      if (state.currentView === 'dashboard') renderDashboard();
      updateTopbarStatus();
      break;

    case 'output':
      if (msg.sessionId === state.activeSessionId) {
        appendTerminalOutput(msg.data);
        accumulateForTTS(msg.data);
      }
      break;

    case 'session:attention':
      handleAttention(msg.sessionId, msg.preview);
      break;

    case 'session:exit':
    case 'session:killed':
      if (msg.sessionId === state.activeSessionId && state.currentView === 'session') {
        navigate('dashboard');
      }
      break;

    case 'update:available':
      state.updateInfo = msg.data;
      showUpdateBanner(msg.data);
      break;

    case 'subscribed':
      break;

    case 'pong':
      break;
  }
}

// ── Update Banner ───────────────────────────────────────────

function showUpdateBanner(info) {
  // Remove existing banner if any
  const existing = document.querySelector('.update-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.className = 'update-banner';
  banner.innerHTML = `
    <div style="flex:1;">
      <strong>Update available</strong>
      <span style="opacity:0.7;margin-left:6px;">${info.currentVersion} → ${info.newVersion}</span>
      <span style="opacity:0.5;margin-left:6px;">(${info.commitsBehind} commit${info.commitsBehind > 1 ? 's' : ''})</span>
    </div>
    <button class="update-btn" id="update-apply-btn">Update & Restart</button>
    <button class="update-dismiss" id="update-dismiss-btn">✕</button>
  `;

  document.body.prepend(banner);

  document.getElementById('update-dismiss-btn').onclick = () => banner.remove();
  document.getElementById('update-apply-btn').onclick = async () => {
    const btn = document.getElementById('update-apply-btn');
    btn.textContent = 'Updating…';
    btn.disabled = true;
    try {
      const res = await fetch(`${api.baseUrl}/api/update/apply?token=${state.token}`, {
        method: 'POST', headers: api.headers(),
      });
      const result = await res.json();
      if (result.success) {
        btn.textContent = 'Restarting…';
        // Server will restart, WS will reconnect automatically
        setTimeout(() => {
          banner.innerHTML = '<div style="flex:1;"><strong>Server restarting…</strong> Reconnecting automatically.</div>';
        }, 1000);
        // Force reload after a delay to pick up new client assets
        setTimeout(() => location.reload(), 5000);
      } else {
        btn.textContent = 'Failed — try manually';
      }
    } catch (err) {
      btn.textContent = 'Failed';
    }
  };
}

function updateConnectionUI() {
  const dot = document.querySelector('#topbar .topbar-title');
  // Connection state reflected in subtitle on dashboard
  if (state.currentView === 'dashboard') {
    const sub = $('#server-info');
    if (sub) sub.textContent = state.connected ? `Connected · ${state.sessions.length} session(s)` : 'Reconnecting…';
  }
}

function updateTopbarStatus() {
  const session = state.sessions.find(s => s.id === state.activeSessionId);
  const statusEl = $('#topbar-status');
  if (session && state.currentView === 'session') {
    statusEl.textContent = session.status;
    statusEl.className = 'topbar-status ' + session.status;
  } else {
    statusEl.textContent = '';
  }
}

// ── Router ──────────────────────────────────────────────────

function navigate(view, params = {}) {
  // Cleanup previous view
  if (state.currentView === 'session' && state.activeSessionId) {
    wsSend({ type: 'unsubscribe' });
    destroyTerminal();
  }

  state.currentView = view;
  const main = $('#main');
  main.innerHTML = '';

  const backBtn = $('#btn-back');
  const label = $('#topbar-label');

  switch (view) {
    case 'dashboard':
      backBtn.classList.add('hidden');
      label.textContent = 'Sessions';
      state.activeSessionId = null;
      main.appendChild(cloneTemplate('tpl-dashboard'));
      initDashboard();
      break;

    case 'session':
      backBtn.classList.remove('hidden');
      label.textContent = params.name || 'Session';
      state.activeSessionId = params.id;
      main.appendChild(cloneTemplate('tpl-session-view'));
      initSessionView(params.id);
      break;

    case 'settings':
      backBtn.classList.remove('hidden');
      label.textContent = 'Settings';
      main.appendChild(cloneTemplate('tpl-settings'));
      initSettings();
      break;

    case 'connect':
      backBtn.classList.add('hidden');
      label.textContent = 'Connect';
      main.innerHTML = `
        <div class="dashboard" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;">
          <div style="font-size:48px;opacity:0.3;margin-bottom:16px;">⌘</div>
          <h2 style="font-size:20px;font-weight:700;margin-bottom:6px;">Claude Remote</h2>
          <p class="dim" style="margin-bottom:28px;line-height:1.5;max-width:300px;">
            Enter your server URL and auth token, or open the link printed by the server on your phone.
          </p>
          <div style="width:100%;max-width:340px;text-align:left;">
            <label class="field-label">Server URL</label>
            <input type="url" class="field-input" id="connect-url" placeholder="http://100.64.1.5:3033" value="${state.serverUrl || ''}">
            <label class="field-label">Auth Token</label>
            <input type="text" class="field-input" id="connect-token" placeholder="abc123…" value="${state.token || ''}">
            <button class="btn-primary" id="connect-go" style="width:100%;margin-top:20px;padding:12px;">Connect</button>
            <p class="dim" id="connect-error" style="margin-top:12px;color:var(--red);display:none;"></p>
          </div>
        </div>
      `;
      $('#connect-go').onclick = async () => {
        const url = $('#connect-url').value.trim().replace(/\/+$/, '');
        const token = $('#connect-token').value.trim();
        const errEl = $('#connect-error');
        if (!url || !token) {
          errEl.textContent = 'Both fields are required';
          errEl.style.display = 'block';
          return;
        }
        // Test connection
        errEl.textContent = 'Connecting…';
        errEl.style.display = 'block';
        errEl.style.color = 'var(--text-3)';
        try {
          const res = await fetch(`${url}/api/info?token=${token}`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          if (!res.ok) throw new Error('Auth failed');
          await res.json();
          state.serverUrl = url;
          state.token = token;
          saveSettings();
          connectWS();
          navigate('dashboard');
        } catch (err) {
          errEl.textContent = 'Connection failed — check URL and token';
          errEl.style.color = 'var(--red)';
        }
      };
      break;
  }

  updateTopbarStatus();
}

// ── Dashboard View ──────────────────────────────────────────

function initDashboard() {
  renderDashboard();
  updateConnectionUI();

  $('#btn-new-session').onclick = showNewSessionDialog;

  // Request fresh list
  wsSend({ type: 'list' });
}

function renderDashboard() {
  const grid = $('#session-grid');
  const empty = $('#empty-state');
  if (!grid) return;

  if (state.sessions.length === 0) {
    grid.classList.add('hidden');
    empty?.classList.remove('hidden');
    return;
  }

  grid.classList.remove('hidden');
  empty?.classList.add('hidden');

  grid.innerHTML = '';
  for (const s of state.sessions) {
    const card = cloneTemplate('tpl-session-card');
    card.dataset.id = s.id;
    card.dataset.status = s.status;

    $('.card-name', card).textContent = s.name;
    $('.card-cwd', card).textContent = shortenPath(s.cwd);

    const dot = $('.card-status-dot', card);
    dot.classList.add(s.status);

    const label = $('.card-status-label', card);
    label.textContent = s.status;
    label.classList.add(s.status);

    if (s.attentionPreview) {
      $('.card-preview', card).textContent = s.attentionPreview;
    }

    $('.card-time', card).textContent = timeAgo(s.lastActivity);

    // Events
    card.onclick = (e) => {
      if (e.target.closest('.card-btn')) return;
      navigate('session', { id: s.id, name: s.name });
    };

    $('.card-btn-open', card).onclick = () => navigate('session', { id: s.id, name: s.name });
    $('.card-btn-kill', card).onclick = (e) => {
      e.stopPropagation();
      if (confirm(`Kill "${s.name}"?`)) {
        api.del(`/api/sessions/${s.id}`);
      }
    };

    grid.appendChild(card);
  }

  // Update subtitle
  const sub = $('#server-info');
  if (sub) sub.textContent = state.connected ? `Connected · ${state.sessions.length} session(s)` : 'Reconnecting…';
}

// ── New Session Dialog ──────────────────────────────────────

function showNewSessionDialog() {
  const dialog = cloneTemplate('tpl-new-session');
  document.body.appendChild(dialog);

  const nameInput = $('#new-name', dialog);
  const cwdInput = $('#new-cwd', dialog);
  const dirListing = $('#dir-listing', dialog);

  // Pre-fill cwd with home
  api.get('/api/info').then(info => {
    cwdInput.value = info.home;
  }).catch(() => {});

  // Browse button
  $('#btn-browse', dialog).onclick = async () => {
    const path = cwdInput.value || '~';
    try {
      const { entries, path: resolved } = await api.get(`/api/files?path=${encodeURIComponent(path)}`);
      cwdInput.value = resolved;
      dirListing.classList.remove('hidden');
      dirListing.innerHTML = '';

      // Parent directory
      const parent = resolved.split('/').slice(0, -1).join('/') || '/';
      if (resolved !== '/') {
        const item = createDirItem('..', 'dir', parent);
        item.onclick = () => { cwdInput.value = parent; $('#btn-browse', dialog).click(); };
        dirListing.appendChild(item);
      }

      for (const entry of entries) {
        const item = createDirItem(entry.name, entry.type, entry.path, entry.size);
        if (entry.type === 'dir') {
          item.onclick = () => { cwdInput.value = entry.path; $('#btn-browse', dialog).click(); };
        }
        dirListing.appendChild(item);
      }
    } catch (err) {
      dirListing.classList.remove('hidden');
      dirListing.innerHTML = `<div class="dir-item" style="color:var(--red)">${err.message}</div>`;
    }
  };

  // Cancel
  $('#btn-cancel-new', dialog).onclick = () => dialog.remove();
  dialog.onclick = (e) => { if (e.target === dialog) dialog.remove(); };

  // Create
  $('#btn-create', dialog).onclick = async () => {
    const name = nameInput.value.trim() || undefined;
    const cwd = cwdInput.value.trim() || undefined;
    try {
      const session = await api.post('/api/sessions', { name, cwd });
      dialog.remove();
      navigate('session', { id: session.id, name: session.name });
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  nameInput.focus();
}

function createDirItem(name, type, fullPath, size) {
  const div = document.createElement('div');
  div.className = 'dir-item';

  const icon = document.createElement('span');
  icon.className = 'dir-item-icon';
  icon.textContent = type === 'dir' ? '📁' : '📄';

  const nameEl = document.createElement('span');
  nameEl.className = 'dir-item-name';
  nameEl.textContent = name;

  div.appendChild(icon);
  div.appendChild(nameEl);

  if (size !== null && size !== undefined) {
    const sizeEl = document.createElement('span');
    sizeEl.className = 'dir-item-size';
    sizeEl.textContent = formatSize(size);
    div.appendChild(sizeEl);
  }

  return div;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'K';
  return (bytes / 1048576).toFixed(1) + 'M';
}

// ── Session / Terminal View ─────────────────────────────────

function initSessionView(sessionId) {
  // Subscribe to session output
  wsSend({ type: 'subscribe', sessionId });

  // Init xterm.js
  initTerminal();

  // View toggle (raw vs clean)
  const toggleBtns = $$('.toggle-btn');
  toggleBtns.forEach(btn => {
    btn.onclick = () => {
      toggleBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      $('#xterm-container').classList.toggle('hidden', view !== 'raw');
      $('#clean-container').classList.toggle('hidden', view !== 'clean');
      if (view === 'raw' && state.xterm) {
        state.fitAddon.fit();
      }
    };
  });

  // Quick actions
  $$('.qbtn').forEach(btn => {
    btn.onclick = () => {
      const cmd = btn.dataset.cmd;
      if (cmd) {
        wsSend({ type: 'input', sessionId, data: cmd });
        dismissAttention();
      }
    };
  });

  // Text input
  const cmdInput = $('#cmd-input');
  const sendBtn = $('#send-btn');

  sendBtn.onclick = () => {
    const val = cmdInput.value;
    if (!val) return;
    wsSend({ type: 'input', sessionId, data: val + '\n' });
    cmdInput.value = '';
    cmdInput.style.height = 'auto';
    dismissAttention();
  };

  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  cmdInput.addEventListener('input', () => {
    cmdInput.style.height = 'auto';
    cmdInput.style.height = Math.min(cmdInput.scrollHeight, 120) + 'px';
  });

  // Mic button
  initSTT();
  const micBtn = $('#mic-btn');
  if (micBtn) {
    micBtn.onclick = toggleRecording;
  }

  // Attention dismiss
  const dismissBtn = $('#attention-dismiss');
  if (dismissBtn) dismissBtn.onclick = dismissAttention;
}

function initTerminal() {
  const container = $('#xterm-container');
  if (!container || !window.Terminal) return;

  const term = new window.Terminal({
    theme: {
      background: '#0b0c10',
      foreground: '#e4e6f0',
      cursor: '#a080f0',
      selectionBackground: 'rgba(160,128,240,0.25)',
      black: '#1a1c26',
      red: '#f06070',
      green: '#4ae08c',
      yellow: '#f0c050',
      blue: '#60a0f0',
      magenta: '#a080f0',
      cyan: '#60d0e0',
      white: '#e4e6f0',
      brightBlack: '#4e526a',
      brightRed: '#f08090',
      brightGreen: '#6ae0a0',
      brightYellow: '#f0d070',
      brightBlue: '#80b0f0',
      brightMagenta: '#b0a0f0',
      brightCyan: '#80e0f0',
      brightWhite: '#ffffff',
    },
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 13,
    lineHeight: 1.3,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 5000,
    convertEol: false,
    allowTransparency: true,
  });

  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  // Small delay to let DOM settle before fitting
  setTimeout(() => {
    fitAddon.fit();
    wsSend({
      type: 'resize',
      sessionId: state.activeSessionId,
      cols: term.cols,
      rows: term.rows,
    });
  }, 100);

  // Handle keyboard input in raw mode
  term.onData((data) => {
    wsSend({ type: 'input', sessionId: state.activeSessionId, data });
  });

  // Resize on orientation change
  const resizeObserver = new ResizeObserver(() => {
    if (state.xterm) {
      fitAddon.fit();
      wsSend({
        type: 'resize',
        sessionId: state.activeSessionId,
        cols: term.cols,
        rows: term.rows,
      });
    }
  });
  resizeObserver.observe(container);

  state.xterm = term;
  state.fitAddon = fitAddon;
  state.cleanBuffer = '';
}

function destroyTerminal() {
  if (state.xterm) {
    state.xterm.dispose();
    state.xterm = null;
    state.fitAddon = null;
  }
  state.cleanBuffer = '';
}

function appendTerminalOutput(data) {
  // Raw view — write to xterm
  if (state.xterm) {
    state.xterm.write(data);
  }

  // Clean view — accumulate and render
  state.cleanBuffer += data;
  if (state.cleanBuffer.length > 100_000) {
    state.cleanBuffer = state.cleanBuffer.slice(-60_000);
  }
  renderCleanView();
}

function renderCleanView() {
  const container = $('#clean-container');
  if (!container) return;

  const clean = stripAnsi(state.cleanBuffer);
  const lines = clean.split('\n');

  // Simple heuristic: group lines into blocks
  // Lines that look like Claude output vs shell commands
  let html = '';
  let currentBlock = '';
  let blockType = 'system';

  for (const line of lines.slice(-200)) {  // Last 200 lines
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentBlock) {
        html += `<div class="clean-block ${blockType}">${escapeHtml(currentBlock.trim())}</div>`;
        currentBlock = '';
        blockType = 'system';
      }
      continue;
    }

    // Detect Claude-like output (longer prose, not commands)
    if (trimmed.length > 60 && !trimmed.startsWith('$') && !trimmed.startsWith('/') && !trimmed.match(/^[a-z_]+\(/)) {
      blockType = 'claude';
    }

    currentBlock += line + '\n';
  }

  if (currentBlock.trim()) {
    html += `<div class="clean-block ${blockType}">${escapeHtml(currentBlock.trim())}</div>`;
  }

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Attention Handling ──────────────────────────────────────

function handleAttention(sessionId, preview) {
  // Update session card on dashboard
  const session = state.sessions.find(s => s.id === sessionId);

  // If we're viewing this session, show the banner
  if (sessionId === state.activeSessionId && state.currentView === 'session') {
    const bar = $('#attention-bar');
    const msg = $('#attention-msg');
    if (bar) {
      bar.classList.remove('hidden');
      if (msg) msg.textContent = preview || '';
    }
  }

  // Vibrate
  if (state.alertsEnabled && navigator.vibrate) {
    navigator.vibrate([200, 100, 200]);
  }

  // Push notification if backgrounded
  if (document.hidden && Notification.permission === 'granted') {
    const name = session?.name || 'Session';
    new Notification(`${name} needs input`, {
      body: preview ? preview.slice(0, 120) : 'Claude is waiting for your response',
      tag: `claude-${sessionId}`,
      renotify: true,
    });
  }

  // TTS
  if (state.ttsEnabled && state.alertsEnabled) {
    speak('Attention. ' + (preview || 'Claude needs input.'));
  }
}

function dismissAttention() {
  const bar = $('#attention-bar');
  if (bar) bar.classList.add('hidden');
}

// ── TTS ─────────────────────────────────────────────────────

function accumulateForTTS(data) {
  if (!state.ttsEnabled) return;

  state.ttsAccum += stripAnsi(data);
  clearTimeout(state.ttsTimer);

  state.ttsTimer = setTimeout(() => {
    let text = state.ttsAccum.trim();
    state.ttsAccum = '';
    if (!text || text.length < 5) return;

    if (state.smartTts) {
      // Filter out shell noise
      const lines = text.split('\n').filter(line => {
        const t = line.trim();
        if (!t) return false;
        if (t.startsWith('$') || t.startsWith('>') || t.startsWith('#')) return false;
        if (t.startsWith('diff ') || t.startsWith('---') || t.startsWith('+++')) return false;
        if (t.startsWith('@@')) return false;
        if (/^[a-z_\/.\-]+(:[0-9]+)?$/i.test(t)) return false;
        if (t.startsWith('{') || t.startsWith('}') || t.startsWith('[')) return false;
        return true;
      });
      text = lines.join('. ');
    }

    if (text.length > 5) speak(text);
  }, 900);
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  if (text.length > 800) text = text.slice(0, 800) + '… truncated.';

  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = state.speechRate;
  utt.pitch = 1.0;

  if (state.selectedVoiceURI) {
    const voice = speechSynthesis.getVoices().find(v => v.voiceURI === state.selectedVoiceURI);
    if (voice) utt.voice = voice;
  }

  speechSynthesis.cancel();
  speechSynthesis.speak(utt);
}

// ── STT ─────────────────────────────────────────────────────

function initSTT() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    const mic = $('#mic-btn');
    if (mic) mic.style.display = 'none';
    return;
  }

  if (state.recognition) return; // already init

  const recog = new SR();
  recog.continuous = false;
  recog.interimResults = true;
  recog.lang = state.sttLang;
  state.recognition = recog;

  recog.onresult = (e) => {
    let transcript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    const input = $('#cmd-input');
    if (input) {
      input.value = transcript;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }

    if (e.results[e.results.length - 1].isFinal) {
      setTimeout(() => $('#send-btn')?.click(), 400);
    }
  };

  recog.onend = () => {
    state.recording = false;
    $('#mic-btn')?.classList.remove('recording');
  };

  recog.onerror = () => {
    state.recording = false;
    $('#mic-btn')?.classList.remove('recording');
  };
}

function toggleRecording() {
  if (!state.recognition) return;

  if (state.recording) {
    state.recognition.stop();
    state.recording = false;
    $('#mic-btn')?.classList.remove('recording');
  } else {
    state.recognition.lang = state.sttLang;
    state.recognition.start();
    state.recording = true;
    $('#mic-btn')?.classList.add('recording');
    speechSynthesis.cancel();
  }
}

// ── Settings View ───────────────────────────────────────────

function initSettings() {
  // Toggles
  $$('.toggle-switch').forEach(toggle => {
    const key = toggle.dataset.key;
    if (state[key]) toggle.classList.add('on');
    else toggle.classList.remove('on');

    toggle.onclick = () => {
      toggle.classList.toggle('on');
      state[key] = toggle.classList.contains('on');
      saveSettings();

      // Sync TTS header button
      const voiceBtn = $('#btn-voice');
      if (key === 'ttsEnabled') {
        voiceBtn.classList.toggle('active', state.ttsEnabled);
        if (!state.ttsEnabled) speechSynthesis.cancel();
      }
    };
  });

  // Notification permission
  const notifBtn = $('#btn-notif-perm');
  if (notifBtn) {
    if (Notification.permission === 'granted') {
      notifBtn.textContent = 'Enabled ✓';
    }
    notifBtn.onclick = () => {
      Notification.requestPermission().then(p => {
        notifBtn.textContent = p === 'granted' ? 'Enabled ✓' : 'Denied';
      });
    };
  }

  // Voice select
  const voiceSel = $('#sel-voice');
  function populateVoices() {
    const voices = speechSynthesis.getVoices();
    voiceSel.innerHTML = '<option value="">Default</option>';
    voices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})`;
      if (v.voiceURI === state.selectedVoiceURI) opt.selected = true;
      voiceSel.appendChild(opt);
    });
  }
  speechSynthesis.onvoiceschanged = populateVoices;
  populateVoices();

  voiceSel.onchange = () => {
    state.selectedVoiceURI = voiceSel.value || null;
    saveSettings();
  };

  // Rate
  const rateRange = $('#rate-range');
  const rateVal = $('#rate-val');
  rateRange.value = state.speechRate;
  rateVal.textContent = ` ${state.speechRate.toFixed(1)}×`;
  rateRange.oninput = () => {
    state.speechRate = parseFloat(rateRange.value);
    rateVal.textContent = ` ${state.speechRate.toFixed(1)}×`;
    saveSettings();
  };

  // STT language
  const langSel = $('#sel-lang');
  langSel.value = state.sttLang;
  langSel.onchange = () => {
    state.sttLang = langSel.value;
    saveSettings();
  };

  // Server URL display
  const serverUrl = $('#setting-server-url');
  if (serverUrl) serverUrl.textContent = state.serverUrl || location.origin;

  // Version + Git info
  fetchVersionInfo();

  // Check for updates button
  const checkBtn = $('#btn-check-update');
  if (checkBtn) {
    checkBtn.onclick = async () => {
      checkBtn.textContent = 'Checking…';
      checkBtn.disabled = true;
      try {
        const res = await fetch(`${api.baseUrl}/api/update/check?token=${state.token}`, {
          method: 'POST', headers: api.headers(),
        });
        const data = await res.json();
        const statusEl = $('#setting-update-status');
        if (data.updateAvailable) {
          statusEl.textContent = `${data.details.newVersion} available (${data.details.commitsBehind} commits)`;
          statusEl.style.color = 'var(--accent)';
          checkBtn.textContent = 'Update & Restart';
          checkBtn.disabled = false;
          checkBtn.onclick = applyUpdate;
        } else {
          statusEl.textContent = 'Up to date';
          statusEl.style.color = 'var(--green)';
          checkBtn.textContent = 'Check';
          checkBtn.disabled = false;
        }
      } catch (err) {
        const statusEl = $('#setting-update-status');
        statusEl.textContent = 'Check failed';
        statusEl.style.color = 'var(--red)';
        checkBtn.textContent = 'Retry';
        checkBtn.disabled = false;
      }
    };
  }
}

async function fetchVersionInfo() {
  try {
    const data = await api.get('/api/version');
    const versionEl = $('#setting-version');
    const gitEl = $('#setting-git-info');
    if (versionEl) versionEl.textContent = `v${data.version}`;
    if (gitEl) {
      if (data.git?.isGit) {
        const dirty = data.git.dirty ? ' (modified)' : '';
        gitEl.textContent = `${data.git.branch}@${data.git.commit}${dirty}`;
      } else {
        gitEl.textContent = 'Not a git repo — updates disabled';
      }
    }
    // Show update status if already known
    if (data.updateAvailable) {
      const statusEl = $('#setting-update-status');
      if (statusEl) {
        statusEl.textContent = `${data.updateAvailable.newVersion} available`;
        statusEl.style.color = 'var(--accent)';
      }
    }
  } catch {}
}

async function applyUpdate() {
  const btn = $('#btn-check-update');
  const statusEl = $('#setting-update-status');
  if (btn) { btn.textContent = 'Updating…'; btn.disabled = true; }
  try {
    const res = await fetch(`${api.baseUrl}/api/update/apply?token=${state.token}`, {
      method: 'POST', headers: api.headers(),
    });
    const result = await res.json();
    if (result.success) {
      if (statusEl) statusEl.textContent = `Updated to v${result.version} — restarting…`;
      if (btn) btn.textContent = 'Restarting…';
      // Server will restart, reload page after a delay to get new assets
      setTimeout(() => location.reload(), 5000);
    }
  } catch {
    if (statusEl) statusEl.textContent = 'Update failed';
    if (btn) { btn.textContent = 'Retry'; btn.disabled = false; }
  }
}

function disconnectServer() {
  state.serverUrl = '';
  state.token = '';
  state.connected = false;
  if (state.ws) { state.ws.close(); state.ws = null; }
  saveSettings();
  navigate('connect');
}

// ── Top-level event binding ─────────────────────────────────

$('#btn-back').onclick = () => navigate('dashboard');
$('#btn-settings').onclick = () => {
  if (state.currentView === 'settings') navigate('dashboard');
  else navigate('settings');
};
$('#btn-voice').onclick = () => {
  state.ttsEnabled = !state.ttsEnabled;
  $('#btn-voice').classList.toggle('active', state.ttsEnabled);
  if (!state.ttsEnabled) speechSynthesis.cancel();
  saveSettings();
};

// ── Init ────────────────────────────────────────────────────

// Client-side settings migration
function migrateClientSettings() {
  const saved = JSON.parse(localStorage.getItem('claude-remote-settings') || '{}');
  const currentVersion = saved._settingsVersion || 0;

  // Define migrations: version number → migration function
  const migrations = {
    // Example for future:
    // 1: (s) => { s.newField = s.newField ?? 'default'; return s; },
  };

  let settings = { ...saved };
  let version = currentVersion;
  const maxVersion = Math.max(0, ...Object.keys(migrations).map(Number));

  while (version < maxVersion) {
    version++;
    if (migrations[version]) {
      settings = migrations[version](settings);
    }
  }

  if (version > currentVersion) {
    settings._settingsVersion = version;
    localStorage.setItem('claude-remote-settings', JSON.stringify(settings));
    console.log(`Settings migrated: v${currentVersion} → v${version}`);
  }
}

migrateClientSettings();

// Startup
if (state.token) {
  connectWS();
  navigate('dashboard');

  // Check for updates 10s after startup
  setTimeout(async () => {
    try {
      const res = await fetch(`${api.baseUrl}/api/update/check?token=${state.token}`, {
        method: 'POST', headers: api.headers(),
      });
      const data = await res.json();
      if (data.updateAvailable) {
        showUpdateBanner(data.details);
      }
    } catch {}
  }, 10_000);

} else {
  navigate('connect');
}

// Keep-alive
setInterval(() => wsSend({ type: 'ping' }), 25000);
