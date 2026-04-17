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
  activeTabId: null,
  currentView: 'dashboard',

  // Settings (persisted to localStorage)
  alertsEnabled: true,
  alertPrompt: true,
  alertIdle: true,
  voiceTalkToggle: false,
  voiceAutoAccept: false,
  voiceSpeechRate: 1.1,

  // Runtime
  voiceMode: false,
  whisperEnabled: false,  // server-side Whisper STT availability (fetched on voice-mode enter)
  ttsEnabled: false,      // server-side Kokoro TTS availability (same source, used for awareness only)
  voiceRecording: false,
  xterm: null,
  fitAddon: null,
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
    state.serverUrl = location.origin;
    if (params.get('v')) state.appVersion = params.get('v');
    saveSettings();
    history.replaceState(null, '', location.pathname);
  }
}

function saveSettings() {
  const keys = [
    'alertsEnabled', 'alertPrompt', 'alertIdle', 'voiceTalkToggle', 'voiceAutoAccept', 'voiceSpeechRate', 'serverUrl', 'token', 'appVersion',
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
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')  // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[()][AB012]/g, '')                   // charset selection
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, '')     // other ESC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');   // control chars
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

// ── Session Tree ────────────────────────────────────────────

const collapseState = JSON.parse(localStorage.getItem('claude-remote-tree-state') || '{}');

function saveCollapseState() {
  localStorage.setItem('claude-remote-tree-state', JSON.stringify(collapseState));
}

function countSessions(node) {
  let n = node.sessions.length;
  for (const c of node.children) n += countSessions(c);
  return n;
}

function buildSessionTree(sessions) {
  // Build trie from shortened cwds
  const root = { name: '', children: {}, sessions: [] };
  for (const s of sessions) {
    const p = shortenPath(s.cwd);
    const parts = p.split('/').filter(Boolean);
    let node = root;
    for (const part of parts) {
      if (!node.children[part]) node.children[part] = { name: part, children: {}, sessions: [] };
      node = node.children[part];
    }
    node.sessions.push(s);
  }

  // Convert trie to array, collapsing single-child nodes
  function collapse(node, prefix, parentPath) {
    const childKeys = Object.keys(node.children);
    // Single child + no sessions at this level → merge with child
    if (childKeys.length === 1 && node.sessions.length === 0) {
      const only = node.children[childKeys[0]];
      const base = prefix || node.name;
      const merged = base ? base + '/' + only.name : only.name;
      return collapse(only, merged, parentPath);
    }
    const label = prefix || node.name;
    const fullPath = parentPath ? parentPath + '/' + label : label;
    const children = childKeys
      .sort()
      .map(k => collapse(node.children[k], '', fullPath))
      .flat();
    if (label) {
      return [{ label, path: fullPath, sessions: node.sessions, children }];
    }
    return children;
  }

  let tree = collapse(root, '', '');

  // Strip redundant single root with no sessions
  while (tree.length === 1 && tree[0].sessions.length === 0 && tree[0].children.length > 0) {
    tree = tree[0].children;
  }

  return tree;
}

// ── Session Cache (persists across server restarts) ─────────

function sessionCacheKey() {
  const url = state.serverUrl || location.origin;
  return 'claude-remote-sessions-' + url;
}

function loadCachedSessions() {
  try {
    return JSON.parse(localStorage.getItem(sessionCacheKey()) || '[]');
  } catch { return []; }
}

function saveCachedSessions(sessions) {
  // Merge so we keep the last-known claudeSessionId for any session that's
  // currently missing it (e.g. after the server restarted before saving).
  const prev = new Map(loadCachedSessions().map(s => [s.id, s]));
  const meta = sessions.map(s => ({
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    createdAt: s.createdAt,
    lastActivity: s.lastActivity,
    claudeSessionId: s.claudeSessionId || prev.get(s.id)?.claudeSessionId || null,
  }));
  localStorage.setItem(sessionCacheKey(), JSON.stringify(meta));
}

function mergeWithCache(serverSessions) {
  // Server is authoritative for any session it knows about.
  // Cached sessions not on the server are shown as 'offline'.
  const serverIds = new Set(serverSessions.map(s => s.id));
  const cached = loadCachedSessions().filter(s => !serverIds.has(s.id));
  const offline = cached.map(s => ({ ...s, status: 'offline' }));
  saveCachedSessions(serverSessions);
  return [...serverSessions, ...offline];
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
    case 'sessions': {
      const isFirstLoad = state.sessions.length === 0 && msg.data.length > 0;
      state.sessions = mergeWithCache(msg.data);
      if (state.currentView === 'dashboard') renderDashboard();
      if (state.currentView === 'session') renderTabBar();
      updateTopbarStatus();
      // On first session list, sync auto-accept state to server
      if (isFirstLoad && state.voiceAutoAccept) {
        for (const s of state.sessions) {
          wsSend({ type: 'autoAccept', sessionId: s.id, enabled: true });
        }
      }
      break;
    }

    case 'output':
      // Only show output for the active session + active tab
      if (msg.sessionId === state.activeSessionId && (!msg.tabId || msg.tabId === state.activeTabId)) {
        appendTerminalOutput(msg.data);
      }
      break;

    case 'speak':
      if (state.voiceMode && msg.sessionId === state.activeSessionId && msg.text) {
        speakVoice(msg.text);
      }
      break;

    case 'speak-audio':
      if (state.voiceMode && msg.sessionId === state.activeSessionId && msg.audio_b64) {
        playSpeakAudio(msg.audio_b64, msg.format);
      }
      break;

    case 'session:attention': {
      // Update session status immediately
      const s = state.sessions.find(s => s.id === msg.sessionId);
      if (s) s.status = msg.reason === 'prompt' ? 'waiting' : 'idle';
      // Auto-accept is now handled server-side — if we still get an attention event,
      // it means auto-accept is off for this session, so show the notification
      handleAttention(msg.sessionId, msg.reason, msg.preview);
      break;
    }

    case 'session:exit':
    case 'session:killed':
      if (msg.sessionId === state.activeSessionId && state.currentView === 'session') {
        navigate('dashboard');
      }
      break;

    case 'tab:created':
      if (msg.sessionId === state.activeSessionId) {
        // Update session tabs in state, switch to new tab
        const sess = state.sessions.find(s => s.id === msg.sessionId);
        if (sess) {
          if (!sess.tabs) sess.tabs = [];
          sess.tabs.push(msg.tab);
        }
        switchTab(msg.tab.id);
        renderTabBar();
      }
      break;

    case 'tab:killed':
      if (msg.sessionId === state.activeSessionId) {
        const sess = state.sessions.find(s => s.id === msg.sessionId);
        if (sess && sess.tabs) {
          sess.tabs = sess.tabs.filter(t => t.id !== msg.tabId);
        }
        // If the killed tab was active, switch to first available
        if (state.activeTabId === msg.tabId && sess?.tabs?.length) {
          switchTab(sess.tabs[0].id);
        }
        renderTabBar();
      }
      break;

    case 'tab:exit':
      // A tab's pty exited — update its status in the tab list
      if (msg.sessionId === state.activeSessionId) {
        const sess = state.sessions.find(s => s.id === msg.sessionId);
        if (sess?.tabs) {
          const tab = sess.tabs.find(t => t.id === msg.tabId);
          if (tab) tab.alive = false;
        }
        renderTabBar();
      }
      break;

    case 'update:available':
      state.updateInfo = msg.data;
      showUpdateBanner(msg.data);
      break;

    case 'subscribed':
      // Track which tab the server actually subscribed us to
      if (msg.tabId) state.activeTabId = msg.tabId;
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
    if (state.voiceRecording) stopVoiceRecording();
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
      $('#btn-voice-mode')?.classList.add('hidden');
      $('#btn-auto-accept')?.classList.add('hidden');
      label.textContent = 'Sessions';
      state.activeSessionId = null;
      state.activeTabId = null;
      main.appendChild(cloneTemplate('tpl-dashboard'));
      initDashboard();
      break;

    case 'session':
      backBtn.classList.remove('hidden');
      label.textContent = params.name || 'Session';
      state.activeSessionId = params.id;
      $('#btn-voice-mode')?.classList.remove('hidden');
      $('#btn-auto-accept')?.classList.remove('hidden');
      if (state.voiceAutoAccept) $('#btn-auto-accept')?.classList.add('active');
      main.appendChild(cloneTemplate('tpl-session-view'));
      initSessionView(params.id);
      break;

    case 'settings':
      backBtn.classList.remove('hidden');
      $('#btn-voice-mode')?.classList.add('hidden');
      $('#btn-auto-accept')?.classList.add('hidden');
      label.textContent = 'Settings';
      main.appendChild(cloneTemplate('tpl-settings'));
      initSettings();
      break;

    case 'admin':
      backBtn.classList.remove('hidden');
      $('#btn-voice-mode')?.classList.add('hidden');
      $('#btn-auto-accept')?.classList.add('hidden');
      label.textContent = 'Server admin';
      main.appendChild(cloneTemplate('tpl-admin'));
      initAdminFrame();
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
  // Show cached sessions immediately while waiting for server
  if (state.sessions.length === 0) {
    const cached = loadCachedSessions();
    if (cached.length) state.sessions = cached.map(s => ({ ...s, status: 'offline' }));
  }

  renderDashboard();
  updateConnectionUI();

  $('#btn-new-session').onclick = showNewSessionDialog;
  $('#btn-quick-chat').onclick = showQuickChatPrompt;

  // Request fresh list
  wsSend({ type: 'list' });
}

function renderSessionCard(s) {
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

  if (s.status === 'offline') {
    // Offline sessions are cached locally — create a new session in the same dir
    const relaunch = async () => {
      try {
        const session = await api.post('/api/sessions', { name: s.name, cwd: s.cwd });
        navigate('session', { id: session.id, name: session.name });
      } catch (err) {
        console.error('Relaunch failed:', err);
      }
    };
    card.onclick = (e) => {
      if (e.target.closest('.card-btn')) return;
      relaunch();
    };
    $('.card-btn-open', card).textContent = 'Relaunch';
    $('.card-btn-open', card).onclick = relaunch;
    $('.card-btn-kill', card).textContent = 'Dismiss';
    $('.card-btn-kill', card).onclick = (e) => {
      e.stopPropagation();
      // Remove from local cache
      const cached = loadCachedSessions().filter(c => c.id !== s.id);
      localStorage.setItem(sessionCacheKey(), JSON.stringify(cached));
      state.sessions = state.sessions.filter(x => x.id !== s.id);
      renderDashboard();
    };
  } else if (s.status === 'dead') {
    const openSession = async () => {
      try {
        // Pass the cached claudeSessionId so revive works even if the server
        // lost it (e.g. restarted before the hook save landed).
        const cached = loadCachedSessions().find(c => c.id === s.id);
        const claudeSessionId = s.claudeSessionId || cached?.claudeSessionId || null;
        await api.post(`/api/sessions/${s.id}/reconnect`, { resumeClaude: true, claudeSessionId });
        navigate('session', { id: s.id, name: s.name });
      } catch (err) {
        console.error('Reconnect failed:', err);
      }
    };
    card.onclick = (e) => {
      if (e.target.closest('.card-btn')) return;
      openSession();
    };
    $('.card-btn-open', card).textContent = 'Revive';
    $('.card-btn-open', card).onclick = openSession;
  } else {
    card.onclick = (e) => {
      if (e.target.closest('.card-btn')) return;
      navigate('session', { id: s.id, name: s.name });
    };
    $('.card-btn-open', card).onclick = () => navigate('session', { id: s.id, name: s.name });
  }

  if (s.status !== 'offline') {
    $('.card-btn-kill', card).onclick = (e) => {
      e.stopPropagation();
      if (confirm(`${s.status === 'dead' ? 'Remove' : 'Kill'} "${s.name}"?`)) {
        api.del(`/api/sessions/${s.id}`);
      }
    };
  }

  return card;
}

function renderTreeNode(parentEl, node, depth) {
  const group = document.createElement('div');
  group.className = 'tree-group';

  // Directory header
  const header = document.createElement('div');
  header.className = 'tree-dir-header';
  header.style.paddingLeft = (depth * 16 + 12) + 'px';

  const total = countSessions(node);
  const collapsed = collapseState[node.path];

  const chevron = document.createElement('span');
  chevron.className = 'tree-toggle';
  chevron.textContent = collapsed ? '▶' : '▼';

  const icon = document.createElement('span');
  icon.className = 'dir-item-icon';
  icon.textContent = '📁';

  const name = document.createElement('span');
  name.className = 'dir-item-name';
  name.textContent = node.label;

  const count = document.createElement('span');
  count.className = 'tree-count';
  count.textContent = `${total}`;

  header.append(chevron, icon, name, count);
  header.onclick = () => {
    collapseState[node.path] = !collapseState[node.path];
    saveCollapseState();
    renderDashboard();
  };

  // Content container
  const content = document.createElement('div');
  content.className = 'tree-dir-content';
  if (collapsed) content.classList.add('collapsed');

  for (const s of node.sessions) content.appendChild(renderSessionCard(s));
  for (const child of node.children) renderTreeNode(content, child, depth + 1);

  group.append(header, content);
  parentEl.appendChild(group);
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
  const tree = buildSessionTree(state.sessions);
  for (const node of tree) renderTreeNode(grid, node, 0);

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
  // Determine initial tab
  const sess = state.sessions.find(s => s.id === sessionId);
  const tabs = sess?.tabs || [{ id: 'main', name: 'Terminal', alive: true }];
  state.activeTabId = tabs[0]?.id || 'main';

  // Subscribe to session output (first tab)
  console.log('[session] subscribing to', sessionId, 'tab', state.activeTabId);
  wsSend({ type: 'subscribe', sessionId, tabId: state.activeTabId });

  // Sync auto-accept state to server
  if (state.voiceAutoAccept) {
    wsSend({ type: 'autoAccept', sessionId, enabled: true });
  }

  // Init xterm.js
  initTerminal();

  // Render tab bar
  renderTabBar();

  // Tab add button
  const addBtn = $('#tab-add-btn');
  if (addBtn) {
    addBtn.onclick = () => {
      wsSend({ type: 'createTab', sessionId: state.activeSessionId });
    };
  }

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
      const tabId = state.activeTabId;
      if (raw.length > 1 && raw.endsWith('\r')) {
        const text = raw.slice(0, -1);
        wsSend({ type: 'input', sessionId, tabId, data: text });
        setTimeout(() => {
          wsSend({ type: 'input', sessionId, tabId, data: '\r' });
        }, 150);
      } else {
        wsSend({ type: 'input', sessionId, tabId, data: raw });
      }
      dismissAttention();
    };
  });

  // Text input — type command, Enter or Send sends it
  const cmdInput = $('#cmd-input');
  const sendBtn = $('#send-btn');

  function sendCommand() {
    // Fix smart punctuation from mobile keyboards (e.g. -- → em dash)
    const val = cmdInput.value
      .replace(/\u2014/g, '--')   // em dash → --
      .replace(/\u2013/g, '-')    // en dash → -
      .replace(/\u2018|\u2019/g, "'")  // smart single quotes
      .replace(/\u201C|\u201D/g, '"'); // smart double quotes
    const tabId = state.activeTabId;
    if (!val && !val.trim()) {
      wsSend({ type: 'input', sessionId, tabId, data: '\r' });
    } else {
      wsSend({ type: 'input', sessionId, tabId, data: val });
      setTimeout(() => {
        wsSend({ type: 'input', sessionId, tabId, data: '\r' });
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

  // Attention dismiss
  const dismissBtn = $('#attention-dismiss');
  if (dismissBtn) dismissBtn.onclick = dismissAttention;

  // Voice nav buttons — send command to terminal
  $$('.voice-nav-btn').forEach(btn => {
    btn.onclick = () => {
      const cmd = btn.dataset.cmd;
      if (cmd && state.activeSessionId) {
        wsSend({ type: 'input', sessionId: state.activeSessionId, tabId: state.activeTabId, data: cmd });
      }
    };
  });

  // Restore voice mode if it was active
  if (state.voiceMode) applyVoiceMode(true);
}

function renderTabBar() {
  const tabBar = $('#tab-bar');
  const tabList = $('#tab-list');
  if (!tabBar || !tabList) return;

  const sess = state.sessions.find(s => s.id === state.activeSessionId);
  const tabs = sess?.tabs || [];

  tabList.innerHTML = '';

  // Only show tab items when there's more than 1 tab
  if (tabs.length <= 1) return;
  for (const tab of tabs) {
    const el = document.createElement('button');
    el.className = 'tab-item' + (tab.id === state.activeTabId ? ' active' : '');
    el.dataset.tabId = tab.id;

    const label = document.createElement('span');
    label.textContent = tab.name + (tab.alive === false ? ' (dead)' : '');
    el.appendChild(label);

    // Close button (don't show if it's the only tab)
    if (tabs.length > 1) {
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '\u00d7';
      close.onclick = (e) => {
        e.stopPropagation();
        wsSend({ type: 'killTab', sessionId: state.activeSessionId, tabId: tab.id });
      };
      el.appendChild(close);
    }

    el.onclick = () => {
      if (tab.id !== state.activeTabId) switchTab(tab.id);
    };

    tabList.appendChild(el);
  }
}

function switchTab(tabId) {
  if (tabId === state.activeTabId) return;

  // Unsubscribe from current tab, subscribe to new one
  state.activeTabId = tabId;
  destroyTerminal();
  initTerminal();
  wsSend({ type: 'subscribe', sessionId: state.activeSessionId, tabId });
  renderTabBar();
}

// Fetches the server's voice status so we know whether to record audio for Whisper
// and whether to expect server-synthesized audio from Kokoro TTS.
async function refreshWhisperStatus() {
  try {
    const res = await api.get('/api/voice/status');
    state.whisperEnabled = !!res.whisperEnabled;
    state.ttsEnabled = !!res.ttsEnabled;
  } catch {
    state.whisperEnabled = false;
    state.ttsEnabled = false;
  }
}

function applyVoiceMode(on) {
  const quickBar = $('.quick-bar');
  const inputBar = $('.input-bar');
  const overlay = $('#voice-overlay');
  const voiceBtn = $('#btn-voice-mode');
  const talkBtn = $('#voice-talk-btn');

  if (on) {
    refreshWhisperStatus();  // fire-and-forget — sets state.whisperEnabled
    quickBar?.classList.add('hidden');
    inputBar?.classList.add('hidden');
    overlay?.classList.remove('hidden');
    voiceBtn?.classList.add('active');
    $('#cmd-input')?.blur();

    // Wire talk button
    if (talkBtn) {
      if (state.voiceTalkToggle) {
        talkBtn.onclick = () => {
          if (state.voiceRecording) stopVoiceRecording();
          else startVoiceRecording();
        };
        talkBtn.onmousedown = null;
        talkBtn.onmouseup = null;
        talkBtn.ontouchstart = null;
        talkBtn.ontouchend = null;
      } else {
        talkBtn.onclick = null;
        talkBtn.onmousedown = (e) => { e.preventDefault(); startVoiceRecording(); };
        talkBtn.onmouseup = () => stopVoiceRecording();
        talkBtn.ontouchstart = (e) => { e.preventDefault(); startVoiceRecording(); };
        talkBtn.ontouchend = (e) => { e.preventDefault(); stopVoiceRecording(); };
      }
    }
  } else {
    if (state.voiceRecording) stopVoiceRecording();
    if (window.NativeBridge?.stopSpeaking) window.NativeBridge.stopSpeaking();
    else if ('speechSynthesis' in window) speechSynthesis.cancel();
    quickBar?.classList.remove('hidden');
    inputBar?.classList.remove('hidden');
    overlay?.classList.add('hidden');
    voiceBtn?.classList.remove('active');

    // Clear talk button handlers
    if (talkBtn) {
      talkBtn.onclick = null;
      talkBtn.onmousedown = null;
      talkBtn.onmouseup = null;
      talkBtn.ontouchstart = null;
      talkBtn.ontouchend = null;
    }
  }
}


function toggleVoiceMode() {
  state.voiceMode = !state.voiceMode;
  applyVoiceMode(state.voiceMode);
}

// ── Voice Recording (STT + Waveform) ───────────────────────

let _voiceRecog = null;
let _voiceAnimFrame = null;
let _voiceStream = null;
let _voiceAudioCtx = null;
let _voiceAnalyser = null;
let _voiceTranscriptParts = [];
let _voiceCurrentInterim = '';
let _voicePendingStop = false;
let _voiceMediaRecorder = null;   // parallel audio capture for server-side Whisper
let _voiceMediaChunks = [];
let _voiceHasFinal = false;
let _voiceLastActivity = 0;
let _voiceAudioActive = false;

async function startVoiceRecording() {
  if (state.voiceRecording) return;
  // Interrupt TTS if speaking
  if (window.parent !== window) window.parent.postMessage({ type: 'stop-speaking' }, '*');
  else if ('speechSynthesis' in window) speechSynthesis.cancel();

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const useWhisper = !!state.whisperEnabled;
  if (!SR) {
    const el = $('#voice-you');
    if (el) el.textContent = 'Speech recognition not supported';
    return;
  }

  // Clear previous state
  _voiceTranscriptParts = [];
  _voiceCurrentInterim = '';
  _voicePendingStop = false;
  _voiceHasFinal = false;
  const youEl = $('#voice-you');
  if (youEl) youEl.textContent = '';

  // Always run Android SpeechRecognition — gives us the live waveform cues
  // and a reliable transcript on its own. Whisper runs in parallel (below)
  // and, when it succeeds, replaces the transcript on release.
  _voiceRecog = new SR();
  _voiceRecog.continuous = false;
  _voiceRecog.interimResults = true;
  _voiceRecog.lang = 'en-US';

  _voiceRecog.onspeechstart = () => { _voiceAudioActive = true; _voiceLastActivity = Date.now(); };
  _voiceRecog.onspeechend = () => { _voiceAudioActive = false; };

  _voiceRecog.onresult = (e) => {
    let final = '';
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript + ' ';
      else interim += e.results[i][0].transcript;
    }
    if (final) _voiceTranscriptParts.push(final.trim());
    _voiceCurrentInterim = interim;
    _voiceHasFinal = !interim;
    _voiceLastActivity = Date.now();

    if (_voiceHasFinal && _voicePendingStop) {
      _voicePendingStop = false;
      finishVoiceRecording();
    }
  };

  _voiceRecog.onend = () => {
    if (_voicePendingStop) {
      _voicePendingStop = false;
      finishVoiceRecording();
      return;
    }
    if (state.voiceRecording && _voiceRecog) {
      try { _voiceRecog.start(); } catch {}
    }
  };

  _voiceRecog.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    const el = $('#voice-you');
    if (el) el.textContent = `Error: ${e.error}`;
    stopVoiceRecording();
  };

  try {
    _voiceRecog.start();
  } catch (err) {
    if (youEl) youEl.textContent = `STT error: ${err.message}`;
    return;
  }

  state.voiceRecording = true;
  _voiceLastActivity = 0;
  _voiceAudioActive = false;
  $('#voice-talk-btn')?.classList.add('recording');

  // Open mic for waveform and (when enabled) server-side Whisper capture.
  try {
    if (navigator.mediaDevices?.getUserMedia) {
      _voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _voiceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = _voiceAudioCtx.createMediaStreamSource(_voiceStream);
      _voiceAnalyser = _voiceAudioCtx.createAnalyser();
      _voiceAnalyser.fftSize = 64;
      source.connect(_voiceAnalyser);

      // Server-side Whisper path — only when Whisper is enabled.
      // Tee the audio through an AudioContext MediaStreamDestination so the
      // MediaRecorder operates on a derived stream, not the raw mic stream.
      // This keeps the AnalyserNode (waveform) working on Android, where
      // MediaRecorder otherwise takes exclusive access to the raw mic.
      if (useWhisper && typeof MediaRecorder !== 'undefined') {
        try {
          const dest = _voiceAudioCtx.createMediaStreamDestination();
          source.connect(dest);
          const recStream = dest.stream;

          _voiceMediaChunks = [];
          // Let the browser pick a default MIME — isTypeSupported lies on some WebViews.
          try {
            _voiceMediaRecorder = new MediaRecorder(recStream);
          } catch {
            _voiceMediaRecorder = new MediaRecorder(recStream, { mimeType: 'audio/webm' });
          }
          _voiceMediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) _voiceMediaChunks.push(e.data);
          };
          _voiceMediaRecorder.onerror = (e) => {
            console.warn('[whisper] MediaRecorder error:', e.error?.message || e);
          };
          _voiceMediaRecorder.start();
          console.log('[whisper] MediaRecorder started, state=', _voiceMediaRecorder.state, 'mime=', _voiceMediaRecorder.mimeType);
        } catch (e) {
          console.warn('[whisper] MediaRecorder failed:', e.message);
          _voiceMediaRecorder = null;
        }
      }
    }
  } catch (e) {
    console.warn('[voice] getUserMedia failed:', e.message);
  }

  renderWaveform();
}

