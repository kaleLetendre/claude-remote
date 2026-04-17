# Claude Remote — Features

## PC Side (Desktop / Server)

- **Persistent auth token** — generated once, saved to `~/.claude-remote/server-settings.json` (overridable via `CLAUDE_REMOTE_DATA`), survives restarts and repo reinstalls
- **Multi-instance data isolation** — `CLAUDE_REMOTE_DATA` env var picks the data dir so prod (3033) and dev (3034) instances keep separate tokens, sessions, and Whisper state
- **Password authentication** — set a password from the admin panel; phone connects with password instead of token
- **Admin panel** — web UI at `localhost:3033/admin` for managing server, password, viewing clients and sessions
- **System tray icon** — Electron app with green/red status indicator, right-click menu (Open Admin, Copy Token, Copy Phone URL, Restart, Quit)
- **Auto-start on login** — `./run.sh install` adds to desktop autostart; tray icon appears on boot
- **Multi-session terminal management** — spawn and manage multiple pty sessions from the server
- **Question detection** — Claude Code hooks (primary) and regex fallback detect when Claude asks a question; pushes alerts to connected phones
- **Session status tracking** — idle / working / waiting / done states via Claude Code hooks with regex fallback for non-Claude sessions
- **Git-based auto-updater** — checks remote for new commits, can pull + restart from the admin panel or phone
- **Tailscale auto-detection** — server finds its Tailscale IP on startup and prints a ready-to-use URL
- **CORS support** — allows Capacitor WebView and cross-origin requests from the phone app
- **Crash recovery** — `run.sh` restart loop catches crashes and restarts the server automatically
- **CLI tool** — `./cli.js <command>` for headless server management; covers everything the admin panel does (setup, start, status, token, url, clients, sessions, set-password, remove-password, restart, check-update, apply-update, build-apk, setup-hooks)
- **APK hosting** — server hosts the latest APK at `/api/app/download`; phones can download updates over Tailscale/WAN
- **Session persistence** — sessions survive server restarts (metadata in `{data-dir}/sessions.json`, shown as "dead" on next boot, revivable via the phone)
- **Server-side Whisper STT (optional)** — run `faster-whisper` on the host for higher-accuracy transcription than Android SpeechRecognition. Managed install from the admin panel: bootstrap a venv, download models (tiny.en through large-v3-turbo), enable with `auto`/`cpu`/`cuda` device selection. The phone records audio in parallel with Android STT and swaps in the Whisper transcript if it arrives in time; Android STT remains the fallback. Venv and models live under `{data-dir}/whisper-venv/` and `{data-dir}/whisper-models/`.
- **Server-side Kokoro TTS (optional)** — run `kokoro-onnx` on the host for a natural neural voice instead of Android's robotic system TTS. Managed install from the admin panel: bootstrap a venv, download the ONNX model + voice bundle (~340 MB) in one click, pick a voice (af_bella, am_adam, bf_emma, etc.), set speed (0.5–2.0×), and hit Preview to audition before enabling. When enabled the server synthesizes WAV audio and broadcasts `speak-audio` WS messages; the phone plays them via `<audio>`. Android system TTS is the automatic fallback on synth failure or when TTS is disabled. Venv and assets live under `{data-dir}/tts-venv/` and `{data-dir}/tts-model/`.
- **Claude session resume** — the Claude Code conversation ID is captured from hooks and persisted on change, so Revive can run `claude --resume <id>` and pick up the prior conversation
- **Voice side-channel** — `scripts/speak` and `scripts/cmd` shell scripts (auto-on-PATH for every pty) POST to localhost-only server endpoints; TTS and slash-command injection without touching terminal output. See VOICE-PLAN.md for architecture.
- **PreToolUse auto-accept hook** — `scripts/claude-preauth-hook.sh` skips permission prompts entirely when the session has auto-accept on (server returns `{permissionDecision: "allow"}` via `/api/hooks/preauth`)
- **Version sync at build time** — `client/android/app/build.gradle` runs a `syncAppVersion` task on every `preBuild` that reads `version.json` and rewrites the `app-version` meta tag in both the source `bootstrap/index.html` and the copied assets HTML. Android `versionName` is also sourced from `version.json`. This makes APK/server version mismatch impossible regardless of how the build is invoked.

## Mobile Side (Android App)

- **Dashboard** — see all terminal sessions at a glance with name, status, and last activity
- **Live terminal view** — xterm.js rendering of real terminal output streamed over WebSocket
- **Clean view** — stripped ANSI output grouped into readable blocks (toggle between raw and clean)
- **Password login** — enter server URL + password to connect; token saved locally for future sessions
- **Token fallback** — advanced option to connect with raw auth token if needed
- **Create/manage sessions** — new session dialog with name, working directory, and directory browser
- **Revive dead sessions** — after a server restart, sessions appear as "dead" with a Revive button; tap to spawn a fresh pty and auto-resume Claude (`claude --resume <claudeSessionId>`). The Claude session ID is cached client-side so revive still works if the server lost it.
- **Attention alerts** — banner, vibration, and notification when Claude asks a question
- **Auto-accept toggle** — per-session, instant approval of permission prompts via PreToolUse hook (no prompt ever drawn); Notification-hook Enter-injection as fallback
- **Voice mode** — dedicated overlay with push-to-talk, hides keyboard, shows transcript + simple waveform
- **Push-to-talk STT** — Android system SpeechRecognition by default; when server-side Whisper is enabled the phone captures audio in parallel via MediaRecorder and the Whisper transcript replaces the Android one if it lands in time
- **Native Android TTS** — Claude runs a `speak` shell script from inside the pty, server broadcasts a `speak` WS message, phone plays via native Android TTS (routes through media audio stream, follows headphones/Bluetooth)
- **Hands-free slash commands** — "system command X" voice prefix rewrites to `/X` and sends raw, bypassing the voice-mode wrapper; dynamic passthrough works for any slash command (including custom skills). Stop/cancel map to Ctrl+C. Known-interactive commands (help, model with no args, agents, etc.) are intercepted and spoken guidance is played.
- **Voice output interpretation** — after firing an informational slash command (`/cost`, `/status`, etc.) the client auto-sends a follow-up prompt asking Claude to summarize the output via `speak`, so the user hears a natural-language summary instead of having to read
- **Settings** — voice mode toggle, speech rate, alert preferences
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

## Safety / Multi-Instance

The recommended setup runs two instances side by side:

- **Prod** (port 3033, `main` branch) — stable version, always running
- **Dev** (port 3034, `dev` branch) — active development

If a bad dev change breaks the app, prod keeps you connected remotely. The `./cli.js build-apk --dev` command builds a separate APK (`com.clauderemote.dev` / "CR Dev") that installs alongside the prod app.

Each instance also uses its own data directory via `CLAUDE_REMOTE_DATA` (e.g., `~/.claude-remote/` for dev, `~/.claude-remote-prod/` for prod) so tokens, sessions, passwords, and Whisper state never collide.
