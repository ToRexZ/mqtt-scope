// How the tab strip uses its width: brand, tab widths, scrolling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripLayout, MIN_TAB } from '../../renderer/tabLayout.js';

const base = { brandFull: 120, brandIcon: 30, plus: 30 };

test('everything fits: full brand, natural widths', () => {
  assert.deepEqual(stripLayout({ ...base, available: 600, tabs: [100, 150, 200] }), { brand: 'full', maxTab: null, scroll: false });
});

test('the brand collapses before any tab shrinks', () => {
  // 450 + 120 + 30 > 590, but 450 + 30 + 30 fits.
  assert.deepEqual(stripLayout({ ...base, available: 590, tabs: [150, 150, 150] }), { brand: 'icon', maxTab: null, scroll: false });
});

test('short tabs keep their width, long ones share the rest', () => {
  assert.deepEqual(stripLayout({ ...base, available: 600, tabs: [80, 400, 400] }), { brand: 'icon', maxTab: 230, scroll: false });
});

test('below the minimum the strip scrolls', () => {
  assert.deepEqual(stripLayout({ ...base, available: 900, tabs: Array(12).fill(200) }), { brand: 'icon', maxTab: MIN_TAB, scroll: true });
});

test('no tabs: nothing to shrink', () => {
  assert.deepEqual(stripLayout({ ...base, available: 100, tabs: [] }), { brand: 'icon', maxTab: null, scroll: false });
});
