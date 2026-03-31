import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Settings file paths (canonical locations) ───────────────
export const PATHS = {
  serverSettings: join(ROOT, 'data', 'server-settings.json'),
  connectionInfo: join(ROOT, 'data', 'connection-info.json'),
};

// ── Default settings by version ─────────────────────────────
const DEFAULTS = {
  port: 3033,
  authToken: null,        // null = generate random
  shell: null,            // null = use $SHELL
  cols: 120,
  rows: 40,
  autoUpdate: false,
  updateCheckInterval: 300_000,  // 5 min
  settingsVersion: 1,
};

// ── Migrations ──────────────────────────────────────────────
// Each migration takes the settings object and returns the upgraded version.
// Keyed by the version they migrate FROM → TO.
const MIGRATIONS = {
  // Example: version 1 → 2
  // 1: (settings) => {
  //   settings.newField = 'default';
  //   settings.settingsVersion = 2;
  //   return settings;
  // },
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
    const raw = readFileSync(join(ROOT, 'version.json'), 'utf8');
    return JSON.parse(raw).settingsVersion || 1;
  } catch {
    return 1;
  }
}

function ensureDataDir() {
  const dataDir = join(ROOT, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
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
