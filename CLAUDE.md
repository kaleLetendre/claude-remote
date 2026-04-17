# CLAUDE.md — Claude Remote Project Handoff

You are picking up development of **Claude Remote**, an Android app that lets the user control Claude Code on their workstation from their phone. The user will be using you (Claude Code) through this very app to continue building it — so you are building the tool you're being used through.

## Project Purpose

The user wants to go for a walk while Claude Code works on their computer. They open this app on their Android phone, see a dashboard of terminal sessions, tap into one, and interact with Claude Code remotely — by typing, voice, or quick-tap buttons. When Claude asks a question, the phone buzzes and reads the question aloud.

**The user's priorities, ranked:**
1. Visual terminal output on phone (most important)
2. Managing multiple sessions/projects
3. Notifications/alerts when Claude needs attention
4. Voice-first hands-free interaction (nice to have)

### Target use case: hands-free server ops

Beyond casual walking-and-coding, Claude Remote is aimed at **remote/emergency server maintenance by IT professionals** — restarting Apache, flushing a cache, tailing logs, rolling back a deploy — from a phone, via voice, without needing to be at a computer or SSH'd in. The combination of Claude Code's skills system (custom slash commands) and voice mode's `"system command X"` prefix makes this viable: an operator can define skills like `/restart-apache`, `/flush-cache`, `/rollback-last-deploy`, then invoke them hands-free while driving or away from their desk. The skills themselves contain the actual commands and safety checks; the operator just says the name. This is the key reason voice mode, the `speak` / `cmd` side-channel scripts, and the dynamic `system command` prefix all matter — they're the interface for emergency ops.

Practical pattern:
- Operator writes a Claude Code skill (markdown file) per common op.
- Skill encodes the correct shell commands, safety prompts, and output summarization.
- Operator invokes hands-free: *"system command restart-apache"* → `/restart-apache` fires → Claude runs the skill → spoken confirmation via `speak`.
- `system command help` or asking Claude directly lists available ops.

---

## Architecture Overview

```
┌─────────────────────┐                    ┌──────────────────────────┐
│  Android Phone       │  ◄── WebSocket ──► │  User's Workstation      │
│  (Capacitor app)     │    (Tailscale)     │                          │
│                      │                    │  Node.js Server          │
│  client/bootstrap/   │                    │  server/                 │
│  └── index.html      │                    │  ├── server.js (Express) │
│  (login screen only) │                    │  ├── sessions.js (ptys)  │
│                      │                    │  ├── updater.js (git)    │
│  After login, loads: │                    │  └── settings.js         │
│  client/www/ from    │                    │                          │
│  the server          │                    │  desktop/                │
│                      │                    │  └── main.js (Electron)  │
│                      │                    │      Tray icon + admin   │
└─────────────────────┘                    └──────────────────────────┘
```

**Key architectural decision:** The APK only bundles a lightweight login screen (`client/bootstrap/`). After authentication, the WebView navigates to the server URL and loads the full app from `client/www/`. This means most updates are instant — change files on the server, phones see it on next load. APK rebuilds are only needed for native plugin changes.

