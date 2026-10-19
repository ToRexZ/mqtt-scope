// Subscriptions: from the profile on connect, and at runtime via
// subscribe()/unsubscribe(); invalid and broker-rejected filters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBroker, testClient, until, sleep } from '../helpers/broker.mjs';
import { recorder, connected, text } from './_session.mjs';

async function setup(t, brokerOpts = {}) {
  const broker = await startBroker(brokerOpts);
  t.after(() => broker.close());
  const subs = []; // { topic, qos } granted by the broker, per SUBSCRIBE
  broker.aedes.on('subscribe', (s, client) => {
    if (client) subs.push(...s.map(({ topic, qos }) => ({ topic, qos })));
  });
  const pub = await testClient(broker.port);
  t.after(() => pub.end());
  return { broker, subs, pub };
}

test("'#' receives every topic (nested, root level, leading slash) but not $SYS", async (t) => {
  const { broker, pub } = await setup(t);
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: '#', qos: 0 }] });
  await until(
    async () => {
      await pub.publish('warmup', '1');
      return rec.messages.length > 0;
    },
    { message: 'subscription active' },
  );
  for (const tp of ['a', 'a/b', 'a/b/c/d/e', '/lead', 'x/y']) await pub.publish(tp, tp);
  await broker.publish('$SYS/fake/stat', 'sys'); // clients may not publish to $SYS; the broker can
  await pub.publish('end', 'end');
  await rec.waitFor((m) => m.topic === 'end');
  const got = rec.messages.map((m) => m.topic).filter((x) => x !== 'warmup');
  assert.deepEqual(got, ['a', 'a/b', 'a/b/c/d/e', '/lead', 'x/y', 'end']);
});

test('multiple filters with different qos are requested as given and deliver at min(pub, sub) qos', async (t) => {
  const { broker, subs, pub } = await setup(t);
  const rec = await connected(t, broker.port, {
    subscriptions: [
      { topic: 'q0/#', qos: 0 },
      // exact filters for qos 1/2: aedes only downgrades to the subscription
      // qos when the filter equals the topic (broker quirk, not the session's)
      { topic: 'q1/a', qos: 1 },
      { topic: 'q2/#', qos: 2 },
      { topic: 'qs/a', qos: '1' }, // string qos (as from a form) is accepted
      { topic: 'qx/#', qos: 7 }, // out of range falls back to 0
    ],
  });
  await until(() => subs.length >= 5, { message: 'SUBSCRIBE processed' });
  assert.deepEqual(subs, [
    { topic: 'q0/#', qos: 0 },
    { topic: 'q1/a', qos: 1 },
    { topic: 'q2/#', qos: 2 },
    { topic: 'qs/a', qos: 1 },
    { topic: 'qx/#', qos: 0 },
  ]);
  for (const tp of ['q0/a', 'q1/a', 'q2/a', 'qs/a', 'qx/a', 'q1/a/too-deep', 'nomatch']) await pub.publish(tp, tp, { qos: 2 });
  await pub.publish('q0/end', 'end');
  // qos 0/1/2 deliveries may overtake each other, so wait for all expected ones
  await until(() => ['q0/a', 'q1/a', 'q2/a', 'qs/a', 'qx/a', 'q0/end'].every((tp) => rec.ofTopic(tp).length), {
    message: 'all matching topics',
  });
  await sleep(50); // non-matching topics must not show up
  const qos = Object.fromEntries(rec.messages.map((m) => [m.topic, m.qos]));
  assert.deepEqual(qos, { 'q0/a': 0, 'q1/a': 1, 'q2/a': 2, 'qs/a': 1, 'qx/a': 0, 'q0/end': 0 });
});

test('invalid filters in the profile are skipped with a warning; valid ones still work', async (t) => {
  const { broker, subs, pub } = await setup(t);
  const rec = await connected(t, broker.port, {
    subscriptions: [
      { topic: 'ok/#' },
      { topic: 'a/#/b' },
      { topic: 'a+' },
      { topic: 'x/y#' },
      { topic: '' }, // empty and null entries are ignored silently
      null,
    ],
  });
  await until(() => rec.warnings.length >= 1 && subs.length >= 1, { message: 'warning + subscribe' });
  assert.deepEqual(rec.warnings, ['Skipped invalid subscriptions: a/#/b, a+, x/y#']);
  assert.deepEqual(subs, [{ topic: 'ok/#', qos: 0 }]);
  await pub.publish('ok/1', 'hi');
  await rec.waitFor((m) => m.topic === 'ok/1');
});

test('only-invalid subscriptions: warning, nothing sent to the broker, still connected', async (t) => {
  const { broker, subs } = await setup(t);
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: '#/x' }] });
  await until(() => rec.warnings.length === 1, { message: 'warning' });
  await sleep(100);
  assert.deepEqual(subs, []);
  assert.equal(rec.s.status.state, 'connected');
});

