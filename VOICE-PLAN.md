# Voice Architecture

How Claude Remote's voice mode actually works. The original implementation plan has been executed; this file describes the current system.

---

## Goal

100% hands-free voice interaction with Claude Code — walking, driving, or away from the computer. The user pushes one button, speaks, releases. Claude responds, and the response is spoken back through native Android TTS. Slash commands are invokable by voice for server-ops use cases (restart Apache, flush cache, etc.).

---

## Architecture at a glance

```
┌───────────────────────────────┐
│  Phone (Capacitor WebView)    │
│                               │
│  • Push-to-talk → STT         │
│  • Voice-mode overlay         │
│  • Native Android TTS bridge  │
└──────────────┬────────────────┘
               │  WebSocket (input/output/speak)
               ▼
┌───────────────────────────────┐
│  Node.js server               │
│                               │
│  • /api/voice/speak  (TTS)    │
│  • /api/cmd/queue    (slash)  │
│  • WS broadcasts `speak`      │
└──────────────┬────────────────┘
               │  pty I/O + env vars
               ▼
┌───────────────────────────────┐
│  Claude Code (in pty)         │
│                               │
│  • runs `speak "..."` scripts │
│  • runs `cmd clear` scripts   │
│  • PATH has scripts/ dir      │
└───────────────────────────────┘
```

---

## Input: push-to-talk → STT

Client-side (`client/www/js/app.js`):
- Press and hold the talk button in the voice overlay → `startVoiceRecording()` starts Web Speech API STT (Android SpeechRecognition under the hood).
- When server-side Whisper is enabled (`refreshWhisperStatus()` returned `whisperEnabled: true`), `startVoiceRecording` also opens a `MediaRecorder` on the same mic stream to capture raw audio in parallel.
- Release → `stopVoiceRecording()` finalizes the Android transcript. If a Whisper audio blob was captured, it's POSTed to `/api/voice/transcribe` (timeout 2500 ms). If Whisper returns non-empty text in time, that text replaces the Android transcript; otherwise the Android transcript is used.
- Final transcript is sent to the pty over WebSocket, optionally wrapped with a voice-mode instruction prefix (see below).

Why both paths: Android SpeechRecognition is fast and free but sometimes mangles technical jargon (flag names, CLI tools, command options). Whisper is more accurate but adds latency and requires host compute. The parallel capture + "prefer Whisper if it's ready in time" pattern gives the accuracy win when the host keeps up and falls back gracefully when it doesn't.

### Server-side Whisper (optional)

The server-side STT stack is **off by default** and managed from the admin panel (`Whisper (Server STT)` card):

1. **Bootstrap** — `POST /api/admin/whisper/bootstrap` creates a venv at `{data-dir}/whisper-venv/` and installs `faster-whisper`. Progress streams over WS as `whisper:bootstrap-progress` lines.
2. **Install a model** — `POST /api/admin/whisper/install` downloads a model (tiny.en, base.en, small.en, medium.en, large-v3, large-v3-turbo) into `{data-dir}/whisper-models/`. Progress streams as `whisper:install-progress`.
3. **Configure + enable** — `POST /api/admin/whisper/config` with `{enabled, model, device}` persists to `server-settings.json` and boots a long-lived helper subprocess (`server/whisper/transcribe.py`) via `WhisperHelper.start()`. Device options: `auto` (cuda if `nvidia-smi` works, else cpu), `cpu`, `cuda`.
4. **Transcribe** — `POST /api/voice/transcribe` accepts the audio blob, routes it to the helper over stdin/stdout JSON, returns `{text}`.

The helper process lives for the life of the server — the model is loaded once and held in memory, so per-request latency is just the actual inference cost.

### Voice-mode wrapping

When `voiceMode` is on and the session is not answering a prompt, the transcript is prefixed with:

```
[Voice mode. Do your work normally — edit files, run commands, etc. After
completing your work, run the shell command: speak "your concise spoken
summary here". That text will be read aloud via TTS on the phone. Do not
duplicate the summary in your text output.]

{transcript}
```

This tells Claude to run the `speak` shell script at end of turn. That's the mechanism that produces TTS output (see below).

---

## Output: `speak` shell script → WS → TTS

Instead of parsing Claude's terminal output for speech content (which was fragile — ANSI cleanup, markers, streaming races), we use a **side channel**:

1. Claude runs `speak "summary text"` at end of turn.
2. `scripts/speak` (on pty PATH via `sessions.js:_makePtyEnv`) POSTs to `POST /api/voice/speak` on localhost with `{sessionId, text}`.
3. The server picks a synthesis path (see below) and broadcasts a dedicated WS message.
4. Client's `handleWSMessage` receives the message and plays the audio.

### Default path (Android system TTS)

When server-side Kokoro is disabled (the default):

- Server emits `session:speak` and broadcasts `{type: "speak", sessionId, text}`.
- Client calls `speakVoice(text)`, which forwards text to the bootstrap/Android bridge via `postMessage({type: "speak", text})`.
- Native Android TTS plays it through the media audio stream (follows headphones / car Bluetooth).

Fast, always-available, works offline. Voice quality is the Android default — robotic but functional.

