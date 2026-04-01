# CLAUDE.md — Claude Remote Project Handoff

You are picking up development of **Claude Remote**, an Android app that lets the user control Claude Code on their workstation from their phone. The user will be using you (Claude Code) through this very app to continue building it — so you are building the tool you're being used through.

## Project Purpose

The user wants to go for a walk while Claude Code works on their computer. They open this app on their Android phone, see a dashboard of terminal sessions, tap into one, and interact with Claude Code remotely — by typing, voice, or quick-tap buttons. When Claude asks a question, the phone buzzes and reads the question aloud.

**The user's priorities, ranked:**
1. Visual terminal output on phone (most important)
2. Managing multiple sessions/projects
3. Notifications/alerts when Claude needs attention
4. Voice-first hands-free interaction (nice to have)

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
- Detects when Claude asks questions (regex patterns on output) and pushes `session:attention` alerts
- Tracks session status: `idle` → `working` → `waiting` → `done`
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
- Commands: `status`, `token`, `url`, `clients`, `sessions`, `set-password`, `remove-password`, `restart`, `check-update`, `apply-update`, `build-apk`
- Reads auth token directly from `data/server-settings.json`

**Networking**:
- Designed for Tailscale (mesh VPN). Server auto-detects Tailscale IP (`100.x.x.x`) on startup.
- Also works on LAN. WAN requires a tunnel (Tailscale, Cloudflare, SSH).
- Auth: persistent token stored in `data/server-settings.json`, generated on first run.
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
CLI tool for headless server management. Uses the same REST API as the admin panel. Reads token from `data/server-settings.json`. Commands: status, token, url, clients, sessions, set-password, remove-password, restart, check-update, apply-update, build-apk.

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
- APK distribution: `/api/app/version` (unauthenticated), `/api/app/download`
- WebSocket message types: `subscribe`, `unsubscribe`, `input`, `resize`, `list`, `ping`
- Tracks connected WS clients in `connectedClients` Map (IP, connect time, subscribed session)
- Broadcasts `sessions` list to all clients every 3 seconds
- `detectIPs()` finds LAN and Tailscale interfaces

### `server/settings.js`
Versioned settings with migration support and password hashing.
- `PATHS` — canonical file locations (all in `data/` which is git-ignored)
- `DEFAULTS` — default server settings including `authToken: null`, `password: null`
- `MIGRATIONS` — currently has v1→v2 migration (adds password field)
- `loadServerSettings()` — loads from file, applies env var overrides, runs migrations
- `saveServerSettings()` — writes to `data/server-settings.json`
- `hashPassword(password)` — returns `{ hash, salt }` using `crypto.scryptSync`
- `verifyPassword(password, stored)` — constant-time comparison with `timingSafeEqual`

### `server/sessions.js`
`SessionManager` class (extends EventEmitter). Manages multiple pty instances.
- `create({ name, cwd })` — spawns a new pty, creates the cwd directory if it doesn't exist
- `write(id, data)` — sends input to a session's pty
- `kill(id)` — terminates a session
- `subscribe(id, ws)` / `unsubscribe(id, ws)` — manage which WebSocket clients receive a session's output
- `listDirectory(path)` — returns directory contents for the file browser
- `_detectStatus()` — regex-based heuristic that sets session status based on terminal output patterns
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

### `data/`
Git-ignored directory for persistent user data. Key files:
- `server-settings.json` — auth token, password hash, port, shell, update settings (settingsVersion 2)
- `connection-info.json` — generated on startup with URLs and token

---

## CRITICAL: Lifeline Protection

**NEVER modify files in the `lifeline/` directory unless the user explicitly asks you to.** The lifeline is a frozen emergency fallback system. If the main server breaks due to a bad update, the lifeline on port 3034 keeps the user connected so they can fix things remotely.

Do NOT:
- "Improve" or refactor lifeline code — even if you see bugs or inefficiencies, leave it alone
- Add features to the lifeline — it is intentionally minimal
- Update lifeline dependencies — they are pinned on purpose
- Fix lint warnings, add error handling, or clean up the lifeline code
- Include lifeline files in any bulk edits, renames, or refactors
- Run `npm install` or `npm update` in the `lifeline/` directory

The only acceptable reason to touch lifeline is if the user explicitly says something like "update the lifeline" or "fix the lifeline". Even then, confirm before making changes.

Protected files:
- `lifeline/server.js` — standalone server
- `lifeline/client.html` — single-file terminal UI
- `lifeline/package.json` — pinned dependencies
- `lifeline/app/` — separate Capacitor APK project
- `data/lifeline-home/` — default working directory with recovery README

The lifeline has its own `node_modules/`, its own port (3034), and zero imports from `server/`. It reads only `data/server-settings.json` for auth credentials.

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
- Server settings persisted to `data/server-settings.json` via `saveServerSettings()`.

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
- **Question detection patterns need tuning.** The regex list in `sessions.js` covers common prompts but misses some. Study Claude Code's actual output to refine.
- **No session persistence across server restarts.** If the server restarts, all pty sessions are lost. Could serialize session state or at least session metadata.
- **No file viewer in the app.** There's a file browser for picking directories when creating sessions, but no way to view/edit files from the phone. Could add a simple viewer.
- **Capacitor plugins not yet wired.** The package.json includes `@capacitor/local-notifications`, `@capacitor/haptics`, etc. but app.js still uses the Web APIs (Notification, navigator.vibrate). Should use the Capacitor plugins for better Android support.
- **No HTTPS.** Server is HTTP only. Tailscale encrypts the tunnel so this is fine for that use case, but if exposed directly, TLS should be added.
- **No tests.** No test suite exists yet.
- **Electron sandbox disabled.** Linux requires `ELECTRON_DISABLE_SANDBOX=1` due to chrome-sandbox permissions. Could fix by setting correct permissions on the sandbox binary.

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
