// Moving a tab between windows (main/tabMove.js): a real ConnectionRegistry
// on fake sessions, fake windows whose answers the tests give, and a manual
// clock for the timeouts. No Electron.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import path from 'node:path';
import { ROOT } from './_util.mjs';

const mainRequire = Module.createRequire(path.join(ROOT, 'main', 'tabMove.js'));
const { Requests, TabMover } = mainRequire('./tabMove.js');
const { ConnectionRegistry } = mainRequire('./connections.js');

class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.active = true;
  }
  disconnect() {
    this.active = false;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const TIMEOUT = 1000;

// Windows 1 and 2, each with an inbox of what main asked of it; a connection
// of window 1 (the tab to move) and the batches each window received.
function setup() {
  const registry = new ConnectionRegistry({ createSession: () => new FakeSession() });
  const inbox = new Map([
    [1, []],
    [2, []],
  ]);
  const requests = new Requests((id, channel, message) => {
    if (!inbox.has(id)) return false;
    inbox.get(id).push({ channel, ...message });
    return true;
  });
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const log = [];
  const mover = new TabMover({
    registry,
    ask: (id, channel, data) => requests.ask(id, channel, data),
    isWindow: (id) => inbox.has(id),
    setOwner: (connId, id) => {
      registry.setOwner(connId, id);
      log.push(['owner', id]);
    },
    closeConnection: (connId) => {
      registry.close(connId);
      log.push(['close']);
    },
    left: (id) => log.push(['left', id]),
    timeoutMs: TIMEOUT,
    setTimer: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const received = [];
  registry.on('batch', (_connId, ownerId, batch) => received.push([ownerId, batch.n]));
  const connId = registry.create(1);
  const batch = (n) => registry.get(connId).session.emit('batch', { n });
  // The last request a window got on a channel, then its answer.
  const asked = (id, channel) => inbox.get(id).filter((m) => m.channel === channel).at(-1);
  const answer = async (id, channel, reply) => {
    requests.answer(id, { reqId: asked(id, channel).reqId, ...reply });
    await tick();
  };
  const advance = async (ms) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at > now) continue;
      timers.delete(id);
      t.fn();
    }
    await tick();
  };
  const closeWindow = (id) => {
    inbox.delete(id);
    registry.closeOwner(id);
    requests.windowGone(id);
  };
  return { registry, requests, mover, inbox, log, received, connId, batch, asked, answer, advance, closeWindow };
}

const STATE = { tree: 'the tab' };
const EXPORTED = { state: STATE, index: 1, active: false };

