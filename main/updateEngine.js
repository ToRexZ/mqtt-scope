'use strict';

// Downloads and installs updates for the builds that can replace themselves
// (AppImage, Windows installer), as the engine main/updater.js expects:
// { download(onProgress(percent)): Promise<void>, quitAndInstall(): void | Promise<void> }.
// electron-updater is loaded on first use, so dev runs and tests never load it.

const { SELF_UPDATING } = require('./updateCheck');

const FAKE_STEP_MS = 150;

// How long a restart waits for the Windows installer to start. Starting the
// unsigned installer took 5-15 s in a Windows 11 VM (Windows checks it first);
// far beyond that something is wrong, and an error with Retry beats an
// Installing dialog that never ends. Starting it again on the main thread
// instead could freeze the window and start the installer twice.
const SPAWN_TIMEOUT_MS = 60_000;

// Runs in a worker thread: starts the program detached, as electron-updater's
// spawnLog does, and reports its pid, or the error that kept it from starting.
const SPAWN_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { cmd, args, env, stdio } = workerData;
const fail = (err) => parentPort.postMessage({ error: { message: err.message, code: err.code } });
try {
  const child = spawn(cmd, args, { stdio, env, detached: true });
  child.on('error', fail);
  child.unref();
  if (child.pid !== undefined) parentPort.postMessage({ pid: child.pid });
} catch (err) {
  fail(err);
}
`;

// Starts cmd detached from a worker thread, so the main thread stays free while
// the system starts it; resolves its pid, or rejects with the error (and its
// code, e.g. EACCES). Inline (eval) so there is no file to keep out of the asar.
function spawnInWorker(cmd, args, { env, stdio = 'ignore', timeoutMs = SPAWN_TIMEOUT_MS, Worker = require('node:worker_threads').Worker } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(SPAWN_WORKER, { eval: true, workerData: { cmd, args, env, stdio } });
    worker.unref(); // a worker that never answers must not keep the app open
    let settled = false;
    const finish = (err, pid) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(pid);
    };
    const timer = setTimeout(() => finish(new Error(`The installer did not start within ${timeoutMs / 1000} s`)), timeoutMs);
    worker.on('message', ({ pid, error }) => finish(error && Object.assign(new Error(error.message), { code: error.code }), pid));
    worker.on('error', (err) => finish(err));
    worker.on('exit', (code) => finish(new Error(`The installer could not be started (its worker thread exited with code ${code})`)));
  });
}

// electron-updater sends x-user-staging-id, a random ID it keeps in
// <userData>/.updaterId, with its feed requests (for staged rollouts, which
// this app does not use). An update request must not identify the install, so
// every install sends the same nil UUID: requestHeaders take precedence over
// electron-updater's own value, on the feed requests and the downloads.
const NO_INSTALL_ID = { 'x-user-staging-id': '00000000-0000-0000-0000-000000000000' };

// feedUrl: the MQTTSCOPE_UPDATE_URL override as a generic feed, or null for the
// feed packaged with the app. MQTTSCOPE_UPDATE_FAKE=1 selects a fake for tests.
// onRenamed(file): the AppImage update was installed under a new file name
// (the new version's), before that file runs; called on Restart to update and
// on quit, where the new version does not start. spawnDetached: how a restart
// starts the Windows installer (spawnInWorker; replaceable for tests).
function createEngine({ kind, feedUrl, log, onRenamed = () => {}, env = process.env, loadUpdater = () => require('electron-updater').autoUpdater, spawnDetached = spawnInWorker }) {
  if (!SELF_UPDATING.has(kind)) return null;
  if (env.MQTTSCOPE_UPDATE_FAKE === '1') return fakeEngine();
  return electronUpdaterEngine({ kind, feedUrl, log, onRenamed, loadUpdater, spawnDetached });
}

// Reports 0, 50 and 100 % over ~300 ms. At 50 % a test can hold the download
// (a promise in globalThis.__updateDownloadHold, awaited) or fail it (a message
// in globalThis.__updateDownloadError, read after the hold). Installing only
// sets a flag tests read, or fails with the message a test put in
// globalThis.__updateInstallError.
function fakeEngine() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    async download(onProgress) {
      onProgress(0);
      await wait(FAKE_STEP_MS);
      onProgress(50);
      await globalThis.__updateDownloadHold;
      if (globalThis.__updateDownloadError) throw new Error(globalThis.__updateDownloadError);
      await wait(FAKE_STEP_MS);
      onProgress(100);
    },
    quitAndInstall() {
      if (globalThis.__updateInstallError) throw new Error(globalThis.__updateInstallError);
      globalThis.__updateInstalled = true;
    },
  };
}

const asError = (err) => (err instanceof Error ? err : new Error(String(err)));

function electronUpdaterEngine({ kind, feedUrl, log, onRenamed, loadUpdater, spawnDetached }) {
  let updater = null;
  let restartSpawns = null; // while a Windows restart starts the installer: its starts so far
  // Kept only once fully configured, so a failure here is retried next time.
  const get = () => {
    if (updater) return updater;
    const u = loadUpdater();
    u.autoDownload = false; // nothing downloads until the user asks
    u.autoInstallOnAppQuit = true; // a downloaded update installs when the user quits
    u.autoRunAppAfterInstall = true; // the installer, run with its window, starts the new version (--force-run)
    u.requestHeaders = { ...NO_INSTALL_ID };
    u.logger = {
      info: (m) => log.info('update', m),
      warn: (m) => log.warn('update', m),
      error: (m) => log.error('update', m),
    };
    if (feedUrl) u.setFeedURL({ provider: 'generic', url: feedUrl });
    // Emitted inside the (synchronous) install; a failure here must not stop it.
    u.on('appimage-filename-updated', (file) => {
      try {
        onRenamed(file);
      } catch (err) {
        log.warn('update', `after installing as ${file}: ${err.message}`);
      }
    });
    // electron-updater 6.8.9 starts the Windows installer in NsisUpdater's
    // doInstall() with this.spawnLog(): a child_process.spawn on the main
    // thread, which blocked it for 5-15 s while Windows checked the unsigned
    // installer (the window went "Not Responding"). During a restart the
    // start happens in a worker thread instead, also for the fallback to
    // elevate.exe that doInstall tries when Windows refuses (EACCES). Install
    // on quit keeps the main-thread start: a worker would end with the app.
    if (kind === 'nsis' && typeof u.spawnLog === 'function') {
      const spawnOnMainThread = u.spawnLog;
      u.spawnLog = function (cmd, args = [], env = undefined, stdio = 'ignore') {
        if (!restartSpawns) return spawnOnMainThread.call(this, cmd, args, env, stdio);
        log.info('update', `Executing in a worker thread: ${cmd} with args: ${args}`);
        const started = spawnDetached(cmd, args, { env, stdio }).then(() => true);
        restartSpawns.push(started);
        return started;
      };
    }
    updater = u;
    return u;
  };

  // Restart to update on Windows: what u.quitAndInstall(false, true) does, but
  // the app quits only once the installer has started, and a failure to start
  // it is thrown (the app stays, showing the error and Retry).
  async function installWithoutBlocking(u) {
    const spawns = [];
    let failure = null;
    const onError = (err) => {
      failure ||= asError(err);
    };
    // The window stays responsive meanwhile: a quit asked for now (e.g. the
    // last window closed) waits until the installer started, or if it could
    // not start, happens then (and installs the update on that quit).
    const { app } = require('electron');
    let quitAsked = false;
    const holdQuit = (e) => {
      e.preventDefault();
      quitAsked = true;
    };
    app.on('before-quit', holdQuit);
    u.on('error', onError);
    restartSpawns = spawns;
    try {
      // With its window (not silent), and --force-run (autoRunAppAfterInstall).
      if (!u.install(false, u.autoRunAppAfterInstall)) throw failure || new Error('The update could not be installed');
      // doInstall handles a failed start itself (elevate.exe, or the shell
      // for a missing file) before these settle, and may start another.
      for (let seen = 0; seen < spawns.length; ) {
        const batch = spawns.slice(seen);
        seen = spawns.length;
        await Promise.allSettled(batch);
      }
      if (failure) throw failure;
    } catch (err) {
      u.quitAndInstallCalled = false; // as quitAndInstall does, so a retry or the quit can install
      if (quitAsked) setImmediate(() => u.app.quit());
      throw err;
    } finally {
      restartSpawns = null;
      u.off('error', onError);
      app.off('before-quit', holdQuit);
    }
    // As quitAndInstall does once the installer runs.
    setImmediate(() => {
      require('electron').autoUpdater.emit('before-quit-for-update');
      u.app.quit();
    });
  }

  // electron-updater downloads only what its own check found.
  async function checkThenDownload(u) {
    const result = await u.checkForUpdates();
    if (!result) throw new Error('This build cannot update itself');
    if (!result.isUpdateAvailable) throw new Error('The update feed has no newer version');
    await u.downloadUpdate();
  }

  return {
    // Rejects on electron-updater's 'error' event as well as on its promises,
    // and removes its listeners either way, so a retry starts clean.
    async download(onProgress) {
      const u = get();
      const progress = (p) => onProgress(p?.percent);
      let onError;
      const failed = new Promise((_resolve, reject) => {
        onError = (err) => reject(asError(err));
      });
      u.on('download-progress', progress);
      u.on('error', onError);
      try {
        await Promise.race([failed, checkThenDownload(u)]);
      } finally {
        u.off('download-progress', progress);
        u.off('error', onError);
      }
    },
    // Quits, installs and starts the new version. The Windows installer runs
    // with its window, so its progress shows (build/installer.nsh skips its
    // questions and Finish page on an update), and it is started off the main
    // thread: resolves once it started. Install on quit stays silent. A failed
    // install is reported as an 'error' event, not thrown; throw it.
    quitAndInstall() {
      const u = get();
      if (kind === 'nsis') return installWithoutBlocking(u);
      let failure = null;
      const onError = (err) => {
        failure ||= asError(err);
      };
      u.on('error', onError);
      try {
        u.quitAndInstall(true, true);
      } finally {
        u.off('error', onError);
      }
      if (failure) throw failure;
    },
  };
}

module.exports = { createEngine, spawnInWorker };
