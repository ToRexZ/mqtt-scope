// Shared helpers for the MqttSession integration tests (not a test file itself:
// the runner only picks up *.test.mjs).

import { createRequire } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { until, sleep } from '../helpers/broker.mjs';

const require = createRequire(import.meta.url);
export const { MqttSession } = require('../../main/mqttSession.js');

// Fast timings so reconnect/flush behaviour is observable within a test.
export const FAST = { flushIntervalMs: 10, reconnectPeriod: 100, connectTimeout: 2000 };

export const text = (m) => Buffer.from(m.payload).toString();

// A session that records every event it emits. Torn down via t.after.
export function recorder(t, options = {}) {
  const s = new MqttSession({ ...FAST, ...options });
  const rec = { s, statuses: [], warnings: [], batches: [], messages: [], dropped: 0 };
  s.on('status', (x) => rec.statuses.push({ ...x }));
  s.on('warning', (w) => rec.warnings.push(w));
  s.on('batch', (b) => {
    rec.batches.push(b);
    for (const m of b.messages) rec.messages.push(m);
    rec.dropped += b.dropped;
  });
  rec.states = () => rec.statuses.map((x) => x.state);
  rec.waitState = (state, opts = {}) =>
    until(() => s.status.state === state, { message: `status "${state}" (seen: ${rec.states().join(',')})`, ...opts });
  rec.waitStatusCount = (state, n, opts = {}) =>
    until(() => rec.states().filter((x) => x === state).length >= n, { message: `${n}x status "${state}"`, ...opts });
  rec.waitMessages = (n, opts = {}) => until(() => rec.messages.length >= n, { message: `${n} messages (got ${rec.messages.length})`, ...opts });
  rec.waitFor = (pred, opts = {}) => until(() => rec.messages.find(pred), { message: 'matching message', ...opts });
  rec.ofTopic = (topic) => rec.messages.filter((m) => m.topic === topic);
  if (t) t.after(() => s.disconnect());
  return rec;
}

// recorder + connect to a plain TCP broker + wait for 'connected'.
export async function connected(t, port, profile = {}, options = {}) {
  const rec = recorder(t, options);
  const res = rec.s.connect({ host: '127.0.0.1', port, ...profile });
  if (!res.ok) throw new Error(`connect failed: ${res.error}`);
  await rec.waitState('connected');
  return rec;
}

// A port that nothing listens on (bound then released).
export async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

// Tracks sockets of a server so close() can be immediate.
function tracked(server) {
  const sockets = new Set();
  let connections = 0;
  server.on('connection', (s) => {
    connections++;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return {
    get connections() {
      return connections;
    },
    sockets,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

const listenOn = (server, port = 0) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });

// Aedes on TCP at a chosen port (0 = random), so a test can stop a broker and
// start a fresh one on the very same port.
export async function startBrokerOnPort(port = 0) {
  const aedes = await Aedes.createBroker();
  const server = net.createServer(aedes.handle);
  const tr = tracked(server);
  // Retry briefly: the previous listener on this port may still be releasing it.
  let bound;
  for (let i = 0; ; i++) {
    try {
      bound = await listenOn(server, port);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || i > 40) throw err;
      await sleep(50);
    }
  }
  let clients = 0;
  aedes.on('client', () => clients++);
  return {
    aedes,
    port: bound,
    get clients() {
      return clients;
    },
    get connections() {
      return tr.connections;
    },
    publish: (topic, payload, { retain = false, qos = 0 } = {}) =>
      new Promise((r) => aedes.publish({ cmd: 'publish', topic, payload: Buffer.from(payload), qos, retain, dup: false }, r)),
    async close() {
      await tr.close();
      await new Promise((r) => aedes.close(r));
    },
  };
}

// Accepts TCP connections, reads and discards everything, never answers (no
// CONNACK): for connectTimeout. Sockets close when the client closes them.
export async function startSilentServer() {
  const server = net.createServer((s) => {
    s.on('error', () => {});
    s.resume();
  });
  const tr = tracked(server);
  const port = await listenOn(server);
  return {
    port,
    get connections() {
      return tr.connections;
    },
    get open() {
      return tr.sockets.size;
    },
    close: tr.close,
  };
}

// A WebSocket listener (optionally TLS) feeding into an existing aedes
// instance, accepting only `path` (others get HTTP 400). Records request URLs.
export async function startWsListener(aedes, { path = null, tls = null } = {}) {
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }) : http.createServer();
  const tr = tracked(server);
  const requests = [];
  server.on('upgrade', (req) => requests.push(req.url));
  if (tls) {
    // https 'connection' fires for the raw socket; also track TLS sockets.
    server.on('secureConnection', (s) => {
      tr.sockets.add(s);
      s.on('close', () => tr.sockets.delete(s));
    });
  }
  const wss = new WebSocketServer({ server, ...(path ? { path } : {}) });
  wss.on('connection', (ws, req) => aedes.handle(createWebSocketStream(ws), req));
  const port = await listenOn(server);
  return {
    port,
    requests,
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(() => r()));
      await tr.close();
    },
  };
}

// Records every status event emitted after this call (to prove silence).
export function statusesAfter(s) {
  const seen = [];
  const on = (x) => seen.push({ ...x });
  s.on('status', on);
  return { seen, stop: () => s.off('status', on) };
}

// Resolves once the broker has processed a SUBSCRIBE (from a real client)
// containing `filter`; publishes after that are routed to the subscriber.
// Must be called before the subscribe is sent.
export function onSubscribed(aedes, filter) {
  return new Promise((resolve) => {
    const on = (subs, client) => {
      if (client && subs.some((s) => s.topic === filter)) {
        aedes.off('subscribe', on);
        resolve();
      }
    };
    aedes.on('subscribe', on);
  });
}

// A connected session whose single profile subscription is active at the broker.
export async function subscribedSession(t, aedes, port, filter, qos = 0, options = {}) {
  const ready = onSubscribed(aedes, filter);
  const rec = await connected(t, port, { subscriptions: [{ topic: filter, qos }] }, options);
  await ready;
  return rec;
}

// TCP proxy in front of a broker. blackhole(true) silently discards traffic in
// both directions without closing sockets (a network partition, no FIN/RST).
export async function startProxy(targetPort) {
  let hole = false;
  const pairs = new Set();
  const server = net.createServer((down) => {
    const up = net.connect(targetPort, '127.0.0.1');
    const pair = { down, up };
    pairs.add(pair);
    const kill = () => {
      down.destroy();
      up.destroy();
      pairs.delete(pair);
    };
    down.on('error', kill).on('close', kill);
    up.on('error', kill).on('close', kill);
    down.on('data', (d) => hole || up.write(d));
    up.on('data', (d) => hole || down.write(d));
  });
  const tr = tracked(server);
  const port = await listenOn(server);
  return {
    port,
    get connections() {
      return tr.connections;
    },
    blackhole(on) {
      hole = on;
    },
    async close() {
      for (const p of pairs) {
        p.down.destroy();
        p.up.destroy();
      }
      await tr.close();
    },
  };
}
