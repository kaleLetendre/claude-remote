import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, copyFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Package root (where the code lives)
export const PACKAGE_ROOT = join(__dirname, '..');

// Data directory — persistent across updates, lives in user's home
const DATA_DIR = join(homedir(), '.claude-remote');

export function getDataDir() {
  return DATA_DIR;
}

export function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

// Data file paths
export function getSettingsPath() {
  return join(DATA_DIR, 'server-settings.json');
}

export function getConnectionInfoPath() {
  return join(DATA_DIR, 'connection-info.json');
}

export function getSessionsPath() {
  return join(DATA_DIR, 'sessions.json');
}

// Package-relative paths (code and assets, not data)
export function getServerDir() {
  return join(PACKAGE_ROOT, 'server');
}

export function getClientWwwDir() {
  return join(PACKAGE_ROOT, 'client', 'www');
}

export function getBootstrapDir() {
  return join(PACKAGE_ROOT, 'client', 'bootstrap');
}

export function getVersionPath() {
  return join(PACKAGE_ROOT, 'version.json');
}

// One-time migration: move data/ to ~/.claude-remote/ for existing users
export function migrateDataDir() {
  const oldDataDir = join(PACKAGE_ROOT, 'data');
  const oldSettings = join(oldDataDir, 'server-settings.json');

  if (existsSync(oldSettings) && !existsSync(getSettingsPath())) {
    ensureDataDir();
    copyFileSync(oldSettings, getSettingsPath());

    const oldSessions = join(oldDataDir, 'sessions.json');
    if (existsSync(oldSessions)) {
      copyFileSync(oldSessions, getSessionsPath());
    }
  }
}
