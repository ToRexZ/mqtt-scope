// WindowState: the windows and tabs to reopen at the next launch (no
// Electron, no files).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireFromRoot } from './_util.mjs';

const { WindowState, placeBounds } = requireFromRoot('./main/windowState.js');

const tab = (profileId, connected = true) => ({ profileId, connected });
const B1 = { x: 10, y: 20, width: 1200, height: 800 };
const B2 = { x: 300, y: 40, width: 1000, height: 700 };

test('a reported window is saved with its tabs, active tab and bounds', () => {
  const s = new WindowState(null);
  assert.deepEqual(s.toDoc(), { version: 1, windows: [] });
  s.setBounds(7, B1);
  s.report(7, { tabs: [tab('a'), tab('b', false)], active: 1 });
  s.setBounds(3, B2); // created later, though its id is lower
  s.report(3, { tabs: [tab('c')], active: 0 });
  s.report(9, { tabs: [], active: 0 }); // only New connection tabs: nothing to reopen
  assert.deepEqual(s.toDoc(), {
    version: 1,
    windows: [
      { bounds: B1, tabs: [tab('a'), tab('b', false)], active: 1 },
      { bounds: B2, tabs: [tab('c')], active: 0 },
    ],
  });
  // The latest report and bounds win; the order stays the creation order.
  s.report(7, { tabs: [tab('b', true)], active: 0 });
  s.setBounds(7, { ...B1, width: 900 });
  assert.deepEqual(s.toDoc().windows[0], { bounds: { ...B1, width: 900 }, tabs: [tab('b')], active: 0 });
  // A window whose bounds are not known yet is reopened at the default size.
  s.report(11, { tabs: [tab('d')], active: 0 });
  assert.deepEqual(s.toDoc().windows[2], { bounds: null, tabs: [tab('d')], active: 0 });
});

test('a report keeps only well-formed tabs, and copies them', () => {
  const s = new WindowState(null);
  const tabs = [tab('a'), null, 'b', { profileId: 5 }, { profileId: '' }, { profileId: 'c', connected: 'no' }, tab('d', false)];
  s.report(1, { tabs, active: 9 });
  tabs[0].profileId = 'changed';
  assert.deepEqual(s.toDoc().windows, [{ bounds: null, tabs: [tab('a'), tab('c'), tab('d', false)], active: 2 }]);
  for (const bad of [null, 'x', { tabs: 'x' }, { tabs: [tab('a')], active: -1 }, { tabs: [tab('a')], active: 'x' }]) {
    s.report(2, bad);
    assert.deepEqual(s.toDoc().windows.slice(1), Array.isArray(bad?.tabs) ? [{ bounds: null, tabs: [tab('a')], active: 0 }] : [], JSON.stringify(bad));
  }
});

test('a window closed while others stay open is forgotten; the last one is kept', () => {
  const s = new WindowState(null);
  s.report(1, { tabs: [tab('a')], active: 0 });
  s.report(2, { tabs: [tab('b')], active: 0 });
  s.closed(1, { last: false });
  assert.deepEqual(s.toDoc().windows.map((w) => w.tabs[0].profileId), ['b']);
  s.closed(2, { last: true }); // closing it quits (on macOS the app keeps running)
  assert.deepEqual(s.toDoc().windows.map((w) => w.tabs[0].profileId), ['b']);
  s.closed(99, { last: false }); // never reported
  assert.equal(s.toDoc().windows.length, 1);
});

// macOS: after the last window closed, a window opened from the Dock is what
// is open now.
test('the last window closed is dropped once another window opens', () => {
  const s = new WindowState(null);
  s.report(1, { tabs: [tab('a')], active: 0 });
  s.closed(1, { last: true });
  s.setBounds(2, B2);
  assert.deepEqual(s.toDoc().windows, []);
  s.report(2, { tabs: [tab('b')], active: 0 });
  assert.deepEqual(s.toDoc().windows, [{ bounds: B2, tabs: [tab('b')], active: 0 }]);
});

test('the saved windows are kept until a window reports', () => {
  const saved = { version: 1, windows: [{ bounds: B1, tabs: [tab('a'), tab('gone', false)], active: 1 }] };
  const s = new WindowState(saved);
  assert.deepEqual(s.toDoc(), saved);
  s.setBounds(1, B2);
  assert.deepEqual(s.toDoc(), saved);
  s.report(1, { tabs: [tab('b')], active: 0 });
  assert.deepEqual(s.toDoc(), { version: 1, windows: [{ bounds: B2, tabs: [tab('b')], active: 0 }] });
  for (const bad of [null, 'garbage', { version: 1, windows: 'x' }, { version: 2, windows: [] }]) {
    assert.deepEqual(new WindowState(bad).toDoc(), { version: 1, windows: [] }, JSON.stringify(bad));
  }
});

