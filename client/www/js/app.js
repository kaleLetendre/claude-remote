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
  alertPrompt: true,
  alertIdle: true,
  speechRate: 1.1,
  selectedVoiceURI: null,
  sttLang: 'en-US',

  // Runtime
  recording: false,
  recognition: null,
  xterm: null,
  fitAddon: null,
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
    'ttsEnabled', 'smartTts', 'alertsEnabled', 'alertPrompt', 'alertIdle', 'speechRate',
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

// ── Momentum Scroll ───────────────────────────────────────
// Adds inertial "throw" scrolling to any element.
// Tracks touch velocity, continues with deceleration on release.
// Additive: flicking again while coasting adds to the velocity.
function enableMomentumScroll(el, { getScrollPos, setScrollPos }) {
  let velocity = 0;
  let lastY = 0;
  let lastTime = 0;
  let animFrame = null;
  let tracking = false;

  const friction = 0.94;   // per-frame multiplier (higher = longer coast)
  const minVelocity = 0.5; // stop threshold

  el.addEventListener('touchstart', (e) => {
    tracking = true;
    // Don't kill existing velocity entirely — let additive work
    velocity *= 0.3;
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    lastY = e.touches[0].clientY;
    lastTime = performance.now();
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const now = performance.now();
    const y = e.touches[0].clientY;
    const dt = now - lastTime || 1;
    const dy = lastY - y; // positive = scroll down

    // Scroll immediately
    setScrollPos(getScrollPos() + dy);

    // Track velocity (pixels per ms, smoothed)
    velocity = 0.7 * (dy / dt) + 0.3 * velocity;
    lastY = y;
    lastTime = now;
  }, { passive: true });

  el.addEventListener('touchend', () => {
    tracking = false;
    // Convert to pixels per frame (~16ms)
    velocity *= 16;
    coast();
  }, { passive: true });

  function coast() {
    if (Math.abs(velocity) < minVelocity) { velocity = 0; return; }
    setScrollPos(getScrollPos() + velocity);
    velocity *= friction;
    animFrame = requestAnimationFrame(coast);
  }
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
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${this.baseUrl}${path}${sep}token=${state.token}`, { headers: this.headers() });
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

const wsSendQueue = [];

function connectWS() {
  if (!state.token) { console.warn('[ws] no token, skipping connect'); return; }
  if (state.ws?.readyState === WebSocket.OPEN) return;
  // If a previous socket is still CONNECTING or CLOSING, tear it down
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.close(); } catch {}
    state.ws = null;
  }

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

  const wsUrl = `${wsHost}?token=${state.token}`;
  console.log('[ws] connecting to', wsUrl);
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    console.log('[ws] connected');
    state.connected = true;
    updateConnectionUI();

    // Flush any messages queued while the socket was connecting
    while (wsSendQueue.length > 0) {
      const queued = wsSendQueue.shift();
      ws.send(JSON.stringify(queued));
    }

    // Re-subscribe to active session after reconnect (e.g. returning from background)
    if (state.activeSessionId && state.currentView === 'session') {
      wsSend({ type: 'subscribe', sessionId: state.activeSessionId });
    }
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleWSMessage(msg);
  };

  ws.onclose = (e) => {
    console.warn('[ws] closed', e.code, e.reason);
    state.connected = false;
    updateConnectionUI();
    setTimeout(connectWS, 3000);
  };

  ws.onerror = (e) => { console.error('[ws] error', e); };
}

function wsSend(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  } else {
    console.warn('[ws] queuing message, ws not open. readyState:', state.ws?.readyState, 'msg:', msg.type);
    wsSendQueue.push(msg);
    // Make sure we're trying to connect
    connectWS();
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
      console.log('[ws] output for', msg.sessionId, 'active:', state.activeSessionId, 'match:', msg.sessionId === state.activeSessionId, 'len:', msg.data?.length);
      if (msg.sessionId === state.activeSessionId) {
        appendTerminalOutput(msg.data);
        accumulateForTTS(msg.data);
      }
      break;

    case 'session:attention':
      handleAttention(msg.sessionId, msg.reason, msg.preview);
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

function showApkUpdateBanner(data, clientVersion) {
  const existing = document.querySelector('.apk-update-banner');
  if (existing) existing.remove();

  const size = data.apkSize ? ` (${(data.apkSize / 1024 / 1024).toFixed(1)} MB)` : '';
  const downloadUrl = `${api.baseUrl}/api/app/download`;

  const banner = document.createElement('div');
  banner.className = 'apk-update-banner';
  banner.innerHTML = `
    <div style="flex:1;">
      <strong>App update available</strong>
      <span style="opacity:0.7;margin-left:6px;">${clientVersion} → ${data.version}</span>
      <span style="opacity:0.5;margin-left:6px;">${size}</span>
    </div>
    <button class="update-btn" id="apk-download-btn">Download APK</button>
    <button class="update-dismiss" id="apk-dismiss-btn">✕</button>
  `;

  document.body.prepend(banner);
  document.getElementById('apk-dismiss-btn').onclick = () => banner.remove();
  document.getElementById('apk-download-btn').onclick = () => {
    // Post message to bootstrap parent to handle download (it has Capacitor bridge)
    // Falls back to window.open which opens the system browser
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'download-apk', url: downloadUrl }, '*');
    } else {
      window.open(downloadUrl, '_blank');
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
            Enter your server URL and password to connect.
          </p>
          <div style="width:100%;max-width:340px;text-align:left;">
            <label class="field-label">Server URL</label>
            <input type="url" class="field-input" id="connect-url" placeholder="http://100.64.1.5:3033" value="${state.serverUrl || ''}">
            <label class="field-label">Password</label>
            <input type="password" class="field-input" id="connect-password" placeholder="Enter password">
            <button class="btn-primary" id="connect-go" style="width:100%;margin-top:20px;padding:12px;">Connect</button>
            <details style="margin-top:16px;">
              <summary class="dim" style="cursor:pointer;font-size:13px;">Advanced: connect with token</summary>
              <div style="margin-top:8px;">
                <label class="field-label">Auth Token</label>
                <input type="text" class="field-input" id="connect-token" placeholder="abc123…" value="${state.token || ''}">
              </div>
            </details>
            <p class="dim" id="connect-error" style="margin-top:12px;color:var(--red);display:none;"></p>
          </div>
        </div>
      `;
      $('#connect-go').onclick = async () => {
        const url = $('#connect-url').value.trim().replace(/\/+$/, '');
        const password = $('#connect-password').value.trim();
        const tokenInput = $('#connect-token').value.trim();
        const errEl = $('#connect-error');
        if (!url) {
          errEl.textContent = 'Server URL is required';
          errEl.style.display = 'block';
          return;
        }
        if (!password && !tokenInput) {
          errEl.textContent = 'Enter a password or token';
          errEl.style.display = 'block';
          return;
        }
        errEl.textContent = 'Connecting…';
        errEl.style.display = 'block';
        errEl.style.color = 'var(--text-3)';
        try {
          let token = tokenInput;
          // If password provided, exchange it for a token
          if (password && !token) {
            const loginRes = await fetch(`${url}/api/auth/login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password }),
            });
            if (!loginRes.ok) {
              const err = await loginRes.json().catch(() => ({}));
              throw new Error(err.error || 'Login failed');
            }
            const loginData = await loginRes.json();
            token = loginData.token;
          }
          // Verify the token works
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
          errEl.textContent = err.message || 'Connection failed';
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
  $('#btn-quick-chat').onclick = showQuickChatPrompt;

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
    if (s.status === 'dead') {
      // Dead session — reconnect on tap
      const openSession = async () => {
        try {
          await api.post(`/api/sessions/${s.id}/reconnect`);
          navigate('session', { id: s.id, name: s.name });
        } catch (err) {
          console.error('Reconnect failed:', err);
        }
      };
      card.onclick = (e) => {
        if (e.target.closest('.card-btn')) return;
        openSession();
      };
      $('.card-btn-open', card).onclick = openSession;
    } else {
      card.onclick = (e) => {
        if (e.target.closest('.card-btn')) return;
        navigate('session', { id: s.id, name: s.name });
      };
      $('.card-btn-open', card).onclick = () => navigate('session', { id: s.id, name: s.name });
    }

    $('.card-btn-kill', card).onclick = (e) => {
      e.stopPropagation();
      if (confirm(`${s.status === 'dead' ? 'Remove' : 'Kill'} "${s.name}"?`)) {
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

// ── Quick Chat ────────────────────────────────────────────────

async function showQuickChatPrompt() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const chatName = `chat-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

  try {
    const info = await api.get('/api/info');
    const cwd = `${info.home}/ClaudeChats/${chatName}`;
    const session = await api.post('/api/sessions', { name: chatName, cwd });
    navigate('session', { id: session.id, name: session.name });
  } catch (err) {
    alert('Error: ' + err.message);
  }
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
  console.log('[session] subscribing to', sessionId);
  wsSend({ type: 'subscribe', sessionId });

  // Init xterm.js
  initTerminal();

  // Jump to bottom button — use touchstart/mousedown + preventDefault to avoid stealing focus
  const jumpBtn = $('#jump-bottom-btn');
  if (jumpBtn) {
    jumpBtn.onmousedown = jumpToBottom;
    jumpBtn.ontouchstart = jumpToBottom;
  }

  // Quick actions — send directly to pty
  $$('.qbtn').forEach(btn => {
    btn.onclick = () => {
      const raw = btn.dataset.cmd;
      if (!raw) return;
      // If data ends with \r (Enter), split text from Enter with a delay
      if (raw.length > 1 && raw.endsWith('\r')) {
        const text = raw.slice(0, -1);
        wsSend({ type: 'input', sessionId, data: text });
        setTimeout(() => {
          wsSend({ type: 'input', sessionId, data: '\r' });
        }, 150);
      } else {
        wsSend({ type: 'input', sessionId, data: raw });
      }
      dismissAttention();
    };
  });

  // Text input — type command, Enter or Send sends it
  const cmdInput = $('#cmd-input');
  const sendBtn = $('#send-btn');

  function sendCommand() {
    const val = cmdInput.value;
    if (!val && !val.trim()) {
      // Empty input — just send Enter
      wsSend({ type: 'input', sessionId, data: '\r' });
    } else {
      // Send text first, then Enter after a short delay
      // Claude Code's TUI input needs this separation
      wsSend({ type: 'input', sessionId, data: val });
      setTimeout(() => {
        wsSend({ type: 'input', sessionId, data: '\r' });
      }, 150);
    }
    cmdInput.value = '';
    dismissAttention();
  }

  sendBtn.onclick = sendCommand;

  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendCommand();
    }
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
  console.log('[term] init, container:', !!container, 'Terminal:', !!window.Terminal, 'FitAddon:', !!window.FitAddon);
  if (!container || !window.Terminal) return;

  const term = new window.Terminal({
    theme: {
      background: '#0b0c10',
      foreground: '#e4e6f0',
      cursor: '#4ae08c',
      selectionBackground: 'rgba(74,224,140,0.25)',
      black: '#1a1c26',
      red: '#f06070',
      green: '#4ae08c',
      yellow: '#f0c050',
      blue: '#60a0f0',
      magenta: '#4ae08c',
      cyan: '#60d0e0',
      white: '#e4e6f0',
      brightBlack: '#4e526a',
      brightRed: '#f08090',
      brightGreen: '#6ae0a0',
      brightYellow: '#f0d070',
      brightBlue: '#80b0f0',
      brightMagenta: '#6ae0a0',
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
    disableStdin: true,  // Terminal is read-only — input goes through the cmd bar
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

  // Terminal is read-only — prevent xterm's hidden textarea from capturing focus.
  // All input goes through the cmd-input bar.
  setTimeout(() => {
    const xtermTextarea = container.querySelector('.xterm-helper-textarea');
    if (xtermTextarea) {
      xtermTextarea.disabled = true;
      xtermTextarea.style.display = 'none';
    }
  }, 200);

  // Resize on orientation change — skip when keyboard opens/closes to avoid scroll jumps
  let resizeTimer = null;
  const resizeObserver = new ResizeObserver(() => {
    if (!state.xterm) return;
    // Skip resize when keyboard opens/closes — the terminal content size hasn't changed
    if (keyboardOpen || keyboardTransitioning) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.xterm || keyboardOpen || keyboardTransitioning) return;
      // Don't resize during active output — causes scroll flash
      if (Date.now() - _lastWriteTime < 500) return;
      const vp = container.querySelector('.xterm-viewport');
      const prevScroll = vp ? vp.scrollTop : 0;
      const atBottom = !vp || (vp.scrollHeight - vp.scrollTop - vp.clientHeight < 80);

      fitAddon.fit();
      wsSend({
        type: 'resize',
        sessionId: state.activeSessionId,
        cols: term.cols,
        rows: term.rows,
      });

      // fit() resets scroll — restore position
      if (vp) {
        const target = atBottom ? vp.scrollHeight : prevScroll;
        vp.scrollTop = target;
        requestAnimationFrame(() => { vp.scrollTop = target; });
      }
    }, 150);
  });
  resizeObserver.observe(container);

  // Terminal is read-only (disableStdin: true) — taps allow text selection and scrolling.
  // The cmd-input bar at the bottom handles all user input.

  // Momentum scrolling for xterm on mobile
  // xterm handles scroll via JS (not native overflow), so we add inertia
  const viewport = container.querySelector('.xterm-viewport');
  if (viewport) {
    enableMomentumScroll(container, {
      getScrollPos: () => viewport.scrollTop,
      setScrollPos: (v) => { viewport.scrollTop = v; },
    });
    viewport.addEventListener('scroll', updateJumpToBottomBtn, { passive: true });
    // Enable text selection on long-press while keeping momentum scroll working.
    // pointer-events:none prevents xterm from fighting our scroll, but also blocks
    // text selection. We toggle it on long-press.
    const screen = container.querySelector('.xterm-screen');
    if (screen) {
      screen.style.pointerEvents = 'none';
      let _longPressTimer = null;
      container.addEventListener('touchstart', (e) => {
        _longPressTimer = setTimeout(() => {
          // Long press detected — enable pointer events for text selection
          screen.style.pointerEvents = 'auto';
          screen.style.userSelect = 'text';
          screen.style.webkitUserSelect = 'text';
        }, 400);
      }, { passive: true });
      container.addEventListener('touchmove', () => {
        // Moved — it's a scroll, not a long press
        clearTimeout(_longPressTimer);
      }, { passive: true });
      container.addEventListener('touchend', (e) => {
        const wasLongPress = !_longPressTimer;
        clearTimeout(_longPressTimer);
        _longPressTimer = null;

        // Quick tap while text is selected → clear selection
        if (!wasLongPress && window.getSelection()?.toString()) {
          window.getSelection().removeAllRanges();
          screen.style.pointerEvents = 'none';
          screen.style.userSelect = '';
          screen.style.webkitUserSelect = '';
          return;
        }

        // Re-disable after a delay so copy menu can be used
        setTimeout(() => {
          if (!window.getSelection()?.toString()) {
            screen.style.pointerEvents = 'none';
            screen.style.userSelect = '';
            screen.style.webkitUserSelect = '';
          }
        }, 300);
      }, { passive: true });
      // Once user clears selection (taps away), restore pointer-events:none
      document.addEventListener('selectionchange', () => {
        if (!window.getSelection()?.toString() && screen.style.pointerEvents === 'auto') {
          screen.style.pointerEvents = 'none';
          screen.style.userSelect = '';
          screen.style.webkitUserSelect = '';
        }
      });
    }
  }

  state.xterm = term;
  state.fitAddon = fitAddon;

  // Install scroll lock after xterm viewport is in the DOM
  setTimeout(installScrollLock, 200);
}

function destroyTerminal() {
  if (state.xterm) {
    state.xterm.dispose();
    state.xterm = null;
    state.fitAddon = null;
  }
}

// Scroll lock: when the user is scrolled up, prevent xterm.write() from
// auto-scrolling to the bottom. We do this by intercepting the scroll event
// on the viewport during writes and snapping back immediately.
let _scrollLocked = false;
let _lockScrollPos = 0;

let _lastWriteTime = 0;

function appendTerminalOutput(data) {
  if (!state.xterm) return;
  _lastWriteTime = Date.now();

  const vp = document.querySelector('#xterm-container .xterm-viewport');
  const atBottom = !vp || (vp.scrollHeight - vp.scrollTop - vp.clientHeight < 80);

  if (!atBottom && vp) {
    // User is scrolled up — save line position, write, restore
    const savedLine = state.xterm.buffer.active.viewportY;
    _scrollLocked = true;

    state.xterm.write(data, () => {
      state.xterm.scrollToLine(savedLine);
      requestAnimationFrame(() => { _scrollLocked = false; });
    });
  } else {
    // At bottom — just write, xterm auto-scrolls
    state.xterm.write(data);
  }

  updateJumpToBottomBtn();
}

// Intercept scroll events on the xterm viewport to enforce the lock.
// This catches xterm's synchronous scroll-to-bottom during write().
function installScrollLock() {
  // No longer needed — scroll lock is handled via xterm.scrollToLine() in the write callback
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Jump to Bottom ────────────────────────────────────────

function updateJumpToBottomBtn() {
  const btn = $('#jump-bottom-btn');
  if (!btn) return;

  const viewport = document.querySelector('#xterm-container .xterm-viewport');
  if (!viewport) { btn.classList.add('hidden'); return; }

  const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 120;
  btn.classList.toggle('hidden', nearBottom);
}

function jumpToBottom(e) {
  // Prevent the button from stealing focus (which closes the keyboard)
  if (e) e.preventDefault();

  const viewport = document.querySelector('#xterm-container .xterm-viewport');
  if (viewport) viewport.scrollTop = viewport.scrollHeight;
  if (state.xterm) state.xterm.scrollToBottom();

  const btn = $('#jump-bottom-btn');
  if (btn) btn.classList.add('hidden');
}

// ── Attention Handling ──────────────────────────────────────

// Audio chime using Web Audio API (works in Android WebViews)
let _audioCtx = null;
function playChime(type) {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    const now = ctx.currentTime;

    if (type === 'prompt') {
      // Two-tone urgent chime
      [520, 680].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.3, now + i * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.15 + 0.3);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + i * 0.15);
        osc.stop(now + i * 0.15 + 0.3);
      });
    } else {
      // Single soft tone for idle
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.4);
    }
  } catch {}
}

