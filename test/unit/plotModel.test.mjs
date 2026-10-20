// PlotModel: the rules for tabs, plots and their arrangement, and the saved
// document.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PlotModel, kindFor } from '../../renderer/plotModel.js';
import { layoutLeaves, MAX_SERIES, LAYOUT_FORMAT, PLOTS_DOC_VERSION } from '../../renderer/plotLayouts.js';

let changes;
const model = (doc = null) => new PlotModel(doc, { onChange: () => changes++ });
beforeEach(() => (changes = 0));

// A model whose screen tab holds plots titled after `titles` (one series each).
function withPlots(...titles) {
  const m = model();
  for (const t of titles) m.addSeries(null, { topic: `topic/${t}`, alias: t });
  changes = 0;
  return m;
}
const titles = (m) => m.plots.map((p) => p.title);
const byTitle = (m, t) => m.allPlots().find((p) => p.title === t);

test('kindFor: a plot of only state lanes shows state transitions', () => {
  assert.equal(kindFor({ series: [{ display: 'state' }, { display: 'state' }] }), 'states');
  assert.equal(kindFor({ series: [{ display: 'state' }, { display: 'line' }] }), 'timeseries');
  assert.equal(kindFor({ series: [] }), 'timeseries');
});

describe('starting and saving', () => {
  test('a new model has one empty "Plots" tab on screen and nothing selected', () => {
    const m = model();
    assert.deepEqual(m.tabs.map((t) => t.name), ['Plots']);
    assert.equal(m.tab, m.tabs[0]);
    assert.deepEqual(m.plots, []);
    assert.equal(m.selected, null);
    assert.equal(changes, 0);
  });

  test('the saved documents round-trip: the tabs, and the tab on screen in the 0.1 format', () => {
    const m = withPlots('A', 'B');
    m.addTab('Second');
    m.addSeries(null, { topic: 'x', alias: 'C' });
    m.movePlot(byTitle(m, 'A').id, byTitle(m, 'B').id, 'right'); // on another tab: ignored
    const doc = JSON.parse(JSON.stringify(m.toDoc()));
    const legacy = JSON.parse(JSON.stringify(m.legacyDoc()));
    assert.equal(doc.version, PLOTS_DOC_VERSION);
    assert.deepEqual(legacy, { plots: doc.tabs[1].plots, writtenBy: PLOTS_DOC_VERSION });
    assert.deepEqual(doc.legacyMirror, legacy.plots);
    const back = new PlotModel(doc, { legacy });
    assert.deepEqual(back.tabs, m.tabs);
    assert.equal(back.activeTabId, m.activeTabId);
  });

  test('plots changed by an older version (0.1 format) since are kept as an extra tab', () => {
    const m = withPlots('A');
    const doc = JSON.parse(JSON.stringify(m.toDoc()));
    const older = { plots: [{ id: 'old1', title: 'Edited in 0.1', series: [{ topic: 'a' }] }] };
    const back = new PlotModel(doc, { legacy: older });
    assert.deepEqual(back.tabs.map((t) => t.name), ['Plots', 'Plots (older version)']);
    assert.deepEqual(back.tabs[1].plots.map((p) => p.title), ['Edited in 0.1']);
    assert.notEqual(back.tabs[1].plots[0].id, 'old1', 'with its own ids');
    // Unchanged, or emptied by the older version: nothing is added or lost.
    assert.equal(new PlotModel(doc, { legacy: m.legacyDoc() }).tabs.length, 1);
    assert.equal(new PlotModel(doc, { legacy: { plots: [] } }).tabs.length, 1);
  });

  test('a document from a newer version is flagged (so it is not overwritten)', () => {
    assert.equal(model({ version: PLOTS_DOC_VERSION + 1, tabs: [] }).newer, true);
    assert.equal(model({ version: PLOTS_DOC_VERSION, tabs: [] }).newer, false);
    assert.equal(model(null).newer, false);
  });

  test('reloading can keep the tab on screen (another window saved)', () => {
    const m = withPlots('A');
    const first = m.tab;
    m.addTab('Second');
    const doc = JSON.parse(JSON.stringify(m.toDoc()));
    m.switchTab(first.id);
    m.load(doc, { keepActive: true });
    assert.equal(m.tab.name, 'Plots', 'this window stays on its tab');
    m.load(doc);
    assert.equal(m.tab.name, 'Second', 'at startup the saved tab is shown');
    m.load({ tabs: [{ id: 'z', name: 'Only', plots: [] }] }, { keepActive: true });
    assert.equal(m.tab.name, 'Only', 'falls back when the tab is gone');
  });

  test('older documents are migrated; loading does not count as a change', () => {
    const m = model({ plots: [{ id: 'p', title: 'Old', series: [{ topic: 'a' }] }] });
    assert.deepEqual(titles(m), ['Old']);
    assert.equal(m.selectedId, 'p');
    m.load({ tabs: [{ id: 't', name: 'T', plots: [] }] });
    assert.equal(m.selected, null);
    assert.equal(changes, 0);
  });

  test('reloading keeps the selection when the plot still exists', () => {
    const m = withPlots('A', 'B');
    m.select(byTitle(m, 'B').id);
    m.load(JSON.parse(JSON.stringify(m.toDoc())));
    assert.equal(m.selected.title, 'B');
  });
});

