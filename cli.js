#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  Claude Remote CLI — manage the server from the command line
// ═══════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { execSync, spawn as cpSpawn } from 'child_process';
import {
  PACKAGE_ROOT, getSettingsPath, getConnectionInfoPath, getServerDir,
  getDataDir, ensureDataDir, migrateDataDir,
} from './lib/paths.js';

migrateDataDir();

const SETTINGS_PATH = getSettingsPath();
const CONN_INFO_PATH = getConnectionInfoPath();

// ── Helpers ─────────────────────────────────────────────────

function getToken() {
  // Try settings file first
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    if (settings.authToken) return settings.authToken;
  } catch {}
  // Try connection info
  try {
    const info = JSON.parse(readFileSync(CONN_INFO_PATH, 'utf8'));
    if (info.token) return info.token;
  } catch {}
  return null;
}

function getBaseUrl() {
  // Check env override
  if (process.env.CLAUDE_REMOTE_URL) return process.env.CLAUDE_REMOTE_URL;
  // Try connection info for port
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    return `http://localhost:${settings.port || 3033}`;
  } catch {}
  return 'http://localhost:3033';
}

async function api(path, opts = {}) {
  const token = getToken();
  if (!token) {
    console.error('Error: No auth token found. Is the server configured?');
    process.exit(1);
  }
  const url = `${getBaseUrl()}/api${path}?token=${token}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  return res;
}

function formatUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(s % 60)}s`;
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

// ── Colors ──────────────────────────────────────────────────

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// ── Commands ────────────────────────────────────────────────

async function cmdStatus() {
  try {
    const res = await api('/admin/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const ver = d.version?.version || '?';

    console.log(`\n${C.bold('Claude Remote')} ${C.dim(`v${ver}`)}`);
    console.log(`${C.dim('─'.repeat(40))}`);
    console.log(`  Status:     ${C.green('running')}`);
    console.log(`  Hostname:   ${d.hostname}`);
    console.log(`  Uptime:     ${formatUptime(d.uptime)}`);
    console.log(`  Port:       ${d.port}`);
    console.log(`  LAN:        ${d.ips?.lanIp || 'unknown'}`);
    console.log(`  Tailscale:  ${d.ips?.tailscaleIp || C.dim('not detected')}`);
    console.log(`  Password:   ${d.passwordSet ? C.green('set') : C.yellow('not set')}`);
    console.log(`  Clients:    ${d.clients?.length || 0} connected`);
    console.log(`  Sessions:   ${d.sessions?.length || 0} active`);
    console.log();
  } catch (e) {
    console.log(`\n${C.bold('Claude Remote')}`);
    console.log(`  Status:     ${C.red('offline')}`);
    console.log(`  ${C.dim(e.message)}\n`);
    process.exit(1);
  }
}

async function cmdToken() {
  const token = getToken();
  if (token) {
    console.log(token);
  } else {
    console.error('No token found');
    process.exit(1);
  }
}

async function cmdUrl() {
  try {
    const info = JSON.parse(readFileSync(CONN_INFO_PATH, 'utf8'));
    console.log(info.bestUrl || info.tailscaleUrl || info.lanUrl);
  } catch {
    const token = getToken();
    console.log(`${getBaseUrl()}?token=${token}`);
  }
}

async function cmdClients() {
  const res = await api('/admin/status');
  if (!res.ok) { console.error('Server not reachable'); process.exit(1); }
  const d = await res.json();
  if (!d.clients?.length) {
    console.log(C.dim('No clients connected'));
    return;
  }
  console.log(`\n${C.bold('Connected Clients')} (${d.clients.length})\n`);
  for (const c of d.clients) {
    const ago = formatUptime((Date.now() - c.connectedAt) / 1000);
    const session = c.subscribedSession ? C.dim(` watching ${c.subscribedSession}`) : '';
    console.log(`  ${c.ip}  ${C.dim(ago)}${session}`);
  }
  console.log();
}

async function cmdSessions() {
  const res = await api('/sessions');
  if (!res.ok) { console.error('Server not reachable'); process.exit(1); }
  const sessions = await res.json();
  if (!sessions.length) {
    console.log(C.dim('No active sessions'));
    return;
  }
  console.log(`\n${C.bold('Sessions')} (${sessions.length})\n`);
  for (const s of sessions) {
    const statusColor = s.status === 'working' ? C.green : s.status === 'waiting' ? C.yellow : C.dim;
    console.log(`  ${C.bold(s.name || 'Unnamed')}  ${statusColor(s.status || 'idle')}  ${C.dim(s.id)}`);
    if (s.cwd) console.log(`    ${C.dim(s.cwd)}`);
  }
  console.log();
}

async function cmdSetPassword(pw) {
  if (!pw) {
    pw = await prompt('New password: ');
    if (!pw) { console.error('Cancelled'); process.exit(1); }
  }
  const res = await api('/admin/password', {
    method: 'POST',
    body: JSON.stringify({ password: pw }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    console.error(`Error: ${e.error || res.statusText}`);
    process.exit(1);
  }
  console.log(C.green('Password set'));
}

async function cmdRemovePassword() {
  const res = await api('/admin/password', { method: 'DELETE' });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    console.error(`Error: ${e.error || res.statusText}`);
    process.exit(1);
  }
  console.log(C.green('Password removed'));
}

async function cmdRestart() {
  const res = await api('/restart', { method: 'POST' });
  if (!res.ok) { console.error('Failed to restart'); process.exit(1); }
  console.log(C.yellow('Server restarting...'));
}

async function cmdCheckUpdate() {
  const res = await api('/update/check', { method: 'POST' });
  if (!res.ok) { console.error('Failed to check for updates'); process.exit(1); }
  const data = await res.json();
  if (data.updateAvailable) {
    console.log(C.green(`Update available: ${data.details?.version || 'new version'}`));
  } else {
    console.log(C.dim('Already up to date'));
  }
}

async function cmdApplyUpdate() {
  const res = await api('/update/apply', { method: 'POST' });
  if (!res.ok) { console.error('Failed to apply update'); process.exit(1); }
  const data = await res.json();
  console.log(C.green('Update applied'));
  if (data.needsRestart) console.log(C.yellow('Server will restart shortly...'));
}

async function cmdBuildApk() {
  const { writeFileSync } = await import('fs');
  const clientDir = join(PACKAGE_ROOT, 'client');
  const androidDir = join(clientDir, 'android');

  // ── Auto-bump version ──────────────────────────────────
  const versionPath = join(PACKAGE_ROOT, 'version.json');
  const versionData = JSON.parse(readFileSync(versionPath, 'utf8'));
  const [major, minor, patch] = versionData.version.split('.').map(Number);
  const newVersion = `${major}.${minor}.${patch + 1}`;
  versionData.version = newVersion;
  versionData.minClientVersion = newVersion;
  writeFileSync(versionPath, JSON.stringify(versionData, null, 2) + '\n');
  console.log(`${C.green('Version bumped')} → ${newVersion}`);

  // Update bootstrap meta tag to match
  const bootstrapPath = join(clientDir, 'bootstrap', 'index.html');
  if (existsSync(bootstrapPath)) {
    const html = readFileSync(bootstrapPath, 'utf8');
    const updated = html.replace(
      /(<meta name="app-version" content=")[^"]*(")/,
      `$1${newVersion}$2`
    );
    writeFileSync(bootstrapPath, updated);
  }

  // ── Build ──────────────────────────────────────────────
  console.log(C.dim('Syncing Capacitor...'));
  execSync('npx cap sync android', { cwd: clientDir, stdio: 'inherit' });

  console.log(C.dim('Building APK...'));
  execSync('./gradlew assembleDebug', { cwd: androidDir, stdio: 'inherit' });

  const apkPath = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (existsSync(apkPath)) {
    const size = (readFileSync(apkPath).length / 1024 / 1024).toFixed(1);
    console.log(`\n${C.green('APK built')} v${newVersion} (${size} MB)`);
    console.log(`  ${C.dim(apkPath)}`);
    console.log(`  Download from server: ${getBaseUrl()}/api/app/download`);
  }
}

// ── Setup ──────────────────────────────────────────────────

async function cmdSetup() {
  const platform = process.platform;
  console.log(`\n${C.bold('Claude Remote Setup')}\n`);
  console.log(`Platform: ${platform}, Node: ${process.version}\n`);

  // Step 1: Install server dependencies
  const serverDir = getServerDir();
  const nodeModules = join(serverDir, 'node_modules');
  if (!existsSync(nodeModules)) {
    console.log(C.yellow('Installing server dependencies...'));
    try {
      execSync('npm install', { cwd: serverDir, stdio: 'inherit' });
      console.log(C.green('Dependencies installed.\n'));
    } catch {
      console.log(C.red('\nFailed to install dependencies. node-pty requires C++ build tools:'));
      if (platform === 'linux') {
        console.log(`  ${C.bold('sudo apt install -y build-essential python3')}`);
      } else if (platform === 'darwin') {
        console.log(`  ${C.bold('xcode-select --install')}`);
      } else if (platform === 'win32') {
        console.log(`  ${C.bold('npm install -g windows-build-tools')} (run as Administrator)`);
      }
      console.log('\nInstall build tools, then run `claude-remote setup` again.');
      process.exit(1);
    }
  } else {
    console.log(C.green('Server dependencies: OK'));
  }

  // Step 2: Tailscale check
  console.log(`\n${C.bold('── Tailscale ──')}\n`);
  let tailscaleInstalled = false;
  let tailscaleIp = null;
  try {
    const which = platform === 'win32' ? 'where' : 'which';
    execSync(`${which} tailscale`, { stdio: 'pipe' });
    tailscaleInstalled = true;
    try {
      const status = execSync('tailscale status --json', { encoding: 'utf8', stdio: 'pipe' });
      const parsed = JSON.parse(status);
      if (parsed.Self?.TailscaleIPs?.length) {
        tailscaleIp = parsed.Self.TailscaleIPs.find(ip => ip.startsWith('100.'));
      }
    } catch {}
  } catch {}

  if (tailscaleIp) {
    console.log(C.green(`Tailscale connected: ${tailscaleIp}`));
  } else if (tailscaleInstalled) {
    console.log(C.yellow('Tailscale installed but not connected.'));
    if (platform === 'win32') {
      console.log(`  Open the Tailscale app and sign in.`);
    } else {
      console.log(`  Run: ${C.bold('sudo tailscale up')}`);
    }
  } else {
    console.log(C.yellow('Tailscale not found. Install it for remote access over the internet:'));
    if (platform === 'linux') {
      console.log(`  ${C.bold('curl -fsSL https://tailscale.com/install.sh | sh')}`);
    } else if (platform === 'darwin') {
      console.log(`  ${C.bold('brew install tailscale')}  or install from the Mac App Store`);
    } else if (platform === 'win32') {
      console.log(`  Download from: ${C.bold('https://tailscale.com/download/windows')}`);
    }
    console.log(`\n  ${C.dim('Without Tailscale, the app will only work on your local network.')}`);
  }

  console.log(`\n  ${C.dim('Phone setup: Install Tailscale from the Play Store and sign in with the same account.')}`);

  // Step 3: Generate token
  console.log(`\n${C.bold('── Authentication ──')}\n`);
  ensureDataDir();
  const { loadServerSettings, saveServerSettings, hashPassword } = await import('./server/settings.js');
  const settings = loadServerSettings();
  if (!settings.authToken) {
    const crypto = await import('crypto');
    settings.authToken = crypto.randomBytes(16).toString('hex');
    saveServerSettings(settings);
    console.log(C.green('Auth token generated.'));
  } else {
    console.log(C.green('Auth token: exists'));
  }

  // Step 4: Offer password setup
  if (!settings.password) {
    const answer = await prompt('Set a password for phone login? [y/N] ');
    if (answer.toLowerCase() === 'y') {
      const pw = await prompt('Password: ');
      if (pw.trim()) {
        settings.password = hashPassword(pw.trim());
        saveServerSettings(settings);
        console.log(C.green('Password set.'));
      }
    }
  } else {
    console.log(C.green('Password: set'));
  }

  // Step 5: Connection info
  console.log(`\n${C.bold('── Connection Info ──')}\n`);
  const port = settings.port;
  if (tailscaleIp) {
    console.log(`  Server URL: ${C.bold(`http://${tailscaleIp}:${port}`)}`);
  } else {
    console.log(`  Server URL: ${C.bold(`http://localhost:${port}`)}`);
    console.log(`  ${C.dim('(Set up Tailscale to connect from your phone outside your network)')}`);
  }
  console.log(`  Auth token: ${C.dim(settings.authToken)}`);

  // Step 6: APK guide
  console.log(`\n${C.bold('── Android App ──')}\n`);
  console.log('  Install the Android app on your phone:');
  console.log(`  1. Open: ${C.bold('https://github.com/kaleLetendre/claude-remote/releases/latest')}`);
  console.log('  2. Download claude-remote.apk');
  console.log('  3. Install it (enable "Install from unknown sources" if prompted)');
  console.log('  4. Open the app and enter your server URL and password/token');

  // Step 7: Offer to start
  console.log();
  const start = await prompt('Start the server now? [Y/n] ');
  if (start.toLowerCase() !== 'n') {
    console.log();
    await cmdStart();
  }
}

async function cmdStart() {
  const runner = join(PACKAGE_ROOT, 'runner.js');
  const child = cpSpawn(process.execPath, [runner, 'start'], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  // Forward signals
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  // Keep this process alive while child runs
  await new Promise(() => {});
}

// ── Attach to Session ─────────────────────────────────────

async function cmdAttach(sessionId) {
  // Fetch sessions
  const res = await api('/sessions');
  if (!res.ok) { console.error('Server not reachable'); process.exit(1); }
  const sessions = await res.json();
  if (!sessions.length) { console.log(C.dim('No active sessions')); process.exit(0); }

  let session;
  if (sessionId) {
    // Match by ID or partial ID or name
    session = sessions.find(s => s.id === sessionId)
      || sessions.find(s => s.id.includes(sessionId))
      || sessions.find(s => s.name?.toLowerCase().includes(sessionId.toLowerCase()));
    if (!session) { console.error(`No session matching "${sessionId}"`); process.exit(1); }
  } else if (sessions.length === 1) {
    session = sessions[0];
  } else {
    // Interactive picker
    console.log(`\n${C.bold('Pick a session to attach:')}\n`);
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const statusColor = s.status === 'working' ? C.green : s.status === 'waiting' ? C.yellow : C.dim;
      const claude = s.claudeSessionId ? C.dim(` claude:${s.claudeSessionId.slice(0, 8)}`) : '';
      console.log(`  ${C.bold(String(i + 1))}  ${s.name || 'Unnamed'}  ${statusColor(s.status || 'idle')}  ${C.dim(s.cwd || '')}${claude}`);
    }
    console.log();
    const answer = await prompt('Session number: ');
    const idx = parseInt(answer) - 1;
    if (isNaN(idx) || idx < 0 || idx >= sessions.length) { console.error('Invalid selection'); process.exit(1); }
    session = sessions[idx];
  }

  console.log(`${C.dim('Attaching to')} ${C.bold(session.name || 'Unnamed')} ${C.dim(`(${session.id})`)}`);
  console.log(C.dim('Press Ctrl+] to detach\n'));

  // Connect WebSocket
  const { default: WebSocket } = await import('ws');
  const token = getToken();
  const wsUrl = `${getBaseUrl().replace(/^http/, 'ws')}?token=${token}`;
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: session.id }));

    // Get terminal size and send resize
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    ws.send(JSON.stringify({ type: 'resize', sessionId: session.id, cols, rows }));
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'output') {
      process.stdout.write(msg.data);
    } else if (msg.type === 'session:killed') {
      console.log(C.dim('\nSession ended.'));
      cleanup();
    }
  });

  ws.on('close', () => {
    console.log(C.dim('\nDisconnected.'));
    cleanup();
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error: ${err.message}`);
    cleanup();
  });

  // Raw mode for stdin
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (data) => {
    // Ctrl+] (0x1d) to detach
    if (data === '\x1d') {
      console.log(C.dim('\nDetached.'));
      cleanup();
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', sessionId: session.id, data }));
    }
  });

  // Handle terminal resize
  process.stdout.on('resize', () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', sessionId: session.id, cols: process.stdout.columns, rows: process.stdout.rows }));
    }
  });

  function cleanup() {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    try { ws.close(); } catch {}
    process.exit(0);
  }

  // Keep alive
  await new Promise(() => {});
}

// ── Setup Hooks ───────────────────────────────────────────

async function cmdSetupHooks() {
  const { writeFileSync, chmodSync } = await import('fs');
  const { homedir } = await import('os');

  const claudeSettings = join(homedir(), '.claude', 'settings.json');
  const relayScript = join(PACKAGE_ROOT, 'scripts', 'claude-hook-relay.sh');

  // Ensure relay script is executable
  try {
    chmodSync(relayScript, 0o755);
  } catch (e) {
    console.error(C.red(`Cannot chmod relay script: ${e.message}`));
    process.exit(1);
  }

  // Read existing settings
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(claudeSettings, 'utf8'));
  } catch {
    console.log(C.yellow('No existing ~/.claude/settings.json — creating one.'));
  }

  if (!settings.hooks) settings.hooks = {};

  // Helper: check if relay script is already in a hook array entry's hooks list
  const hasRelay = (hookEntry) =>
    hookEntry.hooks?.some(h => h.command?.includes('claude-hook-relay.sh'));

  // Helper: create a relay hook object
  const relayHook = (hookType) => ({
    command: `${relayScript} ${hookType}`,
    type: 'command',
    timeout: 5,
  });

  // Add Notification hooks (separate entries per matcher)
  if (!settings.hooks.Notification) settings.hooks.Notification = [];
  for (const matcher of ['idle_prompt', 'permission_prompt']) {
    const existing = settings.hooks.Notification.find(e => e.matcher === matcher);
    if (existing) {
      if (!hasRelay(existing)) {
        existing.hooks.push(relayHook('notification'));
      }
    } else {
      settings.hooks.Notification.push({
        matcher,
        hooks: [relayHook('notification')],
      });
    }
  }

  // Add Stop and UserPromptSubmit hooks (append to existing entries)
  for (const [event, hookType] of [['Stop', 'stop'], ['UserPromptSubmit', 'user_prompt_submit']]) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    if (settings.hooks[event].length === 0) {
      settings.hooks[event].push({ hooks: [relayHook(hookType)] });
    } else {
      // Append to first entry if not already present
      const first = settings.hooks[event][0];
      if (!hasRelay(first)) {
        first.hooks.push(relayHook(hookType));
      }
    }
  }

  writeFileSync(claudeSettings, JSON.stringify(settings, null, 2) + '\n');

  console.log(C.green('Claude Code hooks configured.'));
  console.log(`  Settings: ${C.dim(claudeSettings)}`);
  console.log(`  Relay:    ${C.dim(relayScript)}`);
  console.log();
  console.log('Hooks added:');
  console.log(`  ${C.dim('Notification (idle_prompt)')}`);
  console.log(`  ${C.dim('Notification (permission_prompt)')}`);
  console.log(`  ${C.dim('Stop')}`);
  console.log(`  ${C.dim('UserPromptSubmit')}`);
  console.log();
  console.log(`Existing hooks preserved. Run again safely — it's idempotent.`);
}

// ── CLI router ──────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

const commands = {
  setup:            { fn: cmdSetup,          desc: 'Interactive first-time setup' },
  start:            { fn: cmdStart,          desc: 'Start the server' },
  status:           { fn: cmdStatus,         desc: 'Show server status' },
  token:            { fn: cmdToken,          desc: 'Print auth token' },
  url:              { fn: cmdUrl,            desc: 'Print phone connection URL' },
  clients:          { fn: cmdClients,        desc: 'List connected clients' },
  sessions:         { fn: cmdSessions,       desc: 'List active sessions' },
  'set-password':   { fn: () => cmdSetPassword(args[0]),  desc: 'Set server password' },
  'remove-password':{ fn: cmdRemovePassword, desc: 'Remove server password' },
  restart:          { fn: cmdRestart,        desc: 'Restart the server' },
  'check-update':   { fn: cmdCheckUpdate,    desc: 'Check for updates' },
  'apply-update':   { fn: cmdApplyUpdate,    desc: 'Apply available update' },
  'build-apk':      { fn: cmdBuildApk,       desc: 'Build Android APK' },
  attach:           { fn: () => cmdAttach(args[0]),  desc: 'Attach to a session (interactive picker or pass ID/name)' },
  'setup-hooks':    { fn: cmdSetupHooks,    desc: 'Configure Claude Code hooks for notifications' },
};

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`\n${C.bold('claude-remote')} — control Claude Code from your phone\n`);
  console.log('Usage: claude-remote <command>\n');
  console.log('Commands:');
  const maxLen = Math.max(...Object.keys(commands).map(k => k.length));
  for (const [name, { desc }] of Object.entries(commands)) {
    console.log(`  ${name.padEnd(maxLen + 2)}${C.dim(desc)}`);
  }
  console.log();
  process.exit(0);
}

if (!commands[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  console.error(`Run 'claude-remote help' for available commands`);
  process.exit(1);
}

commands[cmd].fn().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