### Optional path (Kokoro on the server)

When the operator has enabled Kokoro from the admin panel:

- Server calls `ttsMgr.tts.synthesize(text)`, getting back a WAV blob (base64).
- Server emits `session:speakAudio` and broadcasts `{type: "speak-audio", sessionId, audio_b64, format: "wav"}`.
- Client's `playSpeakAudio` decodes the blob, wraps it in a URL, and plays it via `new Audio()`. The WebView's `<audio>` element routes through the Android media stream, so Bluetooth / headphones behave identically to native TTS.
- On synthesis failure the server falls back to the Android-TTS path automatically — no client-side coordination needed.

Kokoro-82M produces natural, human-sounding voices at real-time speed on CPU (sub-second for typical summaries). See **Server-side Kokoro TTS** below.

### Benefits of the side-channel design (both paths)

- Text/audio never touches the terminal stream — nothing to parse, no false positives.
- Works reliably regardless of Claude Code UI framing changes.
- Shell-quoted strings in `speak "..."` survive exactly as intended.
- Localhost-only endpoint + env-var-based auth (`CLAUDE_REMOTE_SESSION_ID` must be set) means only code running inside a Claude Remote pty can trigger TTS.

---

## Server-side Kokoro TTS

Managed analogously to Whisper. Off by default.

1. **Bootstrap** — `POST /api/admin/tts/bootstrap` creates a venv at `{data-dir}/tts-venv/`, installs `kokoro-onnx`, and downloads `kokoro-v1.0.onnx` + `voices-v1.0.bin` (~340 MB total) into `{data-dir}/tts-model/`. Progress streams over WS as `tts:bootstrap-progress` lines. Unlike Whisper, there is no per-voice install — the voices bundle contains every Kokoro voice at once.
2. **Configure + enable** — `POST /api/admin/tts/config` with `{enabled, voice, device, speed}` persists to `server-settings.json` and boots a long-lived helper (`server/tts/synthesize.py`) via `TtsHelper.start()`. Voice comes from `KNOWN_VOICES` in `tts-manager.js` (af_bella, am_adam, bf_emma, …). Device `auto` resolves to cuda when `nvidia-smi` works, else cpu. Speed is clamped to [0.5, 2.0].
3. **Preview** — `POST /api/admin/tts/preview` synthesizes a short sample so the operator can hear the voice without leaving the admin page.
4. **Synthesize** — `POST /api/voice/speak` (from `scripts/speak` inside the pty) routes through the helper when TTS is enabled; otherwise falls through to the Android-TTS text broadcast.

The helper process lives for the life of the server — the ONNX model is loaded once, so per-request latency is just inference cost.

---

## Hands-free slash commands: "system command X"

For server-ops use cases (emergency maintenance, cache flushes, service restarts), the user needs to fire slash commands without looking at the phone.

`tryParseVoiceCommand` in app.js detects the prefix **"system command"** at the start of a transcript and rewrites:

| Utterance | Behavior |
|---|---|
| "system command clear" | sends `/clear` raw to pty (no wrapper) |
| "system command compact" | sends `/compact` raw |
| "system command cost" | sends `/cost`, then auto-fires a follow-up voice prompt so Claude summarizes the output via `speak` |
| "system command status" | same pattern — fires `/status`, Claude summarizes aloud |
| "system command model opus" | sends `/model opus` raw |
| "system command stop" | sends `\x03` (Ctrl+C) to cancel generation — not a slash command |
| "system command restart-apache" | sends `/restart-apache` raw — works for any custom skill |

The mapping is **dynamic** — whatever follows "system command" becomes `/<rest>`. Exceptions:

- **Ctrl+C aliases** (`stop`, `cancel`, `abort`, `escape`): send the raw byte instead.
- **Known interactive commands** (`help`, `agents`, `config`, `resume`, `permissions`, `mcp`, `hooks`, `output-style`, `ide`, `vim`, `login`, `logout`, and `model` with no args): intercepted. Instead of firing the command and getting stuck in a modal, the client speaks guidance (e.g., "Specify the model: system command model opus, sonnet, or haiku").
- **Context-wiping commands** (`clear`, `compact`, `exit`, `quit`, `init`): skip the follow-up summary prompt to avoid wasting a turn on confirmation.

### Output interpretation

When a slash command prints informational output (`/cost`, `/status`, etc.), the client automatically fires a follow-up voice-mode prompt after 700ms:

> `[Voice mode. The slash command output is visible above in this turn as local-command-stdout. Summarize the result in one short natural sentence and call the shell command: speak "your one-sentence summary". Do not print any other text or duplicate the summary.]`

This triggers a Claude turn. Claude Code bundles the slash command's stdout into that turn automatically, so Claude sees the output and summarizes it via `speak`. The user hears a natural-language summary instead of having to read.

---

## Claude firing slash commands (`cmd` script)

For end-of-turn cleanup (e.g., `/compact` after a long conversation), Claude needs to trigger slash commands itself. But slash commands only execute when the TUI prompt is active — during Claude's response, stdin is being consumed.

Solution: `scripts/cmd` + a server-side queue + the Stop hook.

