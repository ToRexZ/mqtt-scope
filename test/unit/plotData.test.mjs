// PlotData: which points are collected for plotted series.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PlotData, pointsFromMessages, MAX_POINTS } from '../../renderer/plotData.js';

const enc = (s) => new TextEncoder().encode(s);
const msg = (topic, payload, ts) => ({ topic, payload: enc(typeof payload === 'string' ? payload : JSON.stringify(payload)), ts });
const series = (topic, segs = null) => ({ topic, segs });

describe('ingest', () => {
  test('collects numbers from the payload or a JSON path, oldest first', () => {
    const d = new PlotData();
    d.track([series('t'), series('r', ['battery']), series('r', ['pose', 'x'])]);
    assert.equal(d.ingest(msg('t', '21.5', 1)), true);
    assert.equal(d.ingest(msg('r', { battery: 80, pose: { x: -1 } }, 2)), true);
    d.ingest(msg('r', { battery: 79, pose: { x: 0 } }, 3));
    assert.deepEqual(d.points('t', null), [{ t: 1, v: 21.5 }]);
    assert.deepEqual(d.points('r', ['battery']), [{ t: 2, v: 80 }, { t: 3, v: 79 }]);
    assert.deepEqual(d.points('r', ['pose', 'x']), [{ t: 2, v: -1 }, { t: 3, v: 0 }]);
  });

  test('booleans become 0/1 and numeric strings count; other values are skipped', () => {
    const d = new PlotData();
    d.track([series('r', ['ok']), series('r', ['n']), series('r', ['s'])]);
    d.ingest(msg('r', { ok: true, n: '12', s: 'RUNNING' }, 1));
    d.ingest(msg('r', { ok: false, n: 'x', s: null }, 2));
    assert.deepEqual(d.points('r', ['ok']), [{ t: 1, v: 1 }, { t: 2, v: 0 }]);
    assert.deepEqual(d.points('r', ['n']), [{ t: 1, v: 12 }]);
    assert.deepEqual(d.points('r', ['s']), []);
  });

  test('reports whether a point was added; untracked topics are ignored', () => {
    const d = new PlotData();
    d.track([series('t')]);
    assert.equal(d.ingest(msg('other', '1', 1)), false);
    assert.equal(d.ingest(msg('t', 'not a number', 1)), false);
    assert.equal(d.ingest(msg('t', '1', 1)), true);
  });

  test('keeps time order: earlier messages after later ones are dropped, equal times kept', () => {
    const d = new PlotData();
    d.track([series('t')]);
    d.ingest(msg('t', '1', 10));
    d.ingest(msg('t', '2', 5));
    d.ingest(msg('t', '3', 10));
    assert.deepEqual(d.points('t').map((p) => p.v), [1, 3]);
  });

  test('caps each series, dropping the oldest points', () => {
    const d = new PlotData({ maxPoints: 3 });
    d.track([series('t')]);
    for (let i = 1; i <= 5; i++) d.ingest(msg('t', String(i), i));
    assert.deepEqual(d.points('t').map((p) => p.v), [3, 4, 5]);
    assert.equal(MAX_POINTS, 100000);
  });

  test('a path and no path, or [] and null, are the same series', () => {
    const d = new PlotData();
    d.track([series('t', []), series('t', null)]);
    d.ingest(msg('t', '7', 1));
    assert.deepEqual(d.points('t', []), [{ t: 1, v: 7 }]);
    assert.deepEqual(d.points('t', null), [{ t: 1, v: 7 }]);
  });
});

describe('track', () => {
  test('new series start from initial(series); known series keep their points', () => {
    const d = new PlotData();
    const asked = [];
    d.track([series('a')], (s) => (asked.push(s.topic), [{ t: 1, v: 1 }]));
    d.ingest(msg('a', '2', 2));
    d.track([series('a'), series('b')], (s) => (asked.push(s.topic), [{ t: 5, v: 5 }]));
    assert.deepEqual(asked, ['a', 'b']);
    assert.deepEqual(d.points('a').map((p) => p.v), [1, 2]);
    assert.deepEqual(d.points('b').map((p) => p.v), [5]);
  });

  test('series no longer tracked are forgotten (tracking again starts afresh)', () => {
    const d = new PlotData();
    d.track([series('a'), series('b')]);
    d.ingest(msg('a', '1', 1));
    d.track([series('b')]);
    assert.deepEqual(d.points('a'), []);
    assert.equal(d.ingest(msg('a', '2', 2)), false);
    d.track([series('a'), series('b')]);
    assert.deepEqual(d.points('a'), []);
  });

  test('initial points are copied and capped', () => {
    const d = new PlotData({ maxPoints: 2 });
    const given = [{ t: 1, v: 1 }, { t: 2, v: 2 }, { t: 3, v: 3 }];
    d.track([series('a')], () => given);
    assert.deepEqual(d.points('a').map((p) => p.v), [2, 3]);
    d.ingest(msg('a', '4', 4));
    assert.equal(given.length, 3, 'the caller’s array is not changed');
  });

  test('the same series listed twice is collected once', () => {
    const d = new PlotData();
    d.track([series('a', ['x']), series('a', ['x'])]);
    d.ingest(msg('a', { x: 1 }, 1));
    assert.equal(d.points('a', ['x']).length, 1);
  });

  test('untracked series read as an empty, unchangeable list', () => {
    const d = new PlotData();
    const pts = d.points('nope', null);
    assert.deepEqual(pts, []);
    assert.throws(() => pts.push({ t: 1, v: 1 }), TypeError);
  });
});