describe('adding series', () => {
  test('a new plot goes into the tab on screen, titled after the series, and is selected', () => {
    const m = model();
    const { plot, series } = m.addSeries(null, { topic: 'robot/state', segs: ['battery'] });
    assert.equal(plot.title, 'robot/state › $.battery');
    assert.deepEqual(series, { id: series.id, topic: 'robot/state', segs: ['battery'], slot: 0, display: 'line', width: 2, visible: true });
    assert.equal(m.selected, plot);
    assert.equal(plot.kind, 'timeseries');
    assert.equal(changes, 1);
    const named = m.addSeries(null, { topic: 'a', alias: '  Speed  ' });
    assert.equal(named.plot.title, 'Speed');
    assert.equal(named.series.alias, 'Speed');
  });

  test('a new plot of a state lane shows state transitions; adding lines later keeps it', () => {
    const m = model();
    const { plot } = m.addSeries(null, { topic: 'safety', segs: ['ok'], display: 'state' });
    assert.equal(plot.kind, 'states');
    m.addSeries(plot.id, { topic: 'speed' });
    assert.equal(plot.kind, 'states');
  });

  test('settleKind decides for a plot filled from several picks at once', () => {
    const m = model();
    const { plot } = m.addSeries(null, { topic: 'a', display: 'line' });
    plot.series[0].display = 'state';
    m.addSeries(plot.id, { topic: 'b', display: 'state' });
    changes = 0;
    m.settleKind(plot.id);
    assert.equal(plot.kind, 'states');
    assert.equal(changes, 1);
    m.settleKind(plot.id);
    assert.equal(changes, 1, 'no change, no save');
  });

  test('palette slots fill the gaps; duplicates are not added; a plot holds at most 8', () => {
    const m = model();
    const { plot } = m.addSeries(null, { topic: 's0' });
    for (let i = 1; i < MAX_SERIES; i++) m.addSeries(plot.id, { topic: `s${i}` });
    assert.deepEqual(plot.series.map((s) => s.slot), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(m.addSeries(plot.id, { topic: 'more' }), { plot, series: null, full: true });
    m.removeSeries(plot.id, plot.series[2].id);
    assert.equal(m.addSeries(plot.id, { topic: 'new' }).series.slot, 2);
    const before = changes;
    assert.deepEqual(m.addSeries(plot.id, { topic: 's0', segs: [] }), { plot, series: null }, 'already there, even though full');
    assert.equal(changes, before);
  });

  test('an unknown plot or display is handled', () => {
    const m = model();
    assert.deepEqual(m.addSeries('nope', { topic: 'a' }), { plot: null, series: null });
    assert.equal(m.addSeries(null, { topic: 'a', display: 'pie' }).series.display, 'line');
    assert.equal(m.allPlots().length, 1);
  });
});

describe('changing plots and series', () => {
  test('updatePlot applies valid values only and reports whether anything changed', () => {
    const m = withPlots('A');
    const p = m.plots[0];
    assert.equal(m.updatePlot(p.id, { title: '  Battery ', windowSec: 60, legend: false, yMin: 0, yMax: 100, kind: 'states' }), true);
    assert.deepEqual([p.title, p.windowSec, p.legend, p.yMin, p.yMax, p.kind], ['Battery', 60, false, 0, 100, 'states']);
    assert.equal(changes, 1);
    assert.equal(m.updatePlot(p.id, { title: '  ', windowSec: 7, legend: 'yes', yMin: NaN, kind: 'pie', other: 1 }), false);
    assert.equal(m.updatePlot(p.id, { title: 'Battery' }), false);
    assert.equal(changes, 1);
    assert.equal(m.updatePlot(p.id, { yMin: null }), true);
    assert.equal(p.yMin, null);
    assert.equal(p.timeGrid, true, 'time grid lines are on by default');
    assert.equal(m.updatePlot(p.id, { timeGrid: false }), true);
    assert.equal(p.timeGrid, false);
    assert.equal(m.updatePlot(p.id, { timeGrid: 'off' }), false);
    assert.equal(m.updatePlot('nope', { title: 'X' }), false);
  });

  test('updateSeries: alias, colour, palette slot, display, width, visibility', () => {
    const m = withPlots('A');
    const p = m.plots[0];
    const s = p.series[0];
    m.updateSeries(p.id, s.id, { alias: '  Speed ', color: '#ABCDEF', display: 'step', width: 4, visible: false });
    assert.deepEqual([s.alias, s.color, s.display, s.width, s.visible], ['Speed', '#abcdef', 'step', 4, false]);
    m.updateSeries(p.id, s.id, { slot: 5 });
    assert.equal(s.slot, 5);
    assert.equal(s.color, undefined, 'a palette colour replaces the own colour');
    m.updateSeries(p.id, s.id, { alias: '' });
    assert.equal('alias' in s, false);
    changes = 0;
    assert.equal(m.updateSeries(p.id, s.id, { color: 'red', slot: 9, display: 'pie', width: 0, visible: 'no' }), false);
    assert.equal(changes, 0);
    m.updateSeries(p.id, s.id, { color: '#000000' });
    assert.equal(m.updateSeries(p.id, s.id, { color: null }), true);
    assert.equal(s.color, undefined);
  });

  test('removing a plot selects its neighbour and takes it out of the arrangement', () => {
    const m = withPlots('A', 'B', 'C');
    m.layout();
    m.select(byTitle(m, 'B').id);
    m.removePlot(byTitle(m, 'B').id);
    assert.equal(m.selected.title, 'C', 'the next one');
    m.removePlot(byTitle(m, 'C').id);
    assert.equal(m.selected.title, 'A', 'else the previous one');
    assert.equal(m.tab.layout, byTitle(m, 'A').id);
    assert.equal(m.removePlot('nope'), false);
  });

  test('selection is limited to the tab on screen', () => {
    const m = withPlots('A', 'B');
    assert.equal(m.selected.title, 'B', 'the newest plot');
    assert.equal(m.select(byTitle(m, 'B').id), false, 'already selected');
    assert.equal(m.select(byTitle(m, 'A').id), true);
    assert.equal(changes, 0, 'selecting is not saved');
    m.addTab('Other');
    assert.equal(m.select(byTitle(m, 'A').id), false, 'not on screen');
    assert.equal(m.selected, null);
  });
});

describe('arrangement', () => {
  test('plots are arranged automatically; the same object comes back while nothing changes', () => {
    const m = withPlots('A', 'B');
    const l = m.layout();
    assert.deepEqual(layoutLeaves(l), m.plots.map((p) => p.id));
    assert.equal(m.layout(), l);
    m.addSeries(null, { topic: 'c', alias: 'C' });
    assert.deepEqual(layoutLeaves(m.layout()), m.plots.map((p) => p.id), 'a new plot joins at the bottom');
  });

  test('movePlot splits the target or swaps, and the list follows the screen order', () => {
    const m = withPlots('A', 'B', 'C');
    const [a, b, c] = m.plots;
    assert.equal(m.movePlot(c.id, a.id, 'left'), true);
    assert.deepEqual(m.tab.layout.children[0], { dir: 'row', children: [c.id, a.id], sizes: [1, 1] });
    assert.deepEqual(titles(m), ['C', 'A', 'B']);
    m.movePlot(b.id, c.id, 'center');
    assert.deepEqual(titles(m), ['B', 'A', 'C']);
    changes = 0;
    assert.equal(m.movePlot(a.id, a.id, 'left'), false);
    assert.equal(m.movePlot(a.id, b.id, 'diagonal'), false);
    assert.equal(m.movePlot(a.id, 'nope', 'left'), false);
    assert.equal(changes, 0);
  });

  test('movePlotToTab moves a plot to the end of another tab', () => {
    const m = withPlots('A', 'B');
    const first = m.tab;
    const second = m.addTab('Second');
    m.switchTab(first.id);
    m.layout();
    m.select(byTitle(m, 'A').id);
    assert.equal(m.movePlotToTab(byTitle(m, 'A').id, second.id), true);
    assert.deepEqual(titles(m), ['B']);
    assert.equal(m.tab.layout, byTitle(m, 'B').id);
    assert.equal(m.selected.title, 'B');
    assert.deepEqual(second.plots.map((p) => p.title), ['A']);
    assert.equal(m.movePlotToTab(byTitle(m, 'B').id, first.id), false, 'already there');
  });

  test('arrange lays plots out in rows again', () => {
    const m = withPlots('A', 'B', 'C', 'D');
    m.movePlot(m.plots[3].id, m.plots[0].id, 'center');
    m.arrange(2);
    assert.equal(m.tab.columns, 2);
    assert.equal(m.tab.layout.dir, 'col');
    assert.deepEqual(m.tab.layout.children.map((r) => r.dir), ['row', 'row']);
    m.arrange(99);
    assert.equal(m.tab.columns, 0);
  });

  test('setSplitSizes applies valid sizes to a split of the layout on screen', () => {
    const m = withPlots('A', 'B', 'C');
    const split = m.layout();
    assert.equal(m.setSplitSizes(split, [3, 1, 1]), true);
    assert.deepEqual(split.sizes, [3, 1, 1]);
    assert.equal(changes, 1);
    assert.equal(m.setSplitSizes(split, [3, 1, 1]), false, 'unchanged');
    assert.equal(m.setSplitSizes(split, [1, 1]), false, 'wrong count');
    assert.equal(m.setSplitSizes(split, [1, 0, 1]), false, 'not positive');
    assert.equal(m.setSplitSizes({ dir: 'row', children: ['x', 'y'], sizes: [1, 1] }, [2, 1]), false, 'not in this layout');
    assert.equal(m.setSplitSizes('a', [1]), false);
    assert.equal(changes, 1);
  });

  test('reading the layout changes nothing; weights for automatic placement come from the caller', () => {
    const m = new PlotModel(null, { weightOf: (p) => (p.title === 'Tall' ? 3 : 1) });
    m.addSeries(null, { topic: 'a', alias: 'Tall' });
    m.addSeries(null, { topic: 'b', alias: 'Short' });
    const l = m.layout();
    assert.deepEqual(l.sizes, [3, 1]);
    assert.equal(m.layout(), l);
    assert.equal(m.tab.layout, l);
  });
});

describe('tabs', () => {
  test('addTab gives unique names and shows the new tab', () => {
    const m = model();
    assert.equal(m.nextTabName(), 'Plots 2');
    const t = m.addTab('Plots');
    assert.equal(t.name, 'Plots (2)');
    assert.equal(m.tab, t);
    assert.equal(m.addTab('   ').name, 'Plots 3');
    assert.equal(changes, 2);
  });

  test('switchTab shows a tab and selects its first plot', () => {
    const m = withPlots('A');
    const first = m.tab;
    m.addTab('Other');
    assert.equal(m.selected, null);
    assert.equal(m.switchTab(first.id), true);
    assert.equal(m.selected.title, 'A');
    assert.equal(m.switchTab(first.id), false);
    assert.equal(m.switchTab('nope'), false);
  });

  test('renameTab keeps names unique and ignores empty or unchanged names', () => {
    const m = model();
    const second = m.addTab('Second');
    assert.equal(m.renameTab(second.id, '  Plots '), 'Plots (2)');
    assert.equal(m.renameTab(second.id, 'Plots (2)'), null);
    assert.equal(m.renameTab(second.id, ''), null);
    assert.equal(m.renameTab('nope', 'X'), null);
  });

  test('duplicateTab copies plots and arrangement under new ids, right after the original', () => {
    const m = withPlots('A', 'B');
    m.movePlot(m.plots[1].id, m.plots[0].id, 'left');
    m.addTab('Last');
    const copy = m.duplicateTab(m.tabs[0].id);
    assert.deepEqual(m.tabs.map((t) => t.name), ['Plots', 'Plots copy', 'Last']);
    assert.equal(m.tab, copy);
    assert.deepEqual(titles(m), ['B', 'A']);
    const ids = new Set(m.tabs[0].plots.map((p) => p.id));
    assert.ok(copy.plots.every((p) => !ids.has(p.id)));
    assert.deepEqual(layoutLeaves(copy.layout), copy.plots.map((p) => p.id));
    assert.equal(m.duplicateTab('nope'), null);
  });

  test('deleteTab shows the neighbour, keeps another tab on screen, and never leaves no tab', () => {
    const m = model();
    const [a, b, c] = [m.tab, m.addTab('B'), m.addTab('C')];
    m.switchTab(b.id);
    m.deleteTab(b.id);
    assert.equal(m.tab, c);
    m.deleteTab(a.id);
    assert.equal(m.tab, c, 'deleting another tab keeps this one on screen');
    m.deleteTab(c.id);
    assert.deepEqual(m.tabs.map((t) => t.name), ['Plots']);
    assert.equal(m.deleteTab('nope'), false);
  });

  test('export and import a tab with its arrangement; the copy gets new ids', () => {
    const m = withPlots('A', 'B');
    m.movePlot(m.plots[1].id, m.plots[0].id, 'right');
    m.updatePlot(m.plots[0].id, { kind: 'states' });
    const file = m.exportTab(m.tab.id);
    assert.equal(file.name, 'Plots.mqtt-scope-layout.json');
    assert.equal(JSON.parse(file.text).format, LAYOUT_FORMAT);
    const tab = m.importTab(file.text);
    assert.equal(tab.name, 'Plots (2)');
    assert.equal(m.tab, tab);
    assert.deepEqual(titles(m), ['A', 'B']);
    assert.equal(tab.plots[0].kind, 'states');
    assert.deepEqual(layoutLeaves(tab.layout), tab.plots.map((p) => p.id));
    assert.equal(tab.layout.dir, 'row');
    assert.ok(tab.plots.every((p) => !m.tabs[0].plots.some((q) => q.id === p.id)));
    assert.equal(m.exportTab('nope'), null);
  });

  test('importing something else throws a readable error and changes nothing', () => {
    const m = model();
    assert.throws(() => m.importTab('{"format":"x"}'), /Not an MQTT Scope plot layout/);
    assert.throws(() => m.importTab('nope'), /Not a JSON file/);
    assert.equal(m.tabs.length, 1);
    assert.equal(changes, 0);
  });

  test('allSeries lists the series of every tab', () => {
    const m = withPlots('A');
    m.addTab('Other');
    m.addSeries(null, { topic: 'b' });
    assert.deepEqual(m.allSeries().map((s) => s.topic), ['topic/A', 'b']);
    assert.equal(m.tabOf(byTitle(m, 'A').id), m.tabs[0]);
  });
});

describe('the 0.1 copy written by this version is never taken for an older version’s', () => {
  test('a stale copy written by this version (e.g. saved a moment before the tabs) adds no tab', () => {
    const m = withPlots('A');
    const stale = m.legacyDoc();
    m.addSeries(null, { topic: 'b', alias: 'B' });
    const doc = JSON.parse(JSON.stringify(m.toDoc()));
    assert.equal(stale.writtenBy, 2);
    assert.equal(new PlotModel(doc, { legacy: JSON.parse(JSON.stringify(stale)) }).tabs.length, 1);
  });
  test('a copy without the mark (rewritten by 0.1) that differs becomes a tab', () => {
    const m = withPlots('A');
    const doc = JSON.parse(JSON.stringify(m.toDoc()));
    const rewritten = { plots: [{ id: 'z', title: 'Z', series: [{ topic: 'z' }] }] };
    assert.deepEqual(new PlotModel(doc, { legacy: rewritten }).tabs.map((t) => t.name), ['Plots', 'Plots (older version)']);
  });
});
