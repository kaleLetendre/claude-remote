# Claude Remote ⌘

Control Claude Code on your computer from your Android phone. Multi-session dashboard, real terminal output, voice I/O, and push notifications when Claude needs your attention.

```
┌─────────────────┐                      ┌───────────────────────┐
│  Android Phone   │ ◄── WebSocket ────► │  Your Workstation     │
│                  │    (local network)   │                       │
│  Dashboard       │                      │  Node.js Server       │
│  ├─ Session 1 🟢 │                      │  ├─ pty: claude (proj1)│
│  ├─ Session 2 🟡 │                      │  ├─ pty: claude (proj2)│
│  └─ Session 3 ⚪ │                      │  └─ pty: bash          │
│                  │                      │                       │
│  🎙 Voice input  │                      │  REST API + WebSocket  │
│  🔈 TTS output   │                      │  Session management    │
│  📳 Alerts       │                      │  File browsing         │
└─────────────────┘                      └───────────────────────┘
```

## Architecture

**Server** (`server/`) — Node.js + Express + WebSocket + node-pty
- Manages multiple independent terminal sessions
- Each session is a real pseudo-terminal (pty) that can run Claude Code, bash, or anything
- Detects when Claude asks questions and pushes attention alerts
- Tracks session status: `idle` → `working` → `waiting` → `done`
- REST API for session CRUD + file browsing
- WebSocket for real-time terminal I/O streaming

**Client** (`client/www/`) — Vanilla HTML/CSS/JS, no framework
- Capacitor-wrapped native Android app
- Dashboard with session cards showing live status
- Full terminal view with xterm.js (raw mode) and a cleaned-up readable view (toggle)
- Directory browser for picking project folders
- STT (Speech-to-Text) via Web Speech API
- TTS (Text-to-Speech) with smart filtering to only read Claude's output
- Push notifications via Capacitor Local Notifications

## Quick Start

```bash
# Clone and setup
chmod +x setup.sh
./setup.sh

# Start the server
cd server
npm start
```

The server prints your connection URL with auth token. Then either:

**Option A — Browser (fastest to test)**
Open the URL on your phone's browser. Works immediately.

**Option B — Native Android App**
```bash
cd client

# Edit capacitor.config.ts:
# Uncomment the server.url line and set it to your server's LAN IP
# e.g., url: 'http://192.168.1.42:3033'

npx cap sync android
npx cap open android     # Opens in Android Studio → Build & Run
```

**Option C — Direct device deploy**
```bash
cd client
npx cap run android      # Deploys to connected USB device
```

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

