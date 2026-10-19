import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { childPath, pathFromSegments, getAt, ancestorPaths, parsePath } from '../../renderer/jsonPath.js';
import { prng } from './_util.mjs';

describe('childPath', () => {
  test('identifiers use dot notation', () => {
    assert.equal(childPath('$', 'a'), '$.a');
    assert.equal(childPath('$', '_'), '$._');
    assert.equal(childPath('$', 'a1_b2'), '$.a1_b2');
    assert.equal(childPath('$', '$x'), '$.$x');
    assert.equal(childPath('$', 'A'), '$.A');
    assert.equal(childPath('$.a', 'b'), '$.a.b');
  });

  test('numbers use bracket index notation', () => {
    assert.equal(childPath('$', 0), '$[0]');
    assert.equal(childPath('$.a', 12), '$.a[12]');
  });

  test('keys that are not identifiers are quoted with JSON escaping', () => {
    assert.equal(childPath('$', 'a b'), '$["a b"]');
    assert.equal(childPath('$', 'a.b'), '$["a.b"]');
    assert.equal(childPath('$', '"'), '$["\\""]');
    assert.equal(childPath('$', '\\'), '$["\\\\"]');
    assert.equal(childPath('$', 'é'), '$["é"]');
    assert.equal(childPath('$', '😀'), '$["😀"]');
    assert.equal(childPath('$', ''), '$[""]');
    assert.equal(childPath('$', '0'), '$["0"]', 'numeric-looking string keys stay strings');
    assert.equal(childPath('$', '1a'), '$["1a"]');
    assert.equal(childPath('$', 'a-b'), '$["a-b"]');
    assert.equal(childPath('$', 'a]'), '$["a]"]');
    assert.equal(childPath('$', 'line\nbreak'), '$["line\\nbreak"]');
  });
});

describe('pathFromSegments', () => {
  test('empty segments is the root', () => {
    assert.equal(pathFromSegments([]), '$');
  });
  test('mixed segments', () => {
    assert.equal(pathFromSegments(['a', 0, 'b c', 2, '$']), '$.a[0]["b c"][2].$');
  });
});

describe('getAt', () => {
  const v = { a: { b: [1, { c: 2 }] }, z: null, s: 'str', n: 0 };
  test('walks objects and arrays', () => {
    assert.equal(getAt(v, ['a', 'b', 1, 'c']), 2);
    assert.equal(getAt(v, ['a', 'b', 0]), 1);
    assert.equal(getAt(v, ['n']), 0);
    assert.equal(getAt(v, ['z']), null);
  });
  test('empty segments return the value itself', () => {
    assert.equal(getAt(v, []), v);
    assert.equal(getAt(null, []), null);
    assert.equal(getAt(5, []), 5);
  });
  test('missing keys and paths through null/primitives are undefined', () => {
    assert.equal(getAt(v, ['missing']), undefined);
    assert.equal(getAt(v, ['z', 'x']), undefined);
    assert.equal(getAt(v, ['s', 0]), undefined);
    assert.equal(getAt(v, ['n', 'x']), undefined);
    assert.equal(getAt(v, ['a', 'b', 5]), undefined);
    assert.equal(getAt(null, ['a']), undefined);
    assert.equal(getAt(undefined, ['a']), undefined);
  });
});

describe('ancestorPaths', () => {
  test('root and every proper prefix, excluding the path itself', () => {
    assert.deepEqual(ancestorPaths(['a']), ['$']);
    assert.deepEqual(ancestorPaths(['a', 'b', 0]), ['$', '$.a', '$.a.b']);
    assert.deepEqual(ancestorPaths(['x y', 3, 'z']), ['$', '$["x y"]', '$["x y"][3]']);
  });
  test('root segments', () => {
    assert.deepEqual(ancestorPaths([]), ['$']);
  });
  test('matches pathFromSegments of each prefix (random)', () => {
    const r = prng(7);
    for (let i = 0; i < 200; i++) {
      const segs = randomSegs(r);
      const expected = [];
      for (let k = 0; k < Math.max(1, segs.length); k++) expected.push(pathFromSegments(segs.slice(0, k)));
      assert.deepEqual(ancestorPaths(segs), expected);
    }
  });
});

