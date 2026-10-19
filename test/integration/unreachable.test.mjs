// Unreachable brokers, connect timeouts, and tearing a session down while it
// is still connecting or retrying.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBroker, until, sleep } from '../helpers/broker.mjs';
import { recorder, freePort, startSilentServer, statusesAfter } from './_session.mjs';

test('closed port → error (ECONNREFUSED) then reconnecting, repeatedly; never connected', async (t) => {
  const port = await freePort();
  const rec = recorder(t);
  const url = `mqtt://127.0.0.1:${port}`;
  const res = rec.s.connect({ host: '127.0.0.1', port });
  assert.deepEqual(res, { ok: true, url }); // the attempt itself is accepted
  await rec.waitStatusCount('reconnecting', 3);
  const errors = rec.statuses.filter((s) => s.state === 'error');
  assert.ok(errors.length >= 3, `one error per attempt (got ${errors.length})`);
  for (const e of errors) assert.match(e.error, /ECONNREFUSED/);
  assert.ok(rec.statuses.every((s) => s.url === url), 'every status carries the url');
  assert.ok(!rec.states().includes('connected'));
  assert.equal(rec.statuses[0].state, 'connecting');
});

test('first failed attempt: the error stays the visible status until the next retry', async (t) => {
  // The 'close' handler deliberately keeps an 'error' status, but mqtt.js emits
  // 'offline' between 'error' and 'close' on the first failure, which defeats the
  // guard: the reason is replaced by offline → disconnected(unexpected).
  const port = await freePort();
  const rec = recorder(t, { reconnectPeriod: 300 });
  rec.s.connect({ host: '127.0.0.1', port });
  await rec.waitStatusCount('reconnecting', 1);
  const states = rec.states();
  const firstRetry = states.indexOf('reconnecting');
  assert.equal(
    states[firstRetry - 1],
    'error',
    `status shown while waiting for the first retry should be the error, sequence was: ${states.join(' → ')}`,
  );
});

test('connectTimeout: a server that never sends CONNACK → "connack timeout" error after ~connectTimeout, then retries', async (t) => {
  const srv = await startSilentServer();
  t.after(() => srv.close());
  const rec = recorder(t, { connectTimeout: 300, reconnectPeriod: 100 });
  const t0 = Date.now();
  rec.s.connect({ host: '127.0.0.1', port: srv.port });
  await rec.waitState('error', { timeout: 3000 });
  const elapsed = Date.now() - t0;
  assert.match(rec.s.status.error, /connack timeout/i);
  assert.ok(elapsed >= 250 && elapsed < 2000, `timed out after ${elapsed} ms (connectTimeout 300)`);
  await until(() => srv.connections >= 2, { message: 'a retry after the timeout' });
  assert.ok(!rec.states().includes('connected'));
  assert.ok(rec.states().includes('reconnecting'));
});

test('disconnect() while connecting stops everything: no more statuses, no retries, socket closed', async (t) => {
  const srv = await startSilentServer();
  t.after(() => srv.close());
  const rec = recorder(t, { connectTimeout: 300, reconnectPeriod: 100 });
  rec.s.connect({ host: '127.0.0.1', port: srv.port });
  await until(() => srv.connections === 1, { message: 'TCP connection' });
  assert.equal(rec.s.status.state, 'connecting');

  rec.s.disconnect();
  const last = rec.statuses.at(-1);
  assert.equal(last.state, 'disconnected');
  assert.ok(!last.unexpected, 'user-initiated disconnect is not flagged unexpected');
  assert.equal(rec.s.client, null);
  assert.equal(rec.s.timer, null);

  const later = statusesAfter(rec.s);
  await until(() => srv.open === 0, { message: 'server sees the socket closed' });
  await sleep(600); // > connectTimeout + reconnectPeriod: a leaked client would retry or time out
  later.stop();
  assert.deepEqual(later.seen, [], 'no status events after the final disconnected');
  assert.equal(srv.connections, 1, 'no reconnect attempts after disconnect()');
});

test('disconnect() during the reconnect loop silences the session for good', async (t) => {
  const srv = await startSilentServer();
  t.after(() => srv.close());
  const rec = recorder(t, { connectTimeout: 150, reconnectPeriod: 50 });
  rec.s.connect({ host: '127.0.0.1', port: srv.port });
  await rec.waitStatusCount('reconnecting', 2);
  rec.s.disconnect();
  assert.equal(rec.s.status.state, 'disconnected');
  const later = statusesAfter(rec.s);
  // A TCP connect the client initiated just before disconnect() may still be
  // accepted by the server a few ms later; count attempts only after that.
  await sleep(50);
  const attempts = srv.connections;
  await sleep(500); // ~10 reconnect periods
  later.stop();
  assert.deepEqual(later.seen, []);
  assert.equal(srv.connections, attempts, 'no further connection attempts');
});

test('disconnect() during reconnect loop to a closed port: final status is disconnected, then silence', async (t) => {
  const port = await freePort();
  const rec = recorder(t, { reconnectPeriod: 50 });
  rec.s.connect({ host: '127.0.0.1', port });
  await rec.waitStatusCount('reconnecting', 2);
  rec.s.disconnect();
  assert.deepEqual(rec.statuses.at(-1), { state: 'disconnected', url: `mqtt://127.0.0.1:${port}` });
  const later = statusesAfter(rec.s);
  await sleep(300);
  later.stop();
  assert.deepEqual(later.seen, []);
});

test('disconnect() is idempotent and a no-op on a fresh session', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const rec = recorder(t);
  rec.s.disconnect();
  assert.deepEqual(rec.statuses, [], 'nothing to disconnect → no status');
  rec.s.connect({ host: '127.0.0.1', port: broker.port });
  await rec.waitState('connected');
  rec.s.disconnect();
  rec.s.disconnect();
  assert.deepEqual(rec.states(), ['connecting', 'connected', 'disconnected']);
  await until(() => broker.aedes.connectedClients === 0, { message: 'broker sees client gone' });
});

test('an invalid profile while connected tears down the old connection and reports the error', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const rec = recorder(t);
  rec.s.connect({ host: '127.0.0.1', port: broker.port });
  await rec.waitState('connected');
  const res = rec.s.connect({ host: '   ', port: broker.port });
  assert.deepEqual(res, { ok: false, error: 'Host is required' });
  assert.deepEqual(rec.states(), ['connecting', 'connected', 'disconnected', 'error']);
  assert.equal(rec.s.connected, false);
  await until(() => broker.aedes.connectedClients === 0, { message: 'old connection closed at broker' });
  for (const [profile, re] of [
    [{ protocol: 'http', host: 'x' }, /Unsupported protocol/],
    [{ host: 'x', port: 70000 }, /Invalid port/],
    [{ host: 'x', port: 'abc' }, /Invalid port/],
  ]) {
    const r = rec.s.connect(profile);
    assert.equal(r.ok, false);
    assert.match(r.error, re);
    assert.equal(rec.s.status.state, 'error');
  }
});

test('session is reusable after a failure: a later good connect works', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const rec = recorder(t);
  rec.s.connect({ host: '127.0.0.1', port: await freePort() });
  await rec.waitState('error');
  rec.s.connect({ host: '127.0.0.1', port: broker.port });
  await rec.waitState('connected');
  assert.equal(rec.s.url, `mqtt://127.0.0.1:${broker.port}`);
  const later = statusesAfter(rec.s);
  await sleep(250); // the abandoned client must not report its retries
  later.stop();
  assert.deepEqual(later.seen, []);
});