test('broker-rejected subscription → warning naming the rejected filter; allowed filters still deliver', async (t) => {
  const { broker, pub } = await setup(t, { denySubscribe: ['secret/#'] });
  const rec = await connected(t, broker.port, {
    subscriptions: [{ topic: 'open/#' }, { topic: 'secret/#' }],
  });
  await until(() => rec.warnings.length >= 1, { message: 'rejection warning' });
  // the allowed filter in the same SUBSCRIBE packet works
  await until(
    async () => {
      await pub.publish('open/1', 'x');
      return rec.messages.some((m) => m.topic === 'open/1');
    },
    { message: 'open/# delivers' },
  );
  assert.equal(rec.warnings.length, 1, rec.warnings.join(' | '));
  assert.match(rec.warnings[0], /secret\/#/, `warning should name the rejected filter, got: "${rec.warnings[0]}"`);
  assert.doesNotMatch(rec.warnings[0], /open\/#/, 'the accepted filter must not be reported as rejected');
});

test('runtime subscribe() delivers, unsubscribe() stops delivery', async (t) => {
  const { broker, pub } = await setup(t);
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: 'base/#' }] });
  assert.deepEqual(rec.s.subscriptions, [{ topic: 'base/#' }]);

  assert.deepEqual(await rec.s.subscribe('rt/#', 1), { ok: true });
  assert.deepEqual(rec.s.subscriptions, [{ topic: 'base/#' }, { topic: 'rt/#', qos: 1 }]);
  await pub.publish('rt/a', 'one', { qos: 1 });
  const m = await rec.waitFor((x) => x.topic === 'rt/a');
  assert.equal(m.qos, 1);

  assert.deepEqual(await rec.s.unsubscribe('rt/#'), { ok: true });
  assert.deepEqual(rec.s.subscriptions, [{ topic: 'base/#' }]);
  // Same publisher connection → broker processes in order: once base/marker
  // arrives, rt/b (published before it) would already have arrived too.
  await pub.publish('rt/b', 'two', { qos: 1 });
  await pub.publish('base/marker', 'm', { qos: 1 });
  await rec.waitFor((x) => x.topic === 'base/marker');
  assert.equal(rec.ofTopic('rt/b').length, 0, 'no messages after unsubscribe');
});

test('unsubscribing a profile filter stops it too', async (t) => {
  const { broker, pub } = await setup(t);
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: 'p/#' }, { topic: 'keep/#' }] });
  await until(async () => {
    await pub.publish('p/1', 'x');
    return rec.ofTopic('p/1').length > 0;
  });
  assert.deepEqual(await rec.s.unsubscribe('p/#'), { ok: true });
  await pub.publish('p/2', 'x');
  await pub.publish('keep/marker', 'x');
  await rec.waitFor((x) => x.topic === 'keep/marker');
  assert.equal(rec.ofTopic('p/2').length, 0);
});

test('subscribing twice to the same filter does not duplicate it or its messages', async (t) => {
  const { broker, pub } = await setup(t);
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: 'd/#' }] });
  assert.deepEqual(await rec.s.subscribe('d/#', 0), { ok: true });
  assert.deepEqual(await rec.s.subscribe('d/#', 0), { ok: true });
  assert.equal(rec.s.subscriptions.filter((s) => s.topic === 'd/#').length, 1);
  await pub.publish('d/1', 'x');
  await pub.publish('d/end', 'x');
  await rec.waitFor((x) => x.topic === 'd/end');
  assert.equal(rec.ofTopic('d/1').length, 1);
});

test('subscribe() rejects invalid filters locally without contacting the broker', async (t) => {
  const { broker, subs } = await setup(t);
  const rec = await connected(t, broker.port);
  for (const f of ['', 'a/#/b', 'a+', 'x#', undefined]) {
    const r = await rec.s.subscribe(f, 0);
    assert.equal(r.ok, false, `filter ${JSON.stringify(f)}`);
    assert.ok(r.error);
  }
  await sleep(50);
  assert.deepEqual(subs, []);
  assert.deepEqual(rec.s.subscriptions, []);
});

test('subscribe() rejected by the broker → {ok:false} and not remembered', async (t) => {
  const { broker } = await setup(t, { denySubscribe: ['secret/#'] });
  const rec = await connected(t, broker.port);
  const r = await rec.s.subscribe('secret/#', 1);
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.deepEqual(rec.s.subscriptions, []);
  assert.equal(rec.s.status.state, 'connected', 'rejection does not drop the connection');
  assert.deepEqual(await rec.s.subscribe('fine/#', 1), { ok: true });
});

test('subscribe()/unsubscribe() when not connected → {ok:false, "Not connected"}', async (t) => {
  const rec = recorder(t);
  assert.deepEqual(await rec.s.subscribe('a/#', 0), { ok: false, error: 'Not connected' });
  assert.deepEqual(await rec.s.unsubscribe('a/#'), { ok: false, error: 'Not connected' });
});

test('retained messages are delivered once on subscribe', async (t) => {
  const { broker } = await setup(t);
  await broker.publish('ret/1', 'r1', { retain: true });
  await broker.publish('ret/2', 'r2', { retain: true });
  const rec = await connected(t, broker.port);
  assert.deepEqual(await rec.s.subscribe('ret/#', 0), { ok: true });
  await rec.waitMessages(2);
  await sleep(100);
  assert.deepEqual(rec.messages.map((m) => [m.topic, text(m), m.retain]).sort(), [
    ['ret/1', 'r1', true],
    ['ret/2', 'r2', true],
  ]);
});
