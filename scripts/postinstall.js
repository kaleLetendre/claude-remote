#!/usr/bin/env node
// Post-install: install server dependencies (including node-pty native build)
// and register the per-branch app-identity git automation.

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const serverDir = join(repoRoot, 'server');

// Register per-branch app identity merge driver + hooksPath.
// `identityours` = silently keep current branch's version. See .gitattributes
// and .githooks/post-merge for the full picture.
if (existsSync(join(repoRoot, '.git'))) {
  try {
    execSync('git config merge.identityours.driver true', { cwd: repoRoot, stdio: 'ignore' });
    execSync('git config core.hooksPath .githooks', { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    // Not fatal — user can run the config commands manually.
  }
}

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
