// Batching: incoming messages are buffered and emitted as few 'batch' events;
// overflow beyond maxBuffered is counted as dropped; the flush timer is tied to
// the connection lifetime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBroker, testClient, until, sleep } from '../helpers/broker.mjs';
import { connected, subscribedSession, text } from './_session.mjs';

async function setup(t) {
  const broker = await startBroker();
  t.after(() => broker.close());
  return broker;
}

test('a burst of 2000 messages arrives in a handful of batches, complete and in order', async (t) => {
  const broker = await setup(t);
  const rec = await subscribedSession(t, broker.aedes, broker.port, 'b/#', 0, { flushIntervalMs: 100 });
  const N = 2000;
  await Promise.all(Array.from({ length: N }, (_, i) => broker.publish(`b/${i % 10}`, String(i))));
  await rec.waitMessages(N);
  await sleep(150);
  t.diagnostic(`${N} messages in ${rec.batches.length} batches`);
  assert.equal(rec.messages.length, N, 'no duplicates');
  assert.equal(rec.dropped, 0);
  assert.ok(rec.batches.length <= 20, `expected few batches, got ${rec.batches.length}`);
  assert.deepEqual(rec.messages.map((m) => Number(text(m))), Array.from({ length: N }, (_, i) => i));
});

test('no empty batches are emitted while idle', async (t) => {
  const broker = await setup(t);
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: 'idle/#' }] });
  await sleep(150); // 15 flush intervals with nothing to deliver
  assert.equal(rec.batches.length, 0);
  await broker.publish('idle/x', '1');
  await rec.waitMessages(1);
  await sleep(100);
  assert.ok(rec.batches.every((b) => b.messages.length > 0 || b.dropped > 0));
  assert.equal(rec.batches.length, 1);
});

test('maxBuffered: overflow is counted as dropped and delivered + dropped === sent', async (t) => {
  const broker = await setup(t);
  const max = 100;
  const rec = await subscribedSession(t, broker.aedes, broker.port, 'o/#', 0, { maxBuffered: max, flushIntervalMs: 300 });
  const N = 1000;
  await Promise.all(Array.from({ length: N }, (_, i) => broker.publish('o/x', String(i))));
  await until(() => rec.messages.length + rec.dropped >= N, {
    message: `delivered+dropped to reach ${N} (got ${rec.messages.length}+${rec.dropped})`,
  });
  await sleep(350);
  t.diagnostic(`delivered ${rec.messages.length}, dropped ${rec.dropped}, batches ${rec.batches.length}`);
  assert.equal(rec.messages.length + rec.dropped, N);
  assert.ok(rec.dropped > 0, 'a 1000 burst into a 100 buffer must drop');
  for (const b of rec.batches) assert.ok(b.messages.length <= max, `batch of ${b.messages.length} exceeds maxBuffered`);
  const seq = rec.messages.map((m) => Number(text(m)));
  assert.ok(seq.every((v, i) => i === 0 || v > seq[i - 1]), 'delivered subset keeps publish order');
  assert.equal(seq[0], 0, 'the oldest messages are kept, newer ones dropped');
});

test('dropped count is reported in the batch that follows the overflow (even with zero messages kept)', async (t) => {
  const broker = await setup(t);
  const rec = await subscribedSession(t, broker.aedes, broker.port, 'z/#', 0, { maxBuffered: 1, flushIntervalMs: 200 });
  await Promise.all(Array.from({ length: 50 }, (_, i) => broker.publish('z/x', String(i))));
  await until(() => rec.messages.length + rec.dropped >= 50, { message: 'all accounted' });
  assert.equal(rec.messages.length + rec.dropped, 50);
  assert.ok(rec.batches.every((b) => b.messages.length <= 1));
  assert.ok(rec.batches.some((b) => b.dropped > 0));
});

test('disconnect() stops the flush timer and discards the unflushed buffer', async (t) => {
  const broker = await setup(t);
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: 'd/#' }] }, { flushIntervalMs: 250 });
  assert.ok(rec.s.timer, 'flush timer runs while connected');
  await until(
    async () => {
      await broker.publish('d/x', 'buffered');
      return rec.s.buffer.length > 0;
    },
    { message: 'a message sitting in the buffer' },
  );
  const batchesBefore = rec.batches.length;
  rec.s.disconnect();
  assert.equal(rec.s.timer, null);
  assert.equal(rec.s.buffer.length, 0);
  assert.equal(rec.s.dropped, 0);
  await sleep(400); // > one flush interval
  assert.equal(rec.batches.length, batchesBefore, 'no batch after disconnect');
});

test('no batches leak from an old connection after reconnecting to another profile', async (t) => {
  const broker = await setup(t);
  const other = await startBroker();
  t.after(() => other.close());
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: '#' }] }, { flushIntervalMs: 300 });
  await until(
    async () => {
      await broker.publish('old/x', 'old');
      return rec.s.buffer.length > 0;
    },
    { message: 'old message buffered' },
  );
  rec.s.connect({ host: '127.0.0.1', port: other.port, subscriptions: [{ topic: '#' }] });
  await rec.waitState('connected');
  await until(
    async () => {
      await other.publish('new/x', 'new');
      return rec.messages.length > 0;
    },
    { message: 'new message', timeout: 3000 },
  );
  assert.ok(rec.messages.every((m) => m.topic === 'new/x'), 'only messages from the new connection');
});

test('flush timer restarts on a new connect() after disconnect()', async (t) => {
  const broker = await setup(t);
  const rec = await connected(t, broker.port, { subscriptions: [{ topic: 'r/#' }] });
  rec.s.disconnect();
  assert.equal(rec.s.timer, null);
  rec.s.connect({ host: '127.0.0.1', port: broker.port, subscriptions: [{ topic: 'r/#' }] });
  await rec.waitState('connected');
  assert.ok(rec.s.timer);
  const c = await testClient(broker.port);
  t.after(() => c.end());
  await until(
    async () => {
      await c.publish('r/1', 'again');
      return rec.messages.length > 0;
    },
    { message: 'messages after reconnect' },
  );
});
