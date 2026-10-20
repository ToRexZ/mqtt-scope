// Plot tabs: sanitising, migration from the older layouts format, the split
// layout that fills a tab (arranging, moving plots), and splitter resizing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT_FORMAT,
  sanitizePlot,
  sanitizeTab,
  newTab,
  migratePlotsDoc,
  autoColumns,
  gridShape,
  normalizeWeights,
  layoutLeaves,
  sanitizeLayoutTree,
  autoLayout,
  syncLayout,
  removeFromLayout,
  moveInLayout,
  withFreshIds,
  resizeWeights,
  layoutFile,
  parseLayoutFile,
} from '../../renderer/plotLayouts.js';

const plot = (title, topic = 't') => ({ title, series: [{ topic }] });

describe('plot kind', () => {
  test('time grid lines: on unless turned off (older saved plots get them)', () => {
    assert.equal(sanitizePlot(plot('A')).timeGrid, true);
    assert.equal(sanitizePlot({ ...plot('A'), timeGrid: false }).timeGrid, false);
  });
  test('defaults to time series, keeps states, rejects unknown kinds', () => {
    assert.equal(sanitizePlot(plot('A')).kind, 'timeseries');
    assert.equal(sanitizePlot({ ...plot('A'), kind: 'states' }).kind, 'states');
    assert.equal(sanitizePlot({ ...plot('A'), kind: 'pie' }).kind, 'timeseries');
  });
});

describe('sanitizeTab', () => {
  test('fills defaults and validates columns and layout', () => {
    const t = sanitizeTab({
      id: 'x',
      name: '  Safety ',
      columns: 2,
      layout: { dir: 'row', children: ['a', 'gone'], sizes: [1, 1] },
      plots: [{ ...plot('A'), id: 'a' }, { nope: 1 }],
    });
    assert.equal(t.id, 'x');
    assert.equal(t.name, 'Safety');
    assert.equal(t.columns, 2);
    assert.equal(t.layout, 'a', 'unknown plots leave the layout; a lone child is lifted');
    assert.equal(t.plots.length, 1);
  });
  test('falls back for bad values', () => {
    const t = sanitizeTab({ name: '', columns: 9, layout: 'x' }, 'Fallback');
    assert.equal(t.name, 'Fallback');
    assert.equal(t.columns, 0);
    assert.equal(t.layout, null);
    assert.ok(t.id);
    assert.equal(sanitizeTab(null), null);
  });
  test('newTab', () => {
    const t = newTab('A');
    assert.deepEqual({ ...t, id: 'id' }, { id: 'id', name: 'A', columns: 0, layout: null, plots: [] });
  });
});

describe('migratePlotsDoc', () => {
  test('nothing saved gives one empty tab', () => {
    for (const doc of [null, undefined, {}, { plots: 'bad' }]) {
      const { tabs, activeTabId } = migratePlotsDoc(doc);
      assert.equal(tabs.length, 1);
      assert.equal(tabs[0].name, 'Plots');
      assert.equal(activeTabId, tabs[0].id);
    }
  });
  test('current tabs format is kept; a missing active tab falls back to the first', () => {
    const doc = { tabs: [{ id: 'a', name: 'A', plots: [plot('1')] }, { id: 'b', name: 'B', plots: [] }], activeTabId: 'b' };
    const m = migratePlotsDoc(doc);
    assert.deepEqual(m.tabs.map((t) => t.name), ['A', 'B']);
    assert.equal(m.activeTabId, 'b');
    assert.equal(migratePlotsDoc({ ...doc, activeTabId: 'gone' }).activeTabId, 'a');
    assert.equal(migratePlotsDoc({ tabs: [] }).tabs.length, 1);
  });
  test('older working plots without layouts become one tab', () => {
    const m = migratePlotsDoc({ plots: [plot('Battery')] });
    assert.deepEqual(m.tabs.map((t) => [t.name, t.plots.map((p) => p.title)]), [['Plots', ['Battery']]]);
  });
  test('every saved layout becomes a tab; the active one keeps its name and the working plots', () => {
    const m = migratePlotsDoc({
      plots: [plot('Edited')],
      layouts: [
        { id: 'l1', name: 'Robot', plots: [plot('Original')] },
        { id: 'l2', name: 'Other', plots: [plot('Other plot')] },
      ],
      activeLayoutId: 'l1',
    });
    assert.deepEqual(
      m.tabs.map((t) => [t.name, t.plots.map((p) => p.title)]),
      [
        ['Robot', ['Edited']],
        ['Robot (saved)', ['Original']],
        ['Other', ['Other plot']],
      ],
    );
    assert.equal(m.activeTabId, m.tabs[0].id);
  });
  test('an unchanged active layout is not duplicated', () => {
    const m = migratePlotsDoc({ plots: [plot('Same')], layouts: [{ id: 'l1', name: 'Robot', plots: [plot('Same')] }], activeLayoutId: 'l1' });
    assert.deepEqual(m.tabs.map((t) => t.name), ['Robot']);
  });
  test('layouts without working plots each become a tab', () => {
    const m = migratePlotsDoc({ plots: [], layouts: [{ id: 'l1', name: 'A', plots: [plot('x')] }, { id: 'l2', name: 'B', plots: [] }], activeLayoutId: 'l1' });
    assert.deepEqual(m.tabs.map((t) => t.name), ['A', 'B']);
  });
});

