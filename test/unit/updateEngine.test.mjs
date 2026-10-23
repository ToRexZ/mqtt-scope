// The update engine: which builds get one, the test fake, and the
// electron-updater adapter, run against a stand-in autoUpdater. The last parts
// run the real electron-updater too, with stand-ins for the app and its HTTP
// client (so nothing leaves the process), for what its requests send and what
// it runs the Windows installer with.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requireFromRoot } from './_util.mjs';

const { createEngine, spawnInWorker } = requireFromRoot('./main/updateEngine.js');

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeLog() {
  const lines = [];
  const at = (level) => (...args) => lines.push([level, ...args]);
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

// Behaves like electron-updater's autoUpdater as far as the engine uses it.
// It has its own 'error' listener (electron-updater logs errors that way).
class FakeAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.on('error', () => {});
    this.calls = [];
    this.checkResult = { isUpdateAvailable: true, updateInfo: { version: '9.9.9' } };
    this.pending = null; // the current downloadUpdate()
    this.onInstall = () => {};
  }
  setFeedURL(options) {
    this.calls.push(['setFeedURL', options]);
  }
  async checkForUpdates() {
    this.calls.push(['checkForUpdates']);
    return this.checkResult;
  }
  downloadUpdate() {
    this.calls.push(['downloadUpdate']);
    this.pending = deferred();
    return this.pending.promise;
  }
  quitAndInstall(...args) {
    this.calls.push(['quitAndInstall', ...args]);
    this.onInstall();
  }
  listeners_() {
    return { error: this.listenerCount('error'), progress: this.listenerCount('download-progress') };
  }
}

function realEngine(opts = {}) {
  const updater = new FakeAutoUpdater();
  let loads = 0;
  const log = fakeLog();
  const engine = createEngine({
    kind: 'appimage',
    feedUrl: null,
    log,
    env: {},
    loadUpdater: () => {
      loads++;
      return updater;
    },
    ...opts,
  });
  return { engine, updater, log, loads: () => loads };
}

// Waits until the engine has asked for the download.
async function untilDownloading(updater) {
  for (let i = 0; i < 20 && !updater.pending; i++) await flush();
  assert.ok(updater.pending, 'downloadUpdate() was called');
}

describe('createEngine', () => {
  test('no engine for builds that cannot replace themselves', () => {
    let loads = 0;
    for (const kind of ['manual', 'pacman', 'portable', 'dev']) {
      for (const env of [{}, { MQTTSCOPE_UPDATE_FAKE: '1' }]) {
        assert.equal(createEngine({ kind, feedUrl: null, log: fakeLog(), env, loadUpdater: () => void loads++ }), null);
      }
    }
    assert.equal(loads, 0);
  });

  test('AppImage and Windows installer builds get one; electron-updater loads on first use', async () => {
    for (const kind of ['appimage', 'nsis']) {
      const { engine, updater, loads } = realEngine({ kind });
      assert.equal(typeof engine.download, 'function');
      assert.equal(typeof engine.quitAndInstall, 'function');
      assert.equal(loads(), 0);
      const done = engine.download(() => {});
      await untilDownloading(updater);
      updater.pending.resolve(['/tmp/x']);
      await done;
      assert.equal(loads(), 1);
    }
  });
});

