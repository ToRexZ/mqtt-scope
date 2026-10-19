import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { countNodes, containerPaths, searchJson } from '../../renderer/jsonTree.js';

const sorted = (set) => [...set].sort();

describe('countNodes', () => {
  test('counts the root and every nested value', () => {
    assert.equal(countNodes(1), 1);
    assert.equal(countNodes(null), 1);
    assert.equal(countNodes({}), 1);
    assert.equal(countNodes([]), 1);
    assert.equal(countNodes({ a: 1, b: [1, 2] }), 5);
    assert.equal(countNodes([[[[]]]]), 4);
    assert.equal(countNodes({ a: null, b: 'str', c: { d: false } }), 5);
  });

  test('strings are leaves (characters are not counted)', () => {
    assert.equal(countNodes('abcdef'), 1);
    assert.equal(countNodes(['abc']), 2);
  });

  test('stops at the limit', () => {
    const big = Array.from({ length: 10000 }, (_, i) => ({ i }));
    assert.equal(countNodes(big), 20001);
    assert.equal(countNodes(big, 101), 101);
    assert.equal(countNodes(big, 1), 1);
    assert.equal(countNodes({ a: 1 }, 100), 2, 'a limit above the size returns the size');
  });
});

describe('containerPaths', () => {
  const v = { a: { b: { c: 1 } }, arr: [{ x: [] }, 2], 'k y': {}, s: 'x', n: null };

  test('every object and array path, depth first', () => {
    assert.deepEqual(containerPaths(v), ['$', '$.a', '$.a.b', '$.arr', '$.arr[0]', '$.arr[0].x', '$["k y"]']);
  });

  test('maxDepth limits how deep containers are listed', () => {
    assert.deepEqual(containerPaths(v, 0), ['$']);
    assert.deepEqual(containerPaths(v, 1), ['$', '$.a', '$.arr', '$["k y"]']);
    assert.deepEqual(containerPaths(v, 2), ['$', '$.a', '$.a.b', '$.arr', '$.arr[0]', '$["k y"]']);
  });

  test('primitives and null have no container paths', () => {
    assert.deepEqual(containerPaths(1), []);
    assert.deepEqual(containerPaths(null), []);
    assert.deepEqual(containerPaths('s'), []);
  });

  test('array indices use bracket notation; numeric-looking object keys are quoted', () => {
    assert.deepEqual(containerPaths([[], { 0: {} }]), ['$', '$[0]', '$[1]', '$[1]["0"]']);
  });
});

describe('searchJson', () => {
  const v = {
    Name: 'Sensor-A',
    nested: { deep: { temperature: 21.5, unit: 'C' } },
    list: [{ id: 'abc' }, { id: 'xyz' }, 'ABCD'],
    nothing: null,
    flag: true,
  };

  test('matches keys case-insensitively', () => {
    const r = searchJson(v, 'NAME');
    assert.deepEqual(sorted(r.matches), ['$.Name']);
    assert.equal(r.count, 1);
    assert.deepEqual(sorted(r.visible), ['$', '$.Name']);
  });

  test('matches primitive values case-insensitively, with all ancestors visible', () => {
    const r = searchJson(v, 'abc');
    assert.deepEqual(sorted(r.matches), ['$.list[0].id', '$.list[2]']);
    assert.equal(r.count, 2);
    assert.deepEqual(sorted(r.visible), ['$', '$.list', '$.list[0]', '$.list[0].id', '$.list[2]']);
  });

  test('numbers, booleans and null are matched by their string form', () => {
    assert.deepEqual(sorted(searchJson(v, '21.5').matches), ['$.nested.deep.temperature']);
    assert.deepEqual(sorted(searchJson(v, 'tru').matches), ['$.flag']);
    assert.deepEqual(sorted(searchJson(v, 'null').matches), ['$.nothing']);
    assert.deepEqual(sorted(searchJson(v, 'null').visible), ['$', '$.nothing']);
  });

  test('array indices are not matched as keys', () => {
    const r = searchJson(['a', 'b'], '0');
    assert.equal(r.count, 0);
    assert.equal(r.matches.size, 0);
  });

  test('nested matches under a matching key are all reported', () => {
    const r = searchJson({ abc: { abd: 1, other: 'ab' } }, 'ab');
    assert.deepEqual(sorted(r.matches), ['$.abc', '$.abc.abd', '$.abc.other']);
    assert.equal(r.count, 3);
    assert.deepEqual(sorted(r.visible), ['$', '$.abc', '$.abc.abd', '$.abc.other']);
  });

  test('a key and its value both matching count twice but are one match path', () => {
    const r = searchJson({ name: 'name' }, 'name');
    assert.equal(r.count, 2);
    assert.deepEqual(sorted(r.matches), ['$.name']);
  });

  test('deep match makes every ancestor visible, siblings stay hidden', () => {
    const r = searchJson(v, 'unit');
    assert.deepEqual(sorted(r.visible), ['$', '$.nested', '$.nested.deep', '$.nested.deep.unit']);
    assert.ok(!r.visible.has('$.list'));
  });

  test('no matches', () => {
    const r = searchJson(v, 'zzz-not-there');
    assert.equal(r.count, 0);
    assert.equal(r.matches.size, 0);
    assert.equal(r.visible.size, 0);
  });

  test('a primitive root can match at $', () => {
    const r = searchJson('Hello', 'ell');
    assert.deepEqual(sorted(r.matches), ['$']);
    assert.deepEqual(sorted(r.visible), ['$']);
    assert.equal(r.count, 1);
  });

  test('keys needing quotes produce bracket paths', () => {
    const r = searchJson({ 'odd key': { 'x.y': 1 } }, 'x.y');
    assert.deepEqual(sorted(r.matches), ['$["odd key"]["x.y"]']);
    assert.ok(r.visible.has('$["odd key"]'));
  });

  test('empty containers are never value matches', () => {
    const r = searchJson({ a: {}, b: [] }, 'object');
    assert.equal(r.count, 0);
  });

  test('unicode case folding via toLowerCase', () => {
    assert.deepEqual(sorted(searchJson({ k: 'ÄRGER' }, 'ärg').matches), ['$.k']);
  });
});
