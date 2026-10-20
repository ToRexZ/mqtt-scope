// plotView: what a plot shows (labels, chart input, time range, legend) and
// the sizes it needs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceLabel,
  paletteVar,
  seriesCss,
  DISPLAY_LABELS,
  labelOf,
  defaultDisplay,
  showsLegend,
  minPlotHeight,
  layoutWeight,
  chartSeries,
  chartRange,
  chartAxis,
  legendValue,
  MIN_PLOT_HEIGHT,
} from '../../renderer/plotView.js';
import { sanitizePlot } from '../../renderer/plotLayouts.js';

const enc = (s) => new TextEncoder().encode(s);
const plot = (extra = {}, series = [{ topic: 't' }]) => sanitizePlot({ title: 'P', series, ...extra });

describe('colours and labels', () => {
  test('palette slots wrap around the 8 colours; own colours win', () => {
    assert.equal(paletteVar(0), '--series-1');
    assert.equal(paletteVar(9), '--series-2');
    assert.equal(paletteVar(undefined), '--series-1');
    assert.equal(seriesCss({ slot: 2 }), 'var(--series-3)');
    assert.equal(seriesCss({ slot: 2, color: '#123456' }), '#123456');
    assert.deepEqual(DISPLAY_LABELS.map(([v]) => v), ['line', 'points', 'step', 'state']);
  });
});

describe('labels', () => {
  test('source and alias', () => {
    assert.equal(sourceLabel('a/b', null), 'a/b');
    assert.equal(sourceLabel('a/b', ['x', 0, 'odd key']), 'a/b › $.x[0]["odd key"]');
    assert.equal(labelOf({ topic: 'a', segs: ['v'] }), 'a › $.v');
    assert.equal(labelOf({ topic: 'a', segs: ['v'], alias: 'Speed' }), 'Speed');
  });
});

describe('defaults', () => {
  test('booleans are state lanes, everything else lines', () => {
    const m = (v) => ({ payload: enc(JSON.stringify(v)) });
    assert.equal(defaultDisplay(m({ ok: true }), ['ok']), 'state');
    assert.equal(defaultDisplay(m({ ok: 1 }), ['ok']), 'line');
    assert.equal(defaultDisplay(m(true), null), 'line', 'a bare `true` payload is text, not JSON');
    assert.equal(defaultDisplay({ payload: enc('12') }, ['x']), 'line');
    assert.equal(defaultDisplay(undefined, ['x']), 'line');
  });
});

describe('sizes', () => {
  const lanes = (n, extra = {}) => plot(extra, Array.from({ length: n }, (_, i) => ({ topic: `t${i}`, display: 'state' })));
  test('a State transitions plot needs room for every visible lane', () => {
    assert.equal(minPlotHeight(lanes(8, { kind: 'states' })), 84 + 8 * 16);
    assert.equal(minPlotHeight(lanes(1, { kind: 'states' })), MIN_PLOT_HEIGHT);
    const hidden = lanes(8, { kind: 'states' });
    hidden.series.slice(0, 4).forEach((s) => (s.visible = false));
    assert.equal(minPlotHeight(hidden), 84 + 4 * 16);
  });
  test('a line plot counts its legend and any state lanes', () => {
    assert.equal(minPlotHeight(plot()), 108 + 22);
    assert.equal(minPlotHeight(plot({ legend: false })), MIN_PLOT_HEIGHT);
    assert.equal(minPlotHeight(lanes(3)), 108 + 22 + 3 * 16);
  });
  test('plots with lanes get more height when placed automatically', () => {
    assert.equal(layoutWeight(plot()), 220);
    assert.equal(layoutWeight(lanes(2)), 220 + 2 * 34);
    assert.equal(layoutWeight(lanes(6, { kind: 'states' })), 60 + 6 * 34);
    assert.equal(layoutWeight(plot({ kind: 'states' }, [])), 60 + 34);
    assert.equal(layoutWeight(undefined), 1);
  });
  test('State transitions plots have no legend', () => {
    assert.equal(showsLegend(plot()), true);
    assert.equal(showsLegend(plot({ legend: false })), false);
    assert.equal(showsLegend(plot({ kind: 'states' })), false);
  });
});