function handleAttention(sessionId, reason, preview) {
  const session = state.sessions.find(s => s.id === sessionId);
  const name = session?.name || 'Session';

  // Skip if user is actively viewing this session
  if (state.currentView === 'session' && state.activeSessionId === sessionId && !document.hidden) return;

  if (reason === 'prompt' && !state.alertPrompt) return;
  if (reason === 'idle' && !state.alertIdle) return;

  if (reason === 'prompt') {
    // Claude is blocked waiting for user input
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    playChime('prompt');

    // Try Web Notification (works in some contexts)
    try {
      if (Notification.permission === 'granted') {
        new Notification(`${name} needs input`, {
          body: preview ? preview.slice(0, 120) : 'Claude is waiting for your response',
          tag: `claude-prompt-${sessionId}`,
          renotify: true,
        });
      }
    } catch {}

    if (state.ttsEnabled) {
      speak(preview || 'Claude needs input.');
    }
  } else if (reason === 'idle') {
    // Output finished
    if (navigator.vibrate) navigator.vibrate([100]);
    playChime('idle');

    try {
      if (Notification.permission === 'granted') {
        new Notification(`${name} — output finished`, {
          body: 'Claude appears to be done.',
          tag: `claude-idle-${sessionId}`,
          renotify: true,
        });
      }
    } catch {}

    if (state.ttsEnabled) {
      speak(`${name} output finished.`);
    }
  }

  // Show in-app toast regardless of view
  showAttentionToast(sessionId, name, reason, preview);
}

