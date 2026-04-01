#!/usr/bin/env node
// Post-install: install server dependencies (including node-pty native build)

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = join(__dirname, '..', 'server');

if (!existsSync(join(serverDir, 'package.json'))) {
  // Not in full project context (e.g. running from tarball without server/)
  process.exit(0);
}

if (existsSync(join(serverDir, 'node_modules'))) {
  // Already installed
  process.exit(0);
}

console.log('Installing Claude Remote server dependencies...');
try {
  execSync('npm install --production', { cwd: serverDir, stdio: 'inherit' });
} catch {
  console.error('\nFailed to install server dependencies.');
  console.error('node-pty requires C++ build tools. Install them and run:');
  console.error('  cd ' + serverDir + ' && npm install');
  // Don't fail the install — let the user fix it and run `claude-remote setup`
  process.exit(0);
}
