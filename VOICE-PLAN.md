# Voice Mode — Implementation Plan

100% hands-free voice interaction with Claude Code sessions. The user enters "voice mode" from any session — the keyboard collapses, a talk button appears, and TTS reads back Claude's responses. Claude Code still has full tool access (edit files, run commands, read code). The voice layer is purely an I/O adapter.

---

## Design Principles

- **Voice mode is a view toggle, not a new session.** Same terminal, same pty, same WebSocket. Just a different UI on top.
- **Claude Code stays fully capable.** It still edits files, runs bash, reads code. Voice mode doesn't limit what it can do — it only changes how the user gives input and receives output.
- **Input wrapping.** User speech is transcribed and wrapped with a short prefix that tells Claude to respond conversationally after completing its work. This doesn't restrict tool use — it just ensures Claude summarizes what it did in speakable prose. The prefix also asks Claude to wrap its spoken response in `~VOICE~` markers so the output parser can reliably extract it.
- **Marker-based output extraction.** Instead of heuristically parsing terminal output (fragile), the input prefix asks Claude to put its voice-friendly response between `~VOICE~` markers. The parser just scans for content between markers — simple, reliable, survives Claude Code UI changes.
- **No external dependencies.** Web Speech API for TTS. The phone's built-in keyboard STT is better than anything we'd build, but voice mode uses the SpeechRecognition API directly since the keyboard is hidden.
- **Progressive.** Each layer is independently useful. Partially implemented voice mode is still better than no voice mode.

---

## Future: Structured Mode (not yet viable)

Claude Code offers a non-interactive mode (`claude -p --output-format stream-json`) that outputs clean JSON events instead of terminal output. Each text token, tool call, and tool result arrives as a separate JSON object. This would eliminate all output parsing — we'd get Claude's prose as `text_delta` events, tool use as structured `tool_use` blocks, and session management via `--resume $session_id`.

**Why we can't use it yet:** `-p` mode requires an Anthropic API key and bills per-token. It doesn't work with Claude Max/Pro subscriptions, which only cover interactive (terminal) mode. If Anthropic adds subscription support for `-p` mode, or the user has an API key, this becomes the better architecture for everything — not just voice mode.

**What it would change:** Sessions would no longer be ptys. The server would spawn `claude -p` subprocesses, parse JSON streams, and push structured events over WebSocket. The client would render text, tool status cards, and diffs from structured data instead of a raw terminal. Voice mode would get `text_delta` events directly — no markers needed.

**For now:** We use pty sessions + `~VOICE~` markers for voice, and Claude Code hooks for notifications/status (see HOOKS-PLAN.md). Both work with interactive mode and Max subscriptions.

---

## Layer 0 — Clean Slate

Remove all existing voice code. It was a rough first pass that doesn't fit the new design.

**Remove from app.js:**
- `accumulateForTTS()` function and its call in `handleWSMessage`
- `speak()` function
- `initSTT()` function and its call in `initSessionView`
- `toggleRecording()` function
- Mic button event listener
- Voice toggle button (`#btn-voice`) event listener
- All related state: `ttsEnabled`, `smartTts`, `speechRate`, `selectedVoiceURI`, `sttLang`, `recognition`, `recording`, `ttsAccum`, `ttsTimer`
- Settings UI for all of the above (TTS/STT toggles, voice selection, speech rate, language)

**Remove from index.html:**
- Mic button element
- Voice toggle button element
- Settings template rows for TTS, STT, voice, speech rate, language

**Remove from style.css:**
- Mic button styles, recording indicator styles, voice-related CSS

**Keep:**
- Attention system (vibration, push notifications, chime) — that's separate from voice mode
- Quick action buttons (Yes/No/Enter/Ctrl-C) — still useful in normal mode

**Test:** Everything works exactly as before minus mic and TTS. No regressions.

---

## Layer 1 — Voice Mode UI Shell

The visual container. No actual voice functionality yet — just the mode toggle and layout.

**Changes:**

Add a "voice mode" toggle button in the session view top bar (next to raw/clean toggle). When activated:
- Keyboard and command input area collapse (hidden)
- Quick action buttons collapse (hidden)
- A voice mode overlay appears over the bottom portion of the screen:
  - Central **talk button** (large, round, prominent)
  - Animated indicator showing voice mode is active (pulsing ring, waveform gif, or CSS animation — something that makes it obvious the mode is on)
  - A small text area showing the last transcript (what the user said) and last response (what Claude said) — useful for glancing at while walking
  - An exit button to return to normal mode
