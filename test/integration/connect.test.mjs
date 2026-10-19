// Connecting over every transport: mqtt (TCP), mqtts (TLS), ws, wss. Status
// sequence, reported URL, TLS verification and TLS file handling.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBroker, makeCerts, testClient, until, sleep } from '../helpers/broker.mjs';
import { recorder, text, startWsListener } from './_session.mjs';

let certs;
let broker;
before(async () => {
  certs = makeCerts();
  broker = await startBroker({ tls: certs, ws: true });
});
after(() => broker.close());

// Proves the data path: the session receives a message published by an outside client.
async function assertReceives(rec, label) {
  const c = await testClient(broker.port);
  try {
    await until(
      async () => {
        await c.publish(`probe/${label}`, label);
        return rec.messages.some((m) => m.topic === `probe/${label}` && text(m) === label);
      },
      { message: `${label} message` },
    );
  } finally {
    await c.end();
  }
}

describe('mqtt (TCP)', () => {
  test('status goes connecting → connected and carries the url', async (t) => {
    const rec = recorder(t);
    const url = `mqtt://127.0.0.1:${broker.port}`;
    const res = rec.s.connect({ host: '127.0.0.1', port: broker.port, subscriptions: [{ topic: 'probe/#' }] });
    assert.deepEqual(res, { ok: true, url });
    // 'connecting' is emitted synchronously from connect()
    assert.deepEqual(rec.statuses, [{ state: 'connecting', url }]);
    await rec.waitState('connected');
    assert.deepEqual(rec.statuses, [
      { state: 'connecting', url },
      { state: 'connected', url },
    ]);
    assert.equal(rec.s.connected, true);
    await assertReceives(rec, 'tcp');
  });

  test('port given as a string and host with surrounding whitespace are accepted', async (t) => {
    const rec = recorder(t);
    const res = rec.s.connect({ host: '  127.0.0.1 ', port: String(broker.port) });
    assert.equal(res.ok, true);
    assert.equal(res.url, `mqtt://127.0.0.1:${broker.port}`);
    await rec.waitState('connected');
  });

  test('client id: generated with mqtt-scope- prefix, or taken from the profile', async (t) => {
    const ids = [];
    const onClient = (c) => ids.push(c.id);
    broker.aedes.on('client', onClient);
    t.after(() => broker.aedes.off('client', onClient));

    const a = recorder(t);
    a.s.connect({ host: '127.0.0.1', port: broker.port });
    await a.waitState('connected');
    const b = recorder(t);
    b.s.connect({ host: '127.0.0.1', port: broker.port, clientId: 'my-fixed-id' });
    await b.waitState('connected');
    await until(() => ids.length >= 2, { message: 'broker saw both clients' });
    assert.match(ids[0], /^mqtt-scope-[0-9a-f]+$/);
    assert.equal(ids[1], 'my-fixed-id');
  });

  test('a non-TLS profile ignores caFile (even a missing one)', async (t) => {
    const rec = recorder(t);
    const res = rec.s.connect({ host: '127.0.0.1', port: broker.port, caFile: '/definitely/missing/ca.pem' });
    assert.equal(res.ok, true);
    await rec.waitState('connected');
  });
});

