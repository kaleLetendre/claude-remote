#!/usr/bin/env node
// Cross-platform server lifecycle manager (replaces run.sh for the core loop)

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { getServerDir, getVersionPath } from './lib/paths.js';

const args = process.argv.slice(2);
const command = args[0] || 'start';

if (command === 'version') {
  try {
    const ver = JSON.parse(readFileSync(getVersionPath(), 'utf8'));
    console.log(`Claude Remote v${ver.version}`);
  } catch {
    console.log('Claude Remote (version unknown)');
  }
  process.exit(0);
}

if (command === 'status') {
  try {
    const res = await fetch('http://localhost:3033/api/info');
    if (res.ok) {
      const info = await res.json();
      console.log(`Server running — ${info.hostname} on port ${info.port}`);
    } else {
      console.log('Server not responding');
    }
  } catch {
    console.log('Server not running');
  }
  process.exit(0);
}

if (command !== 'start') {
  console.log('Usage: claude-remote start|version|status');
  process.exit(1);
}

// ── Server run loop ────────────────────────────────────────

const serverDir = getServerDir();
let child = null;

function startServer() {
  return new Promise((resolve) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: serverDir,
      stdio: 'inherit',
      env: { ...process.env },
    });

    child.on('exit', (code) => {
      child = null;
      resolve(code ?? 1);
    });
  });
}

function cleanup() {
  if (child) {
    child.kill();
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Windows: handle Ctrl+C
if (process.platform === 'win32') {
  const rl = await import('readline');
  const iface = rl.createInterface({ input: process.stdin });
  iface.on('SIGINT', () => process.emit('SIGINT'));
}

console.log('Starting Claude Remote server...');

while (true) {
  const exitCode = await startServer();

  if (exitCode === 75) {
    console.log('Restart requested — restarting in 2s...');
    await new Promise(r => setTimeout(r, 2000));
    continue;
  } else if (exitCode === 0) {
    console.log('Server stopped cleanly.');
    break;
  } else {
    console.log(`Server crashed (exit ${exitCode}) — restarting in 5s...`);
    await new Promise(r => setTimeout(r, 5000));
  }
}
