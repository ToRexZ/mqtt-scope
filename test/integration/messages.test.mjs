// Message fidelity: what arrives in 'batch' events must match exactly what
// was published (bytes, topic, flags), with standalone payload buffers.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startBroker, testClient, until, sleep } from '../helpers/broker.mjs';
import { connected, text } from './_session.mjs';

let broker;
let pub;
before(async () => {
  broker = await startBroker();
  pub = await testClient(broker.port);
});
after(async () => {
  await pub.end();
  await broker.close();
});

// A session subscribed to `filter`, warmed up so the subscription is active.
async function subscribed(t, filter, qos = 0, options = {}) {
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: filter, qos }] }, options);
  const warm = `${filter.replace(/[#+].*$/, '').replace(/\/$/, '') || 'warm'}/__warm`;
  await until(
    async () => {
      await pub.publish(warm, 'w');
      return rec.messages.some((m) => m.topic === warm);
    },
    { message: 'subscription active' },
  );
  // Flush out any extra warm-up copies still in flight (same publisher → in order).
  await pub.publish(`${warm}/done`, 'd');
  await rec.waitFor((m) => m.topic === `${warm}/done`);
  rec.messages.length = 0;
  return rec;
}

const isStandalone = (p) =>
  p instanceof Uint8Array && p.byteOffset === 0 && p.buffer.byteLength === p.byteLength;

test('binary payload with all 256 byte values round-trips byte-exact', async (t) => {
  const rec = await subscribed(t, 'bin/#');
  const bytes = new Uint8Array(1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  await pub.publish('bin/all', Buffer.from(bytes));
  const m = await rec.waitFor((x) => x.topic === 'bin/all');
  assert.equal(m.payload.byteLength, 1024);
  assert.deepEqual(Buffer.from(m.payload), Buffer.from(bytes));
  assert.ok(isStandalone(m.payload));
});

test('invalid UTF-8 bytes are delivered untouched (no text decoding in the session)', async (t) => {
  const rec = await subscribed(t, 'bin/#');
  const bytes = Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x00, 0xed, 0xa0, 0x80]);
  await pub.publish('bin/invalid-utf8', bytes);
  const m = await rec.waitFor((x) => x.topic === 'bin/invalid-utf8');
  assert.deepEqual(Buffer.from(m.payload), bytes);
});

test('0-byte payload arrives as an empty standalone Uint8Array', async (t) => {
  const rec = await subscribed(t, 'empty/#');
  await pub.publish('empty/one', Buffer.alloc(0));
  const m = await rec.waitFor((x) => x.topic === 'empty/one');
  assert.equal(m.payload.byteLength, 0);
  assert.ok(m.payload instanceof Uint8Array);
  assert.equal(m.payload.buffer.byteLength, 0);
});

test('5 MB payload round-trips byte-exact into a standalone buffer', async (t) => {
  const rec = await subscribed(t, 'big/#');
  const big = randomBytes(5 * 1024 * 1024);
  await pub.publish('big/blob', big);
  const m = await rec.waitFor((x) => x.topic === 'big/blob', { timeout: 15000 });
  assert.equal(m.payload.byteLength, big.length);
  assert.ok(Buffer.from(m.payload).equals(big), 'payload bytes differ');
  assert.ok(isStandalone(m.payload));
});

test('payloads are standalone copies, not views into the socket chunk (burst of small messages)', async (t) => {
  const rec = await subscribed(t, 'burst/#', 0, { flushIntervalMs: 50 });
  const N = 500;
  // Published back-to-back so many messages share one TCP chunk on arrival.
  for (let i = 0; i < N; i++) pub.client.publish(`burst/${i}`, `payload-${i}`);
  await rec.waitMessages(N);
  for (const m of rec.messages) {
    assert.ok(isStandalone(m.payload), `${m.topic}: offset ${m.payload.byteOffset}, backing ${m.payload.buffer.byteLength} vs ${m.payload.byteLength}`);
    assert.equal(Object.getPrototypeOf(m.payload), Uint8Array.prototype, 'plain Uint8Array (not a Buffer view)');
  }
  assert.deepEqual(
    rec.messages.map(text),
    Array.from({ length: N }, (_, i) => `payload-${i}`),
    'order and content preserved',
  );
  // and each copy is independent: mutating one does not affect another
  const [a, b] = rec.messages;
  a.payload.fill(0);
  assert.equal(text(b), 'payload-1');
});