describe('chart input', () => {
  test('visible series with their points and style', () => {
    const p = plot({}, [
      { topic: 'a', segs: ['x'], alias: 'X', color: '#ff0000', width: 3, display: 'step', slot: 2 },
      { topic: 'b', visible: false },
    ]);
    const asked = [];
    const out = chartSeries(p, (topic, segs) => (asked.push([topic, segs]), [{ t: 1, v: 2 }]));
    assert.deepEqual(asked, [['a', ['x']]]);
    assert.deepEqual(out, [{ label: 'X', slot: 2, color: '#ff0000', display: 'step', width: 3, points: [{ t: 1, v: 2 }] }]);
  });

  test('time range: zoom, then the live window (frozen or now), else everything', () => {
    const series = [{ points: [{ t: 0, v: 1 }] }];
    const p = plot({ windowSec: 60 });
    assert.deepEqual(chartRange(p, series, { zoom: { t0: 5, t1: 9, yMin: 1 } }), { t0: 5, t1: 9 });
    assert.deepEqual(chartRange(p, series, { now: 100_000 }), { t0: 40_000, t1: 100_000 });
    assert.deepEqual(chartRange(p, series, { now: 100_000, frozenAt: 70_000 }), { t0: 10_000, t1: 70_000 });
    assert.equal(chartRange(plot({ windowSec: 0 }), series, { now: 1 }), null);
  });

  test('a frozen "All" plot stops at the freeze, however much data arrives after it', () => {
    const all = plot({ windowSec: 0 });
    const series = [{ points: [{ t: 5_000, v: 1 }, { t: 90_000, v: 2 }] }, { points: [{ t: 2_000, v: 1 }] }, { points: [] }];
    assert.deepEqual(chartRange(all, series, { frozenAt: 60_000 }), { t0: 2_000, t1: 60_000 });
    assert.equal(chartRange(all, [{ points: [] }], { frozenAt: 60_000 }), null, 'nothing to show yet');
    assert.equal(chartRange(all, [{ points: [{ t: 70_000, v: 1 }] }], { frozenAt: 60_000 }), null, 'all data after the freeze');
  });

  test('axis: a value zoom wins over the fixed range; plot type and time grid are passed on', () => {
    const p = plot({ yMin: 0, yMax: 100, kind: 'states' });
    assert.deepEqual(chartAxis(p), { yMin: 0, yMax: 100, kind: 'states', timeGrid: true });
    assert.deepEqual(chartAxis(p, { yMin: 10, yMax: 20 }), { yMin: 10, yMax: 20, kind: 'states', timeGrid: true });
    assert.equal(chartAxis(plot({ timeGrid: false })).timeGrid, false);
  });
});

describe('legend value', () => {
  const pts = [
    { t: 1000, v: 1 },
    { t: 2000, v: 0 },
  ];
  test('latest, or nearest to the hovered time, with its timestamp', () => {
    const p = plot();
    const s = p.series[0];
    assert.equal(legendValue(p, s, pts).text, '0');
    assert.equal(legendValue(p, s, pts, { hoverTime: 1100 }).text, '1');
    assert.match(legendValue(p, s, pts).title, /\d\d:\d\d:\d\d\.000$/);
  });
  test('true/false for state lanes and State transitions plots of 0/1 values', () => {
    const lane = plot({}, [{ topic: 't', display: 'state' }]);
    assert.equal(legendValue(lane, lane.series[0], pts).text, 'false');
    const states = plot({ kind: 'states' });
    assert.equal(legendValue(states, states.series[0], pts, { hoverTime: 1000 }).text, 'true');
    assert.equal(legendValue(states, states.series[0], [{ t: 1, v: 3 }]).text, '3');
  });
  test('while frozen: the value in force at the freeze, not newer ones; hovering still wins', () => {
    const p = plot();
    const s = p.series[0];
    const live = [{ t: 1000, v: 1 }, { t: 2000, v: 2 }, { t: 3000, v: 3 }];
    assert.equal(legendValue(p, s, live, { frozenAt: 2500 }).text, '2');
    assert.equal(legendValue(p, s, live, { frozenAt: 500 }).text, '–', 'nothing before the freeze');
    assert.equal(legendValue(p, s, live, { frozenAt: 2500, hoverTime: 1000 }).text, '1');
    assert.equal(legendValue(p, s, live, { frozenAt: 2500, hoverTime: 2900 }).text, '2', 'never a value from after the freeze');
  });
  test('no data, and rounding to 6 significant digits', () => {
    const p = plot();
    assert.deepEqual(legendValue(p, p.series[0], []), { text: '–', title: 'No data yet' });
    assert.equal(legendValue(p, p.series[0], [{ t: 1, v: 1 / 3 }]).text, '0.333333');
  });
});
