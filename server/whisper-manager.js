import { spawn, execSync, execFile } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { PACKAGE_ROOT, getDataDir } from '../lib/paths.js';

// ── Layout ───────────────────────────────────────────────────────────
const SCRIPT_PATH = join(PACKAGE_ROOT, 'server', 'whisper', 'transcribe.py');
const VENV_DIR = () => join(getDataDir(), 'whisper-venv');
const MODEL_DIR = () => join(getDataDir(), 'whisper-models');
const VENV_PY = () => join(VENV_DIR(), 'bin', 'python');
const VENV_PIP = () => join(VENV_DIR(), 'bin', 'pip');

export const KNOWN_MODELS = [
  'tiny.en', 'base.en', 'small.en', 'medium.en',
  'large-v3', 'large-v3-turbo',
];

// ── Host capability detection ────────────────────────────────────────
let _cachedCuda = null;
export function isCudaAvailable() {
  if (_cachedCuda !== null) return _cachedCuda;
  try {
    execSync('nvidia-smi', { stdio: 'pipe', timeout: 2000 });
    _cachedCuda = true;
  } catch {
    _cachedCuda = false;
  }
  return _cachedCuda;
}

let _cachedPython = null;
export function findPython3() {
  if (_cachedPython !== null) return _cachedPython;
  for (const bin of ['python3', 'python']) {
    try {
      const out = execSync(`${bin} --version`, { stdio: 'pipe', timeout: 2000 }).toString();
      if (/Python 3\./.test(out)) {
        _cachedPython = bin;
        return bin;
      }
    } catch {}
  }
  _cachedPython = false;
  return false;
}

let _cachedFfmpeg = null;
export function isFfmpegAvailable() {
  if (_cachedFfmpeg !== null) return _cachedFfmpeg;
  try {
    execSync('ffmpeg -version', { stdio: 'pipe', timeout: 2000 });
    _cachedFfmpeg = true;
  } catch {
    _cachedFfmpeg = false;
  }
  return _cachedFfmpeg;
}

export function isVenvReady() {
  return existsSync(VENV_PY()) && existsSync(VENV_PIP());
}

export function isFasterWhisperInstalled() {
  if (!isVenvReady()) return false;
  try {
    execSync(`${VENV_PY()} -c "import faster_whisper"`, { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── Venv / dependency management ─────────────────────────────────────

// Spawn a command and stream its stdout+stderr line-by-line to onLog.
// Resolves on exit 0, rejects on non-zero exit or spawn error.
function _runStreamed(cmd, args, onLog, { timeout = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    onLog(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`command timed out after ${timeout}ms`));
    }, timeout);

    const pipe = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          onLog(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      stream.on('end', () => { if (buf.length) onLog(buf); });
    };
    pipe(child.stdout);
    pipe(child.stderr);

    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`exit code ${code}`));
    });
  });
}

export async function createVenv(onLog = () => {}) {
  const py = findPython3();
  if (!py) throw new Error('Python 3 not found on PATH');
  if (!existsSync(getDataDir())) mkdirSync(getDataDir(), { recursive: true });
  if (isVenvReady()) { onLog('venv already exists, skipping create'); return; }
  onLog(`Creating venv at ${VENV_DIR()}...`);
  await _runStreamed(py, ['-m', 'venv', VENV_DIR()], onLog, { timeout: 60_000 });
  // Upgrade pip (best-effort; don't fail bootstrap if this errors)
  try {
    await _runStreamed(VENV_PY(), ['-m', 'pip', 'install', '--upgrade', 'pip'], onLog, { timeout: 180_000 });
  } catch (e) {
    onLog(`pip upgrade skipped: ${e.message}`);
  }
}

export async function installFasterWhisper(onLog = () => {}) {
  if (!isVenvReady()) throw new Error('venv not ready — call createVenv first');
  if (isFasterWhisperInstalled()) { onLog('faster-whisper already installed, skipping'); return; }
  onLog('Installing faster-whisper (this can take a minute)...');
  await _runStreamed(VENV_PIP(), ['install', 'faster-whisper'], onLog, { timeout: 900_000 });
}

// Run the full setup (venv + package). Streams progress via onLog.
export async function bootstrap(onLog = () => {}) {
  await createVenv(onLog);
  await installFasterWhisper(onLog);
}

// ── Model install / list / delete ────────────────────────────────────

// faster-whisper downloads to a HuggingFace-cache structure:
//   data/whisper-models/
//     ├─ .locks/                                         (ignored)
//     └─ models--Systran--faster-whisper-<name>/
//           └─ snapshots/<hash>/...                      (actual files)
const HF_PREFIX = 'models--Systran--faster-whisper-';

function hfDirForModel(name) {
  return join(MODEL_DIR(), HF_PREFIX + name);
}

function modelNameFromDir(dirName) {
  if (!dirName.startsWith(HF_PREFIX)) return null;
  return dirName.slice(HF_PREFIX.length);
}

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    try {
      const s = statSync(p);
      if (s.isDirectory()) {
        for (const child of readdirSync(p)) walk(join(p, child));
      } else {
        total += s.size;
      }
    } catch {}
  };
  walk(dir);
  return total;
}

export function listInstalledModels() {
  if (!existsSync(MODEL_DIR())) return [];
  const result = [];
  for (const entry of readdirSync(MODEL_DIR())) {
    const name = modelNameFromDir(entry);
    if (!name) continue;                      // skip .locks and anything unrecognized
    const p = join(MODEL_DIR(), entry);
    try {
      if (statSync(p).isDirectory() && dirSize(p) > 0) {
        result.push({ name, sizeBytes: dirSize(p) });
      }
    } catch {}
  }
  return result;
}

