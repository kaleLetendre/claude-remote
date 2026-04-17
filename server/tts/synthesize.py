#!/usr/bin/env python3
"""
Long-lived kokoro-onnx helper. Loads the model + voices once, serves many
requests over a line-delimited JSON protocol on stdin/stdout.

Protocol:
  In  (one JSON object per line):
    {"text": "hello world", "voice": "af_bella", "speed": 1.0}
    (voice and speed are optional; default to env-configured values)
  Out (one JSON object per line):
    {"audio_b64": "<base64 wav>", "format": "wav", "ms": 123}
    {"error": "reason"}
  On startup:
    {"ready": true, "voice": "af_bella", "device": "cpu"}
    {"error": "..."} then exit 1

Env:
  KOKORO_VOICE         required, e.g. "af_bella"
  KOKORO_DEVICE        "cpu" or "cuda"          (default cpu)
  KOKORO_SPEED         float                    (default 1.0)
  KOKORO_MODEL_FILE    path to kokoro-v1.0.onnx (required)
  KOKORO_VOICES_FILE   path to voices-v1.0.bin  (required)
"""

import base64
import io
import json
import os
import sys
import time
import wave


def fail(msg: str, code: int = 1) -> None:
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def float_to_wav_bytes(samples, sample_rate: int) -> bytes:
    """Convert a numpy float32 array in [-1, 1] to 16-bit PCM WAV bytes."""
    import numpy as np
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def main() -> None:
    voice = os.environ.get("KOKORO_VOICE")
    device = os.environ.get("KOKORO_DEVICE", "cpu")
    speed_env = os.environ.get("KOKORO_SPEED", "1.0")
    model_file = os.environ.get("KOKORO_MODEL_FILE")
    voices_file = os.environ.get("KOKORO_VOICES_FILE")

    if not voice:
        fail("KOKORO_VOICE not set")
    if not model_file or not os.path.exists(model_file):
        fail(f"KOKORO_MODEL_FILE missing: {model_file}")
    if not voices_file or not os.path.exists(voices_file):
        fail(f"KOKORO_VOICES_FILE missing: {voices_file}")
    try:
        default_speed = float(speed_env)
    except ValueError:
        default_speed = 1.0

    # Select ONNX execution provider based on requested device.
    if device == "cuda":
        os.environ.setdefault("ONNX_PROVIDER", "CUDAExecutionProvider")

    try:
        from kokoro_onnx import Kokoro
    except ImportError as e:
        fail(f"kokoro_onnx not installed: {e}. Run: pip install kokoro-onnx")

    try:
        kokoro = Kokoro(model_file, voices_file)
    except Exception as e:
        fail(f"kokoro load failed: {e}")

    sys.stdout.write(
        json.dumps({"ready": True, "voice": voice, "device": device}) + "\n"
    )
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            sys.stdout.write(json.dumps({"error": f"bad json: {e}"}) + "\n")
            sys.stdout.flush()
            continue

        text = (req.get("text") or "").strip()
        req_voice = req.get("voice") or voice
        try:
            req_speed = float(req.get("speed", default_speed))
        except (TypeError, ValueError):
            req_speed = default_speed
        if not text:
            sys.stdout.write(json.dumps({"error": "text required"}) + "\n")
            sys.stdout.flush()
            continue

        start = time.time()
        try:
            samples, sample_rate = kokoro.create(
                text, voice=req_voice, speed=req_speed, lang="en-us"
            )
            wav_bytes = float_to_wav_bytes(samples, sample_rate)
        except Exception as e:
            sys.stdout.write(json.dumps({"error": f"synthesize failed: {e}"}) + "\n")
            sys.stdout.flush()
            continue
        ms = int((time.time() - start) * 1000)

        audio_b64 = base64.b64encode(wav_bytes).decode("ascii")
        sys.stdout.write(
            json.dumps({"audio_b64": audio_b64, "format": "wav", "ms": ms}) + "\n"
        )
        sys.stdout.flush()


if __name__ == "__main__":
    main()
