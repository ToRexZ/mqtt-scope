// ConnectionRegistry with fake sessions (no broker, no Electron).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import path from 'node:path';
import { ROOT } from './_util.mjs';

const mainRequire = Module.createRequire(path.join(ROOT, 'main', 'connections.js'));
const { ConnectionRegistry } = mainRequire('./connections.js');

class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.active = false;
    this.status = { state: 'disconnected' };
    this.disconnects = 0;
  }
  connect() {
    this.active = true;
    return { ok: true, url: 'mqtt://x' };
  }
  // Like MqttSession, reports the change synchronously.
  disconnect() {
    this.disconnects++;
    this.active = false;
    this.status = { state: 'disconnected' };
    this.emit('status', this.status);
  }
}

const reg = () => new ConnectionRegistry({ createSession: () => new FakeSession() });

const collect = (r, ...names) => {
  const seen = [];
  for (const n of names) r.on(n, (...args) => seen.push([n, ...args]));
  return seen;
};

test('create returns app-wide unique ids', () => {
  const r = reg();
  assert.deepEqual([r.create(1), r.create(2), r.create(1)], ['c1', 'c2', 'c3']);
});

test('events carry the connection id and its owner', () => {
  const r = reg();
  const seen = collect(r, 'status', 'warning', 'batch');
  const id = r.create(7);
  r.get(id).session.emit('status', { state: 'connected' });
  r.get(id).session.emit('warning', 'w');
  r.get(id).session.emit('batch', { messages: [], dropped: 0 });
  assert.deepEqual(seen, [
    ['status', 'c1', 7, { state: 'connected' }],
    ['warning', 'c1', 7, 'w'],
    ['batch', 'c1', 7, { messages: [], dropped: 0 }],
  ]);
});

test('connect refuses a profile bound to another connection', () => {
  const r = reg();
  const a = r.create(1);
  const b = r.create(2);
  assert.equal(r.connect(a, { id: 'a' }).ok, true);
  assert.deepEqual(r.connect(b, { id: 'a' }), { ok: false, duplicate: { connId: 'c1', ownerId: 1 } });
  assert.equal(r.connect(a, { id: 'a' }).ok, true);
  assert.deepEqual(r.findProfile('a'), { connId: 'c1', ownerId: 1 });
});

test('connecting another profile rebinds the connection', () => {
  const r = reg();
  const a = r.create(1);
  r.connect(a, { id: 'a' });
  r.connect(a, { id: 'b' });
  assert.deepEqual(r.openProfileIds(), ['b']);
  assert.equal(r.findProfile('a'), null);
});

test('close drops late events', () => {
  const r = reg();
  const id = r.create(1);
  const { session } = r.get(id);
  const seen = collect(r, 'status', 'warning', 'batch');
  r.close(id);
  session.emit('batch', { messages: [], dropped: 0 });
  session.emit('status', { state: 'connected' });
  assert.deepEqual(seen, []);
  assert.equal(session.disconnects, 1);
  assert.equal(r.get(id), null);
  assert.equal(r.size, 0);
});

test('closeOwner closes only that window', () => {
  const r = reg();
  r.create(1);
  r.create(1);
  r.create(2);
  r.closeOwner(1);
  assert.equal(r.size, 1);
  assert.notEqual(r.get('c3'), null);
  assert.deepEqual(r.ofOwner(1), []);
  assert.deepEqual(r.ofOwner(2), ['c3']);
});

test('hold queues events in order; release delivers them to the new owner', () => {
  const r = reg();
  const id = r.create(1);
  const seen = collect(r, 'status', 'warning', 'batch');
  const { session } = r.get(id);
  r.hold(id);
  const A = { n: 'A' };
  const S = { state: 'connected' };
  const B = { n: 'B' };
  session.emit('batch', A);
  session.emit('status', S);
  session.emit('batch', B);
  assert.deepEqual(seen, []);
  r.setOwner(id, 2);
  r.release(id);
  assert.deepEqual(seen, [
    ['batch', 'c1', 2, A],
    ['status', 'c1', 2, S],
    ['batch', 'c1', 2, B],
  ]);
  // After release events flow straight through again.
  session.emit('batch', A);
  assert.equal(seen.length, 4);
});

