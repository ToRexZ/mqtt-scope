// MQTT 5 against a real Mosquitto 2 broker in Docker (aedes is 3.1.1 only).
// Skipped when docker or the eclipse-mosquitto:2 image is unavailable.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mqtt from 'mqtt';
import { until } from '../helpers/broker.mjs';
import { recorder, text } from './_session.mjs';

const run = promisify(execFile);
const IMAGE = 'eclipse-mosquitto:2';
const docker = (args, timeout = 15000) => run('docker', args, { timeout }).then((r) => r.stdout.trim());

async function startMosquitto() {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}'], 10000);
  } catch {
    return { skip: 'docker not available' };
  }
  try {
    await docker(['image', 'inspect', IMAGE]);
  } catch {
    try {
      await docker(['pull', IMAGE], 60000);
    } catch (err) {
      return { skip: `cannot pull ${IMAGE}: ${err.message.split('\n')[0]}` };
    }
  }
  // --rm plus an in-container timeout: the container cannot outlive a crashed test run by much.
  // Anonymous access to everything except publishing/reading under secret/.
  const conf = 'listener 1883\\nallow_anonymous true\\nacl_file /tmp/acl\\n';
  const acl = 'topic deny secret/#\\ntopic readwrite #\\n';
  const id = await docker([
    'run', '-d', '--rm', '-p', '127.0.0.1::1883', IMAGE,
    'sh', '-c', `printf '${conf}' > /tmp/m.conf && printf '${acl}' > /tmp/acl && exec timeout 300 mosquitto -c /tmp/m.conf`,
  ]);
  try {
    const mapped = await docker(['port', id, '1883/tcp']);
    const port = Number(mapped.split('\n')[0].split(':').pop());
    // wait until the broker accepts MQTT 5 connections
    await until(
      async () => {
        const c = mqtt.connect({ host: '127.0.0.1', port, protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 1000 });
        const ok = await new Promise((r) => {
          c.once('connect', () => r(true));
          c.once('error', () => r(false));
          c.once('close', () => r(false));
        });
        c.end(true);
        return ok;
      },
      { timeout: 20000, interval: 200, message: 'mosquitto ready' },
    );
    return { id, port };
  } catch (err) {
    await docker(['rm', '-f', id]).catch(() => {});
    return { skip: `mosquitto container did not become ready: ${err.message}` };
  }
}

const env = await startMosquitto();
after(async () => {
  if (env.id) await docker(['rm', '-f', env.id]).catch(() => {});
});

// userProperties come back as null-prototype objects
const plain = (o) => (o ? { ...o } : o);

async function v5Client(t) {
  const c = await mqtt.connectAsync({ host: '127.0.0.1', port: env.port, protocolVersion: 5, reconnectPeriod: 0 });
  t.after(() => c.endAsync(true).catch(() => {}));
  const received = [];
  c.on('message', (topic, payload, packet) => received.push({ topic, payload: Buffer.from(payload), properties: packet.properties, retain: packet.retain }));
  return { c, received };
}