describe('a move', () => {
  test('hands the connection to the window that built the tab; what arrived meanwhile follows, in order', async () => {
    const t = setup();
    t.batch(1);
    const moving = t.mover.move(t.connId, 2, 0);
    assert.equal(t.mover.busy(1), true);
    assert.equal(t.mover.busy(2), true);
    t.batch(2);
    await tick();
    assert.deepEqual(t.asked(1, 'tab:export'), { channel: 'tab:export', connId: t.connId, reqId: 1 });
    await t.answer(1, 'tab:export', { result: EXPORTED });
    assert.deepEqual(t.log, [['owner', null]], 'between windows it belongs to neither');
    assert.deepEqual(t.asked(2, 'tab:import'), { channel: 'tab:import', connId: t.connId, state: STATE, index: 0, activate: true, reqId: 2 });
    t.batch(3);
    await t.answer(2, 'tab:import', { result: true });
    assert.equal(await moving, true);
    t.batch(4);
    assert.deepEqual(t.received, [
      [1, 1],
      [2, 2],
      [2, 3],
      [2, 4],
    ]);
    assert.equal(t.registry.get(t.connId).ownerId, 2);
    assert.deepEqual(t.log, [['owner', null], ['owner', 2], ['left', 1], ['left', 2]]);
    assert.equal(t.mover.busy(1), false);
    assert.equal(t.mover.moving(t.connId), false);
  });

  test('the window it leaves can close meanwhile without ending the connection', async () => {
    const t = setup();
    const moving = t.mover.move(t.connId, 2, 0);
    await tick();
    await t.answer(1, 'tab:export', { result: EXPORTED });
    t.closeWindow(1);
    t.batch(1);
    await t.answer(2, 'tab:import', { result: true });
    assert.equal(await moving, true);
    assert.equal(t.registry.get(t.connId).ownerId, 2);
    assert.deepEqual(t.received, [[2, 1]]);
  });

  test('a failed export leaves the tab where it was', async () => {
    const t = setup();
    const moving = t.mover.move(t.connId, 2, 0);
    t.batch(1);
    await tick();
    await t.answer(1, 'tab:export', { error: 'Unknown tab' });
    assert.equal(await moving, false);
    assert.deepEqual(t.inbox.get(2), []);
    assert.equal(t.registry.get(t.connId).ownerId, 1);
    assert.deepEqual(t.received, [[1, 1]]);
    assert.deepEqual(t.log, [['left', 1], ['left', 2]]);
  });

  test('a failed import gives the tab back to its window, at its place, and its events go there', async () => {
    const t = setup();
    const moving = t.mover.move(t.connId, 2, 0);
    await tick();
    await t.answer(1, 'tab:export', { result: EXPORTED });
    t.batch(1);
    await t.answer(2, 'tab:import', { error: 'Cannot build it' });
    assert.deepEqual(t.asked(1, 'tab:import'), { channel: 'tab:import', connId: t.connId, state: STATE, index: 1, activate: false, reqId: 3 });
    assert.deepEqual(t.received, [], 'held until it is back');
    await t.answer(1, 'tab:import', { result: true });
    assert.equal(await moving, false);
    assert.equal(t.registry.get(t.connId).ownerId, 1);
    assert.deepEqual(t.received, [[1, 1]]);
  });

  test('an import that takes too long gives the tab back; a copy built after all is dropped', async () => {
    const t = setup();
    const moving = t.mover.move(t.connId, 2, 0);
    await tick();
    await t.answer(1, 'tab:export', { result: EXPORTED });
    await t.advance(TIMEOUT - 1);
    assert.equal(t.asked(1, 'tab:import'), undefined);
    await t.advance(1);
    await t.answer(1, 'tab:import', { result: true });
    assert.equal(await moving, false);
    assert.equal(t.registry.get(t.connId).ownerId, 1);

    // Window 2 gets there in the end: it is asked to let the tab go.
    await t.answer(2, 'tab:import', { result: true });
    assert.deepEqual(t.asked(2, 'tab:export').drop, true);
    await t.answer(2, 'tab:export', { result: { state: null, index: 0, active: true } });
    assert.deepEqual(t.log.at(-1), ['left', 2]);
    assert.equal(t.registry.get(t.connId).ownerId, 1);
  });

  test('an export answered too late goes back to its window; events wait for it', async () => {
    const t = setup();
    const moving = t.mover.move(t.connId, 2, 0);
    await tick();
    await t.advance(TIMEOUT);
    t.batch(1);
    assert.deepEqual(t.received, []);
    await t.answer(1, 'tab:export', { result: EXPORTED });
    assert.deepEqual(t.inbox.get(2), [], 'never offered to window 2');
    await t.answer(1, 'tab:import', { result: true });
    assert.equal(await moving, false);
    assert.deepEqual(t.received, [[1, 1]]);
  });

  test('with the window it came from gone, a tab that cannot go on ends its connection', async () => {
    const t = setup();
    const moving = t.mover.move(t.connId, 2, 0);
    await tick();
    await t.answer(1, 'tab:export', { result: EXPORTED });
    t.closeWindow(1);
    await t.answer(2, 'tab:import', { error: 'Cannot build it' });
    assert.equal(await moving, false);
    assert.equal(t.registry.get(t.connId), null);
    assert.deepEqual(t.log, [['owner', null], ['close'], ['left', 1], ['left', 2]]);
  });

  test('the window it goes to closing fails the move', async () => {
    const t = setup();
    const moving = t.mover.move(t.connId, 2, 0);
    await tick();
    await t.answer(1, 'tab:export', { result: EXPORTED });
    t.closeWindow(2);
    await tick();
    await t.answer(1, 'tab:import', { result: true });
    assert.equal(await moving, false);
    assert.equal(t.registry.get(t.connId).ownerId, 1);
  });

  test('one move at a time per tab, to another open window', async () => {
    const t = setup();
    await assert.rejects(t.mover.move(t.connId, 1, 0), /Unknown window/);
    await assert.rejects(t.mover.move(t.connId, 9, 0), /Unknown window/);
    await assert.rejects(t.mover.move('c99', 2, 0), /Unknown connection/);
    const moving = t.mover.move(t.connId, 2, 0);
    await assert.rejects(t.mover.move(t.connId, 2, 0), /Unknown connection/);
    await tick();
    await t.answer(1, 'tab:export', { error: 'no' });
    assert.equal(await moving, false);
    assert.equal(t.registry.get(t.connId).held, null, 'released');
  });
});

describe('requests', () => {
  test('are answered by the window asked only; one going away fails its own', async () => {
    const sent = [];
    const requests = new Requests((id, channel, message) => id !== 3 && sent.push([id, channel, message]) > 0);
    const first = requests.ask(1, 'tab:export', { connId: 'c1' });
    const second = requests.ask(2, 'tab:import', { connId: 'c1' });
    assert.deepEqual(sent, [
      [1, 'tab:export', { connId: 'c1', reqId: 1 }],
      [2, 'tab:import', { connId: 'c1', reqId: 2 }],
    ]);
    requests.answer(2, { reqId: 1, result: 'not yours' });
    requests.answer(1, { reqId: 1, result: 'state' });
    assert.equal(await first, 'state');
    requests.answer(1, { reqId: 1, result: 'again' }); // answered already: ignored
    requests.windowGone(1);
    requests.windowGone(2);
    await assert.rejects(second, /window closed/);
    await assert.rejects(requests.ask(3, 'tab:export', {}), /window is closed/);
    const failing = requests.ask(1, 'tab:export', {});
    requests.answer(1, { reqId: 4, error: 'Unknown tab' });
    await assert.rejects(failing, /Unknown tab/);
  });
});