- Terminal view stays visible above the overlay (scrolled to bottom, still live-updating)
- Raw/clean toggle still works in voice mode

**State:**
- `voiceMode: false` — added to app state
- Persisted to localStorage so it remembers across navigations

**Test:** Toggle voice mode on and off. Terminal stays visible. Keyboard appears/disappears. The overlay renders. Nothing breaks in normal mode. Switching sessions while in voice mode keeps the mode active.

---

## Layer 2 — Talk Button + STT

Wire up the talk button to SpeechRecognition.

**Changes:**

- Press and hold the talk button → start recording (SpeechRecognition)
- Release → stop recording, finalize transcript
- Transcript appears in the voice mode text area
- Transcript is sent to the terminal as input (raw, no wrapping yet — that's Layer 3)
- Visual feedback:
  - While recording: talk button changes color/animation, maybe a pulse or glow
  - While processing: brief spinner or "..." indicator
  - On send: transcript text flashes or fades to confirm it was sent
- Also support **tap to start, tap to stop** (alternative to press-and-hold, useful for longer speech)
- Silence detection: if the user pauses for 3+ seconds, auto-stop and send (configurable later)
- Handle errors gracefully: `no-speech` → reset silently, network error → show toast

**No TTS yet** — just getting input working first.

**Test:** Enter voice mode. Hold talk button, speak a command to Claude, release. Does the transcript appear? Is it sent to the terminal? Does Claude receive it and respond (visible in the terminal above)?

---

## Layer 3 — Input Wrapping

When voice mode is active, wrap the user's transcript before sending it to the terminal so Claude responds in voice-friendly prose.

**Changes:**

- When voice mode is on, instead of sending raw transcript, prepend a brief instruction:
  ```
  [Voice mode. Do your work normally — edit files, run commands, read code, whatever is needed.
  When you're done, wrap your spoken response in ~VOICE~ markers like this:
  ~VOICE~
  Your conversational summary here. Keep it concise — this will be read aloud.
  ~VOICE~
  The markers MUST appear on their own lines. Everything between them is sent to text-to-speech.
  Everything outside them (tool output, diffs, etc) is shown in the terminal but not spoken.]
  
  {user's transcript}
  ```
- The prefix is only prepended on the **first message** after entering voice mode, or after Claude returns to idle. Don't repeat it every message — Claude Code maintains context within a conversation.
- Actually: test both approaches (every message vs first-only). Claude Code conversations can be long, and context may drift. Start with every message since it's simpler.
- The prefix should NOT appear in subsequent voice messages if Claude is in a follow-up exchange (e.g., Claude asks "which file?" and the user responds "the main one"). Detect this by checking if the session is in `waiting` status — if so, send raw transcript without prefix.
- **Fallback**: If Claude forgets the markers (it will sometimes), fall back to heuristic parsing of the last output chunk. But the markers should work 90%+ of the time since Claude is good at following formatting instructions.

**Test:** Enter voice mode. Ask Claude to "read the README and tell me what the project does." Does Claude read the file (tool use visible in terminal) and respond with a conversational summary? Ask it to "add a comment to the top of app.js explaining what it does." Does it edit the file AND explain what it did in prose?

---

## Layer 4 — Output Parsing + TTS

The big one. Parse Claude Code's terminal output to extract speakable content, then read it aloud.

**Changes:**

**Output parser** — scan terminal output for `~VOICE~` markers:

The input prefix (Layer 3) asks Claude to wrap its spoken response in `~VOICE~` markers. The parser:
- Strips ANSI codes from incoming terminal chunks
- Buffers text, looking for `~VOICE~` start marker
- Captures everything between `~VOICE~` and the closing `~VOICE~`
- Sends captured text to TTS
- Ignores everything outside the markers (tool output, diffs, prompts)

This is far more reliable than heuristic line-by-line filtering. Claude is asked to produce the markers, and we just extract them. If Claude Code's UI framing changes, the markers still work because they're in Claude's response text, not the UI chrome.

**Fallback** (when markers are missing): If no `~VOICE~` markers appear after Claude returns to idle, fall back to basic heuristic — take the last block of non-code, non-tool text and speak it. This covers cases where Claude forgets the markers or the user is in a quick Y/N exchange.

**TTS:**
- Use `speechSynthesis.speak()` with the parsed prose
- Break long text into sentence-sized utterances (split on `.`, `!`, `?`) for natural pacing
- Queue utterances rather than canceling — Claude might produce multiple paragraphs
- While TTS is speaking, show the text in the voice mode overlay (so user can read along)
- When TTS finishes all queued utterances, play a subtle tone indicating it's the user's turn
- If user presses talk button while TTS is speaking, cancel TTS immediately (interrupt-to-speak)

**Voice settings** (in the voice mode overlay, not main settings):
- Voice selection (dropdown of available voices)
- Speech rate slider
- These persist to localStorage

**Test:** Enter voice mode. Ask Claude to edit a file. Watch the terminal — you should see normal Claude Code output. Listen — you should hear only the summary/explanation, not the diff or file contents. Ask Claude "what does the main function in server.js do?" — it should read the file and explain it aloud.

---

## Layer 5 — Physical Button Mapping

Map a hardware button to the talk function so the user doesn't need to look at the screen.

**Changes:**

- **Volume button**: Capture volume-down key event in voice mode → trigger talk button. Requires Capacitor plugin or Android-level event handling. Volume-up could cancel/stop.
- **Headphone button**: Media button events via `navigator.mediaSession` or Capacitor plugin. Single press = toggle recording.
- **Bluetooth headset**: Same media button API. Test with common Bluetooth earbuds.
- Add a setting to choose which button maps to talk (or disable hardware mapping).
- When using hardware button, provide haptic feedback (vibration) on press/release so the user knows it registered.

**Test:** Plug in wired headphones. Press the inline button — does recording start? Press again — does it stop and send? Try with Bluetooth earbuds. Try with volume button while phone is in pocket.

---

## Layer 6 — Hands-Free (No Button)

Experimental: fully buttonless voice mode using silence detection and wake-word-like behavior.

**Changes:**

- **Continuous listening mode** toggle within voice mode
- Mic stays active, STT runs continuously
- When user speaks → buffer transcript
- When silence detected (2-3 seconds) → send transcript
- When TTS is speaking → pause STT (so it doesn't hear itself), resume after
- Post-TTS beep/tone → "your turn to speak"
- Challenge: ambient noise, false triggers. May need a confidence threshold.
- Challenge: distinguishing "user is talking to Claude" from "user is talking to someone else." Could use a trigger phrase ("hey Claude") but that adds friction. Start without one, see how it goes.

**Test:** Turn on continuous listening. Set phone on desk. Have a 5-minute design conversation with Claude. Can you go back and forth without touching the phone at all?

---

## Open Questions

1. **Marker reliability.** How often will Claude forget or malform the `~VOICE~` markers? Needs real-world testing. If it's unreliable, we may need to reinforce the instruction or try a different marker format.

2. **Long operations.** If Claude is editing 10 files, the user hears nothing for 30+ seconds. Should we provide interim status? ("Still working... edited 3 files so far.") Claude Code hooks (see HOOKS-PLAN.md) could push `PostToolUse` events to the client, which voice mode could speak as brief status updates.

3. **Error handling.** If Claude hits an error, will it put the error message inside `~VOICE~` markers? The prefix should instruct it to do so. Test with permission denials, file-not-found, etc.

4. **Session switching.** Voice commands for "switch to [session name]" and "list sessions" would be natural but that's navigation logic on top of the voice I/O layer. Defer to after the core works.

5. **Prompt prefix tuning.** The voice mode prefix in Layer 3 will need iteration. Too long and it wastes context. Too short and Claude forgets to summarize or omits markers. Test and adjust.

6. **Hooks integration.** Once HOOKS-PLAN.md is implemented, voice mode can use hook-driven events (tool use, idle, waiting) instead of terminal parsing for status awareness. This makes voice mode more resilient to Claude Code updates.

---

## Implementation Order

Start with Layer 0 (rip out old code) → Layer 1 (UI shell) → Layer 2 (talk button) → test heavily → Layer 3 (input wrapping) → Layer 4 (output parsing + TTS) → test heavily → then Layers 5-6 based on how it feels.

Each layer gets committed, pushed, and tested on the phone before moving to the next.
