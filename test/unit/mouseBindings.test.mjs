// mouseBindings: which drag pans and which box-zooms a plot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOUSE_CHOICES, DEFAULT_MOUSE, normalizeMouse, dragAction } from '../../renderer/mouseBindings.js';

const ev = (button, mods = {}) => ({ button, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

test('choices and defaults', () => {
  assert.deepEqual(MOUSE_CHOICES.map(([id]) => id), ['left', 'right', 'middle', 'shift-left', 'ctrl-left']);
  assert.deepEqual(DEFAULT_MOUSE, { pan: 'left', box: 'right' });
});

test('normalizeMouse: valid and different, else defaults', () => {
  assert.deepEqual(normalizeMouse({ pan: 'right', box: 'left' }), { pan: 'right', box: 'left' });
  assert.deepEqual(normalizeMouse({ pan: 'middle' }), { pan: 'middle', box: 'right' });
  assert.deepEqual(normalizeMouse({ pan: 'right' }), DEFAULT_MOUSE, 'would equal the default box');
  assert.deepEqual(normalizeMouse({ pan: 'left', box: 'left' }), DEFAULT_MOUSE);
  assert.deepEqual(normalizeMouse({ pan: 'wheel', box: 7 }), DEFAULT_MOUSE);
  assert.deepEqual(normalizeMouse(null), DEFAULT_MOUSE);
});

test('dragAction with the defaults', () => {
  assert.equal(dragAction(ev(0), DEFAULT_MOUSE), 'pan');
  assert.equal(dragAction(ev(2), DEFAULT_MOUSE), 'box');
  assert.equal(dragAction(ev(1), DEFAULT_MOUSE), null);
  assert.equal(dragAction(ev(0, { shiftKey: true }), DEFAULT_MOUSE), 'pan', 'an unbound modifier falls back to the plain left drag');
  assert.equal(dragAction(ev(3), DEFAULT_MOUSE), null);
});

test('dragAction with other bindings', () => {
  const b = { pan: 'shift-left', box: 'left' };
  assert.equal(dragAction(ev(0), b), 'box');
  assert.equal(dragAction(ev(0, { shiftKey: true }), b), 'pan');
  assert.equal(dragAction(ev(2), b), null);
  const c = { pan: 'middle', box: 'ctrl-left' };
  assert.equal(dragAction(ev(1), c), 'pan');
  assert.equal(dragAction(ev(0, { ctrlKey: true }), c), 'box');
  assert.equal(dragAction(ev(0, { metaKey: true }), c), 'box', 'Cmd on macOS');
  assert.equal(dragAction(ev(0), c), null);
});
