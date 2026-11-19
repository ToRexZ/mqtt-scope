import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { childPath, pathFromSegments, getAt, ancestorPaths, parsePath, isSelector, namedSegs, nameParts } from '../../renderer/jsonPath.js';
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

describe('selectors (array entries picked by name)', () => {
  const sel = (field, equals) => ({ field, equals });
  const diagSegs = ['status', sel('name', 'A/B'), 'values', sel('key', 'T'), 'value'];
  const diag = {
    status: [
      { name: 'MOTOR', values: [{ key: 'T', value: '60' }] },
      { name: 'A/B', level: 2, values: [{ key: 'MODE', value: '3' }, { key: 'T', value: '21.5' }] },
    ],
  };

  test('isSelector: only { field: key|name, equals: non-empty string }', () => {
    assert.equal(isSelector(sel('key', 'T')), true);
    assert.equal(isSelector(sel('name', 'x')), true);
    for (const bad of [sel('id', 'x'), sel('key', ''), sel('key', 3), { field: 'key' }, 'key', 3, null, [], { field: 'key', equals: 'x', more: 1 }]) {
      assert.equal(isSelector(bad), false, JSON.stringify(bad));
    }
  });

  test('printed as a JSONPath filter, and parsed back', () => {
    const text = '$.status[?(@.name=="A/B")].values[?(@.key=="T")].value';
    assert.equal(pathFromSegments(diagSegs), text);
    assert.equal(childPath('$.a', sel('key', 'T')), '$.a[?(@.key=="T")]');
    assert.deepEqual(parsePath(text), diagSegs);
    for (const odd of ['q"x\\y])', 'é ✓', ' spaced ', '[?(@.key=="x")]']) {
      const segs = ['a', sel('key', odd), 'value'];
      assert.deepEqual(parsePath(pathFromSegments(segs)), segs, odd);
    }
    assert.throws(() => parsePath('$.a[?(@.id=="x")]'), /Invalid path/);
    assert.throws(() => parsePath('$.a[?(@.key=="")]'), /Invalid path/);
    assert.throws(() => parsePath('$.a[?(@.key==x)]'), /Invalid path/);
  });

  test('getAt follows the entry with that name, wherever it is', () => {
    assert.equal(getAt(diag, diagSegs), '21.5');
    assert.equal(getAt(diag, ['status', sel('name', 'A/B'), 'level']), 2);
    assert.equal(getAt(diag, ['status', sel('name', 'GONE'), 'level']), undefined);
    assert.equal(getAt({ status: { name: 'A/B' } }, ['status', sel('name', 'A/B')]), undefined, 'not an array');
    assert.equal(getAt({ a: [null, 3, { key: 'T', v: 1 }] }, ['a', sel('key', 'T'), 'v']), 1, 'skips non-objects');
    assert.equal(getAt({ a: [{ key: 'T', v: 1 }, { key: 'T', v: 2 }] }, ['a', sel('key', 'T'), 'v']), 1, 'first match');
  });

  test('namedSegs: positional steps become names where the entry has a unique key/name', () => {
    assert.deepEqual(namedSegs(diag, ['status', 1, 'values', 1, 'value']), diagSegs);
    assert.deepEqual(namedSegs(diag, ['status', 1, 'level']), ['status', sel('name', 'A/B'), 'level']);
    assert.deepEqual(namedSegs(diag, diagSegs), diagSegs, 'already named');
    assert.deepEqual(namedSegs({ a: [{ key: 'K', name: 'N', v: 1 }] }, ['a', 0, 'v']), ['a', sel('key', 'K'), 'v'], 'key before name');
    assert.deepEqual(namedSegs({ a: [{ key: 'K', v: 1 }, { key: 'K', v: 2 }] }, ['a', 1, 'v']), ['a', 1, 'v'], 'duplicate name');
    assert.deepEqual(namedSegs({ a: [{ key: 'K', name: 'N1' }, { key: 'K', name: 'N2' }] }, ['a', 1]), ['a', sel('name', 'N2')], 'duplicate key, unique name');
    assert.deepEqual(namedSegs({ a: [{ key: 7, v: 1 }] }, ['a', 0, 'v']), ['a', 0, 'v'], 'not a string');
    assert.deepEqual(namedSegs({ a: [{ key: '', v: 1 }] }, ['a', 0, 'v']), ['a', 0, 'v'], 'empty name');
    assert.deepEqual(namedSegs({ a: [5, 6] }, ['a', 1]), ['a', 1], 'array of numbers');
    assert.deepEqual(namedSegs({ a: [[{ key: 'K' }]] }, ['a', 0, 0, 'key']), ['a', 0, sel('key', 'K'), 'key'], 'nested arrays');
    assert.deepEqual(namedSegs({}, ['x', 0]), ['x', 0], 'path not in the message');
    assert.equal(namedSegs(diag, null), null);
    assert.deepEqual(namedSegs(diag, []), []);
  });

  test('nameParts: the names (and fields after them) for a label; null without a selector', () => {
    assert.deepEqual(nameParts(diagSegs), ['A/B', 'T']);
    assert.deepEqual(nameParts(['status', sel('name', 'A'), 'level']), ['A', 'level']);
    assert.deepEqual(nameParts(['robots', sel('name', 'r1'), 'battery', 'charge']), ['r1', 'battery', 'charge']);
    assert.deepEqual(nameParts(['a', sel('key', 'K'), 'list', 2]), ['K', 'list', '[2]']);
    assert.deepEqual(nameParts(['top', 'a', sel('key', 'K'), 'value']), ['top', 'K'], 'fields before the array are kept');
    assert.deepEqual(nameParts([sel('key', 'K'), 'value']), ['K'], 'payload is the array');
    assert.equal(nameParts(['a', 0, 'value']), null);
    assert.equal(nameParts(null), null);
  });
});
