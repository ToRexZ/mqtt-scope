import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireFromRoot } from './_util.mjs';

const { createJsonStore } = requireFromRoot('./main/jsonStore.js');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttscope-store-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('createJsonStore', () => {
  test('set/get round-trip for every known store', () => {
    const store = createJsonStore(dir);
    const values = {
      savedMessages: [{ topic: 'a', payload: 'é😀 <b>', qos: 1 }],
      plots: [{ id: 'p', series: [{ topic: 't', segs: ['a', 0] }], windowSec: 60 }],
      settings: { historyLimit: 100, historyMB: 64 },
      updates: { skipped: '0.3.1' },
      profileLayouts: { version: 1, byProfile: { a: { version: 2, tabs: [] } }, lastUsed: 'a', legacyProfiles: [] },
      windowState: { windows: [] },
    };
    for (const [name, value] of Object.entries(values)) {
      assert.deepEqual(store.set(name, value), { ok: true });
      assert.deepEqual(store.get(name), value);
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), ['plots.json', 'profileLayouts.json', 'savedMessages.json', 'settings.json', 'updates.json', 'windowState.json']);
  });

  test('scalar and null values round-trip', () => {
    const store = createJsonStore(dir);
    for (const v of [null, 0, 'x', true, []]) {
      store.set('settings', v);
      assert.deepEqual(store.get('settings', 'fallback'), v);
    }
  });

  test('missing file returns the fallback (default null) without creating backups', () => {
    const store = createJsonStore(dir);
    assert.equal(store.get('plots'), null);
    assert.deepEqual(store.get('plots', []), []);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('missing directory: get falls back, set creates it', () => {
    const sub = path.join(dir, 'x', 'y');
    const store = createJsonStore(sub);
    assert.equal(store.get('settings', 7), 7);
    store.set('settings', { a: 1 });
    assert.deepEqual(store.get('settings'), { a: 1 });
  });

  test('corrupt file returns the fallback and keeps a .corrupt-<timestamp> copy', () => {
    const f = path.join(dir, 'savedMessages.json');
    fs.writeFileSync(f, '{"truncated": ');
    const store = createJsonStore(dir);
    assert.deepEqual(store.get('savedMessages', []), []);
    const backups = fs.readdirSync(dir).filter((n) => /^savedMessages\.json\.corrupt-\d+$/.test(n));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{"truncated": ');
  });

  test('unknown store names throw for get and set and touch nothing', () => {
    const store = createJsonStore(dir);
    for (const name of ['profiles', '', '../settings', 'settings.json', '__proto__', 'constructor', 'toString']) {
      assert.throws(() => store.get(name), { message: `Unknown store "${name}"` }, name);
      assert.throws(() => store.set(name, 1), { message: `Unknown store "${name}"` }, name);
    }
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('atomic write: no .tmp left behind and mode 0600', () => {
    const store = createJsonStore(dir);
    store.set('settings', { a: 1 });
    store.set('settings', { a: 2 });
    assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
    assert.deepEqual(store.get('settings'), { a: 2 });
  });

  test('values that JSON cannot represent follow JSON.stringify semantics', () => {
    const store = createJsonStore(dir);
    store.set('settings', { a: undefined, b: NaN, d: new Date(0) });
    assert.deepEqual(store.get('settings'), { b: null, d: '1970-01-01T00:00:00.000Z' });
  });

  test('set throws on unserializable values and leaves the previous file intact', () => {
    const store = createJsonStore(dir);
    store.set('plots', [1]);
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(() => store.set('plots', cyclic), TypeError);
    assert.deepEqual(store.get('plots'), [1]);
    assert.deepEqual(fs.readdirSync(dir), ['plots.json']);
  });
});
