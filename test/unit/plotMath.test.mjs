import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { niceTicks, formatValue, nearest, windowRange, seriesKey } from '../../renderer/plotMath.js';
import { prng } from './_util.mjs';

const PLOTMATH_URL = new URL('../../renderer/plotMath.js', import.meta.url).href;

// Runs niceTicks in a worker so an infinite loop fails the test instead of
// hanging the runner.
function niceTicksGuarded(min, max, count, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const w = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       import(workerData.url).then((m) => parentPort.postMessage(m.niceTicks(...workerData.args)));`,
      { eval: true, workerData: { url: PLOTMATH_URL, args: [min, max, count] } },
    );
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error(`niceTicks(${min}, ${max}, ${count}) did not return within ${timeoutMs} ms`));
    }, timeoutMs);
    w.once('message', (v) => {
      clearTimeout(timer);
      w.terminate();
      resolve(v);
    });
    w.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function checkTicks(min, max, count, res) {
  const { ticks, step } = res;
  const label = `niceTicks(${min}, ${max}, ${count})`;
  assert.ok(ticks.length >= 2, `${label}: at least two ticks`);
  const eps = step * 1e-9;
  assert.ok(ticks[0] <= min + eps, `${label}: first tick ${ticks[0]} covers min`);
  assert.ok(ticks.at(-1) >= max - eps, `${label}: last tick ${ticks.at(-1)} covers max`);
  // Step is 1, 2 or 5 times a power of ten.
  const mag = 10 ** Math.floor(Math.log10(step) + 1e-12);
  const norm = step / mag;
  assert.ok([1, 2, 5].some((k) => Math.abs(norm - k) < 1e-9), `${label}: step ${step} is 1/2/5 x 10^n`);
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(Math.abs(ticks[i] - ticks[i - 1] - step) <= step * 1e-6, `${label}: even spacing at ${i}`);
  }
  assert.ok(ticks.length <= Math.ceil(1.5 * Math.max(1, count)) + 3, `${label}: ${ticks.length} ticks is too many`);
  assert.ok(res.min <= min + eps && res.max >= max - eps);
}

describe('niceTicks', () => {
  test('simple ranges', () => {
    const r = niceTicks(0, 10, 5);
    assert.deepEqual(r, { min: 0, max: 10, step: 2, ticks: [0, 2, 4, 6, 8, 10] });
    const r2 = niceTicks(0, 1, 5);
    assert.equal(r2.step, 0.2);
    assert.deepEqual(r2.ticks, [0, 0.2, 0.4, 0.6, 0.8, 1]);
    checkTicks(3, 97, 5, niceTicks(3, 97, 5));
  });

  test('default count is 5', () => {
    assert.deepEqual(niceTicks(0, 10), niceTicks(0, 10, 5));
  });

  test('degenerate ranges (min == max, inverted, NaN)', () => {
    assert.deepEqual(niceTicks(5, 5), { min: 4, max: 6, step: 0.5, ticks: [4, 4.5, 5, 5.5, 6] });
    assert.deepEqual(niceTicks(0, 0).ticks, [-1, -0.5, 0, 0.5, 1]);
    assert.deepEqual(niceTicks(NaN, NaN).ticks, [-1, -0.5, 0, 0.5, 1]);
    assert.equal(niceTicks(-3, -3).min, -4);
  });

  test('negative ranges', () => {
    checkTicks(-37, -3, 5, niceTicks(-37, -3, 5));
    checkTicks(-0.004, -0.001, 4, niceTicks(-0.004, -0.001, 4));
    checkTicks(-1e6, 1e6, 6, niceTicks(-1e6, 1e6, 6));
  });

  test('tiny and huge magnitudes', () => {
    for (const [a, b] of [
      [1e-12, 3e-12],
      [1e-300, 5e-300],
      [1e12, 5e12],
      [1e300, 5e300],
      [123456789, 123456790],
    ]) {
      checkTicks(a, b, 5, niceTicks(a, b, 5));
    }
  });

  test('count of 0 or 1 does not divide by zero', () => {
    checkTicks(0, 10, 1, niceTicks(0, 10, 1));
    const r = niceTicks(0, 10, 0);
    assert.ok(r.ticks.length >= 2 && Number.isFinite(r.step));
  });

  test('a tick at zero is exactly 0, not floating-point noise', () => {
    for (const [a, b, c] of [
      [-0.7, 0.3, 7],
      [-0.3, 0.7, 5],
      [-0.78, 0.95, 5],
      [-0.0478, 0.00998, 5],
    ]) {
      const { ticks, step } = niceTicks(a, b, c);
      const nearZero = ticks.filter((v) => Math.abs(v) < step / 2);
      assert.deepEqual(nearZero, [0], `niceTicks(${a}, ${b}, ${c}) -> ${JSON.stringify(ticks)}`);
    }
  });

  test('property: random ranges across magnitudes', () => {
    const r = prng(5);
    for (let i = 0; i < 3000; i++) {
      const scale = 10 ** r.int(-8, 8);
      const a = (r.next() - 0.5) * scale * 10;
      const b = a + r.next() * scale + scale * 1e-6;
      const count = r.int(2, 12);
      checkTicks(a, b, count, niceTicks(a, b, count));
    }
  });

  test('terminates when the range is tiny relative to the magnitude (step below float resolution)', async () => {
    // e.g. nanosecond timestamps or 64-bit ids: ulp(1.7e18) = 256, so v += 50 never advances.
    const res = await niceTicksGuarded(1.7e18, 1.7e18 + 256, 5);
    assert.ok(res.ticks.length >= 2 && res.ticks.length < 100, `${res.ticks.length} ticks`);
    assert.ok(res.ticks.every(Number.isFinite));
    assert.ok(res.min <= 1.7e18 && res.max >= 1.7e18 + 256, 'axis range covers the data');
  });
});

describe('formatValue', () => {
  test('plain numbers with grouping and up to 6 significant digits', () => {
    assert.equal(formatValue(0), '0');
    assert.equal(formatValue(-0), '0');
    assert.equal(formatValue(1), '1');
    assert.equal(formatValue(-42.5), '-42.5');
    assert.equal(formatValue(1234.5678), '1,234.57');
    assert.equal(formatValue(1 / 3), '0.333333');
    assert.equal(formatValue(999999), '999,999');
    assert.equal(formatValue(9999999), '10,000,000', '6 significant digits');
    assert.equal(formatValue(0.001), '0.001');
    assert.equal(formatValue(0.00123456), '0.001235', 'capped at 6 fraction digits');
  });

  test('exponential notation for very large and very small magnitudes', () => {
    assert.equal(formatValue(1e7), '1.00e+7');
    assert.equal(formatValue(-12345678), '-1.23e+7');
    assert.equal(formatValue(0.0009), '9.00e-4');
    assert.equal(formatValue(-1e-4), '-1.00e-4');
    assert.equal(formatValue(1e300), '1.00e+300');
  });

  test('rounding up to 1e7 at 6 significant digits', () => {
    assert.equal(formatValue(9999999.5), '10,000,000');
  });
});

describe('nearest', () => {
  const pts = (...ts) => ts.map((t, i) => ({ t, v: i }));

  test('empty array is null', () => {
    assert.equal(nearest([], 5), null);
  });

  test('single point is always returned', () => {
    const p = pts(10);
    assert.equal(nearest(p, -100), p[0]);
    assert.equal(nearest(p, 1e9), p[0]);
  });

  test('exact hits, before first, after last, between', () => {
    const p = pts(0, 10, 20, 30);
    assert.equal(nearest(p, 20), p[2]);
    assert.equal(nearest(p, -5), p[0]);
    assert.equal(nearest(p, 99), p[3]);
    assert.equal(nearest(p, 13), p[1]);
    assert.equal(nearest(p, 17), p[2]);
  });

  test('ties prefer the earlier point', () => {
    const p = pts(0, 10, 20);
    assert.equal(nearest(p, 5), p[0]);
    assert.equal(nearest(p, 15), p[1]);
  });

  test('duplicate timestamps return one of the equal-time points', () => {
    const p = pts(0, 10, 10, 10, 20);
    assert.equal(nearest(p, 10).t, 10);
    assert.equal(nearest(p, 11).t, 10);
  });

  test('property: matches brute force on random sorted arrays', () => {
    const r = prng(11);
    for (let i = 0; i < 2000; i++) {
      const n = r.int(1, 30);
      const ts = Array.from({ length: n }, () => r.int(0, 100)).sort((a, b) => a - b);
      const p = pts(...ts);
      const t = r.int(-10, 110) + (r.bool() ? 0.5 : 0);
      const got = nearest(p, t);
      const best = Math.min(...ts.map((x) => Math.abs(x - t)));
      assert.equal(Math.abs(got.t - t), best, `t=${t} ts=${ts}`);
      // Earliest point among those at the best distance.
      const firstBest = p.find((q) => Math.abs(q.t - t) === best);
      if (got.t !== firstBest.t) assert.fail(`tie should prefer earlier time: got ${got.t}, expected ${firstBest.t}`);
    }
  });
});

describe('windowRange', () => {
  const s = (...ts) => ({ points: ts.map((t) => ({ t, v: 0 })) });
  const now = 1_000_000;

  test('no data: the full window', () => {
    assert.deepEqual(windowRange([], 60, now), { t0: now - 60_000, t1: now });
    assert.deepEqual(windowRange([s()], 60, now), { t0: now - 60_000, t1: now });
  });

  test('data older than the window: the full window', () => {
    assert.deepEqual(windowRange([s(now - 500_000, now - 1000)], 60, now), { t0: now - 60_000, t1: now });
  });

  test('window not yet filled: starts at the first point', () => {
    assert.deepEqual(windowRange([s(now - 30_000)], 60, now), { t0: now - 30_000, t1: now });
  });

  test('very recent first point: at least a 10 s span', () => {
    assert.deepEqual(windowRange([s(now - 2000)], 60, now), { t0: now - 10_000, t1: now });
    assert.deepEqual(windowRange([s(now)], 60, now), { t0: now - 10_000, t1: now });
  });

  test('windows shorter than 10 s are honoured', () => {
    assert.deepEqual(windowRange([s(now - 1000)], 5, now), { t0: now - 5000, t1: now });
  });

  test('uses the earliest first point across series and skips empty ones', () => {
    assert.deepEqual(windowRange([s(now - 20_000), s(), s(now - 40_000, now - 1)], 60, now), { t0: now - 40_000, t1: now });
  });
});

describe('seriesKey', () => {
  test('null/undefined segs equal empty segs (whole payload)', () => {
    assert.equal(seriesKey('a', null), seriesKey('a', []));
    assert.equal(seriesKey('a', undefined), seriesKey('a', []));
  });

  test('distinguishes topic/segs splits and segment types', () => {
    const keys = [
      seriesKey('a/b', ['c']),
      seriesKey('a', ['b', 'c']),
      seriesKey('a/b/c', []),
      seriesKey('a', ['b/c']),
      seriesKey('a', [0]),
      seriesKey('a', ['0']),
      seriesKey('a', ['a,b']),
      seriesKey('a', ['a', 'b']),
      seriesKey('a["x"]', []),
      seriesKey('a', ['x']),
      seriesKey('', []),
      seriesKey('', ['']),
    ];
    assert.equal(new Set(keys).size, keys.length);
  });

  test('property: unique for distinct (topic, segs) pairs', () => {
    const r = prng(8);
    const pieces = ['a', 'b', '/', '[', ']', '"', ',', '0', ' ', '\\', 'é'];
    const rs = (max) => Array.from({ length: r.int(0, max) }, () => r.pick(pieces)).join('');
    const seen = new Map();
    for (let i = 0; i < 5000; i++) {
      const topic = rs(4);
      const segs = Array.from({ length: r.int(0, 3) }, () => (r.bool(0.3) ? r.int(0, 2) : rs(3)));
      const id = JSON.stringify([topic, segs]);
      const key = seriesKey(topic, segs);
      if (seen.has(key)) assert.equal(seen.get(key), id, `collision for ${JSON.stringify(key)}`);
      else seen.set(key, id);
    }
  });
});
