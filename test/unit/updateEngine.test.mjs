// The update engine: which builds get one, the test fake, and the
// electron-updater adapter, run against a stand-in autoUpdater (electron-updater
// itself needs a packaged Electron app, so it is never loaded here).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { requireFromRoot } from './_util.mjs';

const { createEngine } = requireFromRoot('./main/updateEngine.js');

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

  test('install quits and relaunches the new version (silently on Windows)', () => {
    const { engine, updater } = realEngine();
    engine.quitAndInstall();
    assert.deepEqual(updater.calls.at(-1), ['quitAndInstall', true, true]);
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