describe('grid', () => {
  test('auto columns: stacked for a few plots, then 2 and 3 per row', () => {
    assert.deepEqual([1, 2, 3, 4, 8, 9, 20].map(autoColumns), [1, 1, 1, 2, 2, 3, 3]);
  });
  test('gridShape never has more columns than plots', () => {
    assert.deepEqual(gridShape(0), { cols: 1, rows: 0 });
    assert.deepEqual(gridShape(1, 4), { cols: 1, rows: 1 });
    assert.deepEqual(gridShape(5, 2), { cols: 2, rows: 3 });
    assert.deepEqual(gridShape(4), { cols: 2, rows: 2 });
    assert.deepEqual(gridShape(3, 3), { cols: 3, rows: 1 });
  });
});

describe('split layout', () => {
  const col = (children, sizes = children.map(() => 1)) => ({ dir: 'col', children, sizes });
  const row = (children, sizes = children.map(() => 1)) => ({ dir: 'row', children, sizes });

  test('autoLayout stacks a few plots (heavier ones taller) and puts more in rows', () => {
    assert.equal(autoLayout([]), null);
    assert.equal(autoLayout(['a']), 'a');
    assert.deepEqual(autoLayout(['a', 'b'], 0, (id) => (id === 'a' ? 3 : 1)), col(['a', 'b'], [3, 1]));
    assert.deepEqual(autoLayout(['a', 'b', 'c', 'd', 'e'], 2), col([row(['a', 'b']), row(['c', 'd']), 'e']));
    assert.deepEqual(autoLayout(['a', 'b', 'c'], 3), row(['a', 'b', 'c']));
  });

  test('sanitizeLayoutTree drops unknown and repeated plots, empty and single-child splits', () => {
    assert.equal(sanitizeLayoutTree(null, ['a']), null);
    assert.equal(sanitizeLayoutTree('a', ['a']), 'a');
    assert.equal(sanitizeLayoutTree('z', ['a']), null);
    assert.deepEqual(sanitizeLayoutTree(row(['a', 'a', 'b']), ['a', 'b']), row(['a', 'b']));
    assert.deepEqual(sanitizeLayoutTree(col([row([]), 'a', row(['b'])]), ['a', 'b']), col(['a', 'b']));
    assert.equal(sanitizeLayoutTree({ dir: 'diagonal', children: ['a'] }, ['a']), null);
  });

  test('sanitizeLayoutTree repairs sizes and merges a split into a parent of the same direction', () => {
    assert.deepEqual(sanitizeLayoutTree({ dir: 'row', children: ['a', 'b'], sizes: [2, -1] }, ['a', 'b']), row(['a', 'b'], [2, 1]));
    assert.deepEqual(sanitizeLayoutTree(row([row(['a', 'b'], [1, 3]), 'c'], [2, 1]), ['a', 'b', 'c']), row(['a', 'b', 'c'], [0.5, 1.5, 1]));
  });

  test('syncLayout keeps the arrangement, removes deleted plots and adds new ones at the bottom', () => {
    const t = col([row(['a', 'b']), 'c'], [2, 1]);
    assert.deepEqual(syncLayout(t, ['a', 'b', 'c']), t);
    assert.deepEqual(syncLayout(t, ['a', 'c']), col(['a', 'c'], [2, 1]));
    assert.deepEqual(syncLayout(t, ['a', 'b', 'c', 'd']), col([row(['a', 'b']), 'c', 'd'], [2, 1, 1.5]));
    assert.deepEqual(syncLayout(row(['a', 'b']), ['a', 'b', 'c']), col([row(['a', 'b']), 'c']));
    assert.deepEqual(syncLayout(null, ['a', 'b']), col(['a', 'b']));
  });

  test('removeFromLayout collapses what is left', () => {
    assert.equal(removeFromLayout(row(['a', 'b']), 'a'), 'b');
    assert.equal(removeFromLayout('a', 'a'), null);
  });

  test('moving onto an edge splits the target; the same direction becomes a sibling', () => {
    const t = col(['a', 'b', 'c']);
    assert.deepEqual(moveInLayout(t, 'c', 'a', 'left'), col([row(['c', 'a']), 'b'], [1, 1]));
    assert.deepEqual(moveInLayout(t, 'c', 'a', 'right'), col([row(['a', 'c']), 'b'], [1, 1]));
    assert.deepEqual(moveInLayout(t, 'c', 'a', 'top'), col(['c', 'a', 'b'], [0.5, 0.5, 1]));
    assert.deepEqual(moveInLayout(t, 'a', 'c', 'bottom'), col(['b', 'c', 'a'], [1, 0.5, 0.5]));
    assert.deepEqual(moveInLayout('a', 'a', 'a', 'left'), 'a');
  });

  test('moving onto the middle swaps; unknown plots change nothing', () => {
    const t = col([row(['a', 'b']), 'c'], [2, 1]);
    assert.deepEqual(moveInLayout(t, 'a', 'c', 'center'), col([row(['c', 'b']), 'a'], [2, 1]));
    assert.equal(moveInLayout(t, 'a', 'zz', 'left'), t);
  });

  test('every move keeps each plot exactly once', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    let t = autoLayout(ids, 2);
    let seed = 7;
    const rnd = (n) => ((seed = (seed * 16807) % 2147483647) % n);
    for (let i = 0; i < 300; i++) {
      t = moveInLayout(t, ids[rnd(5)], ids[rnd(5)], ['left', 'right', 'top', 'bottom', 'center'][rnd(5)]);
      assert.deepEqual(layoutLeaves(t).sort(), ids);
      assert.deepEqual(sanitizeLayoutTree(t, ids), t, 'stays normalised');
    }
  });

  test('withFreshIds copies plots and their arrangement under new ids', () => {
    const plots = [{ ...plot('A'), id: 'a' }, { ...plot('B'), id: 'b' }];
    const { plots: copy, layout } = withFreshIds(plots, row(['b', 'a'], [2, 1]));
    assert.deepEqual(copy.map((p) => p.title), ['A', 'B']);
    assert.ok(copy.every((p) => p.id !== 'a' && p.id !== 'b'));
    assert.deepEqual(layout, row([copy[1].id, copy[0].id], [2, 1]));
    assert.equal(withFreshIds(plots, null).layout, null);
  });
});