test('hold keeps at most holdMax messages; the rest count as dropped, after them', () => {
  const r = new ConnectionRegistry({ createSession: () => new FakeSession(), holdMax: 5 });
  const id = r.create(1);
  const seen = collect(r, 'status', 'batch');
  const { session } = r.get(id);
  const msgs = (from, n) => Array.from({ length: n }, (_, i) => ({ n: from + i }));
  const S = { state: 'connected' };
  r.hold(id);
  session.emit('batch', { messages: msgs(1, 3), dropped: 0 });
  session.emit('status', S);
  session.emit('batch', { messages: msgs(4, 4), dropped: 1 }); // 2 fit
  session.emit('batch', { messages: msgs(8, 2), dropped: 0 }); // none fit
  session.emit('batch', { messages: [], dropped: 3 });
  assert.deepEqual(seen, []);
  r.release(id);
  assert.deepEqual(seen, [
    ['batch', 'c1', 1, { messages: msgs(1, 3), dropped: 0 }],
    ['status', 'c1', 1, S],
    ['batch', 'c1', 1, { messages: msgs(4, 2), dropped: 1 }],
    ['batch', 'c1', 1, { messages: [], dropped: 7 }],
  ]);

  // The next hold starts empty.
  seen.length = 0;
  r.hold(id);
  session.emit('batch', { messages: msgs(1, 5), dropped: 0 });
  r.release(id);
  assert.deepEqual(seen, [['batch', 'c1', 1, { messages: msgs(1, 5), dropped: 0 }]]);
});

test('activeCount counts active sessions of every owner', () => {
  const r = reg();
  const a = r.create(1);
  const b = r.create(2);
  r.create(2);
  assert.equal(r.activeCount(), 0);
  r.connect(a, { id: 'a' });
  r.connect(b, { id: 'b' });
  assert.equal(r.activeCount(), 2);
  r.disconnect(a);
  assert.equal(r.activeCount(), 1);
});

test('openProfiles fires when the bound set changes', () => {
  const r = reg();
  const seen = collect(r, 'openProfiles');
  const a = r.create(1);
  r.connect(a, { id: 'a' });
  assert.deepEqual(seen, [['openProfiles', ['a']]]);
  r.connect(a, { id: 'a' });
  assert.equal(seen.length, 1);
  r.close(a);
  assert.deepEqual(seen[1], ['openProfiles', []]);
});

test('bind takes a profile without connecting, with the same duplicate rule', () => {
  const r = reg();
  const seen = collect(r, 'openProfiles');
  const a = r.create(1);
  const b = r.create(2);
  assert.deepEqual(r.bind(a, { id: 'a' }), { ok: true });
  assert.equal(r.get(a).session.active, false);
  assert.deepEqual(seen, [['openProfiles', ['a']]]);
  assert.deepEqual(r.bind(b, { id: 'a' }), { ok: false, duplicate: { connId: 'c1', ownerId: 1 } });
  assert.deepEqual(r.connect(b, { id: 'a' }), { ok: false, duplicate: { connId: 'c1', ownerId: 1 } });
  assert.deepEqual(r.bind(a, { id: 'a' }), { ok: true });
  assert.equal(seen.length, 1, 'unchanged: no event');
  assert.equal(r.connect(a, { id: 'a' }).ok, true, 'it connects to its own profile later');
  assert.deepEqual(r.bind('c9', { id: 'x' }), { ok: false, error: 'Unknown connection' });
});

test('activeCount of one owner counts only its connections', () => {
  const r = reg();
  const a = r.create(1);
  const b = r.create(1);
  const c = r.create(2);
  for (const [id, p] of [
    [a, 'a'],
    [b, 'b'],
    [c, 'c'],
  ]) {
    r.connect(id, { id: p });
  }
  assert.equal(r.activeCount(1), 2);
  assert.equal(r.activeCount(2), 1);
  assert.equal(r.activeCount(3), 0);
  r.disconnect(b);
  assert.equal(r.activeCount(1), 1);
  assert.equal(r.activeCount(), 2);
});