function stopVoiceRecording() {
  if (!state.voiceRecording) return;
  state.voiceRecording = false;
  $('#voice-talk-btn')?.classList.remove('recording');

  if (_voiceHasFinal || (!_voiceTranscriptParts.length && !_voiceCurrentInterim)) {
    // Final result already in, or nothing captured — send immediately
    finishVoiceRecording();
  } else {
    // Still processing interim — wait for final result
    _voicePendingStop = true;
    setTimeout(() => {
      if (_voicePendingStop) {
        _voicePendingStop = false;
        finishVoiceRecording();
      }
    }, 3000);
  }
}

async function finishVoiceRecording() {
  // Stop recognition
  if (_voiceRecog) {
    try { _voiceRecog.stop(); } catch {}
    _voiceRecog = null;
  }

  // Capture whatever the MediaRecorder produced for Whisper (if any)
  const mediaBlob = await _finalizeMediaRecorder();

  // Stop mic/audio
  if (_voiceStream) {
    _voiceStream.getTracks().forEach(t => t.stop());
    _voiceStream = null;
  }
  if (_voiceAudioCtx) {
    _voiceAudioCtx.close().catch(() => {});
    _voiceAudioCtx = null;
    _voiceAnalyser = null;
  }

  // Stop waveform
  if (_voiceAnimFrame) {
    cancelAnimationFrame(_voiceAnimFrame);
    _voiceAnimFrame = null;
  }
  clearWaveform();

  // Server-side Whisper: try to replace transcript with higher-accuracy version.
  // Any failure falls through silently to the Android STT result below.
  if (mediaBlob && state.whisperEnabled) {
    try {
      const whisperText = await transcribeWithWhisper(mediaBlob, 2500);
      if (whisperText && whisperText.trim()) {
        _voiceTranscriptParts = [whisperText.trim()];
        _voiceCurrentInterim = '';
      }
    } catch (e) {
      console.warn('[whisper] transcribe failed, using Android STT:', e.message);
    }
  }

  // Send transcript to terminal
  const parts = [..._voiceTranscriptParts];
  if (_voiceCurrentInterim) parts.push(_voiceCurrentInterim);
  const text = parts.join(' ').trim();
  if (text && state.activeSessionId) {
    // Hands-free slash commands: "system command clear" → `/clear`
    const voiceCmd = tryParseVoiceCommand(text);
    if (voiceCmd) {
      // Intercepted command — speak guidance, send nothing.
      if (voiceCmd.speak) {
        speakVoice(voiceCmd.speak);
        return;
      }

      const sid = state.activeSessionId;
      wsSend({ type: 'input', sessionId: sid, data: voiceCmd.ptyInput });
      if (!voiceCmd.ptyInput.startsWith('\x03')) {
        setTimeout(() => wsSend({ type: 'input', sessionId: sid, data: '\r' }), 50);
      }

      // Informational commands (cost, status, etc.): fire a follow-up prompt so
      // Claude summarizes the slash command's output via speak. Claude Code bundles
      // the slash command's stdout into the next user turn.
      if (voiceCmd.interpret) {
        setTimeout(() => {
          const followUp = `[Voice mode. The slash command output is visible above in this turn as local-command-stdout. Summarize the result in one short natural sentence and call the shell command: speak "your one-sentence summary". Do not print any other text or duplicate the summary.]`;
          wsSend({ type: 'input', sessionId: sid, data: followUp });
          setTimeout(() => wsSend({ type: 'input', sessionId: sid, data: '\r' }), 50);
        }, 700);
      }
      return;
    }

    const session = state.sessions.find(s => s.id === state.activeSessionId);
    const isWaiting = session?.status === 'waiting';

    // In voice mode, wrap with instruction prefix (skip if answering a prompt)
    const toSend = (state.voiceMode && !isWaiting)
      ? `[Voice mode. Do your work normally — edit files, run commands, etc. After completing your work, run the shell command: speak "your concise spoken summary here". That text will be read aloud via TTS on the phone. Do not duplicate the summary in your text output.]\n\n${text}`
      : text;

    wsSend({ type: 'input', sessionId: state.activeSessionId, data: toSend });
    setTimeout(() => {
      wsSend({ type: 'input', sessionId: state.activeSessionId, data: '\r' });
    }, 150);
  }
}