**Server** (Node.js, runs on the user's workstation):
- Express serves the client's static files from `client/www/`
- WebSocket streams terminal I/O in real time
- `node-pty` spawns real pseudo-terminals (one per session)
- REST API for session CRUD, file browsing, auth, admin, version/update management
- Detects when Claude asks questions via Claude Code hooks (primary) with regex fallback, pushes `session:attention` alerts
- Tracks session status: `idle` → `working` → `waiting` → `done`
- `POST /api/hooks/event` — localhost-only endpoint that receives Claude Code hook events relayed by `scripts/claude-hook-relay.sh`
- Git-based updater checks remote for new commits, can pull + restart
- Hosts the latest APK for OTA updates to phones

**Desktop App** (Electron, optional wrapper):
- Launches the Node.js server as a child process
- System tray icon (green = healthy, red = offline)
- Right-click menu: Open Admin, Copy Token, Copy Phone URL, Restart, Start on Login, Quit
- Admin window loads `localhost:3033/admin` in a BrowserWindow
- Minimizes to tray on close (like Discord)

**Client** (vanilla HTML/CSS/JS, wrapped in Capacitor for Android):
- Bootstrap screen (`client/bootstrap/index.html`) — login with password or token, then redirects WebView to server
- Main app (`client/www/`) — loaded from server after auth
- Views: `connect`, `dashboard`, `session`, `settings` (plus inline `new-session` dialog)
- `<template>` elements in index.html define view markup, cloned into `<main>` by the router
- xterm.js (from CDN) for raw terminal rendering
- Custom "clean view" that strips ANSI and groups output into readable blocks
- Web Speech API for STT (speech-to-text) and TTS (text-to-speech)
- Settings persisted to localStorage with versioned migration support

**CLI** (`cli.js` in project root):
- Headless management tool — everything the admin panel can do
- Commands: `setup`, `start`, `status`, `token`, `url`, `clients`, `sessions`, `set-password`, `remove-password`, `restart`, `check-update`, `apply-update`, `build-apk`, `setup-hooks`
- Reads auth token directly from the data-dir's `server-settings.json` (default `~/.claude-remote/`, overridable via `CLAUDE_REMOTE_DATA`)

**Networking**:
- Designed for Tailscale (mesh VPN). Server auto-detects Tailscale IP (`100.x.x.x`) on startup.
- Also works on LAN. WAN requires a tunnel (Tailscale, Cloudflare, SSH).
- Auth: persistent token stored in `{data-dir}/server-settings.json`, generated on first run. Data dir defaults to `~/.claude-remote/` and is overridable via the `CLAUDE_REMOTE_DATA` env var (used to separate prod and dev data).
- Password auth: optional, set via admin panel or CLI. Password exchanged for token via `POST /api/auth/login`.
- CORS enabled for Capacitor WebView (`capacitor://localhost`) and all origins.

---

## File-by-File Reference

### `version.json` (project root)
Single source of truth for versioning. Contains:
- `version`: semver string
- `settingsVersion`: integer (currently 2), bump when settings schema changes
- `minClientVersion`: minimum APK version the server requires
- `changelog`: array of version entries shown in update banners

### `cli.js` (project root)
CLI tool for headless server management. Uses the same REST API as the admin panel. Reads token from the data-dir's `server-settings.json` (see `lib/paths.js`). Commands: setup, start, status, token, url, clients, sessions, set-password, remove-password, restart, check-update, apply-update, build-apk, setup-hooks.

### `run.sh` (project root)
Process wrapper script. Modes:
- `./run.sh start` — runs server in a loop. Exit code 75 = restart. Other non-zero = crash (restart after 5s).
- `./run.sh desktop` — launches Electron app (tray + admin + server)
- `./run.sh install` — creates XDG autostart entry for desktop app on login
- `./run.sh uninstall` — removes autostart entry
- `./run.sh status` — shows if desktop app and server are running
- `./run.sh update` — interactive git pull with confirmation prompt
- `./run.sh version` — prints version from `version.json`

### `server/server.js`
Main entry point. Sets up Express, WebSocket, routes. Key sections:
- Loads persistent settings from `server/settings.js` on startup
- Auth middleware (`authCheck`) — checks Bearer token or `?token=` query param
- CORS middleware — allows all origins for Capacitor WebView
- `POST /api/auth/login` — exchanges password for token (unauthenticated endpoint)
- REST routes: `/api/sessions`, `/api/files`, `/api/info`, `/api/version`, `/api/update/*`, `/api/restart`
- Admin routes: `/api/admin/status`, `/api/admin/password`, `/api/admin/token`
- Whisper admin routes: `/api/admin/whisper/status`, `/api/admin/whisper/bootstrap`, `/api/admin/whisper/install`, `/api/admin/whisper/models/:name` (DELETE), `/api/admin/whisper/config`
- TTS admin routes: `/api/admin/tts/status`, `/api/admin/tts/bootstrap`, `/api/admin/tts/config`, `/api/admin/tts/preview`
- Voice routes: `/api/voice/speak` (routes through Kokoro when enabled, else Android TTS broadcast), `/api/cmd/queue`, `/api/voice/status` (returns `{whisperEnabled, ttsEnabled}`), `/api/voice/transcribe` (server-side Whisper STT)
- APK distribution: `/api/app/version` (unauthenticated), `/api/app/download`
- WebSocket message types: `subscribe`, `unsubscribe`, `input`, `resize`, `list`, `ping`
- Tracks connected WS clients in `connectedClients` Map (IP, connect time, subscribed session)
- Broadcasts `sessions` list to all clients every 3 seconds
- `detectIPs()` finds LAN and Tailscale interfaces

### `lib/paths.js`
Canonical path resolution. `getDataDir()` returns `CLAUDE_REMOTE_DATA` if set, else `~/.claude-remote/`. `PACKAGE_ROOT` points to the repo root. Exposes `getSettingsPath()`, `getSessionsPath()`, `getConnectionInfoPath()`, `getVersionPath()`, `ensureDataDir()`. `migrateDataDir()` runs once at startup and copies legacy `./data/server-settings.json` + `sessions.json` into the data dir for existing users.

### `server/settings.js`
Versioned settings with migration support and password hashing.
- `PATHS` — canonical file locations (delegated to `lib/paths.js`, data is git-ignored and stored outside the repo by default)
- `DEFAULTS` — default server settings including `authToken: null`, `password: null`, `whisper: { enabled, model, device }`, `tts: { enabled, voice, device, speed }`
- `MIGRATIONS` — v1→v2 (adds password), v2→v3 (adds `whisper` block), v3→v4 (adds `tts` block). Current `settingsVersion` is **4**.
- `loadServerSettings()` — loads from file, applies env var overrides, runs migrations
- `saveServerSettings()` — writes to `{data-dir}/server-settings.json`
- `hashPassword(password)` — returns `{ hash, salt }` using `crypto.scryptSync`
- `verifyPassword(password, stored)` — constant-time comparison with `timingSafeEqual`

### `server/whisper-manager.js`
Server-side Whisper STT stack (optional; defaults off). Lets operators run `faster-whisper` on the host for higher accuracy than Android SpeechRecognition.
- Host capability detection: `findPython3()`, `isCudaAvailable()`, `isFfmpegAvailable()`, `isVenvReady()`, `isFasterWhisperInstalled()`
- `bootstrap(onLog)` — creates a managed venv at `{data-dir}/whisper-venv/` and pip-installs `faster-whisper`. Streams progress lines.
- `installModel(name, onProgress)` / `deleteModel(name)` / `listInstalledModels()` — model management under `{data-dir}/whisper-models/` (HF cache layout). Known models: tiny.en, base.en, small.en, medium.en, large-v3, large-v3-turbo.
- `whisper` (singleton `WhisperHelper`) — long-lived subprocess running `server/whisper/transcribe.py`. `start({model, device})` spawns it, `transcribe(audioBuffer)` sends base64-audio requests over stdin and reads JSON replies off stdout. `device: 'auto'` resolves to cuda when `nvidia-smi` succeeds, else cpu.

### `server/whisper/transcribe.py`
Long-lived helper process. Loads the faster-whisper model once on startup (env: `WHISPER_MODEL`, `WHISPER_DEVICE`, `WHISPER_MODEL_DIR`, optional `WHISPER_COMPUTE_TYPE`), emits `{"ready": true}`, then serves one JSON request per line on stdin (`{audio_b64, language}`) with one JSON reply per line on stdout (`{text}` or `{error}`).

### `server/tts-manager.js`
Server-side Kokoro neural TTS stack (optional; defaults off). Mirrors the Whisper manager's structure.
- Host capability detection: `findPython3()`, `isCudaAvailable()`, `isVenvReady()`, `isKokoroInstalled()`, `areAssetsInstalled()`, `isBootstrapped()`.
- `bootstrap(onLog)` — one-click: create managed venv at `{data-dir}/tts-venv/`, pip-install `kokoro-onnx`, then curl-download `kokoro-v1.0.onnx` + `voices-v1.0.bin` into `{data-dir}/tts-model/`. Streams progress lines. Unlike Whisper, **there is no per-voice install** — the single voices bundle contains every Kokoro voice at once.
- `KNOWN_VOICES` — curated subset of Kokoro's catalog: `af_bella`, `af_sarah`, `af_nicole`, `af_sky`, `am_adam`, `am_michael`, `bf_emma`, `bf_isabella`, `bm_george`, `bm_lewis` (a/b = American/British, f/m = female/male).
- `tts` (singleton `TtsHelper`) — long-lived subprocess running `server/tts/synthesize.py`. `start({voice, device, speed})` spawns it, `synthesize(text)` sends a JSON request over stdin and reads a JSON reply off stdout. `device: 'auto'` resolves to cuda when `nvidia-smi` succeeds, else cpu.

### `server/tts/synthesize.py`
Long-lived helper process. Loads `kokoro-onnx` with the model + voices bundle once on startup (env: `KOKORO_VOICE`, `KOKORO_DEVICE`, `KOKORO_SPEED`, `KOKORO_MODEL_FILE`, `KOKORO_VOICES_FILE`), emits `{"ready": true}`, then serves one JSON request per line on stdin (`{text, voice?, speed?}`) with one JSON reply per line on stdout (`{audio_b64, format: "wav", ms}` or `{error}`). Audio is 16-bit PCM WAV at Kokoro's native sample rate.

### `server/sessions.js`
`SessionManager` class (extends EventEmitter). Manages multiple pty instances.
- `create({ name, cwd })` — spawns a new pty, creates the cwd directory if it doesn't exist
- `write(id, data)` — sends input to a session's pty
- `kill(id)` — terminates a session
- `subscribe(id, ws)` / `unsubscribe(id, ws)` — manage which WebSocket clients receive a session's output
- `listDirectory(path)` — returns directory contents for the file browser
- `handleHookEvent()` — processes Claude Code hook events (Notification, Stop, UserPromptSubmit) for status detection
- `_detectStatus()` — regex-based fallback for status detection when hooks are not active (non-Claude sessions)
- Output buffered per session (last 100KB), sent to new subscribers on connect

### `server/updater.js`
`Updater` class (extends EventEmitter). Git-based update system.
- `check()` — fetches remote, compares HEAD with origin, returns update info
- `apply()` — stashes local changes, `git pull`, runs `npm install` if package.json changed, pops stash
- `scheduleRestart(ms)` — exits process with code 75 (run.sh catches this and restarts)

### `desktop/main.js`
Electron main process. Tray-only app (no dock icon on macOS).
- Spawns `node server.js` as child process, captures stdout for token/port
- Creates system tray with green/red icon based on server health (polls every 10s)
- Right-click menu: Open Admin, Copy Token, Copy Phone URL, Restart Server, Start on Login toggle, Quit
- Admin window loads `http://localhost:{port}/admin?token={token}` in a BrowserWindow
- Window minimizes to tray on close (like Discord)
- Auto-restarts server on crash (3s delay)
- Single instance lock prevents multiple copies

### `desktop/package.json`
Electron dependency. Scripts: `"start": "ELECTRON_DISABLE_SANDBOX=1 electron ."` (Linux sandbox workaround).

### `client/bootstrap/index.html`
Minimal login screen bundled in the APK. After successful auth, redirects the WebView to the server URL.
- Password field (primary) with token as advanced fallback
- Auto-connects if saved credentials exist in localStorage
- Checks `/api/app/version` for APK updates before redirecting
- Shows update prompt with Download/Skip buttons if APK is outdated
- `meta[name="app-version"]` tag holds the baked-in version for comparison

### `client/www/index.html`
SPA shell loaded from server. Contains:
- CDN links for xterm.js + fit addon + Google Fonts (IBM Plex Mono, Outfit)
- `<template>` elements for each view (dashboard, session card, new session dialog, session view, file browser, settings)

### `client/www/admin.html`
Standalone admin page served at `/admin`. Same industrial terminal aesthetic.
- Auth screen: password or token login
- Status card: hostname, uptime, port, IPs, client count
- Authentication card: token display (copyable), set/change/remove password
- Connected clients list with IP and connection time
- Sessions list with status
- Controls: restart server, check for updates
- Auto-refreshes every 5s, pauses refresh when user is typing in an input

### `client/www/css/style.css`
All mobile app styles. Aesthetic: **industrial terminal** — deep dark backgrounds, monospace typography, status colors (green/amber/red/blue), subtle noise texture. Uses CSS custom properties throughout.

### `client/www/js/app.js`
All client logic in one file (~1200 lines). Sections marked with comment headers.
- The `api` object handles `?` vs `&` for token query param when path already has query params
- Connect view now has password field (primary) with token as advanced fallback
- Password login calls `POST /api/auth/login` to exchange password for token

### `client/capacitor.config.ts`
Capacitor configuration. Key settings:
- `webDir: 'bootstrap'` — APK bundles only the login screen
- `server.cleartext: true` — allows HTTP for local network
- `server.allowNavigation: ['*']` — lets WebView navigate to server URLs (instead of opening browser)
- `android.allowMixedContent: true` — allows WS over HTTP

### `scripts/`
Shell scripts auto-added to every pty's PATH (via `sessions.js:_makePtyEnv`) so Claude Code can invoke them directly from inside a session.
- `speak` — Claude calls this at end of turn to produce TTS on the phone. POSTs to `/api/voice/speak`. See VOICE-PLAN.md.
- `cmd` — Claude calls this to queue a slash command (`cmd clear` → queues `/clear`); server flushes to the pty when the Stop hook fires, so the slash command fires the moment Claude's turn ends.
- `claude-hook-relay.sh` — legacy Notification hook relay; forwards Claude Code hook events to `/api/hooks/event` for status detection and Enter-injection auto-accept fallback.
- `claude-preauth-hook.sh` — PreToolUse hook; consults `/api/hooks/preauth`. Server returns `{permissionDecision: "allow"}` when the session has auto-accept on, so permission prompts are never drawn. Much faster than the Notification-hook fallback.
- `restart-dev.sh` — safely restarts the dev server (port 3034 only). Always use this instead of `pkill`.
- `postinstall.js` — npm postinstall hook.

### Data dir (`~/.claude-remote/` by default)
Persistent user data, lives **outside the repo** so it survives `git pull` and update reinstalls. Default `~/.claude-remote/`, overridden by `CLAUDE_REMOTE_DATA` (prod uses `~/.claude-remote-prod/` or similar; dev uses `~/.claude-remote/`). A one-time migration (`migrateDataDir()` in `lib/paths.js`) moves legacy `./data/*.json` into the new location on first boot. Key files:
- `server-settings.json` — auth token, password hash, port, shell, update settings, whisper config, tts config (settingsVersion 4)
- `sessions.json` — per-session metadata (id, name, cwd, tabs, claudeSessionId) for revive after a server restart
- `connection-info.json` — generated on startup with URLs and token
- `whisper-venv/` — managed Python venv with `faster-whisper` installed (only if Whisper was bootstrapped)
- `whisper-models/` — HuggingFace cache of installed Whisper models
- `tts-venv/` — managed Python venv with `kokoro-onnx` installed (only if Kokoro TTS was bootstrapped)
- `tts-model/` — Kokoro ONNX model + voices bundle (`kokoro-v1.0.onnx`, `voices-v1.0.bin`)

---

## Prod/Dev Setup

This project uses two instances running simultaneously:

- **Prod** (`~/claude-remote-prod`, main branch): port 3033 — protected by systemd, requires `sudo` to stop/restart
- **Dev** (`~/claude-remote`, dev branch): port 3034 — active development, free to restart

**NEVER kill the prod server on port 3033** unless the user explicitly asks. If the dev server breaks, prod keeps the user connected remotely.

### Restarting the dev server

**ALWAYS use the restart script** — do NOT manually kill processes or use `pkill`:

```bash
~/claude-remote/scripts/restart-dev.sh
```

This script safely stops the dev server (port 3034 only), starts it fresh via `run.sh`, and waits for it to come up. It will never touch prod.

**DO NOT** use `pkill -f node`, `pkill -f server`, `kill` on PIDs, or any other method to restart dev. These approaches frequently kill the wrapper process too, leaving the server dead with no restart loop. The script handles all of this correctly.

### Prod server management (requires sudo)

```bash
sudo systemctl status claude-remote    # check status
sudo systemctl restart claude-remote   # restart
sudo systemctl stop claude-remote      # stop (ONLY if user asks)
sudo journalctl -u claude-remote -f    # view logs
```

### App Identity — Dev vs Prod (CRITICAL)

The dev and prod APKs **MUST** have different Android application IDs so both can be installed on the same phone simultaneously.

| | Dev (this repo) | Prod (`~/claude-remote-prod`, main branch) |
|---|---|---|
| **App ID** | `com.clauderemote.dev` | `com.clauderemote.app` |
| **App Name** | `CR Dev` | `Claude Remote` |
| **Icon BG** | Dark (`#1A1A2E`) | White (`#FFFFFF`) |
| **Port** | 3034 | 3033 |

These values are set in three places that **must stay in sync**:
1. `client/capacitor.config.ts` — `appId` and `appName`
2. `client/android/app/build.gradle` — `namespace` and `applicationId`
3. `client/android/app/src/main/res/values/strings.xml` — `app_name`, `title_activity_main`, `package_name`, `custom_url_scheme`

The Java source lives in `client/android/app/src/main/java/com/clauderemote/dev/` (dev) or `.../app/` (prod). The `package` declaration in each `.java` file must match the namespace.

**NEVER change these values on the dev branch to match prod, or vice versa.** When merging dev→main, the app identity files must be reverted to prod values. When merging main→dev, they must be kept at dev values.

---

## Conventions and Patterns

### Code Style
- **Vanilla JS only.** No React, no frameworks, no build step. The user explicitly requested this.
- ES modules (`import`/`export`, `type: "module"` in package.json).
- Template-based view rendering (HTML `<template>` elements cloned by JS).
- CSS custom properties for theming. All colors, fonts, spacing defined in `:root`.

### State Management
- Single `state` object in app.js. No store, no signals, just a plain object.
- Settings subset persisted to localStorage via `saveSettings()`.
- Server pushes session list every 3 seconds over WebSocket — client re-renders dashboard from that.
- Server settings persisted to `{data-dir}/server-settings.json` via `saveServerSettings()`.

### Adding a New View
1. Add a `<template id="tpl-your-view">` in index.html
2. Add a `case 'your-view':` in the `navigate()` switch in app.js
3. Write an `initYourView()` function
4. Add any needed CSS to style.css

### Adding a New Setting
1. Add the field to `state` in app.js with a default value
2. Add the key to the `keys` array in `saveSettings()`
3. Add UI in the settings template (toggle, select, etc.)
4. Wire it up in `initSettings()`
5. If it's a server setting, also add to `DEFAULTS` in `server/settings.js`
6. **Bump `settingsVersion` in version.json** if the schema changed in a breaking way
7. Add a migration function in the appropriate `MIGRATIONS` object

### Adding a New API Endpoint
1. Add the Express route in `server/server.js` with `authCheck` middleware
2. Call it from app.js via `api.get/post/patch/del`
3. If it should be available via CLI, add a command in `cli.js`
4. If it should appear in admin panel, add it to `admin.html`

### Adding a New WebSocket Message Type
1. Server side: send via `ws.send(JSON.stringify({ type: 'your-type', ... }))`
2. Client side: add a `case 'your-type':` in `handleWSMessage()`

### Adding a New CLI Command
1. Write an `async function cmdYourCommand()` in `cli.js`
2. Add it to the `commands` object with a description
3. It will automatically appear in `node cli.js help`

### Deployment / Updates
- **Client-side changes** (`client/www/`): Live immediately — phones load from server
- **Server-side changes** (`server/`): Require server restart (`node cli.js restart` or via admin/tray)
- **Bootstrap changes** (`client/bootstrap/`): Require APK rebuild (`node cli.js build-apk`)
- **Native plugin changes**: Require APK rebuild + reinstall

### Version Bumping
1. Edit `version.json`: bump `version`, add changelog entry
2. If settings schema changed: bump `settingsVersion`, add migration
3. If APK needs updating: bump `minClientVersion`, update `meta[name="app-version"]` in `client/bootstrap/index.html`
4. Commit and push
5. Clients see the update

---

## Known Issues / Incomplete

- **Clean view heuristic is naive.** Currently just checks line length to guess what's Claude vs shell output. Could be much smarter — look for Claude Code's actual output framing patterns.
- **Question detection regex fallback is crude.** Hooks are primary now and work well; the regex fallback (for non-Claude sessions) still misses edge cases.
- **Session persistence is partial.** Metadata (id, name, cwd, claudeSessionId, tab names) persists and sessions revive via `claude --resume`. What doesn't persist: terminal scrollback, running processes, bash pty state.
- **No file viewer in the app.** The browser is picker-only. Could add a simple read/edit viewer.
- **Capacitor plugin fallbacks.** Bootstrap (`client/bootstrap/index.html`) already uses `Capacitor.Plugins.LocalNotifications` and `Capacitor.Plugins.Haptics` for attention alerts in the Android app — this is the critical path and it works. `app.js` still has Web API fallbacks (`navigator.vibrate`, `new Notification`) for browser-mode. Migrating those fallbacks to also call through the bridge would be consistency cleanup, not a reliability fix.
- **No HTTPS.** Server is HTTP only. Tailscale encrypts the tunnel so this is fine for the intended use case. Needed only for real audio-reactive waveform (`getUserMedia`) — not for TTS (native bridge) or STT (Android system).
- **No tests.** No automated test suite. Voice-command parser, hook handlers, and revive flow would be the first to cover.
- **Electron sandbox disabled.** Linux requires `ELECTRON_DISABLE_SANDBOX=1` due to chrome-sandbox permissions. Fixable by setting correct permissions on the sandbox binary.
- **Hands-free permission approval.** If auto-accept is off and Claude hits a permission prompt, there's no voice path to approve a single prompt. User has to tap or toggle auto-accept on.
- **No continuous / wake-word listening.** Push-to-talk only. Continuous mode would need a trigger phrase, confidence threshold, and self-muting while TTS plays.
- **Structured output mode (`claude -p --output-format stream-json`).** Would replace pty parsing with a clean JSON stream. Blocked on Anthropic adding subscription support (currently API-key only).

---

## User Preferences

- Prefers **vanilla HTML/CSS/JS**. No React, no frameworks.
- Uses **Android** (Samsung Galaxy S23).
- Wants **Tailscale** for WAN access (already set up on phone and workstation).
- Values clean, functional design — industrial terminal aesthetic, not flashy.
- Wants to develop the app **from the app itself** (meta/self-hosting workflow).
- Comfortable with Linux, finds directory structures intuitive.
- Uses Claude Code as their primary development tool.
- Prefers **password auth over tokens** for persistent connections.
- Wants **desktop tray icon** like Discord/Steam so they know the server is running.

---

## Development Workflow

The user works like this:

1. Opens Claude Remote on their phone
2. Creates or opens a session pointed at this repo's directory
3. Launches Claude Code in that session
4. Describes what they want changed
5. You (Claude Code) edit the files, commit, push
6. Client-side changes are live immediately (phone loads from server)
7. Server-side changes: restart via admin panel, tray, or CLI
8. Bootstrap/native changes: rebuild APK with `node cli.js build-apk`

Keep this loop tight. Small commits, clear commit messages, bump version.json when meaningful changes land.

---

## Quick Reference

```bash
# Start server (headless)
./run.sh start

# Start with tray icon + admin window
./run.sh desktop

# Install autostart on login
./run.sh install

# CLI management
node cli.js status          # server status
node cli.js set-password    # set password
node cli.js token           # print auth token
node cli.js url             # print phone connection URL
node cli.js build-apk       # rebuild Android APK

# Rebuild APK (manual)
cd client && npx cap sync android && cd android && ./gradlew assembleDebug

# Install APK to connected phone
adb install -r client/android/app/build/outputs/apk/debug/app-debug.apk
```
