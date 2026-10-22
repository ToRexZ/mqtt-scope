// Updater state machine with fake fetch, engine, store and log. Intervals run
// on mock timers; the install restart() schedules waits in w.timers until the
// test fires it; everything else settles through promises the tests await.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { requireFromRoot } from './_util.mjs';

const { Updater, INSTALL_DELAY_MS } = requireFromRoot('./main/updater.js');
const { CHECK_INTERVAL_MS, pacmanCommand } = requireFromRoot('./main/updateCheck.js');

const rel = (version, body = `Notes for ${version}`) => ({ tag_name: `v${version}`, body });
const flush = () => new Promise((resolve) => setImmediate(resolve));
// Runs what restart() scheduled (the install, INSTALL_DELAY_MS later).
const fire = (w) => {
  for (const { fn } of w.timers.splice(0)) fn();
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Engine whose download() stays pending until the test settles it.
function fakeEngine() {
  const e = { downloads: 0, installs: 0, onProgress: null, pending: null };
  e.download = (onProgress) => {
    e.downloads++;
    e.onProgress = onProgress;
    e.pending = deferred();
    return e.pending.promise;
  };
  e.quitAndInstall = () => {
    e.installs++;
  };
  return e;
}

// `w` is the fake world: set w.release (an Error rejects) before a check.
function make({ saved = null, ...over } = {}) {
  const w = { release: rel('0.3.1'), fetches: 0, saved, sets: 0, enabled: true, enabledReads: 0, connected: 0, logs: [], events: [], timers: [] };
  const u = new Updater({
    currentVersion: '0.3.0',
    kind: 'appimage',
    fetchRelease: async () => {
      w.fetches++;
      if (w.release instanceof Error) throw w.release;
      return w.release;
    },
    engine: null,
    store: {
      get: () => w.saved,
      set: (v) => {
        w.sets++;
        w.saved = v;
      },
    },
    isEnabled: () => {
      w.enabledReads++;
      return w.enabled;
    },
    connectedCount: () => w.connected,
    later: (fn, ms) => w.timers.push({ fn, ms }),
    log: {
      info: (...a) => w.logs.push(['info', ...a]),
      warn: (...a) => w.logs.push(['warn', ...a]),
      error: (...a) => w.logs.push(['error', ...a]),
    },
    ...over,
  });
  u.on('state', (s) => w.events.push(s));
  return { u, w };
}

async function readyToInstall() {
  const engine = fakeEngine();
  const { u, w } = make({ engine });
  await u.check();
  const p = u.download();
  engine.pending.resolve();
  await p;
  assert.equal(u.state.status, 'ready');
  return { u, w, engine };
}

describe('check', () => {
  test('newer release → available, with notes and pacman command for pacman kind', async () => {
    const { u, w } = make({ kind: 'pacman' });
    assert.deepEqual(await u.check(), { result: 'available', version: '0.3.1' });
    const expected = {
      status: 'available',
      current: '0.3.0',
      kind: 'pacman',
      latest: { version: '0.3.1', notes: 'Notes for 0.3.1' },
      progress: null,
      error: null,
      pacmanCommand: pacmanCommand('0.3.1'),
    };
    assert.deepEqual(u.state, expected);
    assert.deepEqual(w.events, [expected]);

    for (const kind of ['appimage', 'nsis', 'portable', 'manual']) {
      const other = make({ kind }).u;
      await other.check();
      assert.equal(other.state.status, 'available', kind);
      assert.equal(other.state.pacmanCommand, null, kind);
    }
  });

  test('same or older release → none, check returns latest', async () => {
    for (const version of ['0.3.0', '0.2.9', '0.0.1']) {
      const { u, w } = make();
      w.release = rel(version);
      assert.deepEqual(await u.check(), { result: 'latest' }, version);
      assert.deepEqual(await u.check({ manual: true }), { result: 'latest' }, version);
      assert.equal(u.state.status, 'none');
      assert.equal(u.state.latest, null);
      assert.equal(w.events.length, 0, 'nothing changed, nothing emitted');
    }
  });

  test('state is emitted only when it changes', async () => {
    const { u, w } = make();
    await u.check();
    await u.check();
    await u.check({ manual: true });
    assert.equal(w.events.length, 1);
    w.release = rel('0.3.1', 'Edited notes');
    await u.check();
    assert.equal(w.events.length, 2);
    assert.equal(w.events[1].latest.notes, 'Edited notes');
  });

  test('a version is logged when it is first offered, not on every check', async () => {
    const { u, w } = make();
    const infos = () => w.logs.filter(([level]) => level === 'info');
    await u.check();
    await u.tick();
    await u.check({ manual: true });
    w.release = rel('0.3.1', 'Edited notes');
    await u.check();
    assert.deepEqual(infos(), [['info', 'update', '0.3.1 is available']]);
    w.release = rel('0.3.2');
    await u.check();
    assert.deepEqual(infos(), [
      ['info', 'update', '0.3.1 is available'],
      ['info', 'update', '0.3.2 is available'],
    ]);
  });

  test('the notice goes away when the latest release is no longer newer', async () => {
    const { u, w } = make();
    await u.check();
    w.release = rel('0.3.0');
    assert.deepEqual(await u.check(), { result: 'latest' });
    assert.equal(u.state.status, 'none');
    assert.equal(u.state.latest, null);
    assert.equal(w.events.length, 2);
  });

  test('automatic check failure is silent and leaves state unchanged', async () => {
    const { u, w } = make();
    w.release = new Error('net::ERR_INTERNET_DISCONNECTED');
    await u.tick();
    assert.equal(w.events.length, 0);
    assert.equal(u.state.status, 'none');
    assert.equal(u.state.error, null);
    assert.deepEqual(w.logs, [['warn', 'update', 'net::ERR_INTERNET_DISCONNECTED']]);

    assert.deepEqual(await u.check({ manual: true }), { result: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' });
    assert.equal(w.events.length, 0);
    assert.equal(u.state.status, 'none');
    assert.equal(u.state.error, null);
  });

  test('a failed check keeps a notice that is already showing', async () => {
    const { u, w } = make();
    await u.check();
    const before = u.state;
    w.release = new Error('HTTP 503');
    await u.tick();
    assert.deepEqual(await u.check({ manual: true }), { result: 'error', error: 'HTTP 503' });
    assert.deepEqual(u.state, before);
    assert.equal(w.events.length, 1);
  });

  test('a fetch that throws synchronously or rejects with a non-Error is reported, and the next check fetches again', async () => {
    let calls = 0;
    const { u } = make({
      fetchRelease: () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        if (calls === 2) return Promise.reject('HTTP 404');
        return Promise.resolve(rel('0.3.1'));
      },
    });
    assert.deepEqual(await u.check({ manual: true }), { result: 'error', error: 'boom' });
    assert.deepEqual(await u.check({ manual: true }), { result: 'error', error: 'HTTP 404' });
    assert.deepEqual(await u.check({ manual: true }), { result: 'available', version: '0.3.1' });
    assert.equal(calls, 3);
  });

  test('an unusable release is an error for a manual check and silent for an automatic one', async () => {
    const unusable = [null, 'not json', [], {}, { tag_name: 'v0.4.0-beta.1' }, { tag_name: 'v0.4.0', draft: true }, { tag_name: 'v0.4.0', prerelease: true }];
    for (const release of unusable) {
      const { u, w } = make();
      w.release = release;
      await u.tick();
      assert.equal(w.events.length, 0, JSON.stringify(release));
      assert.deepEqual(w.logs, [['warn', 'update', 'No usable release found']], JSON.stringify(release));
      assert.deepEqual(await u.check({ manual: true }), { result: 'error', error: 'No usable release found' });
      assert.equal(u.state.status, 'none');
    }
  });

  test('dev builds never fetch', async () => {
    const { u, w } = make({ kind: 'dev' });
    assert.deepEqual(await u.check(), { result: 'disabled' });
    assert.deepEqual(await u.check({ manual: true }), { result: 'disabled' });
    await u.tick();
    assert.equal(w.fetches, 0);
    assert.equal(u.state.kind, 'dev');
    assert.equal(w.events.length, 0);
  });

  test('concurrent checks share one request and get the same result', async () => {
    const d = deferred();
    let fetches = 0;
    const { u, w } = make({
      fetchRelease: () => {
        fetches++;
        return d.promise;
      },
    });
    const a = u.check();
    const b = u.check({ manual: true });
    const c = u.tick();
    assert.equal(fetches, 1);
    d.resolve(rel('0.3.1'));
    const [ra, rb] = await Promise.all([a, b, c]);
    assert.deepEqual(ra, { result: 'available', version: '0.3.1' });
    assert.deepEqual(rb, ra);
    assert.equal(w.events.length, 1);

    await u.check();
    assert.equal(fetches, 2, 'a check after the shared one settled fetches again');
  });

  test('a shared request that fails is logged once and reported to every manual caller', async () => {
    const d = deferred();
    const { u, w } = make({ fetchRelease: () => d.promise });
    const a = u.check({ manual: true });
    const b = u.check({ manual: true });
    const c = u.tick();
    d.reject(new Error('ETIMEDOUT'));
    assert.deepEqual(await a, { result: 'error', error: 'ETIMEDOUT' });
    assert.deepEqual(await b, { result: 'error', error: 'ETIMEDOUT' });
    await c;
    assert.deepEqual(w.logs, [['warn', 'update', 'ETIMEDOUT']]);
    assert.equal(w.events.length, 0);
  });

  test('a manual check that joins an automatic one still ignores the skip', async () => {
    const d = deferred();
    const { u, w } = make({ saved: { skipped: '0.3.1' }, fetchRelease: () => d.promise });
    const auto = u.tick();
    const manual = u.check({ manual: true });
    d.resolve(rel('0.3.1'));
    await auto;
    assert.deepEqual(await manual, { result: 'available', version: '0.3.1' });
    assert.equal(u.state.status, 'available');
    assert.deepEqual(w.saved, {});
  });

  test('state is a copy: mutating it or an event payload changes nothing inside', async () => {
    const { u, w } = make();
    await u.check();
    const s = u.state;
    s.status = 'ready';
    s.latest.version = '9.9.9';
    w.events[0].latest.notes = 'tampered';
    assert.equal(u.state.status, 'available');
    assert.deepEqual(u.state.latest, { version: '0.3.1', notes: 'Notes for 0.3.1' });
  });
});

describe('skip', () => {
  test('skip hides that version until a newer one; manual check un-skips it', async () => {
    const { u, w } = make();
    await u.check();
    u.skip();
    assert.equal(u.state.status, 'none');
    assert.equal(u.state.latest, null);
    assert.deepEqual(w.saved, { skipped: '0.3.1' });

    assert.deepEqual(await u.check(), { result: 'latest' });
    assert.equal(u.state.status, 'none');

    w.release = rel('0.3.2');
    await u.tick();
    assert.equal(u.state.status, 'available');
    assert.equal(u.state.latest.version, '0.3.2');

    u.skip();
    w.release = rel('0.3.1');
    await u.tick();
    assert.equal(u.state.status, 'none', 'a release older than the skipped one stays hidden');

    assert.deepEqual(await u.check({ manual: true }), { result: 'available', version: '0.3.1' });
    assert.equal(u.state.status, 'available');
    assert.deepEqual(w.saved, {});
    await u.tick();
    assert.equal(u.state.status, 'available', 'the skip stays cleared');
  });

  test('a saved skip applies from startup', async () => {
    const { u, w } = make({ saved: { skipped: '0.3.1' } });
    await u.tick();
    assert.equal(u.state.status, 'none');
    assert.equal(w.events.length, 0);
  });

  test('missing or garbage saved data counts as no skip', async () => {
    for (const saved of [null, undefined, 'x', 42, [], ['0.3.1'], {}, { skipped: 5 }, { skipped: 'garbage' }, { skipped: '' }]) {
      const { u } = make({ saved });
      await u.tick();
      assert.equal(u.state.status, 'available', JSON.stringify(saved));
    }
  });

  test('a store that throws on read counts as no skip and is logged', async () => {
    const { u, w } = make({
      store: {
        get: () => {
          throw new Error('EACCES');
        },
        set: () => {},
      },
    });
    await u.tick();
    assert.equal(u.state.status, 'available');
    assert.deepEqual(w.logs, [
      ['warn', 'update', 'could not read the skipped version: EACCES'],
      ['info', 'update', '0.3.1 is available'],
    ]);
  });

  test('a skip that cannot be saved is logged and still holds for this run', async () => {
    const { u, w } = make({
      store: {
        get: () => null,
        set: () => {
          throw new Error('ENOSPC');
        },
      },
    });
    await u.check();
    u.skip();
    assert.equal(u.state.status, 'none');
    assert.match(w.logs.map((l) => l.join(' ')).join('\n'), /ENOSPC/);
    await u.tick();
    assert.equal(u.state.status, 'none');
    assert.deepEqual(await u.check({ manual: true }), { result: 'available', version: '0.3.1' });
    assert.equal(u.state.status, 'available');
  });

  test('skip does nothing unless a notice or an error is showing', async () => {
    const { u, w } = make();
    u.skip();
    assert.equal(w.sets, 0);
    assert.equal(w.events.length, 0);

    const engine = fakeEngine();
    const d = make({ engine });
    await d.u.check();
    d.u.download();
    d.u.skip();
    assert.equal(d.u.state.status, 'downloading');
    engine.pending.resolve();
    await flush();
    d.u.skip();
    assert.equal(d.u.state.status, 'ready');
    assert.equal(d.w.sets, 0);
  });

  test('skip works from a failed download', async () => {
    const engine = fakeEngine();
    const { u, w } = make({ engine });
    await u.check();
    const p = u.download();
    engine.pending.reject(new Error('disk full'));
    await p;
    u.skip();
    assert.equal(u.state.status, 'none');
    assert.equal(u.state.error, null);
    assert.deepEqual(w.saved, { skipped: '0.3.1' });
  });
});

describe('download', () => {
  test('download reports progress then ready; non-self kinds cannot download', async () => {
    const engine = fakeEngine();
    const { u, w } = make({ engine });
    await u.check();
    const p = u.download();
    assert.equal(engine.downloads, 1);
    assert.equal(u.state.status, 'downloading');
    assert.equal(u.state.progress, 0);

    engine.onProgress(-5);
    engine.onProgress(42.7);
    engine.onProgress(42.9);
    engine.onProgress(Number.NaN);
    engine.onProgress('50');
    engine.onProgress(150);
    engine.pending.resolve();
    await p;
    assert.deepEqual(
      w.events.map((s) => [s.status, s.progress]),
      [
        ['available', null],
        ['downloading', 0],
        ['downloading', 42],
        ['downloading', 100],
        ['ready', null],
      ],
    );
    assert.equal(u.state.latest.version, '0.3.1');
    engine.onProgress(10);
    assert.equal(u.state.progress, null, 'progress after the download settled is ignored');

    // State is asserted before awaiting: a wrongly started download would never settle.
    for (const kind of ['manual', 'portable', 'pacman']) {
      const other = make({ kind, engine: fakeEngine() }).u;
      await other.check();
      const refused = other.download();
      assert.equal(other.state.status, 'available', kind);
      await assert.rejects(refused, { message: 'This build cannot update itself' }, kind);
    }
    const noEngine = make({ kind: 'nsis', engine: null }).u;
    await noEngine.check();
    await assert.rejects(noEngine.download(), { message: 'This build cannot update itself' });
  });

  test('download needs an update to download', async () => {
    const engine = fakeEngine();
    const { u, w } = make({ engine });
    const refused = u.download();
    assert.equal(engine.downloads, 0);
    assert.equal(w.events.length, 0);
    await assert.rejects(refused, { message: 'No update to download' });
  });

  test('concurrent downloads share one; download when ready does nothing', async () => {
    const engine = fakeEngine();
    const { u } = make({ engine });
    await u.check();
    const a = u.download();
    const b = u.download();
    assert.equal(a, b);
    assert.equal(engine.downloads, 1);
    engine.pending.resolve();
    await a;
    await u.download();
    assert.equal(engine.downloads, 1);
    assert.equal(u.state.status, 'ready');
  });

  test('failed download can be retried', async () => {
    const engine = fakeEngine();
    const { u, w } = make({ engine });
    await u.check();
    const first = u.download();
    engine.onProgress(30);
    const staleProgress = engine.onProgress;
    engine.pending.reject(new Error('net::ERR_CONNECTION_RESET'));
    await first;
    assert.equal(u.state.status, 'error');
    assert.equal(u.state.error, 'net::ERR_CONNECTION_RESET');
    assert.equal(u.state.progress, null);
    assert.equal(u.state.latest.version, '0.3.1');
    assert.match(w.logs.map((l) => l.join(' ')).join('\n'), /net::ERR_CONNECTION_RESET/);

    const second = u.download();
    assert.equal(u.state.status, 'downloading');
    assert.equal(u.state.error, null);
    staleProgress(77);
    assert.equal(u.state.progress, 0, 'progress from the failed attempt is ignored');
    engine.pending.resolve();
    await second;
    assert.equal(u.state.status, 'ready');
    assert.equal(engine.downloads, 2);
  });

  test('an engine that throws synchronously fails the download and allows a retry', async () => {
    let calls = 0;
    const engine = {
      download: () => {
        calls++;
        if (calls === 1) throw new Error('no feed');
        return Promise.resolve();
      },
      quitAndInstall: () => {},
    };
    const { u } = make({ engine });
    await u.check();
    await u.download();
    assert.equal(u.state.status, 'error');
    assert.equal(u.state.error, 'no feed');
    await u.download();
    assert.equal(u.state.status, 'ready');
    assert.equal(calls, 2);
  });

  test('checks leave a download in progress or ready alone, but still answer', async () => {
    const engine = fakeEngine();
    const { u, w } = make({ engine });
    await u.check();
    const p = u.download();
    const during = w.events.length;

    w.release = rel('0.3.2');
    assert.deepEqual(await u.check({ manual: true }), { result: 'available', version: '0.3.2' });
    await u.tick();
    w.release = rel('0.3.0');
    assert.deepEqual(await u.check({ manual: true }), { result: 'latest' });
    assert.equal(u.state.status, 'downloading');
    assert.equal(u.state.latest.version, '0.3.1');
    assert.equal(w.events.length, during);

    engine.pending.resolve();
    await p;
    w.release = rel('0.3.2');
    await u.tick();
    assert.equal(u.state.status, 'ready');
    assert.equal(u.state.latest.version, '0.3.1');
  });

  test('after a failed download a check keeps the error for that version and moves on for a newer one', async () => {
    const engine = fakeEngine();
    const { u, w } = make({ engine });
    await u.check();
    const p = u.download();
    engine.pending.reject(new Error('disk full'));
    await p;

    await u.tick();
    assert.equal(u.state.status, 'error');
    assert.equal(u.state.error, 'disk full');

    w.release = rel('0.3.2');
    await u.tick();
    assert.equal(u.state.status, 'available');
    assert.equal(u.state.latest.version, '0.3.2');
    assert.equal(u.state.error, null);
  });
});

// restart() answers once the install it starts has been asked for.
const restartedLater = (u, w, opts) => {
  const answer = u.restart(opts);
  fire(w);
  return answer;
};

describe('restart', () => {
  const restarted = restartedLater;

  test('restart asks to confirm while connected, force installs', async () => {
    const { u, w, engine } = await readyToInstall();
    w.connected = 2;
    assert.deepEqual(await u.restart(), { confirm: 2 });
    assert.deepEqual(await u.restart({ force: 'false' }), { confirm: 2 }, 'only a real true forces');
    assert.equal(u.state.status, 'ready', 'a confirm changes nothing');
    assert.equal(w.timers.length, 0);
    assert.equal(engine.installs, 0);
    assert.deepEqual(await restarted(u, w, { force: true }), { ok: true });
    assert.equal(engine.installs, 1);

    const idle = await readyToInstall();
    assert.deepEqual(await restarted(idle.u, idle.w), { ok: true });
    assert.equal(idle.engine.installs, 1);
  });

  test('every window hears "installing" first; the install starts INSTALL_DELAY_MS later', async () => {
    const { u, w, engine } = await readyToInstall();
    const order = [];
    u.on('state', (s) => order.push(s.status));
    engine.quitAndInstall = () => {
      engine.installs++;
      order.push('quitAndInstall');
    };
    let answer = null;
    u.restart().then((a) => (answer = a));
    const installing = {
      status: 'installing',
      current: '0.3.0',
      kind: 'appimage',
      latest: { version: '0.3.1', notes: 'Notes for 0.3.1' },
      progress: null,
      error: null,
      pacmanCommand: null,
    };
    assert.deepEqual(u.state, installing);
    assert.deepEqual(w.events.at(-1), installing);
    assert.deepEqual(order, ['installing'], 'broadcast before anything can block');
    assert.deepEqual(
      w.timers.map((t) => t.ms),
      [INSTALL_DELAY_MS],
    );
    await flush();
    assert.equal(engine.installs, 0);
    assert.equal(answer, null, 'answers only once the install was asked for');

    fire(w);
    await flush();
    assert.deepEqual(answer, { ok: true });
    assert.deepEqual(order, ['installing', 'quitAndInstall']);
    assert.equal(u.state.status, 'installing', 'stays so while the app quits');
  });

  test('the delay is short and, without an injected timer, a real setTimeout', async (t) => {
    assert.ok(INSTALL_DELAY_MS >= 100 && INSTALL_DELAY_MS <= 1000, String(INSTALL_DELAY_MS));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const engine = fakeEngine();
    const { u } = make({ engine, later: undefined });
    await u.check();
    const p = u.download();
    engine.pending.resolve();
    await p;
    const answer = u.restart();
    t.mock.timers.tick(INSTALL_DELAY_MS - 1);
    assert.equal(engine.installs, 0);
    t.mock.timers.tick(1);
    assert.equal(engine.installs, 1);
    assert.deepEqual(await answer, { ok: true });
  });

  test('restart does nothing unless an update is ready', async () => {
    const engine = fakeEngine();
    const { u, w } = make({ engine });
    w.connected = 1;
    assert.deepEqual(await u.restart({ force: true }), { ok: false });
    await u.check();
    assert.deepEqual(await u.restart({ force: true }), { ok: false });
    const p = u.download();
    assert.deepEqual(await u.restart({ force: true }), { ok: false });
    engine.pending.reject(new Error('x'));
    await p;
    assert.deepEqual(await u.restart(), { ok: false });
    assert.equal(w.timers.length, 0);
    assert.equal(engine.installs, 0);
    assert.ok(!w.events.some((s) => s.status === 'installing'));
  });

  test('an install that throws shows its error and can be retried', async () => {
    const { u, w, engine } = await readyToInstall();
    const installOk = engine.quitAndInstall;
    engine.quitAndInstall = () => {
      throw new Error('cannot replace the AppImage');
    };
    assert.deepEqual(await restarted(u, w), { ok: false });
    assert.equal(u.state.status, 'error');
    assert.equal(u.state.error, 'cannot replace the AppImage');
    assert.deepEqual(
      w.events.slice(-2).map((s) => s.status),
      ['installing', 'error'],
    );
    assert.match(w.logs.map((l) => l.join(' ')).join('\n'), /cannot replace the AppImage/);

    engine.quitAndInstall = installOk;
    const p = u.download();
    engine.pending.resolve();
    await p;
    assert.equal(u.state.status, 'ready');
    assert.deepEqual(await restarted(u, w), { ok: true });
    assert.equal(engine.installs, 1, 'the retry installs');
  });

  test('restart installs only once; calls while it is under way get its answer', async () => {
    const { u, w, engine } = await readyToInstall();
    w.connected = 1;
    const first = u.restart({ force: true });
    const again = u.restart({ force: true });
    const unforced = u.restart();
    assert.equal(w.timers.length, 1, 'one install scheduled');
    fire(w);
    assert.deepEqual(await first, { ok: true });
    assert.deepEqual(await again, { ok: true });
    assert.deepEqual(await unforced, { ok: true }, 'already installing: no confirm');
    assert.deepEqual(await u.restart(), { ok: true }, 'nor after it started');
    assert.equal(w.timers.length, 0);
    assert.equal(engine.installs, 1);
  });

  test('while installing, checks, skip and download leave the state alone', async () => {
    const { u, w, engine } = await readyToInstall();
    u.restart();
    const during = w.events.length;
    w.release = rel('0.3.2');
    assert.deepEqual(await u.check({ manual: true }), { result: 'available', version: '0.3.2' });
    await u.tick();
    w.release = rel('0.3.0');
    assert.deepEqual(await u.check({ manual: true }), { result: 'latest' });
    u.skip();
    await u.download();
    assert.equal(engine.downloads, 1);
    assert.equal(w.sets, 0);
    assert.equal(w.events.length, during);
    assert.equal(u.state.status, 'installing');
    assert.equal(u.state.latest.version, '0.3.1');
  });

  // The Windows installer starts in the background (main/updateEngine.js):
  // quitAndInstall() then returns a promise.
  test('an install that starts in the background: installing until it settles; a failure is an error, and Retry works', async () => {
    const { u, w, engine } = await readyToInstall();
    let pending = deferred();
    engine.quitAndInstall = () => {
      engine.installs++;
      return pending.promise;
    };
    let answer = null;
    restartedLater(u, w).then((a) => (answer = a));
    await flush();
    assert.equal(engine.installs, 1);
    assert.equal(answer, null, 'answers once the install started');
    assert.equal(u.state.status, 'installing');
    pending.reject(new Error('The installer did not start within 60 s'));
    await flush();
    assert.deepEqual(answer, { ok: false });
    assert.equal(u.state.status, 'error');
    assert.equal(u.state.error, 'The installer did not start within 60 s');

    const p = u.download();
    engine.pending.resolve();
    await p;
    pending = deferred();
    const retry = restartedLater(u, w);
    pending.resolve();
    assert.deepEqual(await retry, { ok: true });
    assert.equal(engine.installs, 2);
    assert.equal(u.state.status, 'installing');
  });

  test('a listener that throws on "installing" is logged and cannot stop the install', async () => {
    const { u, w, engine } = await readyToInstall();
    u.prependListener('state', (s) => {
      if (s.status === 'installing') throw new Error('window gone');
    });
    let answer;
    assert.doesNotThrow(() => {
      answer = restarted(u, w);
    });
    assert.deepEqual(await answer, { ok: true });
    assert.equal(engine.installs, 1);
    assert.equal(w.events.at(-1).status, 'installing', 'the listener after it heard it');
    assert.ok(w.logs.some((l) => l[0] === 'error' && l.join(' ').includes('window gone')));
  });
});

describe('state listeners', () => {
  // In production the listener is an IPC broadcast, which throws for a destroyed window.
  const failingAt = {
    'download start': (s) => s.status === 'downloading' && s.progress === 0,
    progress: (s) => s.status === 'downloading' && s.progress > 0,
    ready: (s) => s.status === 'ready',
  };
  for (const [name, when] of Object.entries(failingAt)) {
    test(`a listener that throws on ${name} is logged and cannot wedge the download`, async () => {
      const engine = fakeEngine();
      const { u, w } = make({ engine });
      await u.check();
      u.prependListener('state', (s) => {
        if (when(s)) throw new Error(`listener broke on ${name}`);
      });
      let p;
      assert.doesNotThrow(() => {
        p = u.download();
      });
      assert.equal(engine.downloads, 1);
      assert.doesNotThrow(() => engine.onProgress(50));
      assert.equal(u.state.progress, 50);
      engine.pending.resolve();
      await p;
      assert.equal(u.state.status, 'ready');
      assert.deepEqual(
        w.events.map((e) => [e.status, e.progress]),
        [
          ['available', null],
          ['downloading', 0],
          ['downloading', 50],
          ['ready', null],
        ],
        'the listener after the failing one heard every change',
      );
      assert.ok(w.logs.some((l) => l[0] === 'error' && l.join(' ').includes(`listener broke on ${name}`)));

      await u.check();
      const answer = u.restart();
      fire(w);
      assert.deepEqual(await answer, { ok: true });
      assert.equal(engine.installs, 1);
    });
  }
});

describe('start / stop / tick', () => {
  // Fire due intervals, then let the checks they started settle (as they
  // would long before the next one, 6 h later).
  const advance = async (t, ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };

  test('start checks now and every 6 h, skipping while disabled; dev never checks', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { u, w } = make();
    u.start();
    assert.equal(w.fetches, 1, 'checks right away');
    await flush();
    await advance(t, CHECK_INTERVAL_MS - 1);
    assert.equal(w.fetches, 1);
    await advance(t, 1);
    assert.equal(w.fetches, 2);
    assert.equal(u.state.status, 'available');

    w.enabled = false;
    await advance(t, CHECK_INTERVAL_MS);
    await u.tick();
    assert.equal(w.fetches, 2);
    w.enabled = true;
    await advance(t, CHECK_INTERVAL_MS);
    assert.equal(w.fetches, 3);
    u.stop();

    const dev = make({ kind: 'dev' });
    dev.u.start();
    await advance(t, CHECK_INTERVAL_MS * 3);
    assert.equal(dev.w.enabledReads, 0, 'no timer for dev builds');
    await dev.u.tick();
    assert.equal(dev.w.enabledReads, 0, 'tick does nothing for dev builds');
    assert.equal(dev.w.fetches, 0);
    dev.u.stop();
  });

  test('start twice keeps one timer; stop ends it; start again resumes', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { u, w } = make();
    u.start();
    u.start();
    await flush();
    assert.equal(w.fetches, 1);
    await advance(t, CHECK_INTERVAL_MS);
    assert.equal(w.fetches, 2);

    u.stop();
    u.stop();
    await advance(t, CHECK_INTERVAL_MS * 2);
    assert.equal(w.fetches, 2);

    u.start();
    await flush();
    assert.equal(w.fetches, 3);
    await advance(t, CHECK_INTERVAL_MS);
    assert.equal(w.fetches, 4);
    u.stop();
  });

  test('errors inside an automatic check never escape tick', async () => {
    const throwing = make({
      isEnabled: () => {
        throw new Error('settings broke');
      },
    });
    await throwing.u.tick();
    assert.equal(throwing.w.fetches, 0);
    assert.equal(throwing.w.logs[0][0], 'error');
    assert.match(throwing.w.logs[0].join(' '), /settings broke/);

    const { u, w } = make();
    u.on('state', () => {
      throw new Error('broadcast failed');
    });
    await u.tick();
    assert.equal(u.state.status, 'available');
    assert.match(w.logs.map((l) => l.join(' ')).join('\n'), /broadcast failed/);
  });
});