describe('mqtts (TLS)', () => {
  test('caFile verifies the server certificate (localhost) and connects', async (t) => {
    const rec = recorder(t);
    const url = `mqtts://localhost:${broker.tlsPort}`;
    const res = rec.s.connect({
      protocol: 'mqtts',
      host: 'localhost',
      port: broker.tlsPort,
      caFile: certs.caFile,
      subscriptions: [{ topic: 'probe/#' }],
    });
    assert.deepEqual(res, { ok: true, url });
    await rec.waitState('connected');
    assert.deepEqual(rec.states(), ['connecting', 'connected']);
    assert.ok(rec.statuses.every((s) => s.url === url));
    await assertReceives(rec, 'tls');
  });

  test('caFile also verifies when connecting by IP (cert has IP SAN 127.0.0.1)', async (t) => {
    const rec = recorder(t);
    rec.s.connect({ protocol: 'mqtts', host: '127.0.0.1', port: broker.tlsPort, caFile: certs.caFile });
    await rec.waitState('connected');
  });

  test('unknown CA with rejectUnauthorized (default) → error mentioning certificate, never connects', async (t) => {
    let clients = 0;
    const onClient = () => clients++;
    broker.aedes.on('client', onClient);
    t.after(() => broker.aedes.off('client', onClient));

    const rec = recorder(t);
    rec.s.connect({ protocol: 'mqtts', host: 'localhost', port: broker.tlsPort });
    await rec.waitState('error');
    const err = rec.statuses.find((s) => s.state === 'error');
    assert.match(err.error, /certificate/i);
    assert.equal(err.url, `mqtts://localhost:${broker.tlsPort}`);
    // keeps failing on retry, never reaches 'connected' and never reaches the broker
    await rec.waitStatusCount('error', 2);
    assert.ok(!rec.states().includes('connected'));
    assert.equal(clients, 0);
    assert.equal(rec.s.connected, false);
  });

  test('explicit rejectUnauthorized: true behaves the same as the default', async (t) => {
    const rec = recorder(t);
    rec.s.connect({ protocol: 'mqtts', host: 'localhost', port: broker.tlsPort, rejectUnauthorized: true });
    await rec.waitState('error');
    assert.match(rec.s.status.error, /certificate/i);
  });

  test('rejectUnauthorized: false connects to an untrusted server', async (t) => {
    const rec = recorder(t);
    rec.s.connect({
      protocol: 'mqtts',
      host: 'localhost',
      port: broker.tlsPort,
      rejectUnauthorized: false,
      subscriptions: [{ topic: 'probe/#' }],
    });
    await rec.waitState('connected');
    await assertReceives(rec, 'insecure');
  });

  test('wrong CA (a different self-signed CA) is rejected', async (t) => {
    const other = makeCerts();
    const rec = recorder(t);
    rec.s.connect({ protocol: 'mqtts', host: 'localhost', port: broker.tlsPort, caFile: other.caFile });
    await rec.waitState('error');
    assert.match(rec.s.status.error, /certificate|signature/i);
  });

  test('TLS client talking to a plain TCP port fails with an error, not a hang', async (t) => {
    const rec = recorder(t, { connectTimeout: 1000 });
    rec.s.connect({ protocol: 'mqtts', host: 'localhost', port: broker.port, caFile: certs.caFile });
    await until(() => rec.states().some((s) => s === 'error' || s === 'disconnected'), {
      message: 'TLS-to-plain failure surfaced',
    });
    assert.ok(!rec.states().includes('connected'));
  });

  test('missing CA file → {ok:false} immediately and status error naming the file', async (t) => {
    const rec = recorder(t);
    const file = '/nonexistent/dir/ca.pem';
    const res = rec.s.connect({ protocol: 'mqtts', host: 'localhost', port: broker.tlsPort, caFile: file });
    assert.equal(res.ok, false);
    assert.ok(res.error.includes(file), res.error);
    assert.match(res.error, /CA certificate/);
    assert.match(res.error, /ENOENT/);
    assert.deepEqual(rec.statuses, [{ state: 'error', error: res.error }]);
    assert.equal(rec.s.client, null, 'no client must be created');
    assert.equal(rec.s.timer, null, 'no flush timer must be started');
    await sleep(100);
    assert.equal(rec.statuses.length, 1, 'nothing happens afterwards');
  });

  test('missing client cert / key files are reported with their label and path', (t) => {
    const rec = recorder(t);
    const base = { protocol: 'mqtts', host: 'localhost', port: broker.tlsPort, caFile: certs.caFile };
    const r1 = rec.s.connect({ ...base, certFile: '/nope/client.crt' });
    assert.equal(r1.ok, false);
    assert.match(r1.error, /client certificate "\/nope\/client\.crt"/);
    const r2 = rec.s.connect({ ...base, keyFile: '/nope/client.key' });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /client key "\/nope\/client\.key"/);
    assert.equal(rec.s.status.state, 'error');
  });

  test('the readFile constructor option is used to load TLS files', async (t) => {
    const asked = [];
    const rec = recorder(t, {
      readFile: (f) => {
        asked.push(f);
        if (f === 'virtual:ca') return certs.ca;
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
    });
    rec.s.connect({ protocol: 'mqtts', host: 'localhost', port: broker.tlsPort, caFile: 'virtual:ca' });
    await rec.waitState('connected');
    assert.deepEqual(asked, ['virtual:ca']);
  });
});