test('restorable drops deleted profiles, empty windows and malformed input', () => {
  const ids = new Set(['a', 'b', 'c']);
  const doc = {
    version: 1,
    windows: [
      { bounds: B1, tabs: [tab('a'), tab('gone'), tab('b', false)], active: 0 },
      { bounds: B2, tabs: [tab('gone')], active: 0 }, // nothing left: no window
      { bounds: { width: 'x' }, tabs: [tab('c'), tab('a')], active: 0 }, // a profile is in one tab only
      null,
      { tabs: 'x' },
    ],
  };
  assert.deepEqual(WindowState.restorable(doc, ids), [
    { bounds: B1, tabs: [tab('a'), tab('b', false)], active: 0 },
    { bounds: null, tabs: [tab('c')], active: 0 },
  ]);
  // Only a size: the system places it.
  assert.deepEqual(WindowState.restorable({ version: 1, windows: [{ bounds: { width: 1000, height: 700, x: 'a' }, tabs: [tab('a')] }] }, ids), [
    { bounds: { width: 1000, height: 700 }, tabs: [tab('a')], active: 0 },
  ]);
  const cyclic = { version: 1, windows: [] };
  cyclic.windows.push(cyclic);
  for (const bad of [undefined, null, 0, 'garbage', [], {}, { version: 2, windows: doc.windows }, { version: 1, windows: {} }, cyclic]) {
    assert.deepEqual(WindowState.restorable(bad, ids), [], JSON.stringify(bad === cyclic ? 'cyclic' : bad));
  }
  const throwing = { version: 1, get windows() {
    throw new Error('boom');
  } };
  assert.deepEqual(WindowState.restorable(throwing, ids), []);
  assert.deepEqual(WindowState.restorable(doc, new Set()), []);
});

test('active is clamped to the restored tabs', () => {
  const ids = new Set(['a', 'b', 'c']);
  const one = (tabs, active) => WindowState.restorable({ version: 1, windows: [{ bounds: B1, tabs, active }] }, ids)[0].active;
  assert.equal(one([tab('a'), tab('b'), tab('c')], 2), 2);
  assert.equal(one([tab('a'), tab('gone'), tab('c')], 2), 1, 'the same tab, one place left');
  assert.equal(one([tab('a'), tab('gone'), tab('c')], 1), 1, 'its right neighbour');
  assert.equal(one([tab('a'), tab('b'), tab('gone')], 2), 1, 'else its left neighbour');
  assert.equal(one([tab('a'), tab('b')], 7), 1);
  for (const bad of [-1, 1.5, '1', null, undefined]) assert.equal(one([tab('a'), tab('b')], bad), 0, String(bad));
});

test('a saved position off every display is dropped; the size is kept', () => {
  const screens = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: 1920, y: 0, width: 1280, height: 1024 },
  ];
  const at = (x, y) => ({ x, y, width: 1200, height: 800 });
  assert.deepEqual(placeBounds(at(100, 50), screens), at(100, 50));
  assert.deepEqual(placeBounds(at(2500, 300), screens), at(2500, 300), 'on the second display');
  assert.deepEqual(placeBounds(at(-1100, 10), screens), at(-1100, 10), 'mostly off, its title bar partly on');
  for (const [x, y] of [
    [3300, 100], // right of both
    [-1180, 10], // too little of it on screen to drag
    [100, -500], // its title bar above the screens
    [100, 1100], // below
  ]) {
    assert.deepEqual(placeBounds(at(x, y), screens), { width: 1200, height: 800 }, `${x},${y}`);
  }
  assert.deepEqual(placeBounds({ width: 1000, height: 700 }, screens), { width: 1000, height: 700 });
  assert.equal(placeBounds(null, screens), null);
});

test('a maximized or full-screen window is saved and restored as such, with its normal bounds', () => {
  const s = new WindowState(null);
  s.setBounds(1, B1, { maximized: true });
  s.report(1, { tabs: [tab('a')], active: 0 });
  s.setBounds(2, B2, { fullScreen: true, maximized: false });
  s.report(2, { tabs: [tab('b')], active: 0 });
  s.setBounds(3, B2, { maximized: 'yes', fullScreen: 1 }); // only true counts
  s.report(3, { tabs: [tab('c')], active: 0 });
  const doc = s.toDoc();
  assert.deepEqual(doc.windows, [
    { bounds: B1, maximized: true, tabs: [tab('a')], active: 0 },
    { bounds: B2, fullScreen: true, tabs: [tab('b')], active: 0 },
    { bounds: B2, tabs: [tab('c')], active: 0 },
  ]);
  // Restored back to normal: the flag goes.
  s.setBounds(1, B1, { maximized: false });
  assert.deepEqual(s.toDoc().windows[0], { bounds: B1, tabs: [tab('a')], active: 0 });
  s.setBounds(1, B1);
  assert.equal('maximized' in s.toDoc().windows[0], false);

  const ids = new Set(['a', 'b', 'c']);
  assert.deepEqual(WindowState.restorable(doc, ids), doc.windows);
  // Kept as saved until a window reports.
  assert.deepEqual(new WindowState(doc).toDoc(), doc);
  const odd = { version: 1, windows: [{ bounds: B1, maximized: 'true', fullScreen: null, tabs: [tab('a')], active: 0 }] };
  assert.deepEqual(WindowState.restorable(odd, ids), [{ bounds: B1, tabs: [tab('a')], active: 0 }]);
});

test('a saved size larger than the display it opens on is made to fit', () => {
  const screens = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: 1920, y: 0, width: 1280, height: 984 },
  ];
  const big = (x, y) => ({ x, y, width: 2400, height: 1300 });
  assert.deepEqual(placeBounds(big(100, 0), screens), { x: 100, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(placeBounds(big(2000, 20), screens), { x: 2000, y: 20, width: 1280, height: 984 }, 'the second display');
  // Placed by the system: on the primary display.
  assert.deepEqual(placeBounds(big(9000, 0), screens, screens[1]), { width: 1280, height: 984 });
  assert.deepEqual(placeBounds({ width: 2400, height: 1300 }, screens), { width: 1920, height: 1040 }, 'the first one, without a primary');
  assert.deepEqual(placeBounds({ width: 2400, height: 1300 }, []), { width: 2400, height: 1300 }, 'no display known');
  // A size that fits is kept.
  assert.deepEqual(placeBounds({ x: 1950, y: 10, width: 1200, height: 900 }, screens), { x: 1950, y: 10, width: 1200, height: 900 });
});