describe('weights', () => {
  test('normalizeWeights keeps fitting weights (scaled) and resets the rest to equal', () => {
    assert.deepEqual(normalizeWeights([2, 2], 2), [1, 1]);
    assert.deepEqual(normalizeWeights([1, 3], 2), [0.5, 1.5]);
    assert.deepEqual(normalizeWeights([1, 1], 3), [1, 1, 1]);
    assert.deepEqual(normalizeWeights(null, 2), [1, 1]);
    assert.deepEqual(normalizeWeights([1, 0], 2), [1, 1]);
  });
  test('resizeWeights moves one boundary and keeps the pair total', () => {
    const w = resizeWeights([1, 1, 1], [300, 300, 300], 0, 60, 100);
    assert.equal(w[2], 1, 'other tracks are untouched');
    assert.ok(Math.abs(w[0] + w[1] - 2) < 1e-9);
    assert.ok(Math.abs(w[0] / w[1] - 360 / 240) < 1e-9);
  });
  test('resizeWeights stops at the minimum size on both sides', () => {
    const grow = resizeWeights([1, 1], [400, 400], 0, 1000, 300);
    assert.ok(Math.abs(grow[0] / grow[1] - 500 / 300) < 1e-9);
    const shrink = resizeWeights([1, 1], [400, 400], 0, -1000, 300);
    assert.ok(Math.abs(shrink[0] / shrink[1] - 300 / 500) < 1e-9);
  });
  test('resizeWeights with tracks smaller than twice the minimum splits evenly at most', () => {
    const w = resizeWeights([1, 1], [100, 100], 0, 500, 300);
    assert.ok(w.every((x) => Number.isFinite(x) && x > 0));
  });
  test('resizeWeights can keep a different minimum on each side', () => {
    const w = resizeWeights([1, 1], [400, 400], 0, -1000, [250, 100]);
    assert.ok(Math.abs(w[0] / w[1] - 250 / 550) < 1e-9);
    const v = resizeWeights([1, 1], [400, 400], 0, 1000, [250, 100]);
    assert.ok(Math.abs(v[0] / v[1] - 700 / 100) < 1e-9);
  });
  test('resizeWeights ignores an invalid boundary', () => {
    assert.deepEqual(resizeWeights([1, 1], [100, 100], 1, 50, 10), [1, 1]);
  });
});