test('clear forgets points but keeps collecting', () => {
  const d = new PlotData();
  d.track([series('a')]);
  d.ingest(msg('a', '1', 1));
  const live = d.points('a');
  d.clear();
  assert.deepEqual(d.points('a'), []);
  d.ingest(msg('a', '2', 2));
  assert.deepEqual(d.points('a'), [{ t: 2, v: 2 }]);
  assert.equal(live, d.points('a'), 'the same live array');
});

test('pointsFromMessages takes the numeric values in time order', () => {
  const messages = [msg('a', { v: 1 }, 1), msg('a', { v: 'x' }, 2), msg('a', { v: 3 }, 0), msg('a', { v: 4 }, 4)];
  assert.deepEqual(pointsFromMessages(messages, ['v']), [{ t: 1, v: 1 }, { t: 4, v: 4 }]);
  assert.deepEqual(pointsFromMessages(null, null), []);
});

describe('memory and cost', () => {
  test('all series share a point budget: more series, fewer points each', () => {
    const d = new PlotData({ maxPoints: 10_000, budget: 40_000 });
    d.track([series('a'), series('b')]);
    for (let i = 1; i <= 15_000; i++) d.ingest(msg('a', String(i), i));
    assert.ok(d.points('a').length <= 11_000, 'a series never holds much more than its cap');
    d.track(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((t) => series(t)));
    assert.equal(d.points('a').length, 5000, 'cut to 40000 / 8 straight away');
    assert.equal(d.points('a')[4999].v, 15_000, 'keeping the newest');
  });
  test('however many series, each keeps at least 1000 points', () => {
    const d = new PlotData({ maxPoints: 5000, budget: 10_000 });
    d.track(Array.from({ length: 100 }, (_, i) => series(`t${i}`)));
    for (let i = 1; i <= 2000; i++) d.ingest(msg('t0', String(i), i));
    assert.ok(d.points('t0').length >= 1000);
  });
  test('ingesting at the cap stays cheap (trimming happens in chunks)', () => {
    const d = new PlotData({ maxPoints: 100_000 });
    const all = Array.from({ length: 8 }, (_, i) => series('r', [`v${i}`]));
    d.track(all, () => Array.from({ length: 100_000 }, (_, i) => ({ t: i, v: i })));
    const payload = enc(JSON.stringify(Object.fromEntries(all.map((_, i) => [`v${i}`, i]))));
    const t = performance.now();
    for (let i = 0; i < 5000; i++) d.ingest({ topic: 'r', payload, ts: 200_000 + i });
    const perMessage = (performance.now() - t) / 5000;
    assert.ok(perMessage < 0.1, `${perMessage.toFixed(3)} ms per message`);
    assert.ok(d.points('r', ['v0']).length <= 110_000);
  });
});

test('tracking again (e.g. after any edit) does not trim series that are within their slack', () => {
  const d = new PlotData({ maxPoints: 1000, budget: 1_000_000 });
  d.track([series('a')]);
  for (let i = 1; i <= 1050; i++) d.ingest(msg('a', String(i), i));
  assert.equal(d.points('a').length, 1050);
  d.track([series('a')]);
  assert.equal(d.points('a').length, 1050);
});

test('plot data round-trips', () => {
  const d = new PlotData({ maxPoints: 5 });
  d.track([series('t'), series('r', ['battery'])], () => [{ t: 0, v: 9 }]);
  for (let i = 1; i <= 8; i++) d.ingest(msg('t', String(i), i));
  d.ingest(msg('r', { battery: 80 }, 3));
  const snap = d.snapshot();
  assert.deepEqual(snap.map((s) => [s.topic, s.segs]), [['t', null], ['r', ['battery']]]);

  const copy = new PlotData({ maxPoints: 5 });
  copy.track([series('other')]);
  copy.ingest(msg('other', '1', 1));
  copy.restore(structuredClone(snap)); // as it crosses to another window
  assert.deepEqual(copy.snapshot(), snap);
  assert.deepEqual(copy.points('t'), d.points('t'));
  assert.deepEqual(copy.points('r', ['battery']), [{ t: 0, v: 9 }, { t: 3, v: 80 }]);
  assert.equal(copy.limit, d.limit);
  assert.deepEqual(copy.points('other'), [], 'what was tracked before is replaced');
  assert.equal(copy.ingest(msg('other', '2', 2)), false);

  // Collecting goes on.
  assert.equal(copy.ingest(msg('r', { battery: 79 }, 4)), true);
  assert.deepEqual(copy.points('r', ['battery']).map((p) => p.v), [9, 80, 79]);
  // The snapshot is a copy.
  d.ingest(msg('t', '9', 9));
  assert.equal(snap[0].points.at(-1).v, 8);
});

test('restoring keeps every point, whatever was tracked before', () => {
  const d = new PlotData({ maxPoints: 3000, budget: 6000 });
  d.track([series('a')], () => Array.from({ length: 2000 }, (_, i) => ({ t: i, v: i })));
  const copy = new PlotData({ maxPoints: 3000, budget: 6000 });
  copy.track(['a', 'b', 'c', 'd', 'e', 'f'].map((t) => series(t))); // 1000 points each
  copy.restore(d.snapshot());
  assert.equal(copy.points('a').length, 2000);
  assert.equal(copy.limit, 3000);
});