1. Claude runs `cmd clear` (or `cmd model opus`, `cmd compact`, etc.) at end of turn.
2. `scripts/cmd` POSTs to `POST /api/cmd/queue` → server stores in `session._queuedCommands`.
3. When the Stop hook fires (i.e., Claude's turn just ended, prompt is ready), `sessions.handleHookEvent('stop')` calls `_flushQueuedCommands`.
4. After a 300ms delay (so the TUI fully redraws the prompt), the queued `/command\r` bytes are written to the main tab's pty.
5. Claude Code's TUI sees real user input at the prompt → the slash command executes.

---

## Auto-accept (fast path via PreToolUse)

Related voice-enabling feature: the phone has an auto-accept toggle per session. When enabled, Claude never blocks on permission prompts.

Two layers:

1. **PreToolUse hook** (`scripts/claude-preauth-hook.sh`, wired in `~/.claude/settings.json`): fires *before* Claude Code draws a permission prompt. The hook consults `POST /api/hooks/preauth` which returns `{permissionDecision: "allow"}` when the session's `autoAccept` is on. No prompt is ever drawn — instant.
2. **Notification hook fallback** (`scripts/claude-hook-relay.sh`): if a prompt does appear (e.g., older Claude Code versions), the server writes `\r` to the pty to dismiss it. Slower but still functional.

This matters for voice because draw/dismiss round-trips were noticeable on mobile.

---

## Piece-by-piece file map

| Concern | File |
|---|---|
| Voice overlay UI, push-to-talk, STT | `client/www/js/app.js` (search "voice") |
| "system command" prefix detection | `client/www/js/app.js` — `tryParseVoiceCommand` |
| Auto follow-up summarization prompt | `client/www/js/app.js` — inside `stopVoiceRecording` |
| Native TTS bridge | `client/www/js/app.js` — `speakVoice` → `window.parent.postMessage` |
| Bootstrap / Android native bridge | `client/bootstrap/index.html` (NativeBridge) |
| `speak` endpoint | `server/server.js` — `/api/voice/speak` |
| `cmd` queue endpoint | `server/server.js` — `/api/cmd/queue` |
| Queue + flush logic | `server/sessions.js` — `queueCommand`, `_flushQueuedCommands`, Stop hook |
| PreToolUse endpoint | `server/server.js` — `/api/hooks/preauth` |
| Pty env + PATH injection | `server/sessions.js` — `_makePtyEnv` |
| `speak` shell script | `scripts/speak` |
| `cmd` shell script | `scripts/cmd` |
| PreToolUse hook | `scripts/claude-preauth-hook.sh` |
| Legacy Notification hook relay | `scripts/claude-hook-relay.sh` |
| Server-side Whisper lifecycle | `server/whisper-manager.js` |
| Whisper helper subprocess | `server/whisper/transcribe.py` |
| Whisper admin endpoints | `server/server.js` — `/api/admin/whisper/*` |
| Whisper transcribe endpoint | `server/server.js` — `/api/voice/transcribe` |
| Parallel mic capture on phone | `client/www/js/app.js` — `_voiceMediaRecorder`, `transcribeWithWhisper` |
| Whisper admin UI | `client/www/admin.html` — `#whisper-card` |
| Server-side Kokoro TTS lifecycle | `server/tts-manager.js` |
| Kokoro helper subprocess | `server/tts/synthesize.py` |
| Kokoro admin endpoints | `server/server.js` — `/api/admin/tts/*` |
| Kokoro audio broadcast | `server/server.js` — `session:speakAudio` → `speak-audio` WS |
| Audio blob playback on phone | `client/www/js/app.js` — `playSpeakAudio` |
| Kokoro admin UI | `client/www/admin.html` — `#tts-card` |

---

## Known gaps

- **Permission prompts with auto-accept off**: no hands-free path to approve a single prompt. You'd need to tap the approve button or turn on auto-accept globally.
- **Waveform visualization**: uses SpeechRecognition events (`onspeechstart`), ~200ms latency. Real audio-reactive waveform requires `getUserMedia` which needs HTTPS. Low priority — cosmetic.
- **Continuous / wake-word listening**: not implemented. Push-to-talk remains the only activation. Works fine on Bluetooth and wired headsets via the phone's physical button.
- **Structured output mode**: Claude Code's `-p --output-format stream-json` would eliminate terminal-stream complexity entirely, but still requires an API key (no subscription support as of writing). Not blocking anything today.

---

## Adding a new voice command

You almost never need to. The dynamic passthrough handles new Claude Code slash commands automatically (`"system command X"` → `/X`). But if you want to intercept or remap one:

1. Edit `tryParseVoiceCommand` in `client/www/js/app.js`.
2. Add the command name to `interactiveGuides` (intercept with spoken guidance), or to `skipInterpret` (fire but skip summarization), or add a regex pattern above the dynamic fallthrough.
3. Reload the app (no server restart needed — client JS only).

Custom Claude Code skills are the recommended extension pattern for domain operations (`/restart-apache`, `/flush-cache`, etc.). Define them in `~/.claude/skills/` — they're automatically voice-invokable via "system command \<skill-name\>" with no app changes.
