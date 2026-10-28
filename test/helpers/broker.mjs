// In-process MQTT broker for tests: plain TCP, optional TLS and WebSocket
// listeners on random ports, optional auth hooks. Aedes speaks MQTT 3.1.1.

import { createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { createServer as createHttpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';
import mqtt from 'mqtt';

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

// Self-signed CA plus a server certificate for localhost/127.0.0.1.
export function makeCerts() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mqttscope-certs-'));
  const f = (n) => path.join(dir, n);
  const ssl = (...args) => execFileSync('openssl', args, { stdio: 'pipe' });
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Test CA', '-keyout', f('ca.key'), '-out', f('ca.crt'));
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', f('server.key'), '-out', f('server.csr'));
  writeFileSync(f('ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  ssl('x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial', '-days', '2', '-extfile', f('ext.cnf'), '-out', f('server.crt'));
  return {
    dir,
    caFile: f('ca.crt'),
    certFile: f('server.crt'),
    keyFile: f('server.key'),
    ca: readFileSync(f('ca.crt')),
    cert: readFileSync(f('server.crt')),
    key: readFileSync(f('server.key')),
  };
}

// options: { tls: certs from makeCerts(), ws: true, users: { name: password },
//            denySubscribe: [filters], denyPublish: [topics] }
export async function startBroker(options = {}) {
  const aedes = await Aedes.createBroker();
  if (options.users) {
    aedes.authenticate = (client, username, password, done) => {
      const ok = username !== undefined && options.users[username] === password?.toString();
      if (ok) return done(null, true);
      const err = new Error('Bad username or password');
      err.returnCode = 4;
      done(err, false);
    };
  }
  if (options.denySubscribe) {
    aedes.authorizeSubscribe = (client, sub, done) =>
      done(null, options.denySubscribe.includes(sub.topic) ? null : sub);
  }
  if (options.denyPublish) {
    aedes.authorizePublish = (client, packet, done) =>
      done(options.denyPublish.includes(packet.topic) ? new Error('denied') : null);
  }

  const servers = [];
  const sockets = new Set();
  const track = (server) => {
    servers.push(server);
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    return server;
  };

  const tcp = track(createServer(aedes.handle));
  const port = await listen(tcp);

  let tlsPort;
  if (options.tls) {
    const tls = createTlsServer({ key: options.tls.key, cert: options.tls.cert }, aedes.handle);
    servers.push(tls);
    tls.on('secureConnection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    tlsPort = await listen(tls);
  }

  let wsPort;
  if (options.ws) {
    const http = track(createHttpServer());
    const wss = new WebSocketServer({ server: http });
    wss.on('connection', (ws, req) => aedes.handle(createWebSocketStream(ws), req));
    wsPort = await listen(http);
  }

  return {
    aedes,
    port,
    tlsPort,
    wsPort,
    // Publishes from the broker itself (no client needed).
    publish(topic, payload, { retain = false, qos = 0 } = {}) {
      return new Promise((resolve) =>
        aedes.publish(
          { cmd: 'publish', topic, payload: typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload), qos, retain, dup: false },
          resolve,
        ),
      );
    },
    // Drops every client connection (simulates a network failure).
    dropClients() {
      for (const s of sockets) s.destroy();
    },
    // The broker goes down: drops every client and refuses new ones (plain
    // TCP) until start() listens on the same port again.
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => tcp.close(() => r()));
    },
    start() {
      return new Promise((resolve, reject) => {
        tcp.once('error', reject);
        tcp.listen(port, '127.0.0.1', () => resolve());
      });
    },
    async close() {
      for (const s of sockets) s.destroy();
      await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
      await new Promise((r) => aedes.close(r));
    },
  };
}

// A plain mqtt.js client connected to the test broker, for sending and
// observing messages from outside the app under test.
export async function testClient(port, opts = {}) {
  const client = mqtt.connect({ host: '127.0.0.1', port, protocolVersion: 4, reconnectPeriod: 0, ...opts });
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });
  const received = [];
  client.on('message', (topic, payload, packet) => received.push({ topic, payload: Buffer.from(payload), retain: packet.retain, qos: packet.qos }));
  return {
    client,
    received,
    subscribe: (filter, qos = 0) => client.subscribeAsync(filter, { qos }),
    publish: (topic, payload, o = {}) => client.publishAsync(topic, payload, o),
    // Resolves with the first received message matching `pred`.
    waitFor(pred, timeout = 5000) {
      const hit = received.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          client.off('message', on);
          reject(new Error('Timed out waiting for message'));
        }, timeout);
        const on = () => {
          const m = received.find(pred);
          if (m) {
            clearTimeout(t);
            client.off('message', on);
            resolve(m);
          }
        };
        client.on('message', on);
      });
    },
    end: () => client.endAsync(true),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls `fn` until it returns a truthy value.
export async function until(fn, { timeout = 5000, interval = 25, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await sleep(interval);
  }
}
