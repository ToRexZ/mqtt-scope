// Dragging a tab between windows (main/tabDrag.js): how a drag ends, on a
// manual clock for the wait for a drop. No Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { ROOT } from './_util.mjs';

const mainRequire = Module.createRequire(path.join(ROOT, 'main', 'tabDrag.js'));
const { TabDrag } = mainRequire('./tabDrag.js');

const GRACE = 250;
const HOVER = 300;
const HOVER_GRACE = 1500;
const MAX_AGE = 60000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A TabDrag on a manual clock; advance(ms) runs the timers that are due.
// `expired` counts the drags forgotten for their age.
function setup() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const expired = [];
  const drag = new TabDrag({
    graceMs: GRACE,
    hoverMs: HOVER,
    hoverGraceMs: HOVER_GRACE,
    maxAgeMs: MAX_AGE,
    onExpire: () => expired.push(now),
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const advance = async (ms) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at > now) continue;
      timers.delete(id);
      t.fn();
    }
    await tick();
  };
  return { drag, timers, expired, advance };
}

// What a promise settled with so far ('pending' while it has not).
async function state(promise) {
  let out = 'pending';
  promise.then((v) => (out = v));
  await tick();
  return out;
}

test('a drop within the grace period wins over tear-off', async () => {
  const { drag, timers, advance } = setup();
  drag.start('c1', 1);
  assert.deepEqual(drag.active(), { connId: 'c1', fromWindowId: 1 });
  const end = drag.end({ overSource: false });
  await advance(GRACE - 1);
  assert.equal(await state(end), 'pending');
  assert.deepEqual(drag.drop(2, 3), { connId: 'c1', fromWindowId: 1, toWindowId: 2, index: 3 });
  assert.equal(await state(end), 'dropped');
  assert.equal(timers.size, 0, 'no timer left, also not for its age');
  assert.equal(drag.active(), null);

  // The drop may also come first.
  drag.start('c2', 2);
  assert.deepEqual(drag.drop(1, 0), { connId: 'c2', fromWindowId: 2, toWindowId: 1, index: 0 });
  assert.equal(await state(drag.end({ overSource: false })), 'dropped');
  assert.equal(drag.active(), null);
});

test('no drop and outside the source tears off', async () => {
  const { drag, advance } = setup();
  drag.start('c1', 1);
  const end = drag.end({ overSource: false });
  await advance(GRACE);
  assert.equal(await state(end), 'tearOff');
  assert.equal(drag.drop(2, 0), null, 'too late: the drag is over');
  assert.equal(drag.active(), null);
});

test('no drop over the source does nothing', async () => {
  const { drag, advance } = setup();
  drag.start('c1', 1);
  const end = drag.end({ overSource: true });
  await advance(GRACE);
  assert.equal(await state(end), 'none');
  assert.equal(drag.active(), null);

  // A drop on another window still counts, should it come in time.
  drag.start('c1', 1);
  const again = drag.end({ overSource: true });
  assert.deepEqual(drag.drop(2, 1), { connId: 'c1', fromWindowId: 1, toWindowId: 2, index: 1 });
  assert.equal(await state(again), 'dropped');
});

test('a new drag cancels the previous one', async () => {
  const { drag, timers, advance } = setup();
  drag.start('c1', 1);
  const first = drag.end({ overSource: false });
  drag.start('c2', 2);
  assert.equal(await state(first), 'none');
  assert.equal(timers.size, 1, "only the new drag's age");
  assert.deepEqual(drag.drop(1, 0), { connId: 'c2', fromWindowId: 2, toWindowId: 1, index: 0 });
  await advance(GRACE);
  assert.equal(await state(drag.end({ overSource: false })), 'dropped');
});

test('a drop without a drag, or a second drop, takes nothing', async () => {
  const { drag } = setup();
  assert.equal(drag.drop(2, 0), null);
  assert.equal(await state(drag.end({ overSource: false })), 'none');
  drag.start('c1', 1);
  assert.notEqual(drag.drop(2, 0), null);
  assert.equal(drag.drop(3, 0), null);
});

test('cancel ends a drag: an end waiting for a drop does nothing', async () => {
  const { drag, timers } = setup();
  drag.start('c1', 1);
  const end = drag.end({ overSource: false });
  drag.cancel();
  assert.equal(await state(end), 'none');
  assert.equal(timers.size, 0);
  assert.equal(drag.active(), null);
  assert.equal(drag.drop(2, 0), null);
});

test('another window that had the drag over its top bar just before the end gets longer for its drop', async () => {
  const { drag, advance } = setup();
  drag.start('c1', 1);
  drag.hover(2);
  await advance(HOVER); // reported up to HOVER before the end
  const end = drag.end({ overSource: false });
  await advance(HOVER_GRACE - 1);
  assert.equal(await state(end), 'pending');
  assert.deepEqual(drag.drop(2, 0), { connId: 'c1', fromWindowId: 1, toWindowId: 2, index: 0 });
  assert.equal(await state(end), 'dropped');

  // No drop after all: it tears off, later.
  drag.start('c1', 1);
  drag.hover(2);
  const late = drag.end({ overSource: false });
  await advance(HOVER_GRACE - 1);
  assert.equal(await state(late), 'pending');
  await advance(1);
  assert.equal(await state(late), 'tearOff');
});

test('a hover long before the end, or over the window the drag came from, does not wait longer', async () => {
  const { drag, advance } = setup();
  drag.start('c1', 1);
  drag.hover(2);
  await advance(HOVER + 1);
  const end = drag.end({ overSource: false });
  await advance(GRACE);
  assert.equal(await state(end), 'tearOff');

  drag.start('c1', 1);
  drag.hover(1);
  const own = drag.end({ overSource: true });
  await advance(GRACE);
  assert.equal(await state(own), 'none');

  // Hovers of an earlier drag do not count either.
  drag.start('c1', 1);
  drag.hover(2);
  drag.start('c2', 1);
  const next = drag.end({ overSource: false });
  await advance(GRACE);
  assert.equal(await state(next), 'tearOff');
  assert.doesNotThrow(() => drag.hover(2), 'no drag: nothing to note');
});

test('a drag whose end never comes is forgotten after its max age', async () => {
  const { drag, expired, advance } = setup();
  drag.start('c1', 1);
  await advance(MAX_AGE - 1);
  assert.notEqual(drag.active(), null);
  await advance(1);
  assert.deepEqual(expired, [MAX_AGE]);
  assert.equal(drag.active(), null);
  assert.equal(drag.drop(2, 0), null);
  assert.equal(await state(drag.end({ overSource: false })), 'none');

  // One that ended is not forgotten again.
  drag.start('c2', 1);
  drag.drop(2, 0);
  await state(drag.end({ overSource: false }));
  await advance(MAX_AGE);
  assert.equal(expired.length, 1);
});