export function isModelInstalled(name) {
  const p = hfDirForModel(name);
  try { return existsSync(p) && dirSize(p) > 0; } catch { return false; }
}

export function installModel(name, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    if (!KNOWN_MODELS.includes(name)) return reject(new Error(`unknown model: ${name}`));
    if (!isFasterWhisperInstalled()) {
      return reject(new Error('faster-whisper not installed. Bootstrap first.'));
    }
    if (!existsSync(MODEL_DIR())) mkdirSync(MODEL_DIR(), { recursive: true });

    // Use the venv python to call faster_whisper's downloader.
    const code = `
import sys
from faster_whisper import WhisperModel
try:
  # Loading with download_root forces a fetch if not present.
  WhisperModel(${JSON.stringify(name)}, device="cpu", compute_type="int8",
               download_root=${JSON.stringify(MODEL_DIR())})
  print("__DONE__", flush=True)
except Exception as e:
  print(f"__ERROR__ {e}", flush=True)
  sys.exit(1)
`;
    const child = spawn(VENV_PY(), ['-c', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lastLine = '';
    const onData = (chunk) => {
      const s = chunk.toString();
      lastLine = s.trim().split('\n').pop() || lastLine;
      onProgress(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('exit', (code) => {
      if (code === 0) resolve({ name, installed: true });
      else reject(new Error(`install failed (code ${code}): ${lastLine}`));
    });
    child.on('error', reject);
  });
}

export function deleteModel(name) {
  // Remove the HuggingFace snapshot dir and any matching lock file.
  const hfDir = hfDirForModel(name);
  if (existsSync(hfDir)) rmSync(hfDir, { recursive: true, force: true });
  const locksDir = join(MODEL_DIR(), '.locks', HF_PREFIX + name);
  if (existsSync(locksDir)) rmSync(locksDir, { recursive: true, force: true });
}

// ── Helper subprocess lifecycle ──────────────────────────────────────

class WhisperHelper extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.ready = false;
    this.config = null;
    this._pending = [];      // FIFO of {resolve, reject, timer}
    this._buffer = '';
  }

  isRunning() { return !!this.proc && !this.proc.killed; }
  currentConfig() { return this.config; }

  async start({ model, device }) {
    if (this.isRunning()) await this.stop();
    if (!isFasterWhisperInstalled()) throw new Error('faster-whisper not installed');
    if (!isModelInstalled(model)) throw new Error(`model not installed: ${model}`);

    const resolvedDevice = device === 'auto'
      ? (isCudaAvailable() ? 'cuda' : 'cpu')
      : device;

    const env = {
      ...process.env,
      WHISPER_MODEL: model,
      WHISPER_DEVICE: resolvedDevice,
      WHISPER_MODEL_DIR: MODEL_DIR(),
    };

    const proc = spawn(VENV_PY(), [SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.proc = proc;
    this.config = { model, device: resolvedDevice };
    this.ready = false;

    proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    proc.stderr.on('data', (chunk) => {
      // Log helper stderr to our console; useful for diagnosing load failures.
      console.error('[whisper]', chunk.toString().trim());
    });
    proc.on('exit', (code) => {
      this.ready = false;
      this.proc = null;
      for (const p of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`whisper helper exited (code ${code})`));
      }
      this._pending = [];
      this.emit('exit', code);
    });

    await new Promise((resolve, reject) => {
      const ready = (msg) => {
        if (msg.ready) {
          this.ready = true;
          this.off('message', ready);
          this.off('message', errCheck);
          resolve();
        }
      };
      const errCheck = (msg) => {
        if (msg.error) {
          this.off('message', ready);
          this.off('message', errCheck);
          reject(new Error(msg.error));
        }
      };
      this.on('message', ready);
      this.on('message', errCheck);
      setTimeout(() => reject(new Error('whisper startup timeout')), 60_000);
    });
  }

  async stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    this.ready = false;
    this.config = null;
    try { p.stdin.end(); } catch {}
    try { p.kill('SIGTERM'); } catch {}
  }

  _onStdout(chunk) {
    this._buffer += chunk.toString();
    let idx;
    while ((idx = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { console.error('[whisper] bad json from helper:', line); continue; }
      this.emit('message', msg);
      if (msg.ready || msg.error || msg.text !== undefined) {
        if (!msg.ready && this._pending.length > 0) {
          const p = this._pending.shift();
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg);
        }
      }
    }
  }

  transcribe(audioBuffer, { timeoutMs = 5000, language = 'en' } = {}) {
    if (!this.isRunning() || !this.ready) {
      return Promise.reject(new Error('whisper not running'));
    }
    const b64 = audioBuffer.toString('base64');
    const req = JSON.stringify({ audio_b64: b64, language }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._pending.findIndex((p) => p.timer === timer);
        if (idx >= 0) this._pending.splice(idx, 1);
        reject(new Error('whisper transcribe timeout'));
      }, timeoutMs);
      this._pending.push({ resolve, reject, timer });
      try {
        this.proc.stdin.write(req);
      } catch (e) {
        clearTimeout(timer);
        this._pending.pop();
        reject(e);
      }
    });
  }
}

export const whisper = new WhisperHelper();
