// publish(): qos levels, retain, payload types, validation, and what happens
// when the broker refuses or never acknowledges a publish.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBroker, testClient, until, sleep } from '../helpers/broker.mjs';
import { recorder, connected, statusesAfter } from './_session.mjs';

// Settles to the promise's value, or 'pending' if it has not settled within ms.
const settleWithin = (p, ms) => Promise.race([p, sleep(ms).then(() => 'pending')]);

describe('publish to a normal broker', () => {
  let broker;
  let sub; // independent observer
  before(async () => {
    broker = await startBroker();
    sub = await testClient(broker.port);
    await sub.subscribe('#', 2);
  });
  after(async () => {
    await sub.end();
    await broker.close();
  });

  const seen = (topic) => sub.waitFor((m) => m.topic === topic);

  for (const qos of [0, 1, 2]) {
    test(`qos ${qos} publish resolves {ok:true} and is delivered at qos ${qos}`, async (t) => {
      const rec = await connected(t, broker.port);
      const res = await rec.s.publish({ topic: `pq/${qos}`, payload: `q${qos}`, qos });
      assert.deepEqual(res, { ok: true });
      const m = await seen(`pq/${qos}`);
      assert.equal(m.payload.toString(), `q${qos}`);
      assert.equal(m.qos, qos);
      assert.equal(m.retain, false);
    });
  }

  test('qos given as a string is honoured; unknown qos falls back to 0', async (t) => {
    const rec = await connected(t, broker.port);
    assert.deepEqual(await rec.s.publish({ topic: 'pqs/2', payload: 'x', qos: '2' }), { ok: true });
    assert.deepEqual(await rec.s.publish({ topic: 'pqs/bad', payload: 'x', qos: 5 }), { ok: true });
    assert.equal((await seen('pqs/2')).qos, 2);
    assert.equal((await seen('pqs/bad')).qos, 0);
  });

  test('retain=true is stored by the broker: a fresh subscriber gets it with the retain flag', async (t) => {
    const rec = await connected(t, broker.port);
    assert.deepEqual(await rec.s.publish({ topic: 'ret/keep', payload: 'kept', qos: 1, retain: true }), { ok: true });
    const fresh = await testClient(broker.port);
    t.after(() => fresh.end());
    await fresh.subscribe('ret/keep', 1);
    const m = await fresh.waitFor((x) => x.topic === 'ret/keep');
    assert.equal(m.payload.toString(), 'kept');
    assert.equal(m.retain, true);
  });

  for (const [label, payload] of [
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['empty Uint8Array', new Uint8Array(0)],
  ]) {
    test(`retained message is deleted by publishing ${label} with retain`, async (t) => {
      const topic = `ret/del-${label.replace(/\s/g, '-')}`;
      const rec = await connected(t, broker.port);
      await rec.s.publish({ topic, payload: 'to-delete', qos: 1, retain: true });
      const check1 = await testClient(broker.port);
      await check1.subscribe(topic, 1);
      await check1.waitFor((x) => x.topic === topic);
      await check1.end();

      assert.deepEqual(await rec.s.publish({ topic, payload, qos: 1, retain: true }), { ok: true });
      const check2 = await testClient(broker.port);
      t.after(() => check2.end());
      await check2.subscribe(topic, 1);
      await sleep(150); // proving absence
      assert.equal(check2.received.filter((x) => x.topic === topic).length, 0, 'retained message should be gone');
    });
  }

  test('string payload is sent as UTF-8', async (t) => {
    const rec = await connected(t, broker.port);
    const s = 'zażółć 日本 🚀';
    assert.deepEqual(await rec.s.publish({ topic: 'pay/str', payload: s }), { ok: true });
    assert.deepEqual((await seen('pay/str')).payload, Buffer.from(s, 'utf8'));
  });

  test('Uint8Array payload is sent byte-exact, honouring byteOffset/length of a view', async (t) => {
    const rec = await connected(t, broker.port);
    const all = new Uint8Array(256).map((_, i) => i);
    assert.deepEqual(await rec.s.publish({ topic: 'pay/u8', payload: all }), { ok: true });
    assert.deepEqual([...(await seen('pay/u8')).payload], [...all]);

    const backing = new Uint8Array([9, 9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(3, 6);
    assert.deepEqual(await rec.s.publish({ topic: 'pay/view', payload: view }), { ok: true });
    assert.deepEqual([...(await seen('pay/view')).payload], [1, 2, 3]);

    assert.deepEqual(await rec.s.publish({ topic: 'pay/buf', payload: Buffer.from('buf') }), { ok: true });
    assert.equal((await seen('pay/buf')).payload.toString(), 'buf');
  });

  test('null payload is sent as an empty message', async (t) => {
    const rec = await connected(t, broker.port);
    assert.deepEqual(await rec.s.publish({ topic: 'pay/null', payload: null }), { ok: true });
    assert.equal((await seen('pay/null')).payload.length, 0);
  });

  test('non-text, non-bytes payloads are rejected without sending', async (t) => {
    const rec = await connected(t, broker.port);
    for (const payload of [{ a: 1 }, 42, [1, 2], new ArrayBuffer(4)]) {
      assert.deepEqual(await rec.s.publish({ topic: 'pay/bad', payload }), { ok: false, error: 'Payload must be text or bytes' });
    }
    await rec.s.publish({ topic: 'pay/bad-end', payload: 'x' });
    await seen('pay/bad-end');
    assert.equal(sub.received.filter((m) => m.topic === 'pay/bad').length, 0);
  });

  test("invalid topics ('a/+', 'a/#', '', NUL, non-string) are rejected and the connection stays up", async (t) => {
    const rec = await connected(t, broker.port);
    const later = statusesAfter(rec.s);
    for (const topic of ['a/+', 'a/#', '+', '#', '', 'a\u0000b', undefined, null, 42]) {
      const r = await rec.s.publish({ topic, payload: 'x', qos: 1 });
      assert.equal(r.ok, false, `topic ${JSON.stringify(topic)}`);
      assert.ok(r.error);
    }
    assert.deepEqual(await rec.s.publish(), { ok: false, error: 'Topic is required' });
    assert.equal(rec.s.status.state, 'connected');
    assert.deepEqual(await rec.s.publish({ topic: 'after/invalid', payload: 'still works', qos: 1 }), { ok: true });
    assert.equal((await seen('after/invalid')).payload.toString(), 'still works');
    later.stop();
    assert.deepEqual(later.seen, [], 'no status change caused by invalid publishes');
  });

  test("topics with empty levels and UTF-8 ('a//b', '/x', '日本/🚀') are valid publish topics", async (t) => {
    const rec = await connected(t, broker.port);
    for (const topic of ['a//b', '/x', 'trail/', '日本/🚀']) {
      assert.deepEqual(await rec.s.publish({ topic, payload: topic }), { ok: true });
      assert.equal((await seen(topic)).payload.toString(), topic);
    }
  });

  test('publish when disconnected → {ok:false, "Not connected"} (never connected, and after disconnect)', async (t) => {
    const rec = recorder(t);
    assert.deepEqual(await rec.s.publish({ topic: 'x', payload: 'y' }), { ok: false, error: 'Not connected' });
    rec.s.connect({ host: '127.0.0.1', port: broker.port });
    await rec.waitState('connected');
    rec.s.disconnect();
    assert.deepEqual(await rec.s.publish({ topic: 'x', payload: 'y', qos: 1 }), { ok: false, error: 'Not connected' });
  });

  test('publish while the connection is down (reconnecting) → {ok:false, "Not connected"}', async (t) => {
    const b2 = await startBroker();
    const port = b2.port;
    const rec = await connected(t, port, {}, { reconnectPeriod: 5000 });
    await b2.close();
    await until(() => !rec.s.connected, { message: 'connection lost' });
    assert.deepEqual(await rec.s.publish({ topic: 'x', payload: 'y', qos: 1 }), { ok: false, error: 'Not connected' });
  });

  test('many concurrent qos 1 publishes all resolve ok and arrive', async (t) => {
    const rec = await connected(t, broker.port);
    const N = 500;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => rec.s.publish({ topic: 'many/q1', payload: String(i), qos: 1 })),
    );
    assert.ok(results.every((r) => r.ok));
    await until(() => sub.received.filter((m) => m.topic === 'many/q1').length >= N, { message: `${N} arrivals` });
    const got = sub.received.filter((m) => m.topic === 'many/q1').map((m) => Number(m.payload.toString()));
    assert.deepEqual(got.sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i));
  });

  test('properties are ignored on an MQTT 3.1.1 connection (publish still succeeds)', async (t) => {
    const rec = await connected(t, broker.port);
    const res = await rec.s.publish({ topic: 'props/v4', payload: 'p', qos: 1, properties: { contentType: 'text/plain' } });
    assert.deepEqual(res, { ok: true });
    await seen('props/v4');
  });
});

