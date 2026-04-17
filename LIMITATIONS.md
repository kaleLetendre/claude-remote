# Known Limitations & Future Additions

## HTTP only (no real audio waveform)

The server runs HTTP. TTS and STT both work regardless — TTS routes through the native Android bridge (see VOICE-PLAN.md), and STT is handled by the Android system's SpeechRecognition. The remaining HTTP cost:

- **Waveform is approximate** — the voice overlay draws bars based on `onspeechstart`/`onresult` events (~200ms delay) instead of real audio levels. Real audio-reactive waveform would need `navigator.mediaDevices.getUserMedia` which requires HTTPS/secure context.

**Fix (if you care about the waveform):** Tailscale can provision certs for a Tailnet hostname. Run:

```
sudo tailscale cert \
  --cert-file ~/.claude-remote/certs/cert.pem \
  --key-file ~/.claude-remote/certs/key.pem \
  YOUR-HOSTNAME.tailXXXXXX.ts.net
```

Then update the server to use `https.createServer` when cert files exist in `{data-dir}/certs/` (default `~/.claude-remote/certs/`). The phone connects via `https://...:3033` and WS upgrades to `wss://`, unlocking `getUserMedia`.

## Permission prompts with auto-accept off

For the "driving + emergency server ops" use case, auto-accept is expected to be on, which means the PreToolUse hook pre-approves everything and no prompt is ever drawn — so this is effectively solved in the default config. The narrow remaining gap: if a user intentionally turns auto-accept off and then hits a prompt, there is no voice path to approve that single prompt. You'd have to tap the approve button or re-enable auto-accept.

## No continuous / wake-word listening

Push-to-talk is the only activation. This is intentional — ambient-noise false triggers are worse than pushing one button. If continuous mode is ever added, it needs a trigger phrase and a confidence threshold, and should pause itself while TTS is speaking (to avoid hearing itself).

## Structured output mode (future, not yet viable)

Claude Code's `claude -p --output-format stream-json` outputs clean JSON events instead of terminal text. Each token, tool call, and tool result arrives as a separate JSON object. This would replace pty-based sessions with subprocess + JSON streams and eliminate all terminal parsing. It still requires an Anthropic API key (no Claude Max/Pro subscription support), so this is parked until Anthropic bridges the gap.

## No test suite

No automated tests exist. Manual verification only. Worth adding — at minimum for the voice command parser, the hook event handlers, and the session/revive flow.

## Session persistence is partial

Session metadata (id, name, cwd, claudeSessionId, tab names) is persisted to `{data-dir}/sessions.json` (default `~/.claude-remote/sessions.json`) via `sessions._saveSessions()` and restored on server restart as "dead" sessions, which the client shows with a **Revive** button. Reviving spawns a fresh pty in the same cwd and auto-runs `claude --resume <claudeSessionId>` to pick up the prior Claude conversation.

What's NOT preserved:
- Terminal scrollback (the per-tab 100 KB output buffer is in-memory only).
- Running processes inside the pty — those die with the pty.
- Interim work in non-Claude sessions (bash pty state, background jobs, etc.).

## Copy from terminal

Text copied from Claude Remote's terminal output inserts tabs and newlines that make it unusable for pasting commands. Likely an xterm.js copy behavior issue in the Capacitor WebView. Needs investigation.
