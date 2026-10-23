import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings as normalizeAll } from '../../renderer/settings.js';

// These tests cover the numeric limits; the switches and keys are tested below.
const normalizeSettings = (raw) => {
  const { historyLimit, historyMB } = normalizeAll(raw);
  return { historyLimit, historyMB };
};
const NUMERIC_DEFAULTS = { historyLimit: DEFAULT_SETTINGS.historyLimit, historyMB: DEFAULT_SETTINGS.historyMB };

describe('normalizeSettings', () => {
  test('defaults', () => {
    assert.deepEqual(DEFAULT_SETTINGS, { historyLimit: 100, historyMB: 64, autoExpand: true, checkForUpdates: true, keys: {} });
    assert.deepEqual(normalizeAll(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeAll(null), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeAll({}), DEFAULT_SETTINGS);
  });

  test('returns a fresh object, never DEFAULT_SETTINGS itself', () => {
    const out = normalizeAll({});
    assert.notEqual(out, NUMERIC_DEFAULTS);
    assert.notEqual(out.keys, DEFAULT_SETTINGS.keys);
    out.historyLimit = 1;
    assert.equal(DEFAULT_SETTINGS.historyLimit, 100);
  });

  test('valid values pass through', () => {
    assert.deepEqual(normalizeSettings({ historyLimit: 500, historyMB: 128 }), { historyLimit: 500, historyMB: 128 });
  });

  test('numeric strings (as from <input type=number>) are accepted', () => {
    assert.deepEqual(normalizeSettings({ historyLimit: '250', historyMB: ' 32 ' }), { historyLimit: 250, historyMB: 32 });
    assert.equal(normalizeSettings({ historyLimit: '1e3' }).historyLimit, 1000);
  });

  test('clamped to limits', () => {
    assert.deepEqual(normalizeSettings({ historyLimit: 0, historyMB: 0 }), { historyLimit: 1, historyMB: 1 });
    assert.deepEqual(normalizeSettings({ historyLimit: -5, historyMB: -1 }), { historyLimit: 1, historyMB: 1 });
    assert.deepEqual(normalizeSettings({ historyLimit: 1e9, historyMB: 1e9 }), { historyLimit: 10000, historyMB: 4096 });
    assert.deepEqual(normalizeSettings({ historyLimit: 10000, historyMB: 4096 }), { historyLimit: 10000, historyMB: 4096 });
    assert.deepEqual(normalizeSettings({ historyLimit: 1, historyMB: 1 }), { historyLimit: 1, historyMB: 1 });
  });

  test('rounded to integers', () => {
    assert.deepEqual(normalizeSettings({ historyLimit: 2.4, historyMB: 2.5 }), { historyLimit: 2, historyMB: 3 });
    assert.equal(normalizeSettings({ historyLimit: 0.4 }).historyLimit, 1, 'rounds then clamps');
    assert.equal(normalizeSettings({ historyLimit: 10000.4 }).historyLimit, 10000);
  });

  test('non-numeric garbage falls back to defaults per key', () => {
    for (const bad of ['abc', NaN, Infinity, -Infinity, {}, '1e9999', undefined, () => 1, Symbol.iterator.description]) {
      assert.deepEqual(normalizeSettings({ historyLimit: bad, historyMB: bad }), NUMERIC_DEFAULTS, String(bad));
    }
    assert.deepEqual(normalizeSettings({ historyLimit: 'x', historyMB: 8 }), { historyLimit: 100, historyMB: 8 });
  });

  test('non-object input falls back to defaults', () => {
    for (const raw of ['str', 42, true, []]) assert.deepEqual(normalizeSettings(raw), NUMERIC_DEFAULTS, String(raw));
  });

  test('unknown keys are dropped', () => {
    assert.deepEqual(normalizeSettings({ historyLimit: 5, evil: 1 }), { historyLimit: 5, historyMB: 64 });
    assert.deepEqual(Object.keys(normalizeSettings({ extra: true })).sort(), ['historyLimit', 'historyMB']);
  });

  test('null, empty/blank strings, booleans and arrays are not treated as 0/1', () => {
    // Number(null) === 0, Number('') === 0, Number(true) === 1, Number([]) === 0:
    // an emptied settings field must not silently become the minimum.
    for (const bad of [null, '', '   ', false, true, []]) {
      assert.deepEqual(normalizeSettings({ historyLimit: bad, historyMB: bad }), NUMERIC_DEFAULTS, JSON.stringify(bad));
    }
  });
});

describe('normalizeSettings: switches and keyboard shortcuts', () => {
  test('autoExpand defaults to true and only accepts booleans', () => {
    assert.equal(normalizeAll({}).autoExpand, true);
    assert.equal(normalizeAll({ autoExpand: false }).autoExpand, false);
    assert.equal(normalizeAll({ autoExpand: 'false' }).autoExpand, true);
    assert.equal(normalizeAll({ autoExpand: 0 }).autoExpand, true);
  });
  // Main reads it from settings.json (off only when exactly false), so a
  // saved Settings dialog must keep it.
  test('checkForUpdates defaults to true, keeps false, and only accepts booleans', () => {
    assert.equal(normalizeAll({}).checkForUpdates, true);
    assert.equal(normalizeAll({ checkForUpdates: false }).checkForUpdates, false);
    assert.equal(normalizeAll({ checkForUpdates: true }).checkForUpdates, true);
    for (const bad of ['false', 0, null, 'off', [], {}]) assert.equal(normalizeAll({ checkForUpdates: bad }).checkForUpdates, true, JSON.stringify(bad));
    assert.equal(normalizeAll({ checkForUpdates: false, historyLimit: 5 }).checkForUpdates, false, 'kept alongside other settings');
  });
  test('keys keeps overrides of known actions that differ from the default', () => {
    const k = normalizeAll({ keys: { connections: 'Mod+J', settings: 'Mod+,', bogus: 'Mod+B', clear: '', find: 5 } }).keys;
    assert.deepEqual(k, { connections: 'Mod+J' });
    assert.deepEqual(normalizeAll({ keys: 'nope' }).keys, {});
  });
  test('unbinding an action with a default is kept', () => {
    assert.deepEqual(normalizeAll({ keys: { maximize: '' } }).keys, { maximize: '' });
  });
});