describe('fake engine (MQTTSCOPE_UPDATE_FAKE=1)', () => {
  afterEach(() => {
    delete globalThis.__updateInstalled;
    delete globalThis.__updateInstallError;
    delete globalThis.__updateDownloadHold;
    delete globalThis.__updateDownloadError;
  });

  const fake = () => createEngine({ kind: 'appimage', feedUrl: null, log: fakeLog(), env: { MQTTSCOPE_UPDATE_FAKE: '1' }, loadUpdater: assert.fail });

  test('a test can hold the download at 50 % (a promise in globalThis.__updateDownloadHold)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hold = deferred();
    globalThis.__updateDownloadHold = hold.promise;
    const seen = [];
    let done = false;
    const download = fake()
      .download((p) => seen.push(p))
      .then(() => (done = true));
    t.mock.timers.tick(150);
    await flush();
    t.mock.timers.tick(10_000); // far longer than the whole unheld download
    await flush();
    assert.deepEqual(seen, [0, 50]);
    assert.equal(done, false);
    hold.resolve();
    await flush();
    t.mock.timers.tick(150);
    await download;
    assert.deepEqual(seen, [0, 50, 100]);
  });

  test('a test can fail the download at 50 % (a message in globalThis.__updateDownloadError)', async () => {
    globalThis.__updateDownloadError = 'Connection reset';
    const seen = [];
    await assert.rejects(
      fake().download((p) => seen.push(p)),
      { message: 'Connection reset' },
    );
    assert.deepEqual(seen, [0, 50]);
    delete globalThis.__updateDownloadError;
    seen.length = 0;
    await fake().download((p) => seen.push(p));
    assert.deepEqual(seen, [0, 50, 100]);
  });

  test('the failure is read after the hold, so a held download can still be failed', async () => {
    const hold = deferred();
    const reached = deferred();
    globalThis.__updateDownloadHold = hold.promise;
    const download = fake().download((p) => p === 50 && reached.resolve());
    await reached.promise;
    globalThis.__updateDownloadError = 'late failure';
    hold.resolve();
    await assert.rejects(download, { message: 'late failure' });
  });

  test('reports 0, 50 and 100 % over about 300 ms, then resolves', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const engine = createEngine({ kind: 'appimage', feedUrl: null, log: fakeLog(), env: { MQTTSCOPE_UPDATE_FAKE: '1' }, loadUpdater: assert.fail });
    const seen = [];
    let done = false;
    const download = engine.download((p) => seen.push(p)).then(() => (done = true));
    assert.deepEqual(seen, [0]);
    t.mock.timers.tick(150);
    await flush();
    assert.deepEqual(seen, [0, 50]);
    assert.equal(done, false);
    t.mock.timers.tick(150);
    await download;
    assert.deepEqual(seen, [0, 50, 100]);
  });

  test('installing only sets a flag; nothing quits', () => {
    const engine = createEngine({ kind: 'nsis', feedUrl: null, log: fakeLog(), env: { MQTTSCOPE_UPDATE_FAKE: '1' }, loadUpdater: assert.fail });
    engine.quitAndInstall();
    assert.equal(globalThis.__updateInstalled, true);
  });

  test('installing fails with the message a test puts in globalThis.__updateInstallError', () => {
    const engine = createEngine({ kind: 'appimage', feedUrl: null, log: fakeLog(), env: { MQTTSCOPE_UPDATE_FAKE: '1' }, loadUpdater: assert.fail });
    globalThis.__updateInstallError = 'mv: cannot move';
    assert.throws(() => engine.quitAndInstall(), { message: 'mv: cannot move' });
    assert.equal(globalThis.__updateInstalled, undefined);
    delete globalThis.__updateInstallError;
    engine.quitAndInstall();
    assert.equal(globalThis.__updateInstalled, true);
  });

  test('any other value of the variable gets the real engine', async () => {
    for (const value of ['', '0', 'true', 'yes']) {
      const { engine, updater, loads } = realEngine({ env: { MQTTSCOPE_UPDATE_FAKE: value } });
      const done = engine.download(() => {});
      await untilDownloading(updater);
      updater.pending.resolve([]);
      await done;
      assert.equal(loads(), 1, value);
    }
  });
});

