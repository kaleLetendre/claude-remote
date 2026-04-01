# Claude Remote — Features

## PC Side (Desktop / Server)

- **Persistent auth token** — generated once, saved to `data/server-settings.json`, survives restarts
- **Password authentication** — set a password from the admin panel; phone connects with password instead of token
- **Admin panel** — web UI at `localhost:3033/admin` for managing server, password, viewing clients and sessions
- **System tray icon** — Electron app with green/red status indicator, right-click menu (Open Admin, Copy Token, Copy Phone URL, Restart, Quit)
- **Auto-start on login** — `./run.sh install` adds to desktop autostart; tray icon appears on boot
- **Multi-session terminal management** — spawn and manage multiple pty sessions from the server
- **Question detection** — regex-based detection of when Claude Code asks a question; pushes alerts to connected phones
- **Session status tracking** — idle / working / waiting / done states detected from terminal output
- **Git-based auto-updater** — checks remote for new commits, can pull + restart from the admin panel or phone
- **Tailscale auto-detection** — server finds its Tailscale IP on startup and prints a ready-to-use URL
- **CORS support** — allows Capacitor WebView and cross-origin requests from the phone app
- **Crash recovery** — `run.sh` restart loop catches crashes and restarts the server automatically
- **CLI tool** — `node cli.js <command>` for headless server management; covers everything the admin panel does (status, token, url, clients, sessions, set-password, remove-password, restart, check-update, apply-update, build-apk)
- **APK hosting** — server hosts the latest APK at `/api/app/download`; phones can download updates over Tailscale/WAN

## Mobile Side (Android App)

- **Dashboard** — see all terminal sessions at a glance with name, status, and last activity
- **Live terminal view** — xterm.js rendering of real terminal output streamed over WebSocket
- **Clean view** — stripped ANSI output grouped into readable blocks (toggle between raw and clean)
- **Password login** — enter server URL + password to connect; token saved locally for future sessions
- **Token fallback** — advanced option to connect with raw auth token if needed
- **Create/manage sessions** — new session dialog with name, working directory, and directory browser
- **Attention alerts** — banner, vibration, and notification when Claude asks a question
- **Text-to-speech (TTS)** — reads Claude's output aloud; smart mode filters shell noise
- **Speech-to-text (STT)** — voice input via Web Speech API, auto-sends on final result
- **Settings** — TTS/STT toggles, voice selection, speech rate, alert preferences
- **Auto-reconnect** — WebSocket reconnects automatically on disconnect (3s delay)
- **Update notifications** — banner appears when a new server version is available; one-tap update + restart
- **Works in browser** — no APK required; open the server URL on any phone browser via Tailscale/LAN

## Deployment Pipeline

Updates happen in two layers, so most changes don't require an APK rebuild:

**Layer 1: Live web updates (instant, no APK needed)**
The APK only bundles a lightweight connect/login screen. After authenticating, the WebView loads the full app from the server. Any change to `client/www/` on the server is instantly live on all phones — just refresh. This covers UI changes, new features, settings, and bug fixes.

**Layer 2: APK updates (for native changes)**
When Capacitor plugins change or the bootstrap screen itself needs updating, a new APK is built and hosted on the server. On connect, the bootstrap checks its version against the server's `/api/app/version`. If outdated, it prompts the user to download the new APK. The download is served directly from the server over Tailscale/WAN — no app store needed.

**Workflow:**
1. Edit code in `client/www/` or `server/` → changes are live immediately (Layer 1)
2. If native changes needed: `node cli.js build-apk` → builds and hosts the APK on the server
3. Next time a phone connects, it sees the update prompt and downloads the new APK
4. Server code updates: `node cli.js apply-update` or use the admin panel/phone to pull + restart

## Lifeline Fallback System

A separate, frozen emergency system that is never modified by updates. If a bad update breaks the main app, the lifeline keeps you connected.

- **Lifeline server** — standalone Node.js process on port 3034, zero imports from main server code, own `node_modules/`
- **Lifeline client** — single HTML file with inline CSS/JS, plain text terminal (no xterm.js, no CDN dependencies)
- **Lifeline APK** — separate Android app (`CR Lifeline`) that installs alongside the main app, never updated
- **Shared auth** — reads password/token from the same `data/server-settings.json`
- **Independent sessions** — own PTY sessions, separate from main server
- **Always running** — started by `run.sh` and Electron alongside the main server, survives main server crashes
- **Browser accessible** — open `http://server-ip:3034` from any browser as a fallback
