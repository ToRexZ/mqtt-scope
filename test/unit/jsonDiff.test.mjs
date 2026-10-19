import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diffJson, diffLines } from '../../renderer/jsonDiff.js';
import { pathFromSegments, getAt } from '../../renderer/jsonPath.js';
import { prng } from './_util.mjs';

const simplify = (d) => d.map(({ path, type, from, to }) => ({ path, type, from, to }));

describe('diffJson', () => {
  test('identical values give no changes', () => {
    for (const v of [1, 'a', null, true, {}, [], { a: [1, { b: 2 }] }, [[[]]]]) {
      assert.deepEqual(diffJson(v, structuredClone(v)), [], JSON.stringify(v));
    }
  });

  test('top-level scalar change', () => {
    assert.deepEqual(diffJson(1, 2), [{ path: '$', segs: [], type: 'changed', from: 1, to: 2 }]);
    assert.deepEqual(simplify(diffJson('a', 1)), [{ path: '$', type: 'changed', from: 'a', to: 1 }]);
  });

  test('added, removed and changed keys', () => {
    const a = { keep: 1, change: 1, gone: 'x' };
    const b = { keep: 1, change: 2, fresh: true };
    assert.deepEqual(simplify(diffJson(a, b)), [
      { path: '$.change', type: 'changed', from: 1, to: 2 },
      { path: '$.gone', type: 'removed', from: 'x', to: undefined },
      { path: '$.fresh', type: 'added', from: undefined, to: true },
    ]);
  });

  test('nested objects report leaf paths with segs', () => {
    const d = diffJson({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
    assert.deepEqual(d, [{ path: '$.a.b.c', segs: ['a', 'b', 'c'], type: 'changed', from: 1, to: 2 }]);
  });

  test('a whole added/removed subtree is one entry', () => {
    assert.deepEqual(simplify(diffJson({}, { a: { b: 1 } })), [{ path: '$.a', type: 'added', from: undefined, to: { b: 1 } }]);
    assert.deepEqual(simplify(diffJson({ a: [1] }, {})), [{ path: '$.a', type: 'removed', from: [1], to: undefined }]);
  });

  test('arrays growing and shrinking compare by index', () => {
    assert.deepEqual(diffJson([1, 2], [1, 2, 3, 4]), [
      { path: '$[2]', segs: [2], type: 'added', from: undefined, to: 3 },
      { path: '$[3]', segs: [3], type: 'added', from: undefined, to: 4 },
    ]);
    assert.deepEqual(simplify(diffJson([1, 2, 3], [1])), [
      { path: '$[1]', type: 'removed', from: 2, to: undefined },
      { path: '$[2]', type: 'removed', from: 3, to: undefined },
    ]);
    assert.deepEqual(simplify(diffJson([1, 2, 3], [0, 2])), [
      { path: '$[0]', type: 'changed', from: 1, to: 0 },
      { path: '$[2]', type: 'removed', from: 3, to: undefined },
    ]);
  });

  test('type changes are reported at the changed node, not descended into', () => {
    assert.deepEqual(simplify(diffJson({ a: {} }, { a: [] })), [{ path: '$.a', type: 'changed', from: {}, to: [] }]);
    assert.deepEqual(simplify(diffJson({ a: [1] }, { a: { 0: 1 } })), [{ path: '$.a', type: 'changed', from: [1], to: { 0: 1 } }]);
    assert.deepEqual(simplify(diffJson({ a: 1 }, { a: '1' })), [{ path: '$.a', type: 'changed', from: 1, to: '1' }]);
    assert.deepEqual(simplify(diffJson({ a: { x: 1 } }, { a: null })), [{ path: '$.a', type: 'changed', from: { x: 1 }, to: null }]);
    assert.deepEqual(simplify(diffJson(null, {})), [{ path: '$', type: 'changed', from: null, to: {} }]);
  });

  test('null is a value, distinct from a missing key', () => {
    assert.deepEqual(simplify(diffJson({ a: null }, {})), [{ path: '$.a', type: 'removed', from: null, to: undefined }]);
    assert.deepEqual(simplify(diffJson({}, { a: null })), [{ path: '$.a', type: 'added', from: undefined, to: null }]);
    assert.deepEqual(simplify(diffJson(null, undefined)), [{ path: '$', type: 'removed', from: null, to: undefined }]);
    assert.deepEqual(simplify(diffJson(undefined, null)), [{ path: '$', type: 'added', from: undefined, to: null }]);
    assert.deepEqual(diffJson({ a: null }, { a: null }), []);
    assert.deepEqual(diffJson({ a: undefined }, {}), [], 'an own undefined key equals a missing key');
  });

  test('NaN equals NaN (Object.is)', () => {
    assert.deepEqual(diffJson(NaN, NaN), []);
    assert.deepEqual(diffJson({ a: [NaN] }, { a: [NaN] }), []);
    assert.equal(diffJson({ a: NaN }, { a: 0 }).length, 1);
  });

  test('keys needing quotes and empty keys produce valid, parseable paths', () => {
    const d = diffJson({ 'a b': { '': 1, '"': [0] } }, { 'a b': { '': 2, '"': [0, 1] } });
    assert.deepEqual(
      d.map((x) => x.path),
      ['$["a b"][""]', '$["a b"]["\\""][1]'],
    );
    assert.deepEqual(d[1].segs, ['a b', '"', 1]);
  });

  test('__proto__ keys from JSON.parse are diffed as ordinary keys', () => {
    const a = JSON.parse('{"__proto__": {"x": 1}}');
    const b = JSON.parse('{"__proto__": {"x": 2}}');
    assert.deepEqual(simplify(diffJson(a, b)), [{ path: '$.__proto__.x', type: 'changed', from: 1, to: 2 }]);
  });

  test('segs arrays are independent per entry', () => {
    const d = diffJson({ a: { b: 1, c: 1 } }, { a: { b: 2, c: 2 } });
    assert.equal(d.length, 2);
    assert.notEqual(d[0].segs, d[1].segs);
    d[0].segs.push('mutated');
    assert.deepEqual(d[1].segs, ['a', 'c']);
  });

  test('property: path === pathFromSegments(segs), and from/to are the values at segs', () => {
    const r = prng(99);
    const randVal = (depth) => {
      const k = r.int(0, depth > 2 ? 3 : 5);
      if (k === 0) return r.int(0, 3);
      if (k === 1) return r.pick(['a', 'b', '', 'x y']);
      if (k === 2) return r.pick([null, true, false]);
      if (k === 3) return r.int(0, 1) ? 1.5 : 'a';
      if (k === 4) return Array.from({ length: r.int(0, 3) }, () => randVal(depth + 1));
      const o = {};
      for (let i = r.int(0, 3); i > 0; i--) o[r.pick(['a', 'b', 'c', 'd e', '"'])] = randVal(depth + 1);
      return o;
    };
    for (let i = 0; i < 500; i++) {
      const a = randVal(0);
      const b = randVal(0);
      for (const d of diffJson(a, b)) {
        assert.equal(d.path, pathFromSegments(d.segs));
        assert.deepEqual(getAt(a, d.segs), d.from);
        assert.deepEqual(getAt(b, d.segs), d.to);
        assert.equal(d.type, d.from === undefined ? 'added' : d.to === undefined ? 'removed' : 'changed');
      }
      assert.deepEqual(diffJson(a, structuredClone(a)), []);
    }
  });
});

// ------------------------------------------------------------------ lines

const reconstruct = (ops, keep) =>
  ops
    .filter((o) => o.op === ' ' || o.op === keep)
    .map((o) => o.text)
    .join('\n');

function lcsLength(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp[0][0];
}

function checkDiff(aText, bText) {
  const ops = diffLines(aText, bText);
  assert.ok(Array.isArray(ops));
  for (const o of ops) assert.ok([' ', '+', '-'].includes(o.op));
  assert.equal(reconstruct(ops, '-'), aText, 'ops reproduce A');
  assert.equal(reconstruct(ops, '+'), bText, 'ops reproduce B');
  return ops;
}

describe('diffLines', () => {
  test('equal texts are all context lines', () => {
    const ops = checkDiff('a\nb\nc', 'a\nb\nc');
    assert.deepEqual(ops, [
      { op: ' ', text: 'a' },
      { op: ' ', text: 'b' },
      { op: ' ', text: 'c' },
    ]);
  });

  test('empty strings', () => {
    assert.deepEqual(checkDiff('', ''), [{ op: ' ', text: '' }]);
    assert.deepEqual(checkDiff('', 'a'), [
      { op: '-', text: '' },
      { op: '+', text: 'a' },
    ]);
    checkDiff('a', '');
    checkDiff('\n', '');
    checkDiff('', '\n\n');
  });

  test('insert at start, middle and end', () => {
    assert.deepEqual(
      checkDiff('b\nc', 'a\nb\nc').map((o) => o.op),
      ['+', ' ', ' '],
    );
    assert.deepEqual(
      checkDiff('a\nc', 'a\nb\nc').map((o) => o.op + o.text),
      [' a', '+b', ' c'],
    );
    assert.deepEqual(
      checkDiff('a\nb', 'a\nb\nc').map((o) => o.op + o.text),
      [' a', ' b', '+c'],
    );
  });

  test('delete at start, middle and end', () => {
    assert.deepEqual(
      checkDiff('a\nb\nc', 'b\nc').map((o) => o.op + o.text),
      ['-a', ' b', ' c'],
    );
    assert.deepEqual(
      checkDiff('a\nb\nc', 'a\nc').map((o) => o.op + o.text),
      [' a', '-b', ' c'],
    );
    assert.deepEqual(
      checkDiff('a\nb\nc', 'a\nb').map((o) => o.op + o.text),
      [' a', ' b', '-c'],
    );
  });

  test('replacement lists deletions before insertions', () => {
    assert.deepEqual(
      checkDiff('a\nX\nc', 'a\nY\nc').map((o) => o.op + o.text),
      [' a', '-X', '+Y', ' c'],
    );
  });

  test('pretty JSON diff', () => {
    const a = JSON.stringify({ a: 1, b: [1, 2], c: 'x' }, null, 2);
    const b = JSON.stringify({ a: 1, b: [1, 2, 3], c: 'y' }, null, 2);
    const ops = checkDiff(a, b);
    assert.equal(ops.filter((o) => o.op !== ' ').length, 5);
  });

  test('more than 4000 lines on either side returns null', () => {
    const big = Array.from({ length: 4001 }, (_, i) => String(i)).join('\n');
    assert.equal(diffLines(big, 'a'), null);
    assert.equal(diffLines('a', big), null);
  });

  test('exactly 4000 lines is diffed', () => {
    const lines = Array.from({ length: 4000 }, (_, i) => String(i));
    const a = lines.join('\n');
    const b = [...lines.slice(0, 2000), 'changed', ...lines.slice(2001)].join('\n');
    const ops = checkDiff(a, b);
    assert.equal(ops.length, 4001);
  });

  test('property: random inputs reconstruct both sides with a maximal common subsequence', () => {
    const r = prng(2024);
    const alphabet = ['a', 'b', 'c', 'd', '', ' '];
    const randText = () => Array.from({ length: r.int(0, 14) }, () => r.pick(alphabet)).join('\n');
    for (let i = 0; i < 1500; i++) {
      const a = randText();
      const b = r.bool(0.2) ? a : randText();
      const ops = checkDiff(a, b);
      const common = ops.filter((o) => o.op === ' ').length;
      assert.equal(common, lcsLength(a.split('\n'), b.split('\n')), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
  });
});

test('diffLines refuses tables over the cell cap instead of allocating them', async () => {
  const { diffLines } = await import('../../renderer/jsonDiff.js');
  const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join('\n');
  assert.equal(diffLines(a, b), null);
  // A small changed middle inside long identical texts is still diffed.
  const base = Array.from({ length: 3900 }, (_, i) => `l${i}`);
  const changed = [...base];
  changed[1950] = 'changed';
  const out = diffLines(base.join('\n'), changed.join('\n'));
  assert.deepEqual(out.filter((l) => l.op !== ' '), [
    { op: '-', text: 'l1950' },
    { op: '+', text: 'changed' },
  ]);
});
