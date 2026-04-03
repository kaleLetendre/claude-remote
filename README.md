# Claude Remote

Control Claude Code on your computer from your Android phone. Multi-session dashboard, real terminal output, voice I/O, and push notifications when Claude needs your attention.

```
┌─────────────────┐                      ┌───────────────────────┐
│  Android Phone   │ ◄── WebSocket ────► │  Your Workstation     │
│                  │    (Tailscale/LAN)   │                       │
│  Dashboard       │                      │  Node.js Server       │
│  ├─ Session 1    │                      │  ├─ pty: claude (proj1)│
│  ├─ Session 2    │                      │  ├─ pty: claude (proj2)│
│  └─ Session 3    │                      │  └─ pty: bash          │
│                  │                      │                       │
│  Voice input     │                      │  REST API + WebSocket  │
│  TTS output      │                      │  Admin panel           │
│  Push alerts     │                      │  System tray icon      │
└─────────────────┘                      └───────────────────────┘
```

## Quick Start

### Prerequisites

- **Node.js 18+**
- **C++ build tools** (needed by `node-pty`):
  - Linux: `sudo apt install -y build-essential python3`
  - macOS: `xcode-select --install`
  - Windows: `npm install -g windows-build-tools` (as Administrator)
- **Tailscale** (recommended for remote access): install on both your workstation and phone

### Setup

```bash
git clone https://github.com/kaleLetendre/claude-remote.git
cd claude-remote
./cli.js setup
```

The interactive setup will:
1. Install server dependencies
2. Check for Tailscale and guide you through setup
3. Generate an auth token
4. Optionally set a password for phone login
5. Show your connection URL
6. Offer to start the server

### Connect from your phone

**Option A — Browser (fastest to test):**
Open the server URL on your phone's browser. Works immediately.

