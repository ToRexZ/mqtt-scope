import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../renderer/settings.js';

describe('normalizeSettings', () => {
  test('defaults', () => {
    assert.deepEqual(DEFAULT_SETTINGS, { historyLimit: 100, historyMB: 64 });
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  });

  test('returns a fresh object, never DEFAULT_SETTINGS itself', () => {
    const out = normalizeSettings({});
    assert.notEqual(out, DEFAULT_SETTINGS);
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
      assert.deepEqual(normalizeSettings({ historyLimit: bad, historyMB: bad }), DEFAULT_SETTINGS, String(bad));
    }
    assert.deepEqual(normalizeSettings({ historyLimit: 'x', historyMB: 8 }), { historyLimit: 100, historyMB: 8 });
  });

  test('non-object input falls back to defaults', () => {
    for (const raw of ['str', 42, true, []]) assert.deepEqual(normalizeSettings(raw), DEFAULT_SETTINGS, String(raw));
  });

  test('unknown keys are dropped', () => {
    assert.deepEqual(normalizeSettings({ historyLimit: 5, evil: 1 }), { historyLimit: 5, historyMB: 64 });
    assert.deepEqual(Object.keys(normalizeSettings({ extra: true })).sort(), ['historyLimit', 'historyMB']);
  });

  test('null, empty/blank strings, booleans and arrays are not treated as 0/1', () => {
    // Number(null) === 0, Number('') === 0, Number(true) === 1, Number([]) === 0:
    // an emptied settings field must not silently become the minimum.
    for (const bad of [null, '', '   ', false, true, []]) {
      assert.deepEqual(normalizeSettings({ historyLimit: bad, historyMB: bad }), DEFAULT_SETTINGS, JSON.stringify(bad));
    }
  });
});