describe('ws / wss', () => {
  test('ws with wsPath "/" connects; url includes the path', async (t) => {
    const rec = recorder(t);
    const url = `ws://localhost:${broker.wsPort}/`;
    const res = rec.s.connect({ protocol: 'ws', host: 'localhost', port: broker.wsPort, wsPath: '/', subscriptions: [{ topic: 'probe/#' }] });
    assert.deepEqual(res, { ok: true, url });
    await rec.waitState('connected');
    assert.deepEqual(rec.states(), ['connecting', 'connected']);
    assert.ok(rec.statuses.every((s) => s.url === url));
    await assertReceives(rec, 'ws');
  });

  test('ws without wsPath uses /mqtt (request path seen by the server)', async (t) => {
    const wsl = await startWsListener(broker.aedes, { path: '/mqtt' });
    t.after(() => wsl.close());
    const rec = recorder(t);
    const res = rec.s.connect({ protocol: 'ws', host: '127.0.0.1', port: wsl.port, subscriptions: [{ topic: 'probe/#' }] });
    assert.equal(res.url, `ws://127.0.0.1:${wsl.port}/mqtt`);
    await rec.waitState('connected');
    assert.deepEqual(wsl.requests, ['/mqtt']);
    await assertReceives(rec, 'ws-default-path');
  });

  test('ws with a custom wsPath requests exactly that path', async (t) => {
    const wsl = await startWsListener(broker.aedes, { path: '/broker/ws' });
    t.after(() => wsl.close());
    const rec = recorder(t);
    rec.s.connect({ protocol: 'ws', host: '127.0.0.1', port: wsl.port, wsPath: '/broker/ws' });
    await rec.waitState('connected');
    assert.deepEqual(wsl.requests, ['/broker/ws']);
  });

  test('ws path mismatch (server only serves /mqtt) never connects', async (t) => {
    const wsl = await startWsListener(broker.aedes, { path: '/mqtt' });
    t.after(() => wsl.close());
    const rec = recorder(t);
    rec.s.connect({ protocol: 'ws', host: '127.0.0.1', port: wsl.port, wsPath: '/other' });
    await until(() => wsl.requests.length >= 2, { message: 'at least one retry' });
    assert.ok(wsl.requests.every((p) => p === '/other'));
    assert.ok(!rec.states().includes('connected'));
    assert.notEqual(rec.s.status.state, 'connected');
  });

  test('wss with caFile verifies and connects', async (t) => {
    const wsl = await startWsListener(broker.aedes, { path: '/mqtt', tls: certs });
    t.after(() => wsl.close());
    const rec = recorder(t);
    const res = rec.s.connect({ protocol: 'wss', host: 'localhost', port: wsl.port, caFile: certs.caFile, subscriptions: [{ topic: 'probe/#' }] });
    assert.equal(res.url, `wss://localhost:${wsl.port}/mqtt`);
    await rec.waitState('connected');
    await assertReceives(rec, 'wss');
  });

  test('wss without CA is rejected with a certificate error', async (t) => {
    const wsl = await startWsListener(broker.aedes, { path: '/mqtt', tls: certs });
    t.after(() => wsl.close());
    const rec = recorder(t);
    rec.s.connect({ protocol: 'wss', host: 'localhost', port: wsl.port });
    await rec.waitState('error');
    assert.match(rec.s.status.error, /certificate/i);
    assert.ok(!rec.states().includes('connected'));
  });

  test('wss with rejectUnauthorized: false connects', async (t) => {
    const wsl = await startWsListener(broker.aedes, { path: '/mqtt', tls: certs });
    t.after(() => wsl.close());
    const rec = recorder(t);
    rec.s.connect({ protocol: 'wss', host: 'localhost', port: wsl.port, rejectUnauthorized: false });
    await rec.waitState('connected');
  });
});