// In-app toast notification (works regardless of Android WebView limitations)
function showAttentionToast(sessionId, name, reason, preview) {
  // Remove existing toast for this session
  const existing = document.querySelector(`.attention-toast[data-session="${sessionId}"]`);
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'attention-toast';
  toast.dataset.session = sessionId;

  const icon = reason === 'prompt' ? '⚡' : '✓';
  const title = reason === 'prompt' ? `${name} needs input` : `${name} — done`;
  const body = reason === 'prompt'
    ? (preview ? preview.slice(0, 100) : 'Claude is waiting for your response')
    : 'Output finished';

  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${body}</div>
    </div>
    <button class="toast-close">✕</button>
  `;

  // Tap toast to navigate to session
  toast.addEventListener('click', (e) => {
    if (e.target.closest('.toast-close')) {
      toast.remove();
      return;
    }
    toast.remove();
    navigate('session', { id: sessionId, name });
  });

  // Auto-dismiss after 8 seconds
  setTimeout(() => toast.remove(), 8000);

  document.body.appendChild(toast);
  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('show'));
}

// Check for attention events we missed while backgrounded
// Called when app returns to foreground after reconnect
function checkMissedAttention() {
  if (!state.sessions?.length) return;
  for (const s of state.sessions) {
    if (s.attentionReason && s.attentionAt) {
      // Only fire if the attention happened while we were away (last 5 minutes)
      const age = Date.now() - s.attentionAt;
      if (age < 300_000) {
        const name = s.name || 'Session';
        handleAttention(s.id, s.attentionReason, s.attentionPreview);
      }
    }
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

    };
  });

  // Server URL display
  const serverUrl = $('#setting-server-url');
  if (serverUrl) serverUrl.textContent = state.serverUrl || location.origin;

  // Version + Git info
  // Disconnect button
  const disconnectBtn = $('#btn-disconnect');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      disconnectServer();
    });
  }

  // Server update check
  const serverBtn = $('#btn-check-server-update');
  if (serverBtn) {
    // Show current server version on load
    api.get('/api/version').then(data => {
      const el = $('#setting-version');
      if (el) el.textContent = data.version ? `v${data.version}` : '—';
    }).catch(() => {});

    serverBtn.onclick = async () => {
      const statusEl = $('#setting-server-update-status');
      serverBtn.textContent = 'Checking…';
      serverBtn.disabled = true;
      try {
        const res = await fetch(`${api.baseUrl}/api/update/check?token=${state.token}`, {
          method: 'POST', headers: api.headers(),
        });
        const data = await res.json();
        if (data.updateAvailable) {
          statusEl.textContent = `${data.details.newVersion} available`;
          statusEl.style.color = 'var(--accent)';
          serverBtn.textContent = 'Update & Refresh';
          serverBtn.disabled = false;
          serverBtn.onclick = async () => {
            serverBtn.textContent = 'Updating…';
            serverBtn.disabled = true;
            try {
              const res = await fetch(`${api.baseUrl}/api/update/apply?token=${state.token}`, {
                method: 'POST', headers: api.headers(),
              });
              const result = await res.json();
              if (result.success) {
                statusEl.textContent = 'Restarting…';
                setTimeout(() => location.reload(), 5000);
              }
            } catch {
              statusEl.textContent = 'Update failed';
              serverBtn.textContent = 'Retry';
              serverBtn.disabled = false;
            }
          };
        } else {
          statusEl.textContent = 'Up to date';
          statusEl.style.color = 'var(--green)';
          serverBtn.textContent = 'Check';
          serverBtn.disabled = false;
        }
      } catch {
        statusEl.textContent = 'Check failed';
        statusEl.style.color = 'var(--red)';
        serverBtn.textContent = 'Retry';
        serverBtn.disabled = false;
      }
    };
  }

  // App update check
  const appBtn = $('#btn-check-app-update');
  if (appBtn) {
    // Show current app version (from URL param set by bootstrap)
    const params = new URLSearchParams(location.search);
    const clientVersion = params.get('v') || 'unknown';
    const appVersionEl = $('#setting-app-version');
    if (appVersionEl) appVersionEl.textContent = `v${clientVersion}`;

    appBtn.onclick = async () => {
      const statusEl = $('#setting-app-update-status');
      appBtn.textContent = 'Checking…';
      appBtn.disabled = true;
      try {
        const res = await fetch(`${api.baseUrl}/api/app/version`);
        const data = await res.json();
        if (data.version && data.version !== clientVersion) {
          statusEl.textContent = `${clientVersion} → ${data.version}`;
          statusEl.style.color = 'var(--accent)';
          appBtn.textContent = 'Download';
          appBtn.disabled = false;
          appBtn.onclick = () => {
            const url = `${api.baseUrl}/api/app/download`;
            if (window.parent !== window) {
              window.parent.postMessage({ type: 'download-apk', url }, '*');
            } else {
              window.open(url, '_blank');
            }
          };
        } else if (!data.hasApk) {
          statusEl.textContent = 'No APK available on server';
          statusEl.style.color = 'var(--text-2)';
          appBtn.textContent = 'Check';
          appBtn.disabled = false;
        } else {
          statusEl.textContent = 'Up to date';
          statusEl.style.color = 'var(--green)';
          appBtn.textContent = 'Check';
          appBtn.disabled = false;
        }
      } catch {
        statusEl.textContent = 'Check failed';
        statusEl.style.color = 'var(--red)';
        appBtn.textContent = 'Retry';
        appBtn.disabled = false;
      }
    };
  }
}

function disconnectServer() {
  state.serverUrl = '';
  state.token = '';
  state.connected = false;
  if (state.ws) { state.ws.close(); state.ws = null; }
  saveSettings();
  // Tell bootstrap parent to stop polling and show login
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'logout' }, '*');
  }
  navigate('connect');
}

// ── Top-level event binding ─────────────────────────────────

$('#btn-back').onclick = () => navigate('dashboard');

// Android back button — intercept via popstate
window.addEventListener('popstate', () => {
  if (state.currentView === 'session' || state.currentView === 'settings') {
    navigate('dashboard');
  }
  // Push a dummy state so the next back press is also caught
  history.pushState(null, '', location.href);
});
// Seed initial state
history.pushState(null, '', location.href);
$('#btn-settings').onclick = () => {
  if (state.currentView === 'settings') navigate('dashboard');
  else navigate('settings');
};
const voiceBtn = $('#btn-voice');
if (voiceBtn) {
  voiceBtn.onclick = () => {
    state.ttsEnabled = !state.ttsEnabled;
    voiceBtn.classList.toggle('active', state.ttsEnabled);
    if (!state.ttsEnabled) speechSynthesis.cancel();
    saveSettings();
  };
}

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

// ── Keyboard detection ──────────────────────────────────────
// Track whether the software keyboard is open so the ResizeObserver can skip
// fitAddon.fit() during keyboard transitions (which cause scroll jumps).
// Also shrink the app to the visible viewport so the keyboard doesn't cover the input bar.
let keyboardOpen = false;
let keyboardTransitioning = false;
(function setupKeyboardDetection() {
  const vv = window.visualViewport;
  if (!vv) return;
  let fullHeight = vv.height;
  let transitionTimer = null;

  function updateAppHeight() {
    document.documentElement.style.setProperty('--app-height', vv.height + 'px');
  }

  vv.addEventListener('resize', () => {
    const heightDiff = fullHeight - vv.height;
    const wasOpen = keyboardOpen;
    keyboardOpen = heightDiff > 100;

    // Always update app height to match visible viewport
    updateAppHeight();

    if (!keyboardOpen && wasOpen) {
      // Keyboard just closed — suppress ResizeObserver fit() during the close animation
      keyboardTransitioning = true;
      clearTimeout(transitionTimer);
      transitionTimer = setTimeout(() => {
        keyboardTransitioning = false;
        fullHeight = vv.height;
        updateAppHeight();
        // Now do a single fit after the animation settles
        if (state.xterm && state.fitAddon) {
          const container = document.querySelector('#xterm-container');
          const viewport = container?.querySelector('.xterm-viewport');
          const prevScroll = viewport ? viewport.scrollTop : 0;
          const atBottom = !viewport || (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80);

          state.fitAddon.fit();
          wsSend({
            type: 'resize',
            sessionId: state.activeSessionId,
            cols: state.xterm.cols,
            rows: state.xterm.rows,
          });

          if (viewport) {
            const target = atBottom ? viewport.scrollHeight : prevScroll;
            viewport.scrollTop = target;
          }
        }
      }, 400);
    }

    if (!keyboardOpen) {
      fullHeight = vv.height;
    }
  });

  // Also listen to scroll events — Android may pan the viewport instead of resizing
  vv.addEventListener('scroll', updateAppHeight);
})();

// Startup
if (state.token) {
  connectWS();
  navigate('dashboard');

  // APK version check is handled by the bootstrap page before loading the app.
  // No need to re-check here.

  // Check for server code updates 10s after startup
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

// Reconnect immediately when app returns from background
// and check for missed attention events
let _wasHidden = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    _wasHidden = true;
    return;
  }
  // App just came back to foreground
  if (state.token) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      connectWS();
    }
    // Check for missed attention after a short delay (let WS reconnect and send session list)
    if (_wasHidden) {
      _wasHidden = false;
      setTimeout(checkMissedAttention, 1500);
    }
  }
});

