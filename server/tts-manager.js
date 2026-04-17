import { spawn, execSync } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { PACKAGE_ROOT, getDataDir } from '../lib/paths.js';

// ── Layout ───────────────────────────────────────────────────────────
const SCRIPT_PATH = join(PACKAGE_ROOT, 'server', 'tts', 'synthesize.py');
const VENV_DIR = () => join(getDataDir(), 'tts-venv');
const MODEL_DIR = () => join(getDataDir(), 'tts-model');
const VENV_PY = () => join(VENV_DIR(), 'bin', 'python');
const VENV_PIP = () => join(VENV_DIR(), 'bin', 'pip');

// Model + voices files are single blobs from kokoro-onnx releases.
const MODEL_FILE = () => join(MODEL_DIR(), 'kokoro-v1.0.onnx');
const VOICES_FILE = () => join(MODEL_DIR(), 'voices-v1.0.bin');
const MODEL_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx';
const VOICES_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin';

// Curated subset of Kokoro's voice catalog. a=american, b=british, f=female, m=male.
export const KNOWN_VOICES = [
  'af_bella', 'af_sarah', 'af_nicole', 'af_sky',
  'am_adam', 'am_michael',
  'bf_emma', 'bf_isabella',
  'bm_george', 'bm_lewis',
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

export function isVenvReady() {
  return existsSync(VENV_PY()) && existsSync(VENV_PIP());
}

export function isKokoroInstalled() {
  if (!isVenvReady()) return false;
  try {
    execSync(`${VENV_PY()} -c "import kokoro_onnx"`, { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function areAssetsInstalled() {
  try {
    return existsSync(MODEL_FILE()) && statSync(MODEL_FILE()).size > 1_000_000
        && existsSync(VOICES_FILE()) && statSync(VOICES_FILE()).size > 100_000;
  } catch {
    return false;
  }
}

export function isBootstrapped() {
  return isKokoroInstalled() && areAssetsInstalled();
}

// ── Venv / dependency management ─────────────────────────────────────

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
  try {
    await _runStreamed(VENV_PY(), ['-m', 'pip', 'install', '--upgrade', 'pip'], onLog, { timeout: 180_000 });
  } catch (e) {
    onLog(`pip upgrade skipped: ${e.message}`);
  }
}

export async function installKokoro(onLog = () => {}) {
  if (!isVenvReady()) throw new Error('venv not ready — call createVenv first');
  if (isKokoroInstalled()) { onLog('kokoro-onnx already installed, skipping'); return; }
  onLog('Installing kokoro-onnx (this can take a minute)...');
  await _runStreamed(VENV_PIP(), ['install', 'kokoro-onnx', 'soundfile'], onLog, { timeout: 900_000 });
}

export async function downloadAssets(onLog = () => {}) {
  if (!existsSync(MODEL_DIR())) mkdirSync(MODEL_DIR(), { recursive: true });
  if (areAssetsInstalled()) { onLog('model + voices already present, skipping'); return; }
  onLog('Downloading Kokoro model + voices (~340MB)...');
  if (!existsSync(MODEL_FILE())) {
    await _runStreamed('curl', ['-L', '--fail', '-o', MODEL_FILE(), MODEL_URL], onLog, { timeout: 900_000 });
  }
  if (!existsSync(VOICES_FILE())) {
    await _runStreamed('curl', ['-L', '--fail', '-o', VOICES_FILE(), VOICES_URL], onLog, { timeout: 600_000 });
  }
}

// Full setup: venv + kokoro-onnx + model/voices download.
export async function bootstrap(onLog = () => {}) {
  await createVenv(onLog);
  await installKokoro(onLog);
  await downloadAssets(onLog);
}

// ── Helper subprocess lifecycle ──────────────────────────────────────

class TtsHelper extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.ready = false;
    this.config = null;
    this._pending = [];
    this._buffer = '';
  }

  isRunning() { return !!this.proc && !this.proc.killed; }
  currentConfig() { return this.config; }

  async start({ voice, device, speed }) {
    if (this.isRunning()) await this.stop();
    if (!isBootstrapped()) throw new Error('kokoro not bootstrapped (venv, kokoro-onnx, or model/voices missing)');
    if (!KNOWN_VOICES.includes(voice)) throw new Error(`unknown voice: ${voice}`);

    const resolvedDevice = device === 'auto'
      ? (isCudaAvailable() ? 'cuda' : 'cpu')
      : device;

    const env = {
      ...process.env,
      KOKORO_VOICE: voice,
      KOKORO_DEVICE: resolvedDevice,
      KOKORO_SPEED: String(speed || 1.0),
      KOKORO_MODEL_FILE: MODEL_FILE(),
      KOKORO_VOICES_FILE: VOICES_FILE(),
    };

    const proc = spawn(VENV_PY(), [SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.proc = proc;
    this.config = { voice, device: resolvedDevice, speed: speed || 1.0 };
    this.ready = false;

    proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    proc.stderr.on('data', (chunk) => {
      console.error('[tts]', chunk.toString().trim());
    });
    proc.on('exit', (code) => {
      this.ready = false;
      this.proc = null;
      for (const p of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`tts helper exited (code ${code})`));
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
      setTimeout(() => reject(new Error('tts startup timeout')), 60_000);
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
      catch { console.error('[tts] bad json from helper:', line); continue; }
      this.emit('message', msg);
      if (msg.ready || msg.error || msg.audio_b64 !== undefined) {
        if (!msg.ready && this._pending.length > 0) {
          const p = this._pending.shift();
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg);
        }
      }
    }
  }

  synthesize(text, { timeoutMs = 15_000 } = {}) {
    if (!this.isRunning() || !this.ready) {
      return Promise.reject(new Error('tts not running'));
    }
    const req = JSON.stringify({ text: String(text || '') }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._pending.findIndex((p) => p.timer === timer);
        if (idx >= 0) this._pending.splice(idx, 1);
        reject(new Error('tts synthesize timeout'));
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

export const tts = new TtsHelper();
