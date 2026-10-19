import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT_FORMAT,
  sanitizeSeries,
  sanitizePlot,
  sanitizePlots,
  sanitizeLayouts,
  clonePlots,
  samePlots,
  layoutFile,
  parseLayoutFile,
} from '../../renderer/plotLayouts.js';
import { stateSegments, isBinary } from '../../renderer/plotMath.js';

describe('sanitizeSeries', () => {
  test('fills in defaults for older saved series', () => {
    const s = sanitizeSeries({ id: 'a', topic: 't', segs: ['x', 0], slot: 2 });
    assert.deepEqual(s, { id: 'a', topic: 't', segs: ['x', 0], slot: 2, display: 'line', width: 2, visible: true });
  });
  test('keeps valid display, width, visibility, alias and colour', () => {
    const s = sanitizeSeries({ topic: 't', display: 'state', width: 3, visible: false, alias: '  Speed ', color: '#FF0000' });
    assert.equal(s.display, 'state');
    assert.equal(s.width, 3);
    assert.equal(s.visible, false);
    assert.equal(s.alias, 'Speed');
    assert.equal(s.color, '#ff0000');
    assert.equal(typeof s.id, 'string');
  });
  test('drops invalid fields and rejects unusable series', () => {
    const s = sanitizeSeries({ topic: 't', display: 'bogus', width: 99, color: 'red', alias: '  ' }, 9);
    assert.equal(s.display, 'line');
    assert.equal(s.width, 2);
    assert.equal('color' in s, false);
    assert.equal('alias' in s, false);
    assert.equal(s.slot, 1, 'slot fallback wraps at 8');
    assert.equal(sanitizeSeries({ topic: '' }), null);
    assert.equal(sanitizeSeries({ topic: 't', segs: ['ok', { evil: 1 }] }), null);
    assert.equal(sanitizeSeries(null), null);
    assert.equal(sanitizeSeries({ topic: 't', segs: [] }).segs, null, 'empty path means the whole payload');
  });
});

describe('sanitizePlot', () => {
  test('defaults and limits', () => {
    const p = sanitizePlot({ series: Array.from({ length: 10 }, (_, i) => ({ topic: `t${i}` })), windowSec: 42, yMin: 'x', yMax: 5 });
    assert.equal(p.series.length, 8);
    assert.equal(p.windowSec, 300);
    assert.equal(p.legend, true);
    assert.equal(p.legendValues, true);
    assert.equal(p.yMin, null);
    assert.equal(p.yMax, 5);
    assert.equal(p.title, 't0', 'title falls back to the first topic');
  });
  test('rejects non-plots', () => {
    assert.equal(sanitizePlot({ title: 'x' }), null);
    assert.deepEqual(sanitizePlots('nope'), []);
  });
  test('sanitizeLayouts keeps named layouts only', () => {
    const l = sanitizeLayouts([{ name: ' A ', plots: [{ series: [] }] }, { name: '' }, null, { plots: [] }]);
    assert.equal(l.length, 1);
    assert.equal(l[0].name, 'A');
    assert.equal(l[0].plots.length, 1);
  });
});

describe('clonePlots and samePlots', () => {
  const plots = [sanitizePlot({ id: 'p', title: 'T', series: [{ id: 's', topic: 'a', segs: ['x'] }] })];
  test('clones deeply, keeping ids', () => {
    const c = clonePlots(plots);
    assert.deepEqual(c, plots);
    c[0].series[0].alias = 'changed';
    assert.equal(plots[0].series[0].alias, undefined);
  });
  test('samePlots ignores ids but sees real changes', () => {
    const other = [sanitizePlot({ id: 'q', title: 'T', series: [{ id: 'z', topic: 'a', segs: ['x'] }] })];
    assert.equal(samePlots(plots, other), true);
    other[0].series[0].color = '#123456';
    assert.equal(samePlots(plots, other), false);
    assert.equal(samePlots([], []), true);
  });
});

describe('layout files', () => {
  const plots = [sanitizePlot({ title: 'Battery', series: [{ topic: 'agv/state', segs: ['battery'], alias: 'Battery %', display: 'line' }] })];
  test('round-trip', () => {
    const text = layoutFile('Robots', plots);
    assert.equal(JSON.parse(text).format, LAYOUT_FORMAT);
    const back = parseLayoutFile(text);
    assert.equal(back.name, 'Robots');
    assert.ok(samePlots(back.plots, plots));
  });
  test('readable errors for wrong files', () => {
    assert.throws(() => parseLayoutFile('not json'), /Not a JSON file/);
    assert.throws(() => parseLayoutFile('{"format":"other"}'), /Not an MQTT Scope plot layout/);
    assert.throws(() => parseLayoutFile(JSON.stringify({ format: LAYOUT_FORMAT, version: 2, plots })), /Unsupported layout version 2/);
    assert.throws(() => parseLayoutFile(JSON.stringify({ format: LAYOUT_FORMAT, version: 1, plots: [] })), /no plots/);
  });
  test('missing names fall back', () => {
    const text = JSON.stringify({ format: LAYOUT_FORMAT, version: 1, plots });
    assert.equal(parseLayoutFile(text, 'from-file').name, 'from-file');
  });
});

describe('stateSegments', () => {
  const pts = [
    { t: 0, v: 0 },
    { t: 10, v: 1 },
    { t: 20, v: 1 },
    { t: 30, v: 0 },
  ];
  test('merges equal values and extends the last state to the window end', () => {
    assert.deepEqual(stateSegments(pts, 0, 40), [
      { from: 0, to: 10, value: 0, on: false },
      { from: 10, to: 30, value: 1, on: true },
      { from: 30, to: 40, value: 0, on: false },
    ]);
  });
  test('the state at the window start comes from the last earlier point', () => {
    assert.deepEqual(stateSegments(pts, 15, 25), [{ from: 15, to: 25, value: 1, on: true }]);
  });
  test('nothing before the first point, nothing for empty input', () => {
    assert.deepEqual(stateSegments(pts.slice(1), 0, 15), [{ from: 10, to: 15, value: 1, on: true }]);
    assert.deepEqual(stateSegments([], 0, 10), []);
    assert.deepEqual(stateSegments([{ t: 50, v: 1 }], 0, 10), []);
    assert.deepEqual(stateSegments(pts, 10, 10), []);
  });
  test('segments always lie inside the window and cover it without gaps after the first point', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 200; k++) {
      const points = [];
      let t = 0;
      for (let i = 0; i < 30; i++) points.push({ t: (t += 1 + Math.floor(rnd() * 5)), v: rnd() < 0.5 ? 0 : 1 });
      const t0 = rnd() * 100;
      const t1 = t0 + 1 + rnd() * 100;
      const segs = stateSegments(points, t0, t1);
      for (const s of segs) assert.ok(s.from >= t0 && s.to <= t1 && s.to > s.from);
      for (let i = 1; i < segs.length; i++) {
        assert.equal(segs[i].from, segs[i - 1].to);
        assert.notEqual(segs[i].value, segs[i - 1].value);
      }
      if (segs.length) assert.equal(segs.at(-1).to, t1);
    }
  });
  test('isBinary', () => {
    assert.equal(isBinary(pts), true);
    assert.equal(isBinary([{ t: 0, v: 2 }]), false);
    assert.equal(isBinary([]), false);
  });
});
