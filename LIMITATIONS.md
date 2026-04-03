# Known Limitations & Future Additions

## HTTPS / Secure Context (Blocks TTS and Real Waveform)

The server runs HTTP only. Android WebView restricts both `speechSynthesis` (text-to-speech) and `navigator.mediaDevices.getUserMedia` (mic audio) to secure contexts (HTTPS). This means:
- **TTS does not work** — Layer 4 voice output parsing and `~SPEAK~` markers are implemented but speechSynthesis is non-functional on HTTP
- **Waveform is approximate** — uses speech recognition events (~200ms delay) instead of real audio levels
- Voice STT (speech-to-text input) works because SpeechRecognition is handled by the Android system, not the WebView

**Fix:** Enable HTTPS using Tailscale's built-in cert provisioning. Run:

```
sudo tailscale cert \
  --cert-file ~/claude-remote/data/certs/cert.pem \
  --key-file ~/claude-remote/data/certs/key.pem \
  YOUR-HOSTNAME.tailXXXXXX.ts.net
```

Then the server needs to be updated to use `https.createServer` when cert files exist in `data/certs/`. The phone would connect via `https://YOUR-HOSTNAME.tailXXXXXX.ts.net:3033` and WebSocket upgrades to `wss://`. This unlocks `getUserMedia` for instant audio-reactive waveforms.

Your Tailscale hostname: `kale-letendre-x570-aorus-elite-wifi.tailf19ac6.ts.net`

## Voice Mode Waveform

Currently uses speech recognition events (`onspeechstart`, `onresult`) to animate bars. Has ~200ms latency. With HTTPS/secure context, can switch to `getUserMedia` + `AnalyserNode` for frame-accurate audio visualization.

## Structured Output Mode

Claude Code offers `claude -p --output-format stream-json` which outputs clean JSON events instead of terminal text. Would eliminate all output parsing for voice mode. Currently requires an API key (doesn't work with Claude Max/Pro subscriptions). See VOICE-PLAN.md for details.

## No Tests

No test suite exists yet.

## No Session Persistence

If the server restarts, all pty sessions are lost. The client caches session metadata locally and shows them as "offline" (tap to relaunch), but terminal history is gone.

## Copy from Claude Remote

Text copied from Claude Remote's terminal output inserts tabs and newlines, making it unusable for pasting commands. Needs investigation — likely an xterm.js copy behavior issue in the WebView.