const PIECES = [
  'a', 'b', 'Z', '_', '$', '0', '1', '01', '-1', ' ', '.', '[', ']', '"', "'", '\\', '\n', '\t', '\u0000',
  ' ', 'é', '😀', '\uD800', '__proto__', 'constructor', 'a b', 'a.b', '["x"]', '$.a',
];

function randomSegs(r) {
  const segs = [];
  const n = r.int(0, 6);
  for (let i = 0; i < n; i++) {
    if (r.bool(0.3)) {
      segs.push(r.pick([0, 1, 2, 10, 999, 123456789]));
    } else {
      let s = '';
      const len = r.int(0, 4);
      for (let j = 0; j < len; j++) s += r.pick(PIECES);
      segs.push(s);
    }
  }
  return segs;
}

describe('parsePath', () => {
  test('canonical paths', () => {
    assert.deepEqual(parsePath('$'), []);
    assert.deepEqual(parsePath('$.a.b'), ['a', 'b']);
    assert.deepEqual(parsePath('$.a[0]["odd key"]'), ['a', 0, 'odd key']);
    assert.deepEqual(parsePath('$[0][1]'), [0, 1]);
    assert.deepEqual(parsePath('$.$x'), ['$x']);
    assert.deepEqual(parsePath('$[""]'), ['']);
    assert.deepEqual(parsePath('$["0"]'), ['0']);
    assert.deepEqual(parsePath('$["a\\"]b"]'), ['a"]b']);
    assert.deepEqual(parsePath('$["\\u00e9"]'), ['é']);
  });

  test('lenient forms: bare leading key, leading dot, leading index, whitespace', () => {
    assert.deepEqual(parsePath('a.b'), ['a', 'b']);
    assert.deepEqual(parsePath('a[0].c'), ['a', 0, 'c']);
    assert.deepEqual(parsePath('.a'), ['a']);
    assert.deepEqual(parsePath('[3]'), [3]);
    assert.deepEqual(parsePath('  $.a  '), ['a']);
    assert.deepEqual(parsePath(''), []);
    assert.deepEqual(parsePath('   '), []);
    assert.deepEqual(parsePath('$[007]'), [7]);
  });

  test('invalid paths throw', () => {
    const bad = [
      '$.', '$..a', '$[', '$]', '$[a]', "$['a']", '$[-1]', '$[1.5]', '$[ 0 ]', '$.1a', '$ .a', '$.a b',
      '$["unterminated]', '$["a"', '1abc', 'a..b', '$a', '$.a.', '$["\\x"]', '$.a-b', '-',
    ];
    for (const p of bad) assert.throws(() => parsePath(p), Error, p);
  });

  test('error messages point at the offending part', () => {
    assert.throws(() => parsePath('$.a..b'), /Invalid path near "\.\.b"/);
    assert.throws(() => parsePath('1abc'), /Invalid path "1abc"/);
  });

  test('round-trip: parsePath(pathFromSegments(segs)) deep-equals segs (edge cases)', () => {
    const cases = [
      [],
      ['a'],
      [0],
      ['0'],
      [''],
      ['', ''],
      ['a b', 'a.b', '"', '\\', "'", '[0]', ']', '$', '$x', '__proto__'],
      ['é', '😀', ' ', '\uD800', '\u0000', '\n'],
      [0, [1][0], 'x', 2, ''],
      ['["x"]', '$.a', '.', '[', '"]'],
    ];
    for (const segs of cases) {
      assert.deepEqual(parsePath(pathFromSegments(segs)), segs, JSON.stringify(segs));
    }
  });

  test('round-trip: random segment arrays', () => {
    const r = prng(42);
    for (let i = 0; i < 3000; i++) {
      const segs = randomSegs(r);
      const p = pathFromSegments(segs);
      assert.deepEqual(parsePath(p), segs, p);
      // Number segments stay numbers and string segments stay strings.
      parsePath(p).forEach((s, k) => assert.equal(typeof s, typeof segs[k]));
    }
  });
});