async function v5Session(t, filter) {
  const rec = recorder(t);
  rec.s.connect({ host: '127.0.0.1', port: env.port, mqttVersion: 5, subscriptions: [{ topic: filter, qos: 1 }] });
  await rec.waitState('connected');
  // wait for the subscription to be live
  const probe = await v5Client(t);
  const base = filter.replace(/\/?#$/, '');
  await until(
    async () => {
      await probe.c.publishAsync(`${base}/__probe`, 'p');
      return rec.messages.length > 0;
    },
    { message: 'v5 subscription active' },
  );
  // flush out extra probe copies still in flight (same publisher → in order)
  await probe.c.publishAsync(`${base}/__probe_done`, 'd');
  await rec.waitFor((m) => m.topic === `${base}/__probe_done`);
  rec.messages.length = 0;
  return rec;
}

describe('MQTT 5 (mosquitto in docker)', { skip: env.skip || false }, () => {
  test('connects with protocol version 5', async (t) => {
    const rec = recorder(t);
    rec.s.connect({ host: '127.0.0.1', port: env.port, mqttVersion: 5 });
    await rec.waitState('connected');
    assert.equal(rec.s.client.options.protocolVersion, 5);
    assert.deepEqual(rec.states(), ['connecting', 'connected']);
  });

  test('received message properties (user properties, contentType, …) appear in props', async (t) => {
    const rec = await v5Session(t, 'p5/#');
    const pub = await v5Client(t);
    const properties = {
      contentType: 'application/json',
      payloadFormatIndicator: true,
      responseTopic: 'p5/reply',
      correlationData: Buffer.from([1, 2, 3, 4]),
      userProperties: { source: 'integration', unit: '°C' },
    };
    await pub.c.publishAsync('p5/props', '{"t":21.5}', { qos: 1, properties });
    const m = await rec.waitFor((x) => x.topic === 'p5/props');
    assert.equal(text(m), '{"t":21.5}');
    assert.ok(m.props, 'props present on MQTT 5 messages');
    assert.equal(m.props.contentType, 'application/json');
    assert.equal(m.props.payloadFormatIndicator, true);
    assert.equal(m.props.responseTopic, 'p5/reply');
    assert.deepEqual([...m.props.correlationData], [1, 2, 3, 4]);
    assert.deepEqual(plain(m.props.userProperties), { source: 'integration', unit: '°C' });
  });

  test('repeated user property keys are preserved as arrays', async (t) => {
    const rec = await v5Session(t, 'dup5/#');
    const pub = await v5Client(t);
    await pub.c.publishAsync('dup5/x', 'x', { qos: 1, properties: { userProperties: { tag: ['a', 'b'] } } });
    const m = await rec.waitFor((x) => x.topic === 'dup5/x');
    assert.deepEqual(plain(m.props.userProperties), { tag: ['a', 'b'] });
  });

  test('a message without properties has empty/null props', async (t) => {
    const rec = await v5Session(t, 'np5/#');
    const pub = await v5Client(t);
    await pub.c.publishAsync('np5/x', 'x', { qos: 1 });
    const m = await rec.waitFor((x) => x.topic === 'np5/x');
    assert.ok(m.props === null || Object.keys(m.props).length === 0, JSON.stringify(m.props));
  });

  test('binary props (correlationData) are standalone copies like payloads (safe to send over IPC)', async (t) => {
    const rec = await v5Session(t, 'cd5/#');
    const pub = await v5Client(t);
    // several messages back-to-back so they share socket chunks, plus one large
    // message whose packet spans many chunks
    for (let i = 0; i < 20; i++) pub.c.publish('cd5/x', `m${i}`, { qos: 0, properties: { correlationData: Buffer.from([i, i, i]) } });
    pub.c.publish('cd5/big', Buffer.alloc(256 * 1024, 7), { qos: 0, properties: { correlationData: Buffer.from([1, 2, 3]) } });
    await rec.waitMessages(21, { timeout: 10000 });
    const views = [];
    for (const m of rec.messages) {
      const cd = m.props.correlationData;
      assert.equal(cd.byteLength, 3);
      if (cd.buffer.byteLength !== cd.byteLength) views.push([m.topic, cd.buffer.byteLength]);
    }
    views.sort((a, b) => b[1] - a[1]);
    assert.equal(
      views.length,
      0,
      `${views.length}/21 correlationData values are views, not copies; largest: 3 bytes backed by ` +
        `${views[0]?.[1]} bytes (${views[0]?.[0]}). IPC would serialise the whole backing store`,
    );
  });


  test('publish with properties delivers them to an MQTT 5 subscriber', async (t) => {
    const rec = recorder(t);
    rec.s.connect({ host: '127.0.0.1', port: env.port, mqttVersion: 5 });
    await rec.waitState('connected');
    const sub = await v5Client(t);
    await sub.c.subscribeAsync('out5/#', { qos: 1 });
    const res = await rec.s.publish({
      topic: 'out5/x',
      payload: 'hello',
      qos: 1,
      properties: {
        contentType: 'text/plain',
        userProperties: { from: 'workbench', n: '1' },
        responseTopic: 'out5/reply',
        messageExpiryInterval: 60,
      },
    });
    assert.deepEqual(res, { ok: true });
    const m = await until(() => sub.received.find((x) => x.topic === 'out5/x'), { message: 'subscriber got it' });
    assert.equal(m.payload.toString(), 'hello');
    assert.equal(m.properties.contentType, 'text/plain');
    assert.deepEqual(plain(m.properties.userProperties), { from: 'workbench', n: '1' });
    assert.equal(m.properties.responseTopic, 'out5/reply');
    assert.ok(m.properties.messageExpiryInterval > 0 && m.properties.messageExpiryInterval <= 60);
  });

  test('publish with Uint8Array correlationData (what arrives over IPC) works', async (t) => {
    const rec = recorder(t);
    rec.s.connect({ host: '127.0.0.1', port: env.port, mqttVersion: 5 });
    await rec.waitState('connected');
    const sub = await v5Client(t);
    await sub.c.subscribeAsync('cdu5/#', { qos: 1 });
    const res = await rec.s.publish({
      topic: 'cdu5/x',
      payload: 'x',
      qos: 1,
      properties: { correlationData: new Uint8Array([7, 8, 9]) },
    });
    assert.deepEqual(res, { ok: true });
    const m = await until(() => sub.received.find((x) => x.topic === 'cdu5/x'), { message: 'subscriber got it' });
    assert.deepEqual([...m.properties.correlationData], [7, 8, 9]);
  });

  test('retain flag: true on subscribe-time delivery, false on live delivery', async (t) => {
    const pub = await v5Client(t);
    await pub.c.publishAsync('ret5/a', 'stored', { qos: 1, retain: true });
    const rec = recorder(t);
    rec.s.connect({ host: '127.0.0.1', port: env.port, mqttVersion: 5, subscriptions: [{ topic: 'ret5/#', qos: 1 }] });
    const stored = await rec.waitFor((m) => m.topic === 'ret5/a');
    assert.equal(stored.retain, true);
    await pub.c.publishAsync('ret5/a', 'live', { qos: 1, retain: true });
    await until(() => rec.ofTopic('ret5/a').length === 2, { message: 'live copy' });
    assert.equal(rec.ofTopic('ret5/a')[1].retain, false);
    await pub.c.publishAsync('ret5/a', '', { qos: 1, retain: true }); // clear
  });

  test('publish denied by the broker ACL → {ok:false} with the v5 reason; connection stays up', async (t) => {
    const rec = recorder(t);
    rec.s.connect({ host: '127.0.0.1', port: env.port, mqttVersion: 5 });
    await rec.waitState('connected');
    const res = await rec.s.publish({ topic: 'secret/x', payload: 'x', qos: 1 });
    assert.equal(res.ok, false);
    assert.match(res.error, /Not authorized/);
    assert.equal(rec.s.status.state, 'connected');
    assert.deepEqual(await rec.s.publish({ topic: 'open5/x', payload: 'x', qos: 1 }), { ok: true });
    assert.deepEqual(rec.states(), ['connecting', 'connected']);
  });
});
