'use strict';

// Owns the update state: periodic checks, skip, download and restart. Network,
// electron-updater, storage and settings are injected, so there is no Electron
// dependency and the whole state machine runs under plain Node.
//
// UpdateState = { status: 'none'|'available'|'downloading'|'ready'|'installing'|'error',
//   current, kind, latest: { version, notes } | null, progress: whole percent
//   while downloading, else null, error: string|null, pacmanCommand: string|null }
// 'installing': a restart is going ahead; the app quits once it has started.
// Emits 'state' with a copy of the new UpdateState whenever it changes.

const { EventEmitter } = require('node:events');
const { CHECK_INTERVAL_MS, SELF_UPDATING, parseVersion, isNewer, parseRelease, pacmanCommand } = require('./updateCheck');

const NOTHING = { status: 'none', latest: null, progress: null, error: null, pacmanCommand: null };

// From broadcasting 'installing' to starting the install: time for every
// window to draw its Installing dialog before the main process may block (on
// Windows, starting the unsigned installer took seconds) and the app quits.
// An IPC message and a frame take a few ms. A fixed delay, not waiting for
// each window to say it drew: a hidden or minimised window never draws, so
// that would need a timeout anyway.
const INSTALL_DELAY_MS = 300;

const messageOf = (err) => err?.message || String(err);

class Updater extends EventEmitter {
  // fetchRelease(): Promise<GitHub release JSON>; it must settle (callers give it a timeout).
  // engine: { download(onProgress(percent)): Promise<void>, quitAndInstall(): void } | null;
  // download() must settle too, or the state stays 'downloading'.
  // store: { get(): { skipped?: string } | null, set(obj) }.
  // later(fn, ms): runs fn once after ms (a setTimeout; injectable for tests).
  constructor({ currentVersion, kind, fetchRelease, engine = null, store, isEnabled, connectedCount, log, later = (fn, ms) => setTimeout(fn, ms) }) {
    super();
    this._kind = kind;
    this._fetchRelease = fetchRelease;
    this._engine = engine;
    this._store = store;
    this._isEnabled = isEnabled;
    this._connectedCount = connectedCount;
    this._log = log;
    this._later = later;
    this._state = { ...NOTHING, current: currentVersion, kind };
    this._skipped = this._loadSkipped();
    this._request = null; // in-flight release fetch, shared by concurrent checks
    this._download = null; // in-flight download, shared by concurrent calls
    this._downloadId = 0;
    this._installing = null; // the restart under way (its answer), so the install starts once
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
    if (this._kind === 'dev') return;
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
    if (status === 'ready' || status === 'installing') return Promise.resolve();
    if (status !== 'available' && status !== 'error') return Promise.reject(new Error('No update to download'));
    this._set({ status: 'downloading', progress: 0, error: null });
    this._download = this._runDownload(++this._downloadId);
    return this._download;
  }

  // Resolves { ok: false } unless an update is ready; { confirm: n } while n
  // brokers are connected, unless force is exactly true. Otherwise every window
  // hears 'installing' at once, and INSTALL_DELAY_MS later the engine quits and
  // installs: { ok: true }, or { ok: false } with the failure in state
  // ('error'). Calls while a restart is under way get its answer.
  restart({ force = false } = {}) {
    if (this._installing) return this._installing;
    if (this._state.status !== 'ready') return Promise.resolve({ ok: false });
    const connected = this._connectedCount();
    if (connected > 0 && force !== true) return Promise.resolve({ confirm: connected });
    this._set({ status: 'installing' });
    this._installing = new Promise((resolve) => this._later(() => resolve(this._install()), INSTALL_DELAY_MS));
    return this._installing;
  }

  _install() {
    try {
      this._engine.quitAndInstall();
    } catch (err) {
      this._installing = null;
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
  // done (or installing) alone, and keeping a failed download's error for that
  // same version.
  _offer(release) {
    const { status, latest } = this._state;
    if (status === 'downloading' || status === 'ready' || status === 'installing') return;
    if (!release) {
      this._set(NOTHING);
      return;
    }
    if (status === 'error' && latest.version === release.version) return;
    if (latest?.version !== release.version) this._log.info('update', `${release.version} is available`);
    this._set({
      status: 'available',
      latest: { version: release.version, notes: release.notes },
      progress: null,
      error: null,
      pacmanCommand: this._kind === 'pacman' ? pacmanCommand(release.version) : null,
    });
  }

  // Each listener runs in isolation and its errors are logged, not thrown: a
  // failing broadcast (e.g. to a destroyed window) must not abort the
  // transition that triggered it, nor keep the other listeners from hearing it.
  _set(patch) {
    const next = { ...this._state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this._state)) return;
    this._state = next;
    const snapshot = this.state;
    for (const listener of this.rawListeners('state')) {
      try {
        listener.call(this, snapshot);
      } catch (err) {
        this._log.error('update', err);
      }
    }
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

module.exports = { Updater, INSTALL_DELAY_MS };