describe('tab files', () => {
  test('columns and arrangement round-trip and default to auto', () => {
    const plots = [sanitizePlot({ ...plot('A'), id: 'a', kind: 'states' }), sanitizePlot({ ...plot('B'), id: 'b' })];
    const back = parseLayoutFile(layoutFile('Safety', plots, 3, { dir: 'row', children: ['b', 'a'], sizes: [1, 2] }));
    assert.equal(back.columns, 3);
    assert.deepEqual(back.layout, { dir: 'row', children: ['b', 'a'], sizes: [1, 2] });
    assert.equal(back.plots[0].kind, 'states');
    const old = parseLayoutFile(JSON.stringify({ format: LAYOUT_FORMAT, version: 1, name: 'Old', plots }));
    assert.equal(old.columns, 0);
  });
});

describe('files written for both versions', () => {
  test('a saved document with tabs and mirrored 0.1 fields reads back as the same tabs', () => {
    const tabs = [sanitizeTab({ id: 'a', name: 'Safety', columns: 2, plots: [{ ...plot('S'), kind: 'states' }] }), sanitizeTab({ id: 'b', name: 'Motion', plots: [plot('M')] })];
    const doc = { version: 2, tabs, activeTabId: 'b', plots: tabs[1].plots, layouts: tabs.map((t) => ({ id: t.id, name: t.name, plots: t.plots })), activeLayoutId: 'b' };
    const m = migratePlotsDoc(JSON.parse(JSON.stringify(doc)));
    assert.deepEqual(m.tabs, tabs);
    assert.equal(m.activeTabId, 'b');
  });
  test('after an older version rewrote the file (layouts only) the tabs come back from the layouts', () => {
    const old = { plots: [plot('M')], layouts: [{ id: 'a', name: 'Safety', plots: [plot('S')] }, { id: 'b', name: 'Motion', plots: [plot('M')] }], activeLayoutId: 'b' };
    assert.deepEqual(migratePlotsDoc(old).tabs.map((t) => [t.name, t.plots.map((p) => p.title)]), [['Motion', ['M']], ['Safety', ['S']]]);
  });
});

describe('plot ids stay unique across tabs', () => {
  const plotWith = (id, title) => ({ id, title, series: [{ topic: 't' }] });
  test('an older layout that shares ids with the working plots gets its own ids', () => {
    // 0.2 development builds kept ids when saving plots as a layout.
    const m = migratePlotsDoc({
      plots: [plotWith('a', 'Battery (edited)')],
      layouts: [
        { id: 'l1', name: 'Robot', plots: [plotWith('a', 'Battery')] },
        { id: 'l2', name: 'Copy', plots: [plotWith('a', 'Battery copy')] },
      ],
      activeLayoutId: 'l1',
    });
    const ids = m.tabs.flatMap((t) => t.plots.map((p) => p.id));
    assert.equal(new Set(ids).size, ids.length, `ids: ${ids}`);
    assert.equal(m.tabs[0].plots[0].id, 'a', 'the first keeps its id');
  });
  test('tabs saved with clashing ids (or a repeated id in one tab) are repaired, keeping their arrangement', () => {
    const m = migratePlotsDoc({
      tabs: [
        { id: 't1', name: 'A', plots: [plotWith('x', 'X'), plotWith('y', 'Y')], layout: { dir: 'row', children: ['y', 'x'], sizes: [2, 1] } },
        { id: 't2', name: 'B', plots: [plotWith('x', 'X2'), plotWith('z', 'Z')], layout: { dir: 'row', children: ['z', 'x'], sizes: [3, 1] } },
        { id: 't3', name: 'C', plots: [plotWith('q', 'Q1'), plotWith('q', 'Q2')] },
      ],
    });
    const ids = m.tabs.flatMap((t) => t.plots.map((p) => p.id));
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(m.tabs[0].plots.map((p) => p.id), ['x', 'y']);
    const [x2, z] = m.tabs[1].plots;
    assert.deepEqual(m.tabs[1].layout, { dir: 'row', children: [z.id, x2.id], sizes: [3, 1] });
  });
});

describe('layout weights for new plots', () => {
  test('a new plot is sized by its weight relative to the plots already there', () => {
    const weight = (id) => ({ tall: 3, short: 1, mid: 2 })[id];
    assert.deepEqual(syncLayout('tall', ['tall', 'short'], 0, weight), { dir: 'col', children: ['tall', 'short'], sizes: [3, 1] });
    // Existing sizes were doubled by resizing: the scale is kept.
    assert.deepEqual(syncLayout({ dir: 'col', children: ['tall', 'short'], sizes: [6, 2] }, ['tall', 'short', 'mid'], 0, weight), {
      dir: 'col',
      children: ['tall', 'short', 'mid'],
      sizes: [6, 2, 4],
    });
    // Side by side the tallest counts.
    assert.deepEqual(syncLayout({ dir: 'row', children: ['tall', 'short'], sizes: [1, 1] }, ['tall', 'short', 'mid'], 0, weight).sizes, [3, 2]);
  });
});
