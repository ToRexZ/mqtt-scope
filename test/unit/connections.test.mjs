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

// Two clients with one client ID throw each other off the broker, also from
// two different profiles (Duplicate in the connection dialog copies it).
test('an explicit client ID is in one connection per broker at a time', () => {
  const r = reg();
  const a = r.create(1);
  const b = r.create(2);
  const broker = { protocol: 'mqtt', host: 'broker.local', port: 1883 };
  const p1 = { id: 'p1', name: 'One', clientId: 'robot-1', ...broker };
  assert.equal(r.connect(a, p1).ok, true);
  const inUse = { ok: false, clientIdInUse: { connId: 'c1', ownerId: 1, profileId: 'p1', name: 'One', clientId: 'robot-1' } };
  // The same broker, written differently: a port typed in the form, the
  // host's case and spaces, the default port left out, a WebSocket path
  // that mqtt does not use.
  for (const same of [{ port: '1883' }, { host: ' Broker.LOCAL ' }, { port: undefined }, { port: '' }, { wsPath: '/other' }]) {
    const p2 = { id: 'p2', name: 'Two', clientId: 'robot-1', ...broker, ...same };
    assert.deepEqual(r.connect(b, p2), inUse, JSON.stringify(same));
    assert.deepEqual(r.bind(b, p2), inUse, JSON.stringify(same));
  }
  assert.deepEqual(r.openProfileIds(), ['p1'], 'the refused one takes nothing');
  assert.equal(r.get(b).session.active, false);

  // Another broker, another client ID or none (random or per profile) is fine.
  const other = (extra) => ({ id: 'p2', name: 'Two', clientId: 'robot-1', ...broker, ...extra });
  for (const extra of [{ port: 1884 }, { host: 'other.local' }, { protocol: 'mqtts' }, { clientId: 'robot-2' }, { clientId: '' }, { clientId: undefined }]) {
    assert.equal(r.bind(b, other(extra)).ok, true, JSON.stringify(extra));
  }
  // It reconnects to its own profile; rebinding to another profile frees it.
  assert.equal(r.connect(a, p1).ok, true);
  assert.equal(r.connect(a, { id: 'p3', name: 'Three', clientId: 'robot-3', ...broker }).ok, true);
  assert.equal(r.bind(b, other({})).ok, true);
  // Closing frees it too.
  r.close(b);
  const c = r.create(3);
  assert.equal(r.connect(c, other({})).ok, true);
});

test('over WebSockets the path is part of the broker', () => {
  const r = reg();
  const a = r.create(1);
  const b = r.create(1);
  const ws = { protocol: 'ws', host: 'h', port: 9001, clientId: 'x' };
  assert.equal(r.bind(a, { id: 'a', ...ws, wsPath: '/mqtt' }).ok, true);
  assert.equal(r.bind(b, { id: 'b', ...ws }).clientIdInUse?.connId, 'c1', 'no path is /mqtt');
  assert.equal(r.bind(b, { id: 'b', ...ws, port: '' }).clientIdInUse?.connId, 'c1', 'no port is 9001');
  assert.equal(r.bind(b, { id: 'b', ...ws, wsPath: '/ws' }).ok, true);
});

test('the duplicate of a profile is found before its client ID', () => {
  const r = reg();
  const a = r.create(1);
  const b = r.create(2);
  const p = { id: 'a', clientId: 'x', host: 'h', port: 1883 };
  r.connect(a, p);
  assert.deepEqual(r.connect(b, p), { ok: false, duplicate: { connId: 'c1', ownerId: 1 } });
});
