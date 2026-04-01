#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  Claude Remote CLI — manage the server from the command line
// ═══════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(__dirname, 'data', 'server-settings.json');
const CONN_INFO_PATH = join(__dirname, 'data', 'connection-info.json');

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
  const clientDir = join(__dirname, 'client');
  const androidDir = join(clientDir, 'android');

  console.log(C.dim('Syncing Capacitor...'));
  execSync('npx cap sync android', { cwd: clientDir, stdio: 'inherit' });

  console.log(C.dim('Building APK...'));
  execSync('./gradlew assembleDebug', { cwd: androidDir, stdio: 'inherit' });

  const apkPath = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (existsSync(apkPath)) {
    const size = (readFileSync(apkPath).length / 1024 / 1024).toFixed(1);
    console.log(`\n${C.green('APK built')} (${size} MB)`);
    console.log(`  ${C.dim(apkPath)}`);
    console.log(`  Download from server: ${getBaseUrl()}/api/app/download`);
  }
}

// ── CLI router ──────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

const commands = {
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
};

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`\n${C.bold('claude-remote-cli')} — manage Claude Remote from the command line\n`);
  console.log('Usage: node cli.js <command>\n');
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
  console.error(`Run 'node cli.js help' for available commands`);
  process.exit(1);
}

commands[cmd].fn().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
