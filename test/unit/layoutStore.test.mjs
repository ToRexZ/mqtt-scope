// Plot layouts per profile over an in-memory store (no files, no Electron).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireFromRoot } from './_util.mjs';

const { createLayoutStore } = requireFromRoot('./main/layoutStore.js');

// Like main/jsonStore.js: values go in and come out as copies; null when absent.
function fakeStores(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  return {
    data,
    writes,
    get: (name) => (name in data ? structuredClone(data[name]) : null),
    set(name, value) {
      writes.push(name);
      data[name] = structuredClone(value);
      return { ok: true };
    },
  };
}

const doc = (name) => ({ version: 2, tabs: [{ id: name, name, plots: [] }], activeTabId: name });
const globalDocs = { plotTabs: doc('global'), plots: { plots: [] } };

function setup({ initial = globalDocs, ids = ['a', 'b'] } = {}) {
  const stores = fakeStores(initial);
  const errors = [];
  const layouts = createLayoutStore({ stores, profileIds: () => ids, log: { error: (...args) => errors.push(args) } });
  layouts.migrate();
  return { stores, layouts, errors };
}

test('migration remembers which profiles existed', () => {
  const { stores, layouts } = setup();
  assert.deepEqual(stores.data.profileLayouts, { version: 1, byProfile: {}, lastUsed: null, legacyProfiles: ['a', 'b'] });
  // Only once: profiles made later are not taken for old ones.
  layouts.set('a', doc('A'));
  createLayoutStore({ stores, profileIds: () => ['a', 'b', 'c'] }).migrate();
  assert.deepEqual(stores.data.profileLayouts.legacyProfiles, ['a', 'b']);
  assert.deepEqual(stores.data.profileLayouts.byProfile, { a: doc('A') });
  assert.ok(!stores.writes.includes('plotTabs') && !stores.writes.includes('plots'));
});

test('a profile from before the upgrade starts with the global layout', () => {
  const { stores, layouts } = setup();
  layouts.set('a', doc('A'));
  layouts.get('a'); // last used
  assert.deepEqual(layouts.get('b'), { doc: globalDocs.plotTabs, legacy: globalDocs.plots });
  assert.deepEqual(layouts.get('a'), { doc: doc('A'), legacy: null });
  assert.ok(!stores.writes.includes('plotTabs') && !stores.writes.includes('plots'));
});

test('a new profile starts with a copy of the last used layout', () => {
  const { stores, layouts } = setup({ ids: ['a', 'b', 'c'] });
  layouts.set('a', doc('A'));
  layouts.set('b', doc('B'));
  layouts.get('b');
  layouts.get('a');
  assert.equal(stores.data.profileLayouts.lastUsed, 'a');
  assert.deepEqual(layouts.get('new'), { doc: doc('A'), legacy: null });
  assert.equal(stores.data.profileLayouts.lastUsed, 'new');
  // The copy is the new profile's own: saving it leaves the original as it was.
  layouts.set('new', doc('New'));
  assert.deepEqual(layouts.get('a'), { doc: doc('A'), legacy: null });
  // Copies of copies: b3 starts with b2's, a copy of A's.
  layouts.get('b2');
  assert.deepEqual(layouts.get('b3'), { doc: doc('A'), legacy: null });
  // The last used profile has no layout of its own (one from before the
  // upgrade that never saved): the global one, which is not copied.
  layouts.get('c');
  assert.deepEqual(layouts.get('b4'), { doc: globalDocs.plotTabs, legacy: globalDocs.plots });
  assert.ok(!Object.hasOwn(stores.data.profileLayouts.byProfile, 'b4'));
  assert.ok(!stores.writes.includes('plotTabs') && !stores.writes.includes('plots'));
});