**Option B — Android app (recommended):**
Download the APK from [GitHub Releases](https://github.com/kaleLetendre/claude-remote/releases/latest), install it, and enter your server URL + password.

The APK only bundles a login screen. After authentication, it loads the full UI from your server — so app updates are instant (no APK rebuild needed for most changes).

### Day-to-day usage

```bash
# Start server (headless, auto-restarts on crash/update)
./run.sh start

# Or start with desktop tray icon + admin panel
./run.sh desktop

# Install to start automatically on login
./run.sh install
```

## Architecture

**Server** (`server/`) — Node.js + Express + WebSocket + node-pty
- Manages multiple independent terminal sessions (real pseudo-terminals)
- Detects when Claude asks questions and pushes attention alerts
- Status detection via Claude Code hooks (primary) with regex fallback for non-Claude sessions
- Tracks session status: `idle` → `working` → `waiting` → `done`
- REST API for session CRUD, file browsing, auth, and admin
- WebSocket for real-time terminal I/O streaming
- Git-based updater checks remote for new commits, can pull + restart

**Client** (`client/www/`) — Vanilla HTML/CSS/JS, no framework
- Loaded from the server after login (not bundled in APK)
- Dashboard with session cards showing live status
- Full terminal view (xterm.js raw mode) and cleaned-up readable view (toggle)
- Directory browser for picking project folders
- STT (Speech-to-Text) and TTS (Text-to-Speech) via Web Speech API
- Push notifications via Capacitor Local Notifications

**Desktop App** (`desktop/`) — Electron tray app (optional)
- System tray icon: green = healthy, red = offline
- Right-click menu: Open Admin, Copy Token, Copy Phone URL, Restart, Quit
- Admin panel at `localhost:{port}/admin` for managing server, passwords, viewing clients/sessions
- Minimizes to tray on close (like Discord)

**CLI** (`cli.js`) — Headless management tool
- Everything the admin panel can do, from the command line
- Commands: `setup`, `start`, `status`, `token`, `url`, `clients`, `sessions`, `set-password`, `remove-password`, `restart`, `check-update`, `apply-update`, `build-apk`, `setup-hooks`

**Bootstrap** (`client/bootstrap/`) — Login screen bundled in the APK
- Password field (primary) with token as advanced fallback
- Auto-connects if saved credentials exist
- Checks for APK updates before redirecting to the server

## How It Works

### Session Management

Each session is an independent terminal. You can:

- **Create** sessions pointed at different project directories
- **Name** them (e.g., "Backend API", "Frontend", "Tests")
- **Monitor** their status on the dashboard — green = working, amber = waiting for input, gray = idle/done
- **Kill** sessions you don't need anymore
- **Switch** between sessions freely — output is buffered so you never lose history

### Terminal Views

Toggle between two modes:

- **Raw** — Full xterm.js terminal emulator. Exactly what you'd see on your monitor. Supports colors, cursor movement, everything.
- **Clean** — Parsed, stripped output. Removes ANSI codes and shell noise, groups output into readable blocks. Claude's prose is highlighted differently from system output.

### Voice Workflow

1. Enable TTS via the speaker icon in the top bar
2. Turn on "Smart TTS" in settings to only hear Claude's words (filters out diffs, file paths, shell prompts)
3. Tap the mic to speak commands — speech is transcribed and sent as terminal input
4. Auto-sends when you stop speaking

### Attention System

When Claude asks a question or needs input:
- Session card turns amber on the dashboard
- In-session banner appears with the question preview
- Phone vibrates
- Push notification fires if the app is backgrounded
- TTS reads the question aloud (if enabled)

Quick action buttons let you respond with one tap: Yes, No, Enter, Ctrl-C.

## Configuration

Server settings are stored in `data/server-settings.json` (auto-generated, git-ignored). You can manage them via the admin panel, CLI, or by editing the file directly.

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | `3033` | Server port |
| `authToken` | random | Auth token (generated on first run) |
| `password` | `null` | Password hash (set via admin panel or `cli.js set-password`) |
| `shell` | `$SHELL` or `/bin/bash` | Default shell for new sessions |
| `autoUpdate` | `false` | Auto-check for git updates |

Environment variable overrides:

| Variable | Description |
|----------|-------------|
| `PORT` | Override server port |
| `CLAUDE_REMOTE_DATA` | Override data directory (default: `~/.claude-remote`) |

## Remote Access

**Tailscale** (recommended):
Install on both your workstation and phone, sign in with the same account. The server auto-detects its Tailscale IP on startup and prints a ready-to-use URL.

**Cloudflare Tunnel**:
```bash
cloudflared tunnel --url http://localhost:3033
```

**SSH Tunnel** (from Termux on Android):
```bash
ssh -L 3033:localhost:3033 user@your-machine
```

## CLI Reference

```bash
./cli.js setup            # Interactive first-time setup
./cli.js start            # Start the server
./cli.js status           # Show server status, IPs, clients, sessions
./cli.js token            # Print auth token
./cli.js url              # Print phone connection URL
./cli.js clients          # List connected clients
./cli.js sessions         # List active sessions
./cli.js set-password     # Set server password
./cli.js remove-password  # Remove server password
./cli.js restart          # Restart the server
./cli.js check-update     # Check for updates
./cli.js apply-update     # Apply available update
./cli.js build-apk        # Build Android APK (--dev for dev build)
./cli.js setup-hooks      # Configure Claude Code hooks for notifications
```

## Project Structure

```
claude-remote/
├── cli.js                 # CLI management tool
├── runner.js              # Process runner (handles restart loop)
├── run.sh                 # Shell wrapper (start, desktop, install, update)
├── version.json           # Version + settings schema version + changelog
├── package.json
├── lib/
│   └── paths.js           # Canonical path resolution
├── server/
│   ├── server.js          # Express + WS + REST API
│   ├── sessions.js        # Multi-session pty manager
│   ├── updater.js         # Git-based update checker + applier
│   ├── settings.js        # Versioned settings with migration support
│   └── package.json
├── client/
│   ├── bootstrap/         # Login screen (bundled in APK)
│   │   └── index.html
│   ├── www/               # Full app (loaded from server after login)
│   │   ├── index.html     # SPA shell + view templates
│   │   ├── admin.html     # Admin panel
│   │   ├── css/style.css  # Industrial terminal aesthetic
│   │   └── js/app.js      # Client logic
│   ├── capacitor.config.ts
│   ├── package.json
│   └── android/           # Capacitor Android project
├── desktop/
│   ├── main.js            # Electron tray app
│   ├── assets/            # Tray icons
│   └── package.json
├── scripts/
│   └── postinstall.js     # npm postinstall hook
├── data/                  # User data (git-ignored, survives updates)
│   └── server-settings.json
└── setup.sh               # Legacy setup (use cli.js setup instead)
```

## Updates

The app is designed to be developed from itself. Updates are git-based.

### How updates reach your phone

**Web updates (instant):** The APK loads its UI from the server. Any change to `client/www/` is live immediately — phones see it on next load. This covers UI changes, features, settings, and bug fixes.

**Server updates:** Require a server restart after pulling new code. Use the admin panel, phone app, or CLI: `./cli.js apply-update`.

**APK updates (rare):** Only needed when Capacitor plugins change or the bootstrap login screen itself changes. Build with `./cli.js build-apk`, then phones are prompted to download on next connect.

### Updating

**From the CLI:**
```bash
./run.sh update       # Interactive: shows changes, asks to confirm
./cli.js apply-update # Or via the API
```

**From the phone:**
Settings → Check for updates → Update & Restart

**Auto-update:**
Set `autoUpdate: true` in settings. The server checks every 5 minutes and pushes an `update:available` message to all clients.

### Self-development workflow

1. Open the app on your phone
2. Create a session pointed at the `claude-remote/` repo directory
3. Launch Claude Code in that session
4. Tell Claude what to build/fix
5. Claude edits files, commits, pushes
6. Phone shows "Update available" → tap to update
7. Server restarts → you see the changes

### Version management

`version.json` is the single source of truth. Bump `version`, add a changelog entry, commit and push. If the settings schema changed, bump `settingsVersion` and add a migration in `server/settings.js`.

### Rebuilding the APK

```bash
./cli.js build-apk          # Production build
./cli.js build-apk --dev    # Dev build (separate app ID, can install alongside prod)

# Or manually:
cd client && npx cap sync android && cd android && ./gradlew assembleDebug

# Install to connected phone:
adb install -r client/android/app/build/outputs/apk/debug/app-debug.apk
```

## Troubleshooting

**node-pty won't install:** You need C++ build tools. See Prerequisites above.

**Can't connect from phone:** Make sure both devices are on the same network (or both on Tailscale). Check firewall allows the server port.

**Tray icon shows red but server works:** Token mismatch — the tray and server may be reading different settings files. Make sure `CLAUDE_REMOTE_DATA` is set consistently, or restart the tray.

**xterm.js not loading:** The app loads xterm.js from CDN. If offline, download the files to `client/www/lib/` and update the script tags.

**STT not working:** Android Chrome requires HTTPS for mic access in some versions. The native Capacitor app has mic permission built in.

**Capacitor build fails:** Make sure you have Android Studio with SDK 33+ and `ANDROID_HOME` set.

## License

MIT
