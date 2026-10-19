// Stress: sustained message rates through the session. Prints throughput;
// asserts completeness and only a sane throughput floor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBroker, testClient, until, sleep } from '../helpers/broker.mjs';
import { subscribedSession, text } from './_session.mjs';

const report = (t, line) => t.diagnostic(line);

test('20k small messages over a few seconds: all delivered (or accounted as dropped), in order', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const rec = await subscribedSession(t, broker.aedes, broker.port, 'load/#', 0);
  const pub = await testClient(broker.port);
  t.after(() => pub.end());

  const N = 20000;
  const RATE_CHUNK = 2000; // published per tick, ~10 ticks spread over time
  const t0 = performance.now();
  for (let i = 0; i < N; i += RATE_CHUNK) {
    for (let j = i; j < i + RATE_CHUNK; j++) pub.client.publish(`load/${j % 100}`, `m${j}`);
    await sleep(100);
  }
  await until(() => rec.messages.length + rec.dropped >= N, {
    timeout: 20000,
    message: `all ${N} accounted (got ${rec.messages.length} + ${rec.dropped} dropped)`,
  });
  const ms = performance.now() - t0;
  report(t, `stress: ${N} msgs in ${ms.toFixed(0)} ms → ${Math.round((N / ms) * 1000)} msg/s, ${rec.batches.length} batches, dropped ${rec.dropped}`);
  await sleep(50);
  assert.equal(rec.messages.length + rec.dropped, N, 'no extra/duplicate messages');
  assert.equal(rec.dropped, 0, 'default maxBuffered (50k) should not drop at this rate');
  const seq = rec.messages.map((m) => Number(text(m).slice(1)));
  assert.ok(seq.every((v, i) => v === i), 'order preserved');
  assert.ok(rec.batches.length < N / 20, `batching ineffective: ${rec.batches.length} batches`);
  assert.ok(N / (ms / 1000) > 1000, 'throughput floor 1000 msg/s');
});

test('20k message flood as fast as possible, small maxBuffered: delivered + dropped === sent', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const rec = await subscribedSession(t, broker.aedes, broker.port, 'flood/#', 0, { maxBuffered: 2000, flushIntervalMs: 50 });
  const pub = await testClient(broker.port);
  t.after(() => pub.end());
  const N = 20000;
  const t0 = performance.now();
  for (let j = 0; j < N; j++) pub.client.publish('flood/x', `m${j}`);
  await until(() => rec.messages.length + rec.dropped >= N, { timeout: 20000, message: 'flood accounted' });
  const ms = performance.now() - t0;
  report(t, `flood: ${N} msgs in ${ms.toFixed(0)} ms → ${Math.round((N / ms) * 1000)} msg/s, delivered ${rec.messages.length}, dropped ${rec.dropped}, batches ${rec.batches.length}`);
  await sleep(100);
  assert.equal(rec.messages.length + rec.dropped, N);
  assert.ok(rec.batches.every((b) => b.messages.length <= 2000));
});

test('session publish throughput: 5000 qos 1 publishes all acked and received', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const rec = await subscribedSession(t, broker.aedes, broker.port, 'echo/#', 0);
  const N = 5000;
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => rec.s.publish({ topic: 'echo/p', payload: String(i), qos: 1 })));
  const ackMs = performance.now() - t0;
  assert.ok(results.every((r) => r.ok), 'all acked');
  await until(() => rec.messages.length >= N, { timeout: 15000, message: 'echoes' });
  report(t, `publish: ${N} qos1 acked in ${ackMs.toFixed(0)} ms → ${Math.round((N / ackMs) * 1000)} msg/s`);
  assert.equal(new Set(rec.messages.map(text)).size, N);
});
