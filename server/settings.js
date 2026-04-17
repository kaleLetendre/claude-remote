import { readFileSync, writeFileSync, existsSync } from 'fs';
import crypto from 'crypto';
import {
  getSettingsPath, getConnectionInfoPath, getVersionPath,
  ensureDataDir, migrateDataDir,
} from '../lib/paths.js';

// Run one-time migration from ./data/ to ~/.claude-remote/
migrateDataDir();

// ── Settings file paths (canonical locations) ───────────────
export const PATHS = {
  serverSettings: getSettingsPath(),
  connectionInfo: getConnectionInfoPath(),
};

// ── Default settings by version ─────────────────────────────
const DEFAULTS = {
  port: 3033,
  authToken: null,        // null = generate random on first run, then persist
  password: null,         // null = no password set; { hash, salt } when set
  shell: null,            // null = use $SHELL
  cols: 120,
  rows: 40,
  autoUpdate: false,
  updateCheckInterval: 300_000,  // 5 min
  whisper: {
    enabled: false,        // master toggle for server-side STT
    model: null,           // installed model name, e.g. "small.en"
    device: 'auto',        // "auto" | "cpu" | "cuda"
  },
  tts: {
    enabled: false,        // master toggle for server-side Kokoro TTS
    voice: null,           // one of KNOWN_VOICES from tts-manager.js, e.g. "af_bella"
    device: 'auto',        // "auto" | "cpu" | "cuda"
    speed: 1.0,            // 0.5 – 2.0
  },
  settingsVersion: 4,
};

// ── Migrations ──────────────────────────────────────────────
// Each migration takes the settings object and returns the upgraded version.
// Keyed by the version they migrate FROM → TO.
const MIGRATIONS = {
  1: (settings) => {
    settings.password = settings.password || null;
    settings.settingsVersion = 2;
    return settings;
  },
  2: (settings) => {
    settings.whisper = settings.whisper || { enabled: false, model: null, device: 'auto' };
    settings.settingsVersion = 3;
    return settings;
  },
  3: (settings) => {
    settings.tts = settings.tts || { enabled: false, voice: null, device: 'auto', speed: 1.0 };
    settings.settingsVersion = 4;
    return settings;
  },
};

// ── Load / Save / Migrate ───────────────────────────────────

export function loadServerSettings() {
  let settings = { ...DEFAULTS };

  if (existsSync(PATHS.serverSettings)) {
    try {
      const raw = readFileSync(PATHS.serverSettings, 'utf8');
      const saved = JSON.parse(raw);
      settings = { ...DEFAULTS, ...saved };
    } catch {}
  }

  // Apply .env overrides (env vars always win)
  if (process.env.PORT) settings.port = parseInt(process.env.PORT);
  if (process.env.AUTH_TOKEN) settings.authToken = process.env.AUTH_TOKEN;
  if (process.env.SHELL) settings.shell = process.env.SHELL;
  if (process.env.AUTO_UPDATE) settings.autoUpdate = process.env.AUTO_UPDATE === 'true';

  // Run migrations
  settings = migrateSettings(settings);

  return settings;
}

export function saveServerSettings(settings) {
  ensureDataDir();
  writeFileSync(PATHS.serverSettings, JSON.stringify(settings, null, 2));
}

export function migrateSettings(settings) {
  const currentSchemaVersion = getCurrentSchemaVersion();
  let version = settings.settingsVersion || 1;

  while (version < currentSchemaVersion && MIGRATIONS[version]) {
    console.log(`Migrating settings: v${version} → v${version + 1}`);
    settings = MIGRATIONS[version](settings);
    version = settings.settingsVersion;
  }

  settings.settingsVersion = currentSchemaVersion;
  return settings;
}

function getCurrentSchemaVersion() {
  try {
    const raw = readFileSync(getVersionPath(), 'utf8');
    return JSON.parse(raw).settingsVersion || 1;
  } catch {
    return 1;
  }
}

// ── Password hashing ────────────────────────────────────────

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.hash || !stored.salt) return false;
  const hash = crypto.scryptSync(password, stored.salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(stored.hash));
}

// ── Client settings schema ──────────────────────────────────
// This is served to clients so they can migrate their localStorage

export function getClientSettingsSchema() {
  return {
    version: getCurrentSchemaVersion(),
    fields: {
      ttsEnabled: { type: 'boolean', default: false },
      smartTts: { type: 'boolean', default: false },
      alertsEnabled: { type: 'boolean', default: true },
      speechRate: { type: 'number', default: 1.1, min: 0.5, max: 2.5 },
      selectedVoiceURI: { type: 'string', default: null },
      sttLang: { type: 'string', default: 'en-US' },
      serverUrl: { type: 'string', default: '' },
      token: { type: 'string', default: '' },
    },
    // Client-side migrations (sent as JS strings to eval)
    migrations: {
      // 1: "settings.newField = settings.newField || 'default'; return settings;"
    },
  };
}
