// Two real sessions on two brokers through one registry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MqttSession, FAST, text, onSubscribed, startBrokerOnPort } from './_session.mjs';
import { until } from '../helpers/broker.mjs';

const require = createRequire(import.meta.url);
const { ConnectionRegistry } = require('../../main/connections.js');

test('two connections on two brokers keep their messages apart', async (t) => {
  const b1 = await startBrokerOnPort();
  const b2 = await startBrokerOnPort();
  t.after(() => Promise.all([b1.close(), b2.close()]));

  const reg = new ConnectionRegistry({ createSession: () => new MqttSession(FAST) });
  t.after(() => reg.closeOwner(1));
  const got = { c1: [], c2: [] };
  reg.on('batch', (connId, ownerId, batch) => {
    assert.equal(ownerId, 1);
    for (const m of batch.messages) got[connId].push(text(m));
  });

  const c1 = reg.create(1);
  const c2 = reg.create(1);
  const ready = [onSubscribed(b1.aedes, 'same/topic'), onSubscribed(b2.aedes, 'same/topic')];
  const subs = [{ topic: 'same/topic', qos: 0 }];
  assert.equal(reg.connect(c1, { id: 'p1', host: '127.0.0.1', port: b1.port, subscriptions: subs }).ok, true);
  assert.equal(reg.connect(c2, { id: 'p2', host: '127.0.0.1', port: b2.port, subscriptions: subs }).ok, true);
  await Promise.all(ready);

  await b1.publish('same/topic', 'from-1');
  await b2.publish('same/topic', 'from-2');
  await until(() => got[c1].length >= 1 && got[c2].length >= 1, { message: 'a message on each connection' });
  assert.deepEqual(got[c1], ['from-1']);
  assert.deepEqual(got[c2], ['from-2']);
});