describe('electron-updater engine', () => {
  test('configures electron-updater once: no auto download, install on quit, our log', async () => {
    const { engine, updater, log, loads } = realEngine();
    for (let i = 0; i < 2; i++) {
      const done = engine.download(() => {});
      await untilDownloading(updater);
      updater.pending.resolve([]);
      await done;
      updater.pending = null;
    }
    assert.equal(loads(), 1);
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, true);
    assert.equal(updater.autoRunAppAfterInstall, true, 'the Windows installer starts the new version (--force-run)');
    assert.deepEqual(updater.requestHeaders, { 'x-user-staging-id': NIL_UUID }, 'update requests carry no install ID');
    assert.deepEqual(
      updater.calls.filter(([name]) => name === 'setFeedURL'),
      [],
      'without the override, electron-updater uses the feed packaged with the app',
    );
    updater.logger.info('Checking for update');
    updater.logger.warn('slow');
    updater.logger.error('Error: boom');
    assert.deepEqual(log.lines, [
      ['info', 'update', 'Checking for update'],
      ['warn', 'update', 'slow'],
      ['error', 'update', 'Error: boom'],
    ]);
  });

  test('the override becomes a generic feed', async () => {
    const { engine, updater } = realEngine({ feedUrl: 'http://127.0.0.1:5000' });
    const done = engine.download(() => {});
    await untilDownloading(updater);
    updater.pending.resolve([]);
    await done;
    assert.deepEqual(updater.calls[0], ['setFeedURL', { provider: 'generic', url: 'http://127.0.0.1:5000' }]);
  });

  test('a configuration that fails is done again on the next attempt, not kept half done', async () => {
    const { engine, updater, loads } = realEngine({ feedUrl: 'http://127.0.0.1:5000' });
    const setFeedURL = updater.setFeedURL.bind(updater);
    let failures = 1;
    updater.setFeedURL = (options) => {
      if (failures-- > 0) throw new Error('Invalid feed URL');
      setFeedURL(options);
    };
    await assert.rejects(engine.download(() => {}), { message: 'Invalid feed URL' });
    assert.deepEqual(updater.calls, [], 'nothing asked of a half-configured updater');
    const done = engine.download(() => {});
    await untilDownloading(updater);
    updater.pending.resolve([]);
    await done;
    assert.equal(loads(), 2);
    assert.deepEqual(
      updater.calls.map(([name]) => name),
      ['setFeedURL', 'checkForUpdates', 'downloadUpdate'],
    );
  });

  test('checks the feed, then downloads, forwarding progress', async () => {
    const { engine, updater } = realEngine();
    const before = updater.listeners_();
    const seen = [];
    const done = engine.download((p) => seen.push(p));
    await untilDownloading(updater);
    updater.emit('download-progress', { percent: 12.5, transferred: 1, total: 8, bytesPerSecond: 1 });
    updater.emit('download-progress', { percent: 100 });
    updater.pending.resolve(['/tmp/MQTT-Scope-9.9.9.AppImage']);
    await done;
    assert.deepEqual(
      updater.calls.map(([name]) => name),
      ['checkForUpdates', 'downloadUpdate'],
    );
    assert.deepEqual(seen, [12.5, 100]);
    assert.deepEqual(updater.listeners_(), before);
  });

  test('a failed download rejects and leaves no listeners behind, so a retry starts clean', async () => {
    const { engine, updater } = realEngine();
    const before = updater.listeners_();
    for (let attempt = 0; attempt < 3; attempt++) {
      const done = engine.download(() => {});
      await untilDownloading(updater);
      const err = new Error(`net::ERR_CONNECTION_RESET ${attempt}`);
      updater.emit('error', err); // electron-updater emits, then rejects
      updater.pending.reject(err);
      await assert.rejects(done, (e) => e === err);
      updater.pending = null;
      assert.deepEqual(updater.listeners_(), before);
    }
  });

  test("electron-updater's 'error' event rejects even if its promise never settles", { timeout: 5000 }, async () => {
    const { engine, updater } = realEngine();
    const before = updater.listeners_();
    const progress = [];
    const done = engine.download((p) => progress.push(p));
    await untilDownloading(updater);
    updater.emit('error', new Error('sha512 checksum mismatch'));
    await assert.rejects(done, { message: 'sha512 checksum mismatch' });
    assert.deepEqual(updater.listeners_(), before);
    updater.emit('download-progress', { percent: 50 }); // late events reach nobody
    assert.deepEqual(progress, []);
  });

  test('a failed feed check rejects without downloading', async () => {
    const { engine, updater } = realEngine();
    updater.checkForUpdates = async () => {
      throw new Error('HTTP 404 latest-linux.yml');
    };
    updater.downloadUpdate = async () => assert.fail('downloaded anyway');
    await assert.rejects(engine.download(() => {}), { message: 'HTTP 404 latest-linux.yml' });
  });

  test('a build electron-updater will not update, or a feed with nothing newer, rejects without downloading', async () => {
    for (const [checkResult, message] of [
      [null, 'This build cannot update itself'],
      [{ isUpdateAvailable: false, updateInfo: { version: '0.0.1' } }, 'The update feed has no newer version'],
    ]) {
      const { engine, updater } = realEngine();
      const before = updater.listeners_();
      updater.checkResult = checkResult;
      updater.downloadUpdate = async () => assert.fail('downloaded anyway');
      await assert.rejects(engine.download(() => {}), { message });
      assert.deepEqual(updater.listeners_(), before);
    }
  });

  // quitAndInstall(isSilent, isForceRunAfter): a silent install runs the new
  // version if isForceRunAfter, one with its window if autoRunAppAfterInstall.
  // (The Windows installer's restart is below, against the real NsisUpdater.)
  test('Restart to update on the AppImage quits, installs silently and relaunches, as before', () => {
    const { engine, updater } = realEngine({ kind: 'appimage' });
    engine.quitAndInstall();
    assert.deepEqual(updater.calls.at(-1), ['quitAndInstall', true, true]);
  });

  test("an install under a new file name (electron-updater's appimage-filename-updated) is passed to onRenamed", async () => {
    const renamed = [];
    const { engine, updater } = realEngine({ onRenamed: (file) => renamed.push(file) });
    const done = engine.download(() => {});
    await untilDownloading(updater);
    updater.pending.resolve([]);
    await done;
    updater.emit('appimage-filename-updated', '/a/MQTT-Scope-9.9.9-linux-x86_64.AppImage');
    assert.deepEqual(renamed, ['/a/MQTT-Scope-9.9.9-linux-x86_64.AppImage']);
  });

  test('an onRenamed that throws is logged, never thrown into the install', () => {
    const { engine, updater, log } = realEngine({
      onRenamed: () => {
        throw new Error('disk full');
      },
    });
    engine.quitAndInstall();
    assert.doesNotThrow(() => updater.emit('appimage-filename-updated', '/a/MQTT-Scope-9.9.9-linux-x86_64.AppImage'));
    assert.deepEqual(log.lines, [['warn', 'update', 'after installing as /a/MQTT-Scope-9.9.9-linux-x86_64.AppImage: disk full']]);
  });

  test('an install that fails (reported as an event) throws, and leaves no listener behind', () => {
    const { engine, updater } = realEngine();
    const before = updater.listeners_();
    updater.onInstall = () => updater.emit('error', new Error("No update filepath provided, can't quit and install"));
    assert.throws(() => engine.quitAndInstall(), { message: "No update filepath provided, can't quit and install" });
    assert.deepEqual(updater.listeners_(), before);
    updater.onInstall = () => {};
    assert.doesNotThrow(() => engine.quitAndInstall());
  });
});

