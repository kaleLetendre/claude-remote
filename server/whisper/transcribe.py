#!/usr/bin/env python3
"""
Long-lived faster-whisper helper. Loads the model once, serves many requests
over a line-delimited JSON protocol on stdin/stdout.

Protocol:
  In  (one JSON object per line):
    {"audio_b64": "<base64 webm/opus/wav/etc>", "language": "en"}
  Out (one JSON object per line):
    {"text": "...", "ms": 123}            -- success
    {"error": "reason"}                   -- per-request failure
  On startup:
    {"ready": true, "model": "small.en", "device": "cuda"}  -- stdout
    {"error": "..."} then exit 1                            -- on load failure

Env:
  WHISPER_MODEL          required, e.g. "small.en"
  WHISPER_DEVICE         "cpu" or "cuda"        (default cpu)
  WHISPER_COMPUTE_TYPE   optional override      (default: int8 on cpu, float16 on cuda)
  WHISPER_MODEL_DIR      download/cache dir     (required)
"""

import base64
import json
import os
import sys
import tempfile
import time


def fail(msg: str, code: int = 1) -> None:
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def main() -> None:
    model_name = os.environ.get("WHISPER_MODEL")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    model_dir = os.environ.get("WHISPER_MODEL_DIR")
    # Default to int8 everywhere — works on CPU and any CUDA GPU without cuDNN/float16
    # support requirements. Can override via WHISPER_COMPUTE_TYPE if the hardware
    # supports float16 or int8_float16 for better throughput.
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE") or "int8"

    if not model_name:
        fail("WHISPER_MODEL not set")
    if not model_dir:
        fail("WHISPER_MODEL_DIR not set")

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        fail(f"faster_whisper not installed: {e}. Run: pip install faster-whisper")

    try:
        model = WhisperModel(
            model_name,
            device=device,
            compute_type=compute_type,
            download_root=model_dir,
        )
    except Exception as e:
        fail(f"model load failed: {e}")

    sys.stdout.write(
        json.dumps(
            {
                "ready": True,
                "model": model_name,
                "device": device,
                "compute_type": compute_type,
            }
        )
        + "\n"
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

        audio_b64 = req.get("audio_b64")
        language = req.get("language") or "en"
        if not audio_b64:
            sys.stdout.write(json.dumps({"error": "audio_b64 required"}) + "\n")
            sys.stdout.flush()
            continue

        try:
            audio_bytes = base64.b64decode(audio_b64)
        except Exception as e:
            sys.stdout.write(json.dumps({"error": f"bad base64: {e}"}) + "\n")
            sys.stdout.flush()
            continue

        # faster-whisper decodes via ffmpeg; easiest is a temp file.
        start = time.time()
        try:
            with tempfile.NamedTemporaryFile(suffix=".bin", delete=True) as tmp:
                tmp.write(audio_bytes)
                tmp.flush()
                segments, _info = model.transcribe(
                    tmp.name,
                    language=language,
                    beam_size=1,            # fastest; v1 doesn't need multi-beam
                    vad_filter=True,         # drop non-speech padding
                    condition_on_previous_text=False,
                )
                text = "".join(s.text for s in segments).strip()
        except Exception as e:
            sys.stdout.write(json.dumps({"error": f"transcribe failed: {e}"}) + "\n")
            sys.stdout.flush()
            continue
        ms = int((time.time() - start) * 1000)

        sys.stdout.write(json.dumps({"text": text, "ms": ms}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