test('a copied layout is kept from the first opening on', () => {
  const { stores, layouts } = setup();
  layouts.set('a', doc('A'));
  layouts.get('a');
  const first = layouts.get('x');
  assert.deepEqual(first, { doc: doc('A'), legacy: null });
  assert.deepEqual(stores.data.profileLayouts.byProfile.x, doc('A'));
  // Opened again (Retry, or a new tab) before anything was changed: the same.
  assert.deepEqual(layouts.get('x'), first);
  assert.deepEqual(layouts.get('x'), first);
  // A profile opened after x starts with x's.
  layouts.set('x', doc('X'));
  assert.deepEqual(layouts.get('y'), { doc: doc('X'), legacy: null });
});

test('a layout is read even when remembering it cannot be written', () => {
  const { stores, layouts, errors } = setup();
  layouts.set('a', doc('A'));
  layouts.get('a');
  stores.set = () => {
    throw new Error('disk full');
  };
  assert.deepEqual(layouts.get('x'), { doc: doc('A'), legacy: null });
  assert.deepEqual(layouts.get('b'), { doc: globalDocs.plotTabs, legacy: globalDocs.plots });
  assert.equal(errors.length, 2);
  assert.match(String(errors[0][1]), /disk full/);
  // Saving still reports it (the plots panel says it could not save).
  assert.throws(() => layouts.set('a', doc('A2')), /disk full/);
});

test('set and get round-trip; other profiles are untouched', () => {
  const { stores, layouts } = setup();
  layouts.set('a', doc('A'));
  layouts.set('b', doc('B'));
  layouts.set('a', doc('A2'));
  assert.deepEqual(layouts.get('a'), { doc: doc('A2'), legacy: null });
  assert.deepEqual(layouts.get('b'), { doc: doc('B'), legacy: null });
  assert.deepEqual(Object.keys(stores.data.profileLayouts.byProfile).sort(), ['a', 'b']);
  // Each write is a read-modify-write of the stored document: another
  // layout store over the same data (as after a restart) sees both.
  const again = createLayoutStore({ stores, profileIds: () => [] });
  assert.deepEqual(again.get('b'), { doc: doc('B'), legacy: null });
  // Ids are names, never object keys with a meaning.
  layouts.set('__proto__', doc('P'));
  assert.deepEqual(layouts.get('__proto__'), { doc: doc('P'), legacy: null });
  assert.deepEqual(layouts.get('constructor'), { doc: doc('P'), legacy: null }); // a copy of the last used
  assert.throws(() => layouts.set('', doc('X')));
  assert.throws(() => layouts.get(7));
  assert.throws(() => layouts.set('a', null));
});

test('removing a profile removes its layout and clears lastUsed', () => {
  const { stores, layouts } = setup();
  layouts.set('a', doc('A'));
  layouts.set('b', doc('B'));
  layouts.get('a');
  layouts.remove(['a']);
  assert.deepEqual(stores.data.profileLayouts, { version: 1, byProfile: { b: doc('B') }, lastUsed: null, legacyProfiles: ['b'] });
  // A legacy profile with no layout of its own is no longer one.
  const { stores: s2, layouts: l2 } = setup();
  l2.get('b');
  l2.remove(['b', 'gone']);
  assert.deepEqual(s2.data.profileLayouts, { version: 1, byProfile: {}, lastUsed: null, legacyProfiles: ['a'] });
  // Nothing to remove writes nothing.
  const count = s2.writes.length;
  l2.remove([]);
  l2.remove(['unknown']);
  assert.equal(s2.writes.length, count);
});

test('no saved plots at all gives null documents', () => {
  const { layouts } = setup({ initial: {} });
  assert.deepEqual(layouts.get('a'), { doc: null, legacy: null });
  assert.deepEqual(layouts.get('new'), { doc: null, legacy: null });
  // Without the migration (e.g. it could not be written) a profile still gets one.
  const bare = createLayoutStore({ stores: fakeStores({}), profileIds: () => ['a'] });
  assert.deepEqual(bare.get('a'), { doc: null, legacy: null });
});
