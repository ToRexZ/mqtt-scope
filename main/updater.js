'use strict';

// Owns the update state: periodic checks, skip, download and restart. Network,
// electron-updater, storage and settings are injected, so there is no Electron
// dependency and the whole state machine runs under plain Node.
//
// UpdateState = { status: 'none'|'available'|'downloading'|'ready'|'error',
//   current, kind, latest: { version, notes } | null, progress: whole percent
//   while downloading, else null, error: string|null, pacmanCommand: string|null }
// Emits 'state' with a copy of the new UpdateState whenever it changes.

const { EventEmitter } = require('node:events');
const { CHECK_INTERVAL_MS, SELF_UPDATING, parseVersion, isNewer, parseRelease, pacmanCommand } = require('./updateCheck');

const NOTHING = { status: 'none', latest: null, progress: null, error: null, pacmanCommand: null };

const messageOf = (err) => err?.message || String(err);

class Updater extends EventEmitter {
  // fetchRelease(): Promise<GitHub release JSON>; it must settle (callers give it a timeout).
  // engine: { download(onProgress(percent)): Promise<void>, quitAndInstall(): void } | null.
  // store: { get(): { skipped?: string } | null, set(obj) }.
  constructor({ currentVersion, kind, fetchRelease, engine = null, store, isEnabled, connectedCount, log }) {
    super();
    this._kind = kind;
    this._fetchRelease = fetchRelease;
    this._engine = engine;
    this._store = store;
    this._isEnabled = isEnabled;
    this._connectedCount = connectedCount;
    this._log = log;
    this._state = { ...NOTHING, current: currentVersion, kind };
    this._skipped = this._loadSkipped();
    this._request = null; // in-flight release fetch, shared by concurrent checks
    this._download = null; // in-flight download, shared by concurrent calls
    this._downloadId = 0;
    this._timer = null;
  }

  get state() {
    const s = this._state;
    return { ...s, latest: s.latest && { ...s.latest } };
  }

  // Checks now and every CHECK_INTERVAL_MS. Calling it again is a no-op.
  start() {
    if (this._kind === 'dev' || this._timer) return;
    this._timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    this._timer.unref?.();
    this.tick();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  // One automatic check, skipped while the setting is off. Never rejects:
  // it runs from a timer, so anything unexpected is logged instead.
  async tick() {
    try {
      if (this._isEnabled()) await this.check();
    } catch (err) {
      this._log.error('update', err);
    }
  }

  // result 'latest' means nothing to offer (up to date, or skipped on an
  // automatic check). A manual check ignores and clears a skip. Failures never
  // change the state; they are logged and returned as { result: 'error' }.
  async check({ manual = false } = {}) {
    if (this._kind === 'dev') return { result: 'disabled' };
    let release;
    try {
      release = await this._latestRelease();
    } catch (err) {
      return { result: 'error', error: messageOf(err) };
    }
    const { version } = release;
    if (!isNewer(version, this._state.current)) {
      this._offer(null);
      return { result: 'latest' };
    }
    if (this._skipped && !isNewer(version, this._skipped)) {
      if (!manual) {
        this._offer(null);
        return { result: 'latest' };
      }
      this._saveSkipped(null);
    }
    this._offer(release);
    return { result: 'available', version };
  }

  // Hides the offered version (and anything older) until a newer release.
  // Only while it is offered or failed: a downloaded update installs on quit.
  skip() {
    const { status, latest } = this._state;
    if (status !== 'available' && status !== 'error') return;
    this._saveSkipped(latest.version);
    this._set(NOTHING);
  }

  // Resolves when the download settles; a failure lands in state ('error') and
  // download() again retries. Rejects only when there is nothing this build can download.
  download() {
    if (!SELF_UPDATING.has(this._kind) || !this._engine) return Promise.reject(new Error('This build cannot update itself'));
    const { status } = this._state;
    if (status === 'downloading') return this._download;
    if (status === 'ready') return Promise.resolve();
    if (status !== 'available' && status !== 'error') return Promise.reject(new Error('No update to download'));
    this._set({ status: 'downloading', progress: 0, error: null });
    this._download = this._runDownload(++this._downloadId);
    return this._download;
  }

  // { ok: false } unless an update is ready; { confirm: n } while n brokers are
  // connected, unless force is exactly true; otherwise quits and installs.
  restart({ force = false } = {}) {
    if (this._state.status !== 'ready') return { ok: false };
    const connected = this._connectedCount();
    if (connected > 0 && force !== true) return { confirm: connected };
    try {
      this._engine.quitAndInstall();
    } catch (err) {
      this._log.warn('update', `install failed: ${messageOf(err)}`);
      this._set({ status: 'error', error: messageOf(err) });
      return { ok: false };
    }
    return { ok: true };
  }

  _latestRelease() {
    if (!this._request) {
      const request = (async () => {
        const release = parseRelease(await this._fetchRelease());
        if (!release) throw new Error('No usable release found');
        return release;
      })();
      const done = () => {
        this._request = null;
      };
      request.then(done, (err) => {
        done();
        this._log.warn('update', messageOf(err));
      });
      this._request = request;
    }
    return this._request;
  }

  async _runDownload(id) {
    const onProgress = (percent) => {
      if (id !== this._downloadId || this._state.status !== 'downloading' || !Number.isFinite(percent)) return;
      this._set({ progress: Math.min(100, Math.max(0, Math.floor(percent))) });
    };
    let failure = null;
    try {
      await this._engine.download(onProgress);
    } catch (err) {
      failure = err;
    }
    if (failure) {
      this._log.warn('update', `download failed: ${messageOf(failure)}`);
      this._set({ status: 'error', progress: null, error: messageOf(failure) });
    } else {
      this._set({ status: 'ready', progress: null });
    }
  }

  // Shows `release` (or no notice for null), leaving a download in progress or
  // done alone, and keeping a failed download's error for that same version.
  _offer(release) {
    const { status, latest } = this._state;
    if (status === 'downloading' || status === 'ready') return;
    if (!release) {
      this._set(NOTHING);
      return;
    }
    if (status === 'error' && latest.version === release.version) return;
    this._set({
      status: 'available',
      latest: { version: release.version, notes: release.notes },
      progress: null,
      error: null,
      pacmanCommand: this._kind === 'pacman' ? pacmanCommand(release.version) : null,
    });
  }

  _set(patch) {
    const next = { ...this._state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this._state)) return;
    this._state = next;
    this.emit('state', this.state);
  }

  _loadSkipped() {
    try {
      const saved = this._store.get();
      return saved && typeof saved === 'object' && parseVersion(saved.skipped) ? saved.skipped : null;
    } catch (err) {
      this._log.warn('update', `could not read the skipped version: ${messageOf(err)}`);
      return null;
    }
  }

  // Kept in memory too, so a skip holds for this run even if saving fails.
  _saveSkipped(version) {
    this._skipped = version;
    try {
      this._store.set(version ? { skipped: version } : {});
    } catch (err) {
      this._log.warn('update', `could not save the skipped version: ${messageOf(err)}`);
    }
  }
}

module.exports = { Updater };
