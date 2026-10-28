// TabSet: the order of a window's tabs, which is active and the closed ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabSet } from '../../renderer/tabSet.js';

const setOf = (...ids) => {
  const s = new TabSet();
  for (const id of ids) s.add(id);
  return s;
};

test('add ignores an id already in the set', () => {
  const s = setOf('a', 'b');
  s.add('a', { index: 1 });
  assert.deepEqual(s.ids(), ['a', 'b']);
  assert.equal(s.activeId, 'b');
});

test('add appends and activates; index inserts', () => {
  const s = new TabSet();
  s.add('a');
  s.add('b');
  assert.deepEqual(s.ids(), ['a', 'b']);
  assert.equal(s.activeId, 'b');
  assert.equal(s.size, 2);
  s.add('c', { index: 0, activate: false });
  assert.deepEqual(s.ids(), ['c', 'a', 'b']);
  assert.equal(s.activeId, 'b');
});

test('removing the active tab activates its right neighbour, else its left', () => {
  const s = setOf('a', 'b', 'c');
  s.activate('b');
  assert.equal(s.remove('b'), 'c');
  assert.equal(s.activeId, 'c');
  assert.equal(s.remove('c'), 'a');
  assert.equal(s.remove('a'), null);
  assert.equal(s.activeId, null);
  assert.equal(s.size, 0);
});

test('removing a background tab keeps the active one', () => {
  const s = setOf('a', 'b', 'c');
  s.activate('b');
  assert.equal(s.remove('a'), 'b');
  assert.equal(s.remove('zzz'), 'b');
  assert.deepEqual(s.ids(), ['b', 'c']);
});

test('next and previous wrap around', () => {
  const s = setOf('a', 'b', 'c');
  assert.equal(s.next(1), 'a');
  s.activate('a');
  assert.equal(s.next(-1), 'c');
  assert.equal(s.next(1), 'b');
  assert.equal(new TabSet().next(1), null);
});

test('nth is 1-based and null past the end; last is the last tab', () => {
  const s = setOf('a', 'b', 'c');
  assert.equal(s.nth(1), 'a');
  assert.equal(s.nth(3), 'c');
  assert.equal(s.nth(4), null);
  assert.equal(s.nth(0), null);
  assert.equal(s.last(), 'c');
  assert.equal(new TabSet().last(), null);
});

test('move reorders and keeps the active tab', () => {
  const s = setOf('a', 'b', 'c');
  s.activate('a');
  s.move('a', 2);
  assert.deepEqual(s.ids(), ['b', 'c', 'a']);
  assert.equal(s.activeId, 'a');
  s.move('c', 0);
  assert.deepEqual(s.ids(), ['c', 'b', 'a']);
  s.move('b', 99);
  assert.deepEqual(s.ids(), ['c', 'a', 'b']);
});

test('activate reports whether the tab exists', () => {
  const s = setOf('a', 'b');
  assert.equal(s.activate('a'), true);
  assert.equal(s.activate('x'), false);
  assert.equal(s.activeId, 'a');
});

test('othersOf and rightOf list in strip order', () => {
  const s = setOf('a', 'b', 'c', 'd');
  assert.deepEqual(s.othersOf('b'), ['a', 'c', 'd']);
  assert.deepEqual(s.rightOf('b'), ['c', 'd']);
  assert.deepEqual(s.rightOf('d'), []);
  assert.deepEqual(s.rightOf('x'), []);
});

test('closed tabs reopen newest first, at most 25 kept', () => {
  const s = new TabSet();
  assert.equal(s.popClosed(), null);
  for (let i = 0; i < 30; i++) s.pushClosed({ i });
  assert.deepEqual(s.popClosed(), { i: 29 });
  let n = 1;
  while (s.popClosed()) n++;
  assert.equal(n, 25);
});
