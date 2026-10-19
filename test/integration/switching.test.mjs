// connect() while already connected/connecting (switching profiles): only the
// new connection may deliver messages or statuses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBroker, testClient, until, sleep } from '../helpers/broker.mjs';
import { recorder, connected, text, freePort, statusesAfter, onSubscribed } from './_session.mjs';

async function twoBrokers(t) {
  const a = await startBroker();
  const b = await startBroker();
  t.after(() => a.close());
  t.after(() => b.close());
  return [a, b];
}

test('connect() twice back-to-back: second profile wins, first never connects or reports', async (t) => {
  const [a, b] = await twoBrokers(t);
  const rec = recorder(t);
  const urlA = `mqtt://127.0.0.1:${a.port}`;
  const urlB = `mqtt://127.0.0.1:${b.port}`;
  const bSub = onSubscribed(b.aedes, '#');
  rec.s.connect({ host: '127.0.0.1', port: a.port, subscriptions: [{ topic: '#' }] });
  rec.s.connect({ host: '127.0.0.1', port: b.port, subscriptions: [{ topic: '#' }] });
  await rec.waitState('connected');
  await bSub;
  assert.deepEqual(rec.statuses, [
    { state: 'connecting', url: urlA },
    { state: 'disconnected', url: urlA },
    { state: 'connecting', url: urlB },
    { state: 'connected', url: urlB },
  ]);
  await until(() => a.aedes.connectedClients === 0, { message: 'A has no clients' });

  await a.publish('from/a', 'A');
  for (let i = 0; i < 10; i++) await b.publish('from/b', String(i));
  await until(() => rec.ofTopic('from/b').length >= 10, { message: 'B messages' });
  await sleep(100);
  assert.equal(rec.ofTopic('from/a').length, 0);
  assert.equal(rec.ofTopic('from/b').length, 10, 'no duplicates');
  assert.ok(rec.statuses.slice(2).every((s) => s.url === urlB), 'no status from the old client after switching');
});

test('switching from a connected profile: old client closed at broker, its close does not leak as "disconnected (unexpected)"', async (t) => {
  const [a, b] = await twoBrokers(t);
  const rec = await connected(t, a.port, { subscriptions: [{ topic: '#' }] });
  const later = statusesAfter(rec.s);
  const bSub = onSubscribed(b.aedes, '#');
  rec.s.connect({ host: '127.0.0.1', port: b.port, subscriptions: [{ topic: '#' }] });
  await rec.waitState('connected');
  await bSub;
  await until(() => a.aedes.connectedClients === 0, { message: 'old connection closed' });
  await sleep(150); // > reconnectPeriod: old client must not come back
  later.stop();
  assert.deepEqual(
    later.seen.map((s) => s.state),
    ['disconnected', 'connecting', 'connected'],
  );
  assert.ok(!later.seen.some((s) => s.unexpected), 'switch is not an unexpected disconnect');
  assert.equal(a.aedes.connectedClients, 0);

  await a.publish('stale', 'A');
  await b.publish('fresh', 'B');
  await rec.waitFor((m) => m.topic === 'fresh');
  await sleep(50);
  assert.equal(rec.ofTopic('stale').length, 0);
});

test('switching while the old profile is in its reconnect loop: no stale statuses afterwards', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const rec = recorder(t, { reconnectPeriod: 50 });
  rec.s.connect({ host: '127.0.0.1', port: await freePort() });
  await rec.waitStatusCount('reconnecting', 2);
  rec.s.connect({ host: '127.0.0.1', port: broker.port });
  await rec.waitState('connected');
  const later = statusesAfter(rec.s);
  await sleep(300); // several reconnect periods of the abandoned client
  later.stop();
  assert.deepEqual(later.seen, []);
  assert.equal(rec.s.status.state, 'connected');
});

test('reconnecting to the same broker (same profile) leaves exactly one live session client and no duplicate messages', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const profile = { host: '127.0.0.1', port: broker.port, subscriptions: [{ topic: 'same/#', qos: 1 }] };
  const rec = recorder(t);
  rec.s.connect(profile);
  rec.s.connect(profile);
  await rec.waitState('connected');
  rec.s.connect(profile);
  const sub = onSubscribed(broker.aedes, 'same/#');
  await rec.waitState('connected');
  await sub;
  await until(() => broker.aedes.connectedClients === 1, { message: 'one live client' });
  const c = await testClient(broker.port);
  t.after(() => c.end());
  for (let i = 0; i < 25; i++) await c.publish('same/x', String(i), { qos: 1 });
  await until(() => rec.ofTopic('same/x').length >= 25, { message: '25 messages' });
  await sleep(100);
  assert.deepEqual(rec.ofTopic('same/x').map(text), Array.from({ length: 25 }, (_, i) => String(i)));
});

test('a fixed clientId reused across a profile switch does not get the new session kicked', async (t) => {
  // MQTT brokers disconnect an existing client when a new one uses the same id.
  // The session closes the old client first, so the new one must stay up.
  const broker = await startBroker();
  t.after(() => broker.close());
  const profile = { host: '127.0.0.1', port: broker.port, clientId: 'fixed-id', subscriptions: [{ topic: 'fx/#' }] };
  const rec = await connected(t, broker.port, profile);
  rec.s.connect(profile);
  await rec.waitState('connected');
  const later = statusesAfter(rec.s);
  await sleep(300);
  later.stop();
  assert.deepEqual(later.seen, [], `connection flapped: ${later.seen.map((s) => s.state).join(',')}`);
  await until(() => broker.aedes.connectedClients === 1);
});

test('subscriptions are per profile: switching replaces them', async (t) => {
  const [a, b] = await twoBrokers(t);
  const rec = await connected(t, a.port, { subscriptions: [{ topic: 'only-a/#' }] });
  assert.deepEqual(await rec.s.subscribe('runtime-a/#'), { ok: true });
  rec.s.connect({ host: '127.0.0.1', port: b.port, subscriptions: [{ topic: 'only-b/#' }] });
  assert.deepEqual(rec.s.subscriptions, [{ topic: 'only-b/#' }]);
  const subs = [];
  b.aedes.on('subscribe', (s) => subs.push(...s.map((x) => x.topic)));
  await rec.waitState('connected');
  await until(() => subs.length > 0, { message: 'subscribe on B' });
  await sleep(50);
  assert.deepEqual(subs, ['only-b/#']);
});
