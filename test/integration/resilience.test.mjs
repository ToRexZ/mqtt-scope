// Resilience: dropped connections, broker restarts, late brokers and silent
// network partitions. The session must recover on its own and restore every
// subscription.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBroker, testClient, until } from '../helpers/broker.mjs';
import { recorder, connected, text, freePort, startBrokerOnPort, startProxy, onSubscribed } from './_session.mjs';

// Publishes `topic` from a fresh client until the session has it.
async function flows(t, port, rec, topic, payload = topic) {
  const c = await testClient(port);
  try {
    await until(
      async () => {
        await c.publish(topic, payload);
        return rec.messages.some((m) => m.topic === topic && text(m) === payload);
      },
      { message: `message on ${topic}` },
    );
  } finally {
    await c.end();
  }
}

test('dropClients(): offline/reconnecting → connected again, all subscriptions restored', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: 'p/#', qos: 1 }, { topic: 'gone/#' }] });
  assert.deepEqual(await rec.s.subscribe('rt/#', 0), { ok: true });
  assert.deepEqual(await rec.s.unsubscribe('gone/#'), { ok: true });
  await flows(t, broker.port, rec, 'p/before');

  broker.dropClients();
  await rec.waitStatusCount('connected', 2, { message: 'automatic reconnect' });
  const after = rec.states().slice(2);
  t.diagnostic(`after drop: ${after.join(' → ')}`);
  assert.ok(after.includes('reconnecting'), 'reports reconnecting');
  assert.ok(after.includes('offline') || after.includes('disconnected'), 'reports the loss');
  assert.equal(after.at(-1), 'connected');
  const url = `mqtt://127.0.0.1:${broker.port}`;
  assert.ok(rec.statuses.every((s) => s.url === url));
  const lost = rec.statuses.find((s) => s.state === 'disconnected');
  if (lost) assert.equal(lost.unexpected, true, 'a dropped connection is flagged unexpected');

  await flows(t, broker.port, rec, 'p/after');
  await flows(t, broker.port, rec, 'rt/after');
  // the filter unsubscribed before the drop must not come back
  const c = await testClient(broker.port);
  t.after(() => c.end());
  await c.publish('gone/x', 'x');
  await c.publish('p/marker', 'm');
  await rec.waitFor((m) => m.topic === 'p/marker');
  assert.equal(rec.ofTopic('gone/x').length, 0, 'unsubscribed filter was resurrected by the reconnect');
  assert.deepEqual(rec.s.subscriptions.map((s) => s.topic).sort(), ['p/#', 'rt/#']);
});

test('repeated drops: recovers every time, no duplicate deliveries, one broker client at a time', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: 'r/#' }] });
  for (let i = 1; i <= 3; i++) {
    broker.dropClients();
    await rec.waitStatusCount('connected', i + 1, { message: `reconnect #${i}` });
    await flows(t, broker.port, rec, `r/${i}`);
  }
  // each topic was published until seen; afterwards publish one more of each
  // through a single client and check exactly one copy arrives
  rec.messages.length = 0;
  const c = await testClient(broker.port);
  t.after(() => c.end());
  for (let i = 0; i < 20; i++) await c.publish('r/dup', String(i));
  await c.publish('r/end', 'end');
  await rec.waitFor((m) => m.topic === 'r/end');
  assert.equal(rec.ofTopic('r/dup').length, 20);
  await until(() => broker.aedes.connectedClients === 2, { message: `session + publisher only (have ${broker.aedes.connectedClients})` });
});

test('retained messages are delivered exactly once per (re)subscribe, not duplicated by the reconnect', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  await broker.publish('keep/1', 'kept', { retain: true });
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: 'keep/#' }, { topic: 'live/#' }] });
  await rec.waitFor((m) => m.topic === 'keep/1');
  broker.dropClients();
  await rec.waitStatusCount('connected', 2);
  await until(() => rec.ofTopic('keep/1').length >= 2, { message: 'retained re-delivered after reconnect' });
  await flows(t, broker.port, rec, 'live/marker'); // everything sent before this has arrived
  assert.equal(rec.ofTopic('keep/1').length, 2, `retained copies: ${rec.ofTopic('keep/1').length}`);
  assert.ok(rec.ofTopic('keep/1').every((m) => m.retain));
});

test('broker stopped and restarted on the same port: session recovers and re-subscribes on the fresh broker', async (t) => {
  let broker = await startBrokerOnPort(0);
  const port = broker.port;
  t.after(() => broker.close());
  const rec = await connected(t, port, { subscriptions: [{ topic: 'x/#', qos: 1 }] }, { reconnectPeriod: 100 });
  assert.deepEqual(await rec.s.subscribe('y/#', 0), { ok: true });
  await flows(t, port, rec, 'x/1');

  await broker.close();
  await rec.waitStatusCount('reconnecting', 2, { message: 'retrying while broker is down' });
  assert.ok(rec.states().includes('error'), 'connection refused is surfaced while down');
  assert.equal(rec.s.connected, false);

  broker = await startBrokerOnPort(port);
  const resubscribed = Promise.all([onSubscribed(broker.aedes, 'x/#'), onSubscribed(broker.aedes, 'y/#')]);
  await rec.waitStatusCount('connected', 2, { message: 'reconnected to restarted broker' });
  await resubscribed;
  await flows(t, port, rec, 'x/2');
  await flows(t, port, rec, 'y/2');
});

test('broker not running at connect time: session keeps retrying and connects once it appears', async (t) => {
  const port = await freePort();
  const rec = recorder(t, { reconnectPeriod: 100 });
  rec.s.connect({ host: '127.0.0.1', port, subscriptions: [{ topic: 'late/#' }] });
  await rec.waitStatusCount('reconnecting', 2);
  assert.match(rec.statuses.find((s) => s.state === 'error').error, /ECONNREFUSED/);
  const broker = await startBrokerOnPort(port);
  t.after(() => broker.close());
  await rec.waitState('connected');
  await flows(t, port, rec, 'late/1');
});

test('silent network partition (no FIN): keepalive detects it, session reconnects after the network heals', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const proxy = await startProxy(broker.port);
  t.after(() => proxy.close());
  const rec = await connected(t, proxy.port, { keepalive: 1, subscriptions: [{ topic: 'k/#' }] }, { reconnectPeriod: 100, connectTimeout: 500 });
  await flows(t, broker.port, rec, 'k/before');

  proxy.blackhole(true);
  const t0 = Date.now();
  await until(() => !rec.s.connected, { timeout: 5000, message: 'keepalive timeout detected' });
  t.diagnostic(`partition detected after ${Date.now() - t0} ms (keepalive 1 s)`);
  proxy.blackhole(false);
  await rec.waitStatusCount('connected', 2, { timeout: 5000, message: 'reconnect after heal' });
  await flows(t, broker.port, rec, 'k/after');
});
