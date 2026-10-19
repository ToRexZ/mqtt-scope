import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startBroker, makeCerts, testClient, until } from '../helpers/broker.mjs';

const require = createRequire(import.meta.url);
const { MqttSession } = require('../../main/mqttSession.js');

test('helpers: session receives over TCP, TLS and WebSocket', async () => {
  const certs = makeCerts();
  const broker = await startBroker({ tls: certs, ws: true });
  try {
    for (const [protocol, port, extra] of [
      ['mqtt', broker.port, {}],
      ['mqtts', broker.tlsPort, { caFile: certs.caFile }],
      ['ws', broker.wsPort, { wsPath: '/' }],
    ]) {
      const s = new MqttSession({ flushIntervalMs: 10 });
      const got = [];
      s.on('batch', (b) => got.push(...b.messages));
      s.connect({ protocol, host: 'localhost', port, subscriptions: [{ topic: 'x/#', qos: 0 }], ...extra });
      await until(() => s.status.state === 'connected', { message: `${protocol} connect` });
      const c = await testClient(broker.port);
      await until(async () => {
        await c.publish('x/y', protocol);
        return got.some((m) => Buffer.from(m.payload).toString() === protocol);
      }, { message: `${protocol} message` });
      await c.end();
      s.disconnect();
    }
  } finally {
    await broker.close();
  }
});