// Stops the MediaRecorder (if running) and returns the final Blob, or null.
function _finalizeMediaRecorder() {
  return new Promise((resolve) => {
    const mr = _voiceMediaRecorder;
    _voiceMediaRecorder = null;
    if (!mr || mr.state === 'inactive') {
      const chunks = _voiceMediaChunks;
      _voiceMediaChunks = [];
      if (!chunks.length) return resolve(null);
      resolve(new Blob(chunks, { type: chunks[0].type || 'audio/webm' }));
      return;
    }
    const timer = setTimeout(() => resolve(null), 1000);
    mr.onstop = () => {
      clearTimeout(timer);
      const chunks = _voiceMediaChunks;
      _voiceMediaChunks = [];
      if (!chunks.length) return resolve(null);
      resolve(new Blob(chunks, { type: chunks[0].type || 'audio/webm' }));
    };
    try { mr.stop(); } catch { resolve(null); }
  });
}

// POSTs audio to the server's Whisper endpoint. Returns transcribed text.
// Uses AbortController for timeout so a hanging server never blocks voice.
async function transcribeWithWhisper(blob, timeoutMs = 2500) {
  const buf = await blob.arrayBuffer();
  const b64 = _bufToBase64(buf);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const base = api.baseUrl;
    const url = `${base}/api/voice/transcribe?token=${encodeURIComponent(state.token)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ audio_b64: b64, language: 'en' }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.text || '';
  } finally {
    clearTimeout(timer);
  }
}

function _bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// Translate a hands-free voice phrase into raw pty input.
// "system command <rest>" → `/<rest>`, sent raw to Claude Code's TUI.
// Special case: stop/cancel/abort → Ctrl+C (not a slash command).
// Returns one of:
//   null — not a command, fall through to normal voice flow
//   { speak } — intercept: speak the message, do not send anything to the pty
//   { ptyInput, interpret } — send to pty; interpret=true fires a summary follow-up
function tryParseVoiceCommand(text) {
  const m = text.match(/^\s*system\s+commands?\s*[,.:]?\s*(.+?)\s*$/i);
  if (!m) return null;
  const rest = m[1].toLowerCase().replace(/[.!?]+$/, '').trim();
  if (!rest) return { speak: 'No command given. Say system command followed by a command name.' };

  // Cancel the current generation — not a slash command, no follow-up (user is stopping me).
  if (/^(stop|cancel|abort|escape)\b/.test(rest)) return { ptyInput: '\x03', interpret: false };

  const firstWord = rest.split(/\s+/)[0];
  const hasArgs = /\s/.test(rest);

  // Commands that open interactive pickers / menus that voice can't navigate.
  // Intercept and tell the user what to do instead.
  const interactiveGuides = {
    help: 'The help command opens an interactive dialog. Just ask me directly what you want to know.',
    model: hasArgs ? null : 'Specify the model: system command model opus, sonnet, or haiku.',
    agents: 'Agents opens a picker. Ask me in normal voice which agents you want to know about.',
    config: 'Config opens a menu. Ask me in normal voice what you want to change.',
    resume: 'Resume opens a session picker. Use the revive button on the dashboard instead.',
    permissions: 'Permissions opens a menu. Ask me in normal voice to adjust specific rules.',
    mcp: 'MCP opens a picker. Ask me in normal voice about your MCP servers.',
    hooks: 'Hooks opens a menu. Ask me in normal voice about your hooks configuration.',
    'output-style': 'Output style opens a picker. Ask me in normal voice which style you want.',
    ide: 'IDE opens a picker. Not useful via voice.',
    vim: 'Vim mode toggle — not useful via voice.',
    login: 'Login requires a browser flow. Use the admin panel.',
    logout: 'Logout is a destructive action. Run it from the admin panel to avoid mistakes.',
  };
  const guide = interactiveGuides[firstWord];
  if (guide) return { speak: guide };

  // Commands that wipe or rewrite context — skip follow-up to avoid wasting a turn on confirmation.
  const skipInterpret = new Set(['clear', 'compact', 'exit', 'quit', 'init']);
  const interpret = !skipInterpret.has(firstWord);

  return { ptyInput: '/' + rest, interpret };
}

function renderWaveform() {
  if (!state.voiceRecording) return;

  const canvas = $('#voice-waveform');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const container = $('#voice-controls');

  const dpr = window.devicePixelRatio || 1;
  canvas.width = container.clientWidth * dpr;
  canvas.height = container.clientHeight * dpr;
  ctx.scale(dpr, dpr);

  const w = container.clientWidth;
  const h = container.clientHeight;

  ctx.clearRect(0, 0, w, h);

  const barCount = 32;
  const barWidth = w / barCount;
  const gap = 2;

  if (_voiceAnalyser) {
    // Real audio data
    const data = new Uint8Array(_voiceAnalyser.frequencyBinCount);
    _voiceAnalyser.getByteFrequencyData(data);
    for (let i = 0; i < barCount; i++) {
      const val = (data[i] || 0) / 255;
      const barH = Math.max(2, val * h * 0.85);
      const x = i * barWidth + gap / 2;
      const y = (h - barH) / 2;
      ctx.fillStyle = `rgba(160, 128, 240, ${0.15 + val * 0.35})`;
      ctx.fillRect(x, y, barWidth - gap, barH);
    }
  } else {
    // Fallback — smooth gradient between purple (silent) and green (speaking)
    const age = Date.now() - _voiceLastActivity;
    const resultIntensity = age < 300 ? 1.0 : age < 1200 ? (1200 - age) / 900 : 0;
    const t = _voiceAudioActive ? Math.max(resultIntensity, 0.5) : resultIntensity;
    // Lerp RGB: purple (160,128,240) → green (80,200,120)
    const r = Math.round(160 + (80 - 160) * t);
    const g = Math.round(128 + (200 - 128) * t);
    const b = Math.round(240 + (120 - 240) * t);
    const alpha = 0.08 + t * 0.35;
    for (let i = 0; i < barCount; i++) {
      const base = t > 0.05 ? t * (0.1 + Math.random() * 0.7) : 0.02 + Math.random() * 0.03;
      const barH = Math.max(2, base * h * 0.8);
      const x = i * barWidth + gap / 2;
      const y = (h - barH) / 2;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.fillRect(x, y, barWidth - gap, barH);
    }
  }

  _voiceAnimFrame = requestAnimationFrame(renderWaveform);
}

function clearWaveform() {
  const canvas = $('#voice-waveform');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ── Voice TTS ───────────────────────────────

// Play a base64-encoded audio blob from server-side Kokoro TTS.
// The WebView's default <audio> element routes through Android media stream,
// so Bluetooth / headphones behave the same as native TTS.
let _lastSpeakAudio = null;

function playSpeakAudio(b64, format) {
  console.log('[voice] playing kokoro audio, format=', format, 'size=', b64.length);
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const mime = format === 'wav' ? 'audio/wav' : 'audio/mpeg';
    const blob = new Blob([arr], { type: mime });
    const url = URL.createObjectURL(blob);

    // Stop any previous playback so successive speak calls don't overlap.
    if (_lastSpeakAudio) {
      try { _lastSpeakAudio.pause(); URL.revokeObjectURL(_lastSpeakAudio.src); } catch {}
    }
    const audio = new Audio(url);
    _lastSpeakAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      playChime('idle');
      if (_lastSpeakAudio === audio) _lastSpeakAudio = null;
    };
    audio.onerror = (e) => {
      console.error('[voice] audio error', e);
      URL.revokeObjectURL(url);
    };
    audio.play().catch((e) => console.error('[voice] audio.play rejected:', e));
  } catch (e) {
    console.error('[voice] playSpeakAudio failed:', e);
  }
}

function speakVoice(text) {
  console.log('[voice] speaking:', text.slice(0, 80));

  // Use native Android TTS via postMessage to bootstrap (which has NativeBridge)
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'speak', text }, '*');
    return;
  }

  // Fallback to Web Speech API (requires HTTPS)
  if (!('speechSynthesis' in window)) return;

  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (sentences.length === 0) return;
  speechSynthesis.cancel();

  sentences.forEach((sentence, i) => {
    const utt = new SpeechSynthesisUtterance(sentence);
    utt.rate = state.voiceSpeechRate || 1.1;
    if (i === sentences.length - 1) utt.onend = () => playChime('idle');
    speechSynthesis.speak(utt);
  });
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
      tabId: state.activeTabId,
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

// ── Settings View ───────────────────────────────────────────

function initAdminFrame() {
  const frame = $('#admin-frame');
  if (!frame) return;
  const base = state.serverUrl || location.origin;
  const token = encodeURIComponent(state.token || '');
  frame.src = `${base}/admin?token=${token}`;
}

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

  // Open admin panel (iframed into the app)
  const openAdminBtn = $('#btn-open-admin');
  if (openAdminBtn) {
    openAdminBtn.onclick = () => navigate('admin');
  }

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
    const clientVersion = state.appVersion || params.get('v') || 'unknown';
    const appVersionEl = $('#setting-app-version');
    if (appVersionEl) appVersionEl.textContent = `v${clientVersion}`;

    appBtn.onclick = async () => {
      const statusEl = $('#setting-app-update-status');
      appBtn.textContent = 'Checking…';
      appBtn.disabled = true;
      try {
        const res = await fetch(`${api.baseUrl}/api/app/version`);
        const data = await res.json();
        if (clientVersion === 'unknown') {
          statusEl.textContent = 'Version unknown — reinstall APK to detect';
          statusEl.style.color = 'var(--amber)';
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
        } else if (data.version && data.version !== clientVersion) {
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
$('#btn-voice-mode').onclick = toggleVoiceMode;
$('#btn-auto-accept').onclick = () => {
  state.voiceAutoAccept = !state.voiceAutoAccept;
  $('#btn-auto-accept')?.classList.toggle('active', state.voiceAutoAccept);
  saveSettings();
  // Sync auto-accept state to server for all sessions
  for (const s of state.sessions) {
    wsSend({ type: 'autoAccept', sessionId: s.id, enabled: state.voiceAutoAccept });
  }
};

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

    if (keyboardOpen && !wasOpen) {
      // Keyboard just opened — refit terminal to smaller viewport and scroll to bottom
      setTimeout(() => {
        if (state.xterm && state.fitAddon) {
          state.fitAddon.fit();
          wsSend({
            type: 'resize',
            sessionId: state.activeSessionId,
            cols: state.xterm.cols,
            rows: state.xterm.rows,
          });
        }
        const viewport = document.querySelector('#xterm-container .xterm-viewport');
        if (viewport) viewport.scrollTop = viewport.scrollHeight;
      }, 100);
    }

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