// electron-updater's AppImage updater as a packaged build runs it: the GitHub
// feed from app-update.yml (what electron-builder packages for this repo), a
// release 0.3.1 newer than the running 0.3.0. Records each request with its
// headers, and the headers the download would send.
function realElectronUpdater(t) {
  const { AppImageUpdater } = requireFromRoot('electron-updater/out/AppImageUpdater');
  const dir = mkdtempSync(path.join(tmpdir(), 'mqttscope-updater-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'app-update.yml'), 'owner: ToRexZ\nrepo: mqtt-scope\nprovider: github\nupdaterCacheDirName: mqtt-scope-updater\n');
  const app = {
    version: '0.3.0',
    name: 'MQTT Scope',
    isPackaged: true,
    appUpdateConfigPath: path.join(dir, 'app-update.yml'),
    userDataPath: path.join(dir, 'data'),
    baseCachePath: path.join(dir, 'cache'),
    whenReady: () => Promise.resolve(),
    relaunch() {},
    quit() {},
    onQuit() {},
  };
  const updater = new AppImageUpdater(null, app);
  updater.logger = null;
  updater.forceDevUpdateConfig = true; // stands in for APPIMAGE in the environment
  const yml = [
    'version: 0.3.1',
    'files:',
    '  - url: MQTT-Scope-0.3.1-linux-x86_64.AppImage',
    '    sha512: AAAA',
    '    size: 1',
    'path: MQTT-Scope-0.3.1-linux-x86_64.AppImage',
    'sha512: AAAA',
    "releaseDate: '2026-10-22T00:00:00.000Z'",
  ].join('\n');
  const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="alternate" type="text/html" href="https://github.com/ToRexZ/mqtt-scope/releases/tag/v0.3.1"/><title>0.3.1</title><content type="html">Notes</content></entry></feed>`;
  const responses = [
    [/^\/ToRexZ\/mqtt-scope\/releases\.atom$/, atom],
    [/^\/ToRexZ\/mqtt-scope\/releases\/latest$/, JSON.stringify({ tag_name: 'v0.3.1' })],
    [/^\/ToRexZ\/mqtt-scope\/releases\/download\/v0\.3\.1\/latest[\w-]*\.yml$/, yml],
  ];
  const requests = [];
  updater.httpExecutor = {
    async request(options) {
      const pathname = options.path.split('?')[0];
      requests.push({ host: options.hostname, path: pathname, headers: { ...options.headers } });
      const hit = responses.find(([re]) => re.test(pathname));
      if (!hit) throw new Error(`unexpected request ${options.hostname}${options.path}`);
      return hit[1];
    },
  };
  const downloads = [];
  updater.doDownloadUpdate = async (options) => {
    downloads.push({ ...options.requestHeaders });
    return [];
  };
  const savedId = () => readFileSync(path.join(dir, 'data', '.updaterId'), 'utf8');
  return { updater, requests, downloads, savedId };
}

describe('electron-updater engine with the real electron-updater', () => {
  test('on its own, electron-updater sends the install ID it keeps in .updaterId', async (t) => {
    const { updater, requests, savedId } = realElectronUpdater(t);
    const result = await updater.checkForUpdates();
    assert.equal(result.isUpdateAvailable, true);
    assert.match(savedId(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(savedId(), NIL_UUID);
    assert.ok(requests.some((r) => r.headers['x-user-staging-id'] === savedId()));
  });

  // doInstall as Restart to update (isForceRunAfter) and install on quit call
  // it, with the downloaded update in cache/ and APPIMAGE naming the running file.
  test('installing under the new versioned name reports it on both paths; a name without a version is kept', async (t) => {
    const cases = [
      { isForceRunAfter: true, running: 'MQTT-Scope-0.3.0-linux-x86_64.AppImage', renamed: 'MQTT-Scope-0.3.1-linux-x86_64.AppImage' },
      { isForceRunAfter: false, running: 'MQTT-Scope-0.3.0-linux-x86_64.AppImage', renamed: 'MQTT-Scope-0.3.1-linux-x86_64.AppImage' },
      { isForceRunAfter: false, running: 'MQTT-Scope.AppImage', renamed: null },
    ];
    for (const { isForceRunAfter, running, renamed } of cases) {
      const { updater } = realElectronUpdater(t);
      const dir = mkdtempSync(path.join(tmpdir(), 'mqttscope-install-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      mkdirSync(path.join(dir, 'cache'));
      writeFileSync(path.join(dir, running), 'the running version');
      const update = path.join(dir, 'cache', 'MQTT-Scope-0.3.1-linux-x86_64.AppImage');
      writeFileSync(update, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // runs and exits, like AppRun with APPIMAGE_EXIT_AFTER_INSTALL
      const seen = [];
      const engine = createEngine({ kind: 'appimage', feedUrl: null, log: fakeLog(), env: {}, loadUpdater: () => updater, onRenamed: (file) => seen.push(file) });
      await engine.download(() => {});
      updater.downloadedUpdateHelper = { file: update };
      const saved = process.env.APPIMAGE;
      process.env.APPIMAGE = path.join(dir, running);
      try {
        assert.equal(updater.doInstall({ isForceRunAfter }), true);
      } finally {
        if (saved === undefined) delete process.env.APPIMAGE;
        else process.env.APPIMAGE = saved;
      }
      const label = `${running}, isForceRunAfter ${isForceRunAfter}`;
      assert.deepEqual(seen, renamed ? [path.join(dir, renamed)] : [], label);
      assert.deepEqual(readdirSync(dir).sort(), [renamed || running, 'cache'].sort(), label);
    }
  });

  test('through the engine, no feed request or download sends it: every one sends the nil UUID', async (t) => {
    const { updater, requests, downloads, savedId } = realElectronUpdater(t);
    const engine = createEngine({ kind: 'appimage', feedUrl: null, log: fakeLog(), env: {}, loadUpdater: () => updater });
    await engine.download(() => {});
    assert.deepEqual(
      requests.map((r) => `${r.host}${r.path}`.replace(/latest[\w-]*\.yml$/, 'latest*.yml')),
      ['github.com/ToRexZ/mqtt-scope/releases.atom', 'github.com/ToRexZ/mqtt-scope/releases/latest', 'github.com/ToRexZ/mqtt-scope/releases/download/v0.3.1/latest*.yml'],
    );
    assert.equal(downloads.length, 1);
    for (const headers of [...requests.map((r) => r.headers), ...downloads]) {
      assert.equal(headers['x-user-staging-id'], NIL_UUID);
      assert.ok(!Object.values(headers).some((v) => String(v).includes(savedId())), JSON.stringify(headers));
    }
  });
});

// electron-updater's Windows updater, with a downloaded installer and a
// stand-in for starting it on the main thread (its spawnLog). build/installer.nsh
// relies on these arguments: --updated without /S shows the progress and skips
// the questions, and --force-run then starts the new version and closes the
// installer.
function realNsisUpdater(t) {
  const { NsisUpdater } = requireFromRoot('electron-updater/out/NsisUpdater');
  const dir = mkdtempSync(path.join(tmpdir(), 'mqttscope-nsis-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = {
    version: '0.3.0',
    name: 'MQTT Scope',
    isPackaged: true,
    appUpdateConfigPath: path.join(dir, 'app-update.yml'),
    userDataPath: path.join(dir, 'data'),
    baseCachePath: path.join(dir, 'cache'),
    whenReady: () => Promise.resolve(),
    relaunch() {},
    quits: 0,
    quit() {
      this.quits++;
    },
    onQuit(handler) {
      this.quitHandler = handler;
    },
  };
  const updater = new NsisUpdater(null, app);
  updater.logger = null;
  const installer = path.join(dir, 'cache', 'pending', 'MQTT-Scope-0.3.1-win-x64-setup.exe');
  updater.downloadedUpdateHelper = { file: installer, packageFile: null, downloadedFileInfo: { isAdminRightsRequired: false } };
  const started = [];
  updater.spawnLog = async (cmd, args) => {
    started.push([cmd, ...args]);
    return true;
  };
  // Starting the installer, electron-updater announces the quit through
  // Electron's own autoUpdater, which plain Node does not have: stand in for
  // the electron module while the test runs.
  const announced = [];
  const autoUpdater = new EventEmitter();
  autoUpdater.on('before-quit-for-update', () => announced.push(app.quits));
  // Electron's app, for its before-quit: askQuit() is what app.quit() starts
  // with, and returns whether a listener held it off.
  const electronApp = new EventEmitter();
  const askQuit = () => {
    let held = false;
    electronApp.emit('before-quit', { preventDefault: () => (held = true) });
    return held;
  };
  const electronId = requireFromRoot.resolve('electron');
  const saved = requireFromRoot.cache[electronId];
  requireFromRoot.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: { autoUpdater, app: electronApp } };
  t.after(() => {
    if (saved) requireFromRoot.cache[electronId] = saved;
    else delete requireFromRoot.cache[electronId];
  });
  return { updater, app, installer, started, announced, dir, askQuit };
}

// Stands in for spawnInWorker: records each start and holds it until the test
// settles it (resolve(pid) or reject(err)).
function fakeWorkerSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const d = deferred();
    calls.push({ cmd, args, opts, ...d });
    return d.promise;
  };
  return { spawn, calls };
}

const nsisEngine = (updater, spawnDetached, log = fakeLog()) =>
  createEngine({ kind: 'nsis', feedUrl: null, log, env: {}, loadUpdater: () => updater, spawnDetached });

describe('the Windows installer as the real electron-updater runs it', () => {
  // The window stays responsive while the installer starts, so the user can
  // quit (or close the last window) meanwhile.
  test('a quit asked for while the installer starts waits for it; then the app quits once', async (t) => {
    const { updater, app, askQuit } = realNsisUpdater(t);
    const workers = fakeWorkerSpawn();
    const done = nsisEngine(updater, workers.spawn).quitAndInstall();
    assert.equal(askQuit(), true, 'held off');
    workers.calls[0].resolve(1);
    await done;
    await flush();
    assert.equal(app.quits, 1);
    assert.equal(askQuit(), false, 'no longer held');
  });

  test('a quit asked for while the installer failed to start happens then, so the update installs on that quit', async (t) => {
    const { updater, app, askQuit } = realNsisUpdater(t);
    const workers = fakeWorkerSpawn();
    const done = nsisEngine(updater, workers.spawn).quitAndInstall();
    assert.equal(askQuit(), true);
    workers.calls[0].reject(Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }));
    await assert.rejects(done);
    await flush();
    assert.equal(app.quits, 1);
    assert.equal(updater.quitAndInstallCalled, false, 'so install on quit runs');
  });

  test('without a quit asked for, a failed start leaves the app running', async (t) => {
    const { updater, app } = realNsisUpdater(t);
    const workers = fakeWorkerSpawn();
    const done = nsisEngine(updater, workers.spawn).quitAndInstall();
    workers.calls[0].reject(Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }));
    await assert.rejects(done);
    await flush();
    assert.equal(app.quits, 0);
  });

  // Starting the unsigned installer blocked the main process for 5-15 s on
  // Windows (child_process.spawn), so a restart starts it in a worker thread.
  test('Restart to update starts it off the main thread, with its window and --force-run; the app quits once it started', async (t) => {
    const { updater, app, installer, started, announced } = realNsisUpdater(t);
    const workers = fakeWorkerSpawn();
    const done = nsisEngine(updater, workers.spawn).quitAndInstall();
    assert.ok(done instanceof Promise);
    assert.deepEqual(
      workers.calls.map((c) => [c.cmd, ...c.args]),
      [[installer, '--updated', '--force-run']],
    );
    assert.deepEqual(workers.calls[0].opts, { env: undefined, stdio: 'ignore' }, "spawnLog's own defaults");
    assert.deepEqual(started, [], 'nothing started on the main thread');
    await flush();
    assert.equal(app.quits, 0, 'not before the installer runs');
    workers.calls[0].resolve(4242);
    await done;
    assert.equal(app.quits, 0, 'quits on the next turn, as quitAndInstall does');
    await flush();
    assert.equal(app.quits, 1);
    assert.deepEqual(announced, [0], "Electron's before-quit-for-update, before the quit");
  });

  test('a failed start is thrown and nothing quits; a retry starts it again', async (t) => {
    const { updater, app, installer } = realNsisUpdater(t);
    const workers = fakeWorkerSpawn();
    const engine = nsisEngine(updater, workers.spawn);
    const first = engine.quitAndInstall();
    workers.calls[0].reject(Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }));
    await assert.rejects(first, { message: 'spawn EPERM' });
    await flush();
    assert.equal(app.quits, 0);
    assert.equal(updater.quitAndInstallCalled, false, 'electron-updater would ignore a second install');

    const second = engine.quitAndInstall();
    assert.deepEqual(
      workers.calls.map((c) => [c.cmd, ...c.args]),
      [
        [installer, '--updated', '--force-run'],
        [installer, '--updated', '--force-run'],
      ],
    );
    workers.calls[1].resolve(1);
    await second;
    await flush();
    assert.equal(app.quits, 1);
  });

  test("Windows refusing it (EACCES) falls back to electron-updater's elevate.exe, also off the main thread", async (t) => {
    const { updater, app, installer, started, dir } = realNsisUpdater(t);
    const savedResources = process.resourcesPath;
    process.resourcesPath = dir;
    t.after(() => {
      process.resourcesPath = savedResources;
    });
    const workers = fakeWorkerSpawn();
    const done = nsisEngine(updater, workers.spawn).quitAndInstall();
    workers.calls[0].reject(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    for (let i = 0; i < 5 && workers.calls.length < 2; i++) await flush();
    assert.deepEqual(
      workers.calls.map((c) => [c.cmd, ...c.args]),
      [
        [installer, '--updated', '--force-run'],
        [path.join(dir, 'elevate.exe'), installer, '--updated', '--force-run'],
      ],
    );
    assert.equal(app.quits, 0);
    workers.calls[1].resolve(7);
    await done;
    await flush();
    assert.equal(app.quits, 1);
    assert.deepEqual(started, []);
  });

  test('a downloaded update installs silently on quit, on the main thread (a worker would die with the app)', async (t) => {
    const { updater, app, installer, started } = realNsisUpdater(t);
    updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.3.1' } });
    updater.downloadUpdate = async () => [installer];
    const workers = fakeWorkerSpawn();
    await nsisEngine(updater, workers.spawn).download(() => {});
    updater.addQuitHandler(); // what electron-updater does once a download completes
    app.quitHandler(0);
    assert.deepEqual(started, [[installer, '--updated', '/S']]);
    assert.deepEqual(workers.calls, []);
  });

  test('after a failed restart, quitting still installs silently on the main thread', async (t) => {
    const { updater, app, installer, started } = realNsisUpdater(t);
    updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.3.1' } });
    updater.downloadUpdate = async () => [installer];
    const workers = fakeWorkerSpawn();
    const engine = nsisEngine(updater, workers.spawn);
    await engine.download(() => {});
    updater.addQuitHandler();
    const restart = engine.quitAndInstall();
    workers.calls[0].reject(Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }));
    await assert.rejects(restart);
    app.quitHandler(0);
    assert.deepEqual(started, [[installer, '--updated', '/S']]);
    assert.equal(workers.calls.length, 1);
  });
});

describe('spawnInWorker (a detached start off the main thread)', () => {
  test('starts the program from a worker thread and resolves its pid; the main thread does not spawn', async (t) => {
    const childProcess = requireFromRoot('node:child_process');
    t.mock.method(childProcess, 'spawn', () => assert.fail('spawned on the main thread'));
    const pid = await spawnInWorker(process.execPath, ['-e', ''], { env: undefined, stdio: 'ignore' });
    assert.equal(typeof pid, 'number');
    assert.ok(pid > 0);
  });

  test('a program that cannot be started rejects with its error code', async () => {
    await assert.rejects(spawnInWorker(path.join(tmpdir(), 'mqttscope-no-such-program'), [], {}), { code: 'ENOENT' });
  });

  test('no answer within the timeout rejects', async () => {
    class SilentWorker extends EventEmitter {
      unref() {}
    }
    await assert.rejects(spawnInWorker('setup.exe', [], { timeoutMs: 20, Worker: SilentWorker }), { message: 'The installer did not start within 0.02 s' });
  });

  test('a worker that fails or ends without an answer rejects', async () => {
    class FailingWorker extends EventEmitter {
      constructor() {
        super();
        setImmediate(() => this.emit('error', new Error('worker broke')));
      }
      unref() {}
    }
    await assert.rejects(spawnInWorker('setup.exe', [], { Worker: FailingWorker }), { message: 'worker broke' });
    class QuietExit extends EventEmitter {
      constructor() {
        super();
        setImmediate(() => this.emit('exit', 1));
      }
      unref() {}
    }
    await assert.rejects(spawnInWorker('setup.exe', [], { Worker: QuietExit }), { message: 'The installer could not be started (its worker thread exited with code 1)' });
  });
});