describe('publish the broker refuses or never acknowledges', () => {
  test('qos 0 publish denied by the broker: resolves ok, is not delivered; aedes drops the connection and the session recovers', async (t) => {
    const broker = await startBroker({ denyPublish: ['forbidden'] });
    t.after(() => broker.close());
    const obs = await testClient(broker.port);
    t.after(() => obs.end().catch(() => {}));
    await obs.subscribe('#');
    const rec = await connected(t, broker.port);
    const res = await rec.s.publish({ topic: 'forbidden', payload: 'x', qos: 0 });
    // MQTT 3.1.1 has no negative ack: qos 0 "succeeds" once written.
    assert.deepEqual(res, { ok: true });
    await rec.waitStatusCount('connected', 2, { message: 'reconnected after the broker dropped us' });
    t.diagnostic(`statuses: ${rec.states().join(' → ')}`);
    assert.equal(obs.received.filter((m) => m.topic === 'forbidden').length, 0);
    assert.deepEqual(await rec.s.publish({ topic: 'allowed', payload: 'y', qos: 1 }), { ok: true });
    await obs.waitFor((m) => m.topic === 'allowed');
  });

  test('qos 1 publish denied by the broker settles and does not cause a reconnect loop', async (t) => {
    // aedes (like HiveMQ/EMQX on 3.1.1) disconnects a client whose publish is
    // not authorised. mqtt.js keeps the unacked qos 1 packet in its outgoing
    // store and re-sends it after every reconnect → disconnected again.
    const broker = await startBroker({ denyPublish: ['forbidden'] });
    t.after(() => broker.close());
    let clients = 0;
    broker.aedes.on('client', () => clients++);
    const rec = await connected(t, broker.port, {}, { reconnectPeriod: 100 });
    const p = rec.s.publish({ topic: 'forbidden', payload: 'x', qos: 1 });
    const result = await settleWithin(p, 1500);
    t.diagnostic(`after 1.5 s: result=${JSON.stringify(result)}, broker connections=${clients}, statuses=${rec.states().length}`);
    assert.ok(clients <= 3, `reconnect loop: ${clients} connections in 1.5 s (each re-sends the denied publish)`);
    assert.notEqual(result, 'pending', 'publish() promise never settled');
    assert.equal(result.ok, false);
  });

  test('disconnect() while a qos 1 publish awaits PUBACK settles the publish promise', async (t) => {
    const broker = await startBroker();
    t.after(() => broker.close());
    // Hold every publish to 'hold' forever: no PUBACK is ever sent.
    broker.aedes.authorizePublish = (client, packet, done) => {
      if (packet.topic !== 'hold') done(null);
    };
    const rec = await connected(t, broker.port);
    const p = rec.s.publish({ topic: 'hold', payload: 'x', qos: 1 });
    assert.equal(await settleWithin(p, 100), 'pending', 'broker holds the PUBACK');
    rec.s.disconnect();
    const result = await settleWithin(p, 1000);
    assert.notEqual(result, 'pending', 'publish() promise still pending 1 s after disconnect() (UI would wait forever)');
    assert.equal(result.ok, false);
  });
});