Server environment variables (or `.env` file in `server/`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3033` | Server port |
| `AUTH_TOKEN` | random | Fixed auth token |
| `SHELL` | `$SHELL` or `/bin/bash` | Default shell for new sessions |

## Development Mode

For development, you can point the Capacitor app directly at your running server instead of bundling the web assets. In `capacitor.config.ts`, uncomment:

```typescript
server: {
  url: 'http://YOUR_LAN_IP:3033?token=YOUR_TOKEN',
  cleartext: true,
},
```

This gives you live reload — edit `client/www/` files, refresh the app.

## Remote Access (Outside Local Network)

**Tailscale** (recommended):
Install on both devices, then use the Tailscale IP instead of your LAN IP.

**Cloudflare Tunnel**:
```bash
cloudflared tunnel --url http://localhost:3033
```

**SSH Tunnel** (from Termux on Android):
```bash
ssh -L 3033:localhost:3033 user@your-machine
```

## Project Structure

```
claude-remote/
├── server/
│   ├── server.js          # Express + WS + REST API + update endpoints
│   ├── sessions.js        # Multi-session pty manager
│   ├── updater.js         # Git-based update checker + applier
│   ├── settings.js        # Versioned settings with migration support
│   └── package.json
├── client/
│   ├── www/               # Web assets (served by Capacitor + server)
│   │   ├── index.html     # SPA shell + templates
│   │   ├── css/style.css  # Industrial terminal aesthetic
│   │   └── js/app.js      # Client logic (routing, views, TTS, STT, updates)
│   ├── capacitor.config.ts
│   ├── package.json
│   └── android/           # Generated by `npx cap add android`
├── data/                  # User data (git-ignored, survives updates)
│   └── .gitignore
├── version.json           # Version + settings schema version + changelog
├── run.sh                 # Process wrapper (auto-restart on update)
├── setup.sh               # One-time setup script
├── .gitignore
└── README.md
```

## Deployment Pipeline

The app is designed to be developed from itself. The update system is git-based — your repo is the deployment target.

### How Updates Work

```
You (on phone)                    Your Computer
     │                                 │
     │  "claude, fix the TTS bug"      │
     │  ──────────────────────────►    │
     │                                 │  Claude Code edits files
     │                                 │  git commit + git push
     │                                 │
     │                     server checks remote periodically
     │                                 │
     │  ◄── update:available ────────  │
     │  "Update available v0.2.0"      │
     │                                 │
     │  tap "Update & Restart"         │
     │  ──────────────────────────►    │
     │                                 │  git pull
     │                                 │  npm install (if needed)
     │                                 │  server restarts
     │                                 │
     │  ◄── reconnect ───────────────  │
     │  client reloads new assets      │
     │  done.                          │
```

### Server Updates

**From the CLI** (on your computer):
```bash
./run.sh update     # Interactive: shows changes, asks to confirm
```

**From the app** (on your phone):
Settings → Check for updates → Update & Restart

**Auto-update** (headless):
```bash
AUTO_UPDATE=true ./run.sh start
```
Or set `autoUpdate: true` in `data/server-settings.json`. The server checks every 5 minutes, pushes an `update:available` message to all clients, but waits for you to confirm.

### Client Updates

Since the Capacitor app loads its UI from the server URL (not bundled assets), updating the server **automatically updates the client**. When you tap "Update & Restart":

1. Server pulls new code from git
2. Server restarts with new `client/www/` files
3. Your phone's WebSocket reconnects
4. Page reloads → you're on the new version

The native Android shell itself (Capacitor wrapper) rarely needs rebuilding — only if you add new native plugins or change `capacitor.config.ts`.

### Self-Development Workflow

This is the intended workflow for building the app from itself:

1. Open the app on your phone
2. Create a session pointed at the `claude-remote/` repo directory
3. Launch Claude Code in that session
4. Tell Claude what to build/fix/improve
5. Claude edits the source files, commits, pushes
6. Your phone shows "Update available"
7. Tap update → server restarts → you see the changes

You're literally editing the UI you're looking at through the terminal you're using.

### Settings Survive Updates

Settings are stored separately from code:

**Server settings**: `data/server-settings.json` (git-ignored)
**Client settings**: `localStorage` on your phone

Both use versioned schemas. When the settings schema changes, migration functions run automatically on startup. The version is tracked in `version.json`:

```json
{
  "version": "0.2.0",
  "settingsVersion": 2,    ← bump this when schema changes
  ...
}
```

Add migration functions in `server/settings.js` (server-side) or the `migrations` object in `app.js` (client-side).

### Version Management

Version bumps happen in `version.json`. The changelog there is served to clients so the update banner can show what changed. Convention:

```bash
# After making changes:
# 1. Edit version.json (bump version, add changelog entry)
# 2. Commit everything
# 3. Push
# 4. Clients see the update
```

### Rebuilding the APK

If you do need to rebuild the native Android app (rare):

```bash
cd client
npx cap sync android       # Copy www/ into android project
npx cap open android        # Open in Android Studio → Build
# or
npx cap run android         # Build + deploy to connected device
```

### Using run.sh

Always start the server via `run.sh` — it wraps the Node process and handles restarts:

```bash
./run.sh start      # Start server (auto-restarts on crash or update)
./run.sh update     # Interactive update from git
./run.sh version    # Print current version
```

When the server receives an update request via the API, it exits with code 75. `run.sh` catches this and restarts it automatically.

## Troubleshooting

**node-pty won't install**: You need native build tools.
```bash
# macOS
xcode-select --install
# Ubuntu
sudo apt install build-essential python3
```

**Can't connect from phone**: Both devices must be on the same WiFi. Check firewall allows port 3033.

**xterm.js not loading**: The app loads xterm.js from cdnjs.cloudflare.com. If offline, download the files to `client/www/lib/` and update the script tags in index.html.

**STT not working**: Android Chrome requires HTTPS for mic access in some versions. Either use Capacitor (native app has mic permission), or set up an SSL tunnel.

**Capacitor build fails**: Make sure you have Android Studio installed with SDK 33+, and that `ANDROID_HOME` is set.
