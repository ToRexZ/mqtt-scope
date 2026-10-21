'use strict';

// Downloads and installs updates for the builds that can replace themselves
// (AppImage, Windows installer), as the engine main/updater.js expects:
// { download(onProgress(percent)): Promise<void>, quitAndInstall(): void }.
// electron-updater is loaded on first use, so dev runs and tests never load it.

const { SELF_UPDATING } = require('./updateCheck');

const FAKE_STEP_MS = 150;

// electron-updater sends x-user-staging-id, a random ID it keeps in
// <userData>/.updaterId, with its feed requests (for staged rollouts, which
// this app does not use). An update request must not identify the install, so
// every install sends the same nil UUID: requestHeaders take precedence over
// electron-updater's own value, on the feed requests and the downloads.
const NO_INSTALL_ID = { 'x-user-staging-id': '00000000-0000-0000-0000-000000000000' };

// feedUrl: the MQTTSCOPE_UPDATE_URL override as a generic feed, or null for the
// feed packaged with the app. MQTTSCOPE_UPDATE_FAKE=1 selects a fake for tests.
function createEngine({ kind, feedUrl, log, env = process.env, loadUpdater = () => require('electron-updater').autoUpdater }) {
  if (!SELF_UPDATING.has(kind)) return null;
  if (env.MQTTSCOPE_UPDATE_FAKE === '1') return fakeEngine();
  return electronUpdaterEngine({ feedUrl, log, loadUpdater });
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

function electronUpdaterEngine({ feedUrl, log, loadUpdater }) {
  let updater = null;
  // Kept only once fully configured, so a failure here is retried next time.
  const get = () => {
    if (updater) return updater;
    const u = loadUpdater();
    u.autoDownload = false; // nothing downloads until the user asks
    u.autoInstallOnAppQuit = true; // a downloaded update installs when the user quits
    u.requestHeaders = { ...NO_INSTALL_ID };
    u.logger = {
      info: (m) => log.info('update', m),
      warn: (m) => log.warn('update', m),
      error: (m) => log.error('update', m),
    };
    if (feedUrl) u.setFeedURL({ provider: 'generic', url: feedUrl });
    updater = u;
    return u;
  };

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
    // Quits, installs and starts the new version (silently on Windows). A
    // failed install is reported as an 'error' event, not thrown; throw it.
    quitAndInstall() {
      const u = get();
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

module.exports = { createEngine };
