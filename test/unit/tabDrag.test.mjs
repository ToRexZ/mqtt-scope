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
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A TabDrag on a manual clock; advance(ms) runs the timers that are due.
function setup() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const drag = new TabDrag({
    graceMs: GRACE,
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
  return { drag, timers, advance };
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
  assert.equal(timers.size, 0);
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
  assert.equal(timers.size, 0);
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
