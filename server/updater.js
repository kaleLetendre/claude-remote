import { execSync, exec } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
import { PACKAGE_ROOT } from '../lib/paths.js';

const ROOT = PACKAGE_ROOT;

export class Updater extends EventEmitter {
  constructor({ autoCheck = false, checkInterval = 300_000 } = {}) {
    super();
    this.root = ROOT;
    this.checking = false;
    this.updateAvailable = null;  // { version, changelog, commitsBehind }
    this.lastCheck = null;

    if (autoCheck) {
      this.startAutoCheck(checkInterval);
    }
  }

  // ── Version Info ──────────────────────────────────────────

  getVersion() {
    try {
      const raw = readFileSync(join(this.root, 'version.json'), 'utf8');
      return JSON.parse(raw);
    } catch {
      return { version: '0.0.0', settingsVersion: 1 };
    }
  }

  getGitInfo() {
    try {
      const branch = this._git('rev-parse --abbrev-ref HEAD').trim();
      const commit = this._git('rev-parse --short HEAD').trim();
      const dirty = this._git('status --porcelain').trim().length > 0;
      const remote = this._git('remote get-url origin').trim();
      return { branch, commit, dirty, remote, isGit: true };
    } catch {
      return { isGit: false };
    }
  }

  // ── Check for Updates ─────────────────────────────────────

  async check() {
    if (this.checking) return this.updateAvailable;
    this.checking = true;

    try {
      const git = this.getGitInfo();
      if (!git.isGit) {
        this.checking = false;
        return null;
      }

      // Fetch remote without merging
      this._git('fetch origin --quiet');

      const branch = git.branch;
      const local = this._git('rev-parse HEAD').trim();
      const remote = this._git(`rev-parse origin/${branch}`).trim();

      if (local === remote) {
        this.updateAvailable = null;
        this.lastCheck = Date.now();
        this.checking = false;
        return null;
      }

      // How many commits behind
      const behindOutput = this._git(`rev-list --count HEAD..origin/${branch}`).trim();
      const commitsBehind = parseInt(behindOutput) || 0;

      if (commitsBehind === 0) {
        this.updateAvailable = null;
        this.lastCheck = Date.now();
        this.checking = false;
        return null;
      }

      // Get incoming changes summary
      const log = this._git(`log --oneline HEAD..origin/${branch}`).trim();

      // Try to read remote version.json
      let remoteVersion = null;
      let remoteChangelog = [];
      try {
        const raw = this._git(`show origin/${branch}:version.json`);
        const parsed = JSON.parse(raw);
        remoteVersion = parsed.version;
        remoteChangelog = parsed.changelog || [];
      } catch {}

      this.updateAvailable = {
        currentVersion: this.getVersion().version,
        newVersion: remoteVersion || 'unknown',
        commitsBehind,
        log: log.split('\n').slice(0, 10),  // Last 10 commits
        changelog: remoteChangelog,
      };

      this.lastCheck = Date.now();
      this.emit('update-available', this.updateAvailable);

    } catch (err) {
      this.emit('check-error', err.message);
    }

    this.checking = false;
    return this.updateAvailable;
  }

  // ── Apply Update ──────────────────────────────────────────

  async apply() {
    const git = this.getGitInfo();
    if (!git.isGit) throw new Error('Not a git repository');

    // Stash any local changes (settings files, etc.)
    const hasStash = git.dirty;
    if (hasStash) {
      this._git('stash push -m "claude-remote-auto-stash"');
    }

    try {
      // Pull latest
      const pullResult = this._git('pull origin ' + git.branch);

      // Install dependencies if package.json changed
      const changedFiles = this._git('diff --name-only HEAD~1 HEAD').trim();
      if (changedFiles.includes('server/package.json')) {
        this._exec('cd ' + join(this.root, 'server') + ' && npm install');
      }
      if (changedFiles.includes('client/package.json')) {
        this._exec('cd ' + join(this.root, 'client') + ' && npm install');
      }

      // Pop stash if we stashed
      if (hasStash) {
        try { this._git('stash pop'); } catch {}
      }

      this.updateAvailable = null;
      this.emit('update-applied', this.getVersion());

      return {
        success: true,
        version: this.getVersion().version,
        pullResult: pullResult.trim(),
        needsRestart: true,
      };

    } catch (err) {
      // Restore stash on failure
      if (hasStash) {
        try { this._git('stash pop'); } catch {}
      }
      throw new Error('Update failed: ' + err.message);
    }
  }

  // ── Auto-check ────────────────────────────────────────────

  startAutoCheck(interval = 300_000) {  // 5 minutes default
    this._autoCheckTimer = setInterval(() => this.check(), interval);
    // Initial check after 30s
    setTimeout(() => this.check(), 30_000);
  }

  stopAutoCheck() {
    if (this._autoCheckTimer) clearInterval(this._autoCheckTimer);
  }

  // ── Restart Server ────────────────────────────────────────

  scheduleRestart(delayMs = 2000) {
    this.emit('restarting', delayMs);

    setTimeout(() => {
      try {
        writeFileSync(join(this.root, '.restart-requested'), Date.now().toString());
      } catch {}

      // Exit with code 75 — run.sh treats this as "restart me"
      process.exit(75);
    }, delayMs);
  }

  // ── Helpers ───────────────────────────────────────────────

  _git(cmd) {
    return execSync(`git -C "${this.root}" ${cmd}`, {
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  _exec(cmd) {
    return execSync(cmd, { encoding: 'utf8', timeout: 60_000 });
  }
}