test('UTF-8 multibyte topics arrive unchanged', async (t) => {
  const rec = await subscribed(t, '#');
  const topics = ['zażółć/gęślą/jaźń', '日本/東京/温度', 'emoji/🚀/✓', 'ελληνικά', 'mixed/ä/日/🙂/end'];
  for (const tp of topics) await pub.publish(tp, tp);
  await until(() => topics.every((tp) => rec.ofTopic(tp).length === 1), { message: 'all UTF-8 topics' });
  for (const tp of topics) assert.equal(text(rec.ofTopic(tp)[0]), tp);
});

test("topics with empty levels ('a//b', '/lead', 'trail/', '/') arrive unchanged", async (t) => {
  const rec = await subscribed(t, '#');
  const topics = ['a//b', '/lead', 'trail/', '/', '//', 'x///y/'];
  for (const tp of topics) await pub.publish(tp, `t:${tp}`);
  await until(() => topics.every((tp) => rec.ofTopic(tp).length === 1), {
    message: `all empty-level topics (got ${rec.messages.map((m) => m.topic).join(' ')})`,
  });
  for (const tp of topics) assert.equal(text(rec.ofTopic(tp)[0]), `t:${tp}`);
});

test('retain flag: true for retained messages delivered on subscribe, false for live ones', async (t) => {
  await broker.publish('rf/stored', 'old', { retain: true });
  t.after(() => broker.publish('rf/stored', '', { retain: true }));
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: 'rf/#', qos: 1 }] });
  const stored = await rec.waitFor((m) => m.topic === 'rf/stored');
  assert.equal(stored.retain, true);
  assert.equal(text(stored), 'old');

  await pub.publish('rf/live', 'plain', { qos: 1 });
  await pub.publish('rf/stored', 'new', { qos: 1, retain: true }); // live, even though published with retain
  await until(() => rec.ofTopic('rf/live').length && rec.ofTopic('rf/stored').length === 2, { message: 'live messages' });
  assert.equal(rec.ofTopic('rf/live')[0].retain, false);
  assert.equal(rec.ofTopic('rf/stored')[1].retain, false);
  assert.equal(text(rec.ofTopic('rf/stored')[1]), 'new');
});

test('qos is reported per message', async (t) => {
  const rec = await subscribed(t, 'qq/#', 2);
  await pub.publish('qq/0', 'a', { qos: 0 });
  await pub.publish('qq/1', 'b', { qos: 1 });
  await pub.publish('qq/2', 'c', { qos: 2 });
  await until(() => ['qq/0', 'qq/1', 'qq/2'].every((tp) => rec.ofTopic(tp).length), { message: 'three qos levels' });
  assert.deepEqual(['qq/0', 'qq/1', 'qq/2'].map((tp) => rec.ofTopic(tp)[0].qos), [0, 1, 2]);
});

test('every message has ts (ms epoch, non-decreasing in arrival order) and props null on MQTT 3.1.1', async (t) => {
  const rec = await subscribed(t, 'ts/#');
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) {
    await pub.publish(`ts/${i}`, String(i));
    if (i % 10 === 0) await sleep(5);
  }
  await rec.waitMessages(50);
  const t1 = Date.now();
  let prev = 0;
  for (const m of rec.messages) {
    assert.equal(typeof m.ts, 'number');
    assert.ok(m.ts >= t0 && m.ts <= t1, `ts ${m.ts} outside [${t0}, ${t1}]`);
    assert.ok(m.ts >= prev, 'ts must not go backwards');
    prev = m.ts;
    assert.equal(m.props, null);
    assert.deepEqual(Object.keys(m).sort(), ['payload', 'props', 'qos', 'retain', 'topic', 'ts']);
  }
});

test('message objects survive structured cloning (what Electron IPC does) intact', async (t) => {
  const rec = await subscribed(t, 'clone/#');
  await pub.publish('clone/x', Buffer.from([1, 2, 3]));
  await rec.waitFor((m) => m.topic === 'clone/x');
  const batch = structuredClone({ messages: rec.messages, dropped: 0 });
  const m = batch.messages[0];
  assert.ok(m.payload instanceof Uint8Array);
  assert.deepEqual([...m.payload], [1, 2, 3]);
  assert.equal(m.payload.buffer.byteLength, 3);
});
