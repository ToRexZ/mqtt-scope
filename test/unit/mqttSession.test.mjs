// MqttSession and its pure helpers, without a broker. The `mqtt` module is
// replaced in the require cache by a fake whose clients are driven by hand
// (node --test runs each file in its own process, so this does not leak).

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './_util.mjs';

const mainRequire = Module.createRequire(path.join(ROOT, 'main', 'mqttSession.js'));

class FakeClient extends EventEmitter {
  constructor(opts) {
    super();
    this.options = opts;
    this.connected = false;
    this.calls = { subscribe: [], publish: [], unsubscribe: [], end: [] };
  }
  subscribe(topic, opts, cb) {
    if (typeof opts === 'function') [opts, cb] = [undefined, opts];
    this.calls.subscribe.push({ topic, opts, cb });
    return this;
  }
  publish(topic, body, opts, cb) {
    this.calls.publish.push({ topic, body, opts, cb });
    return this;
  }
  unsubscribe(topic, cb) {
    this.calls.unsubscribe.push({ topic, cb });
    return this;
  }
  end(force) {
    this.calls.end.push(force);
    this.connected = false;
    return this;
  }
}

const clients = [];
const fakeMqtt = {
  connect(opts) {
    const c = new FakeClient(opts);
    clients.push(c);
    return c;
  },
};
const mqttPath = mainRequire.resolve('mqtt');
const fakeModule = new Module(mqttPath);
fakeModule.filename = mqttPath;
fakeModule.loaded = true;
fakeModule.exports = fakeMqtt;
mainRequire.cache[mqttPath] = fakeModule;

const { MqttSession, buildConnectOptions, validatePublishTopic, validateFilter } = mainRequire('./mqttSession.js');

const profile = (extra = {}) => ({ protocol: 'mqtt', host: 'broker.test', port: 1883, ...extra });
const noRead = () => {
  throw new Error('readFile should not be called');
};

// ------------------------------------------------------------------ options

describe('buildConnectOptions', () => {
  test('defaults for mqtt', () => {
    const o = buildConnectOptions({ host: 'h' }, { readFile: noRead });
    assert.equal(o.protocol, 'mqtt');
    assert.equal(o.host, 'h');
    assert.equal(o.port, 1883);
    assert.equal(o.protocolVersion, 4);
    assert.equal(o.clean, true);
    assert.equal(o.keepalive, 60);
    assert.equal(o.username, undefined);
    assert.equal(o.password, undefined);
    assert.equal(o.reconnectPeriod, 3000);
    assert.equal(o.connectTimeout, 10000);
    assert.equal('path' in o, false);
    assert.equal('rejectUnauthorized' in o, false);
    assert.equal('ca' in o, false);
  });

  test('default port per protocol: mqtt 1883, mqtts 8883', () => {
    assert.equal(buildConnectOptions({ host: 'h', protocol: 'mqtt' }).port, 1883);
    assert.equal(buildConnectOptions({ host: 'h', protocol: 'mqtts' }).port, 8883);
    assert.equal(buildConnectOptions({ host: 'h', protocol: 'mqtt', port: '' }).port, 1883);
    assert.equal(buildConnectOptions({ host: 'h', protocol: 'mqtts', port: '' }).port, 8883);
  });

  test('default WebSocket ports match the renderer defaults (ws 9001, wss 443)', () => {
    // renderer/profiles.js DEFAULT_PORTS; 1883/8883 are raw TCP/TLS ports.
    assert.equal(buildConnectOptions({ host: 'h', protocol: 'ws', port: '' }).port, 9001);
    assert.equal(buildConnectOptions({ host: 'h', protocol: 'wss', port: '' }).port, 443);
  });

  test('explicit ports, including numeric strings', () => {
    assert.equal(buildConnectOptions({ host: 'h', port: 1 }).port, 1);
    assert.equal(buildConnectOptions({ host: 'h', port: 65535 }).port, 65535);
    assert.equal(buildConnectOptions({ host: 'h', port: '8080' }).port, 8080);
  });

  test('invalid ports throw with the offending value', () => {
    for (const port of [0, -1, 65536, 1.5, 'abc', NaN, null, Infinity]) {
      assert.throws(() => buildConnectOptions({ host: 'h', port }), { message: `Invalid port "${port}"` }, String(port));
    }
  });

  test('unsupported protocols throw; missing protocol means mqtt', () => {
    for (const protocol of ['http', 'MQTT', 'tcp', 'mqtt://']) {
      assert.throws(() => buildConnectOptions({ host: 'h', protocol }), { message: `Unsupported protocol "${protocol}"` });
    }
    assert.equal(buildConnectOptions({ host: 'h', protocol: '' }).protocol, 'mqtt');
    assert.equal(buildConnectOptions({ host: 'h', protocol: undefined }).protocol, 'mqtt');
  });

  test('host is required and trimmed', () => {
    for (const host of [undefined, null, '', '   ']) {
      assert.throws(() => buildConnectOptions({ host }), { message: 'Host is required' });
    }
    assert.equal(buildConnectOptions({ host: '  example.com \n' }).host, 'example.com');
  });

  test('keepalive: 0 allowed, numeric strings accepted, blank falls back to 60, invalid throws', () => {
    assert.equal(buildConnectOptions({ host: 'h', keepalive: 0 }).keepalive, 0);
    assert.equal(buildConnectOptions({ host: 'h', keepalive: '0' }).keepalive, 0);
    assert.equal(buildConnectOptions({ host: 'h', keepalive: '30' }).keepalive, 30);
    assert.equal(buildConnectOptions({ host: 'h', keepalive: 65535 }).keepalive, 65535);
    assert.equal(buildConnectOptions({ host: 'h', keepalive: '' }).keepalive, 60);
    assert.equal(buildConnectOptions({ host: 'h', keepalive: undefined }).keepalive, 60);
    for (const bad of ['abc', -1, 65536, 1.5]) {
      assert.throws(() => buildConnectOptions({ host: 'h', keepalive: bad }), /Invalid keep-alive/, String(bad));
    }
  });

  test('clientId: persistent sessions (clean false) get a stable id derived from the profile', () => {
    const a = buildConnectOptions({ host: 'h', id: 'p1', clean: false }).clientId;
    assert.equal(a, 'mqtt-scope-p1');
    assert.equal(buildConnectOptions({ host: 'h', id: 'p1', clean: false }).clientId, a);
    assert.equal(buildConnectOptions({ host: 'h', id: 'p/1 x', clean: false }).clientId, 'mqtt-scope-p1x');
    assert.equal(buildConnectOptions({ host: 'h', id: 'p1', clean: false, clientId: 'mine' }).clientId, 'mine');
    assert.notEqual(buildConnectOptions({ host: 'h', id: 'p1' }).clientId, 'mqtt-scope-p1');
  });

  test('clientId: kept when given, random when empty', () => {
    assert.equal(buildConnectOptions({ host: 'h', clientId: 'me' }).clientId, 'me');
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
      const id = buildConnectOptions({ host: 'h', clientId: '' }).clientId;
      assert.match(id, /^mqtt-scope-[0-9a-f]{1,8}$/);
      ids.add(id);
    }
    assert.ok(ids.size > 45, 'random ids differ');
  });

  test('protocolVersion: 5 only for mqttVersion 5 (number or string), else 4', () => {
    assert.equal(buildConnectOptions({ host: 'h', mqttVersion: 5 }).protocolVersion, 5);
    assert.equal(buildConnectOptions({ host: 'h', mqttVersion: '5' }).protocolVersion, 5);
    for (const v of [4, '4', 3, undefined, 'x']) assert.equal(buildConnectOptions({ host: 'h', mqttVersion: v }).protocolVersion, 4);
  });

  test('clean is true unless explicitly false', () => {
    assert.equal(buildConnectOptions({ host: 'h', clean: false }).clean, false);
    assert.equal(buildConnectOptions({ host: 'h', clean: true }).clean, true);
    assert.equal(buildConnectOptions({ host: 'h' }).clean, true);
  });

  test('empty username/password become undefined', () => {
    const o = buildConnectOptions({ host: 'h', username: '', password: '' });
    assert.equal(o.username, undefined);
    assert.equal(o.password, undefined);
    const o2 = buildConnectOptions({ host: 'h', username: 'u', password: 'p' });
    assert.equal(o2.username, 'u');
    assert.equal(o2.password, 'p');
  });

  test('WebSocket path defaults to /mqtt', () => {
    assert.equal(buildConnectOptions({ host: 'h', protocol: 'ws', port: 80 }).path, '/mqtt');
    assert.equal(buildConnectOptions({ host: 'h', protocol: 'wss', port: 443, wsPath: '' }).path, '/mqtt');
    assert.equal(buildConnectOptions({ host: 'h', protocol: 'ws', port: 80, wsPath: '/ws' }).path, '/ws');
    assert.equal('path' in buildConnectOptions({ host: 'h', protocol: 'mqtt', wsPath: '/ws' }), false);
  });

  test('TLS: rejectUnauthorized defaults to true for mqtts and wss', () => {
    for (const protocol of ['mqtts', 'wss']) {
      assert.equal(buildConnectOptions({ host: 'h', protocol, port: 1 }).rejectUnauthorized, true);
      assert.equal(buildConnectOptions({ host: 'h', protocol, port: 1, rejectUnauthorized: undefined }).rejectUnauthorized, true);
      assert.equal(buildConnectOptions({ host: 'h', protocol, port: 1, rejectUnauthorized: false }).rejectUnauthorized, false);
    }
  });

  test('TLS: files are read through the injected readFile', () => {
    const read = [];
    const readFile = (f) => (read.push(f), Buffer.from(`content of ${f}`));
    const o = buildConnectOptions(
      { host: 'h', protocol: 'mqtts', caFile: '/ca.pem', certFile: '/cert.pem', keyFile: '/key.pem' },
      { readFile },
    );
    assert.deepEqual(read, ['/ca.pem', '/cert.pem', '/key.pem']);
    assert.equal(o.ca.toString(), 'content of /ca.pem');
    assert.equal(o.cert.toString(), 'content of /cert.pem');
    assert.equal(o.key.toString(), 'content of /key.pem');
  });

  test('TLS: files are ignored for non-TLS protocols', () => {
    const o = buildConnectOptions({ host: 'h', protocol: 'mqtt', caFile: '/ca.pem', certFile: '/c', keyFile: '/k' }, { readFile: noRead });
    assert.equal('ca' in o, false);
    const w = buildConnectOptions({ host: 'h', protocol: 'ws', port: 1, caFile: '/ca.pem' }, { readFile: noRead });
    assert.equal('ca' in w, false);
  });

  test('TLS: read errors name the file and the kind of file', () => {
    const fail = (code) => () => {
      const e = new Error('boom');
      if (code) e.code = code;
      throw e;
    };
    assert.throws(() => buildConnectOptions({ host: 'h', protocol: 'mqtts', caFile: '/x/ca.pem' }, { readFile: fail('ENOENT') }), {
      message: 'Cannot read CA certificate "/x/ca.pem": ENOENT',
    });
    assert.throws(() => buildConnectOptions({ host: 'h', protocol: 'wss', certFile: '/c.pem' }, { readFile: fail('EACCES') }), {
      message: 'Cannot read client certificate "/c.pem": EACCES',
    });
    assert.throws(() => buildConnectOptions({ host: 'h', protocol: 'mqtts', keyFile: '/k.pem' }, { readFile: fail() }), {
      message: 'Cannot read client key "/k.pem": boom',
    });
  });

  test('TLS: default readFile reads real files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttscope-unit-'));
    try {
      const f = path.join(dir, 'ca.pem');
      fs.writeFileSync(f, 'PEM');
      const o = buildConnectOptions({ host: 'h', protocol: 'mqtts', caFile: f });
      assert.equal(o.ca.toString(), 'PEM');
      assert.throws(() => buildConnectOptions({ host: 'h', protocol: 'mqtts', caFile: path.join(dir, 'missing.pem') }), /Cannot read CA certificate ".*missing\.pem": ENOENT/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('custom defaults override reconnectPeriod and connectTimeout', () => {
    const o = buildConnectOptions({ host: 'h' }, { defaults: { reconnectPeriod: 1, connectTimeout: 2 } });
    assert.equal(o.reconnectPeriod, 1);
    assert.equal(o.connectTimeout, 2);
  });
});

describe('validatePublishTopic', () => {
  test('valid topics', () => {
    for (const t of ['a', 'a/b', '/a', 'a/', 'a//b', '$SYS/x', 'with space', 'ünï/😀', '/']) assert.equal(validatePublishTopic(t), null, t);
  });
  test('required', () => {
    for (const t of ['', undefined, null, 5, {}]) assert.equal(validatePublishTopic(t), 'Topic is required');
  });
  test('wildcards are rejected', () => {
    for (const t of ['#', 'a/#', '+', 'a/+/b', 'a+b', 'a#']) assert.equal(validatePublishTopic(t), 'Topic must not contain wildcards (+ or #)', t);
  });
  test('NUL is rejected', () => {
    assert.equal(validatePublishTopic('a\u0000b'), 'Topic must not contain NUL characters');
  });
});

describe('validateFilter', () => {
  test('valid filters', () => {
    for (const f of ['#', 'a/#', '+/b', '+', 'a/+/c', '+/+', '/+', '+/#', '$SYS/#', 'a', 'a//b', '/', 'a/b/c/#']) {
      assert.equal(validateFilter(f), null, f);
    }
  });
  test('# must be the last level on its own', () => {
    for (const f of ['a#', 'a/#/b', '#/a', 'a/b#', '##', '#a']) assert.equal(validateFilter(f), '"#" must be the last level on its own', f);
  });
  test('+ must occupy a whole level', () => {
    for (const f of ['a+', '+a/b', 'a/b+/c', '++', 'a/+b']) assert.equal(validateFilter(f), '"+" must occupy a whole level', f);
  });
  test('required', () => {
    for (const f of ['', undefined, null, 1]) assert.equal(validateFilter(f), 'Topic filter is required');
  });
  test('NUL is rejected (MQTT spec 4.7.3)', () => {
    assert.notEqual(validateFilter('a\u0000b'), null);
    assert.notEqual(validateFilter('a/\u0000/#'), null);
  });
});

// ------------------------------------------------------------------ session

function recorder(session) {
  const ev = { status: [], batch: [], warning: [] };
  for (const k of Object.keys(ev)) session.on(k, (v) => ev[k].push(v));
  return ev;
}

describe('MqttSession without a connection', () => {
  test('initial state', () => {
    const s = new MqttSession();
    assert.deepEqual(s.status, { state: 'disconnected' });
    assert.equal(s.connected, false);
    assert.equal(s.active, false);
    assert.deepEqual(s.subscriptions, []);
    assert.equal(s.options.flushIntervalMs, 50);
    assert.equal(s.options.maxBuffered, 50000);
    assert.equal(new MqttSession({ maxBuffered: 3 }).options.maxBuffered, 3);
  });

  test('publish / subscribe / unsubscribe return Not connected', async () => {
    const s = new MqttSession();
    assert.deepEqual(await s.publish({ topic: 'a', payload: 'x' }), { ok: false, error: 'Not connected' });
    assert.deepEqual(await s.subscribe('a/#', 1), { ok: false, error: 'Not connected' });
    assert.deepEqual(await s.unsubscribe('a/#'), { ok: false, error: 'Not connected' });
  });

  test('invalid topics/filters are rejected before the connection check', async () => {
    const s = new MqttSession();
    assert.deepEqual(await s.publish({ topic: 'a/#', payload: 'x' }), { ok: false, error: 'Topic must not contain wildcards (+ or #)' });
    assert.deepEqual(await s.publish({ topic: '' }), { ok: false, error: 'Topic is required' });
    assert.deepEqual(await s.publish(), { ok: false, error: 'Topic is required' });
    assert.deepEqual(await s.subscribe('a#', 0), { ok: false, error: '"#" must be the last level on its own' });
  });

  test('connect() with an invalid profile sets status error and emits it', () => {
    const s = new MqttSession();
    const ev = recorder(s);
    const before = clients.length;
    const res = s.connect({ protocol: 'mqtt', host: '' });
    assert.deepEqual(res, { ok: false, error: 'Host is required' });
    assert.deepEqual(s.status, { state: 'error', error: 'Host is required' });
    assert.equal(s.active, false, 'an error without a client drops nothing');
    assert.deepEqual(ev.status, [{ state: 'error', error: 'Host is required' }]);
    assert.equal(clients.length, before, 'no client created');
    assert.equal(s.timer, null, 'no flush timer started');
  });

  test('connect() with a TLS file that cannot be read reports the file', () => {
    const s = new MqttSession({
      readFile: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
    });
    const res = s.connect(profile({ protocol: 'mqtts', caFile: '/nope.pem' }));
    assert.equal(res.ok, false);
    assert.equal(res.error, 'Cannot read CA certificate "/nope.pem": ENOENT');
    assert.equal(s.status.state, 'error');
  });

  test('flush() emits nothing when empty', () => {
    const s = new MqttSession();
    const ev = recorder(s);
    s.flush();
    assert.deepEqual(ev.batch, []);
  });

  test('flush() emits the buffer and dropped count, then resets them', () => {
    const s = new MqttSession();
    const ev = recorder(s);
    const m = { topic: 'a', payload: new Uint8Array(1) };
    s.buffer.push(m);
    s.dropped = 3;
    s.flush();
    assert.equal(ev.batch.length, 1);
    assert.deepEqual(ev.batch[0], { messages: [m], dropped: 3 });
    assert.deepEqual(s.buffer, []);
    assert.equal(s.dropped, 0);
    s.flush();
    assert.equal(ev.batch.length, 1, 'nothing more to flush');
  });

  test('flush() with only dropped messages still reports them', () => {
    const s = new MqttSession();
    const ev = recorder(s);
    s.dropped = 2;
    s.flush();
    assert.deepEqual(ev.batch, [{ messages: [], dropped: 2 }]);
  });

  test('disconnect() is idempotent and silent when never connected', () => {
    const s = new MqttSession();
    const ev = recorder(s);
    s.buffer.push({});
    s.dropped = 1;
    s.disconnect();
    s.disconnect();
    assert.deepEqual(ev.status, []);
    assert.deepEqual(s.buffer, []);
    assert.equal(s.dropped, 0);
    assert.equal(s.timer, null);
  });
});

describe('MqttSession with a fake client', () => {
  let s;
  let ev;
  beforeEach(() => {
    s = new MqttSession({ flushIntervalMs: 1_000_000 });
    ev = recorder(s);
  });
  afterEach(() => s.disconnect());

  const connect = (p = profile()) => {
    const res = s.connect(p);
    return { res, c: clients.at(-1) };
  };
  const goOnline = (c) => {
    c.connected = true;
    c.emit('connect');
  };

  test('connect() builds options, reports the URL and starts connecting', () => {
    const { res, c } = connect(profile({ protocol: 'ws', port: 8080, wsPath: '/ws' }));
    assert.deepEqual(res, { ok: true, url: 'ws://broker.test:8080/ws' });
    assert.equal(s.url, 'ws://broker.test:8080/ws');
    assert.equal(c.options.host, 'broker.test');
    assert.equal(c.options.path, '/ws');
    assert.deepEqual(ev.status, [{ state: 'connecting', url: 'ws://broker.test:8080/ws' }]);
    assert.equal(s.connected, false, 'not connected until the client is');
  });

  test('connect() passes the session readFile to TLS option building', () => {
    const read = [];
    s = new MqttSession({ flushIntervalMs: 1_000_000, readFile: (f) => (read.push(f), Buffer.from('x')) });
    s.connect(profile({ protocol: 'mqtts', caFile: '/ca' }));
    assert.deepEqual(read, ['/ca']);
    assert.equal(clients.at(-1).options.ca.toString(), 'x');
  });

  test('connect() keeps only subscriptions with a topic', () => {
    connect(profile({ subscriptions: [{ topic: 'a', qos: 1 }, null, { topic: '' }, { qos: 1 }, { topic: 'b' }] }));
    assert.deepEqual(s.subscriptions, [{ topic: 'a', qos: 1 }, { topic: 'b' }]);
    s.disconnect();
    connect(profile());
    assert.deepEqual(s.subscriptions, []);
  });

  test('on connect: status connected and one subscribe call with normalized qos', () => {
    const { c } = connect(
      profile({
        subscriptions: [
          { topic: '#', qos: 0 },
          { topic: 'a/+', qos: '2' },
          { topic: 'b', qos: 1 },
          { topic: 'c', qos: 7 },
          { topic: 'd' },
        ],
      }),
    );
    goOnline(c);
    assert.deepEqual(s.status, { state: 'connected', url: 'mqtt://broker.test:1883' });
    assert.equal(s.connected, true);
    assert.equal(c.calls.subscribe.length, 1);
    assert.deepEqual(c.calls.subscribe[0].topic, { '#': { qos: 0 }, 'a/+': { qos: 2 }, b: { qos: 1 }, c: { qos: 0 }, d: { qos: 0 } });
    assert.deepEqual(ev.warning, []);
  });

  test('invalid initial subscriptions are skipped with a warning', () => {
    const { c } = connect(profile({ subscriptions: [{ topic: 'a#' }, { topic: 'ok' }, { topic: 'x+/y' }] }));
    goOnline(c);
    assert.deepEqual(ev.warning, ['Skipped invalid subscriptions: a#, x+/y']);
    assert.deepEqual(c.calls.subscribe[0].topic, { ok: { qos: 0 } });
  });

  test('no subscribe call when every initial subscription is invalid or none exist', () => {
    const { c } = connect(profile({ subscriptions: [{ topic: 'a#' }] }));
    goOnline(c);
    assert.equal(c.calls.subscribe.length, 0);
    s.disconnect();
    const { c: c2 } = connect(profile());
    goOnline(c2);
    assert.equal(c2.calls.subscribe.length, 0);
  });

  test('initial subscribe failures and broker rejections become warnings', () => {
    const { c } = connect(profile({ subscriptions: [{ topic: 'a' }, { topic: 'b' }] }));
    goOnline(c);
    const cb = c.calls.subscribe[0].cb;
    // mqtt.js 5 contract: callback(err, subs, suback). A rejection arrives as an
    // error, and the SUBACK's granted codes (bit 0x80) say which filters failed.
    cb(new Error('timeout'));
    const subs = [
      { topic: 'a', qos: 0 },
      { topic: 'b', qos: 0 },
    ];
    cb(new Error('Subscribe error: Unspecified error'), subs, { granted: [0, 128] });
    cb(null, subs, { granted: [0, 0] });
    assert.deepEqual(ev.warning, ['Subscribe failed: timeout', 'Broker rejected subscription: b']);
    assert.deepEqual(s.subscriptions.map((x) => x.topic), ['a'], 'rejected filters are not retried on reconnect');
  });

  test('initial subscribe callback from a replaced client is ignored', () => {
    const { c } = connect(profile({ subscriptions: [{ topic: 'a' }] }));
    goOnline(c);
    connect(profile());
    c.calls.subscribe[0].cb(new Error('late'));
    assert.deepEqual(ev.warning, []);
  });

  test('client lifecycle events map to status', () => {
    const { c } = connect();
    goOnline(c);
    c.emit('offline');
    assert.equal(s.status.state, 'offline');
    c.emit('reconnect');
    assert.equal(s.status.state, 'reconnecting');
    // mqtt.js will retry (reconnectPeriod > 0): the close is not shown as "disconnected".
    c.emit('close');
    assert.equal(s.status.state, 'reconnecting');
    // No retry coming (reconnectPeriod 0): the loss is reported.
    c.options.reconnectPeriod = 0;
    c.emit('close');
    assert.deepEqual(s.status, { state: 'disconnected', url: 'mqtt://broker.test:1883', unexpected: true });
    c.emit('error', new Error('Connection refused: Not authorized'));
    assert.deepEqual(s.status, { state: 'error', url: 'mqtt://broker.test:1883', error: 'Connection refused: Not authorized' });
    c.emit('close');
    assert.equal(s.status.state, 'error', 'close after error keeps the error visible');
  });

  // What a restart for an update asks about (main counts active sessions).
  test('active while connected or still trying to connect, not once disconnected', () => {
    const { c } = connect();
    const seen = () => [s.status.state, s.active];
    assert.deepEqual(seen(), ['connecting', true]);
    goOnline(c);
    assert.deepEqual(seen(), ['connected', true]);
    c.connected = false;
    c.emit('offline');
    assert.deepEqual(seen(), ['offline', true]);
    c.emit('reconnect');
    assert.deepEqual(seen(), ['reconnecting', true]);
    c.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1883'));
    c.emit('close'); // mqtt.js retries
    assert.deepEqual(seen(), ['error', true]);
    c.emit('reconnect');
    c.options.reconnectPeriod = 0;
    c.emit('close'); // no retry coming
    assert.deepEqual(seen(), ['disconnected', false]);

    connect();
    assert.deepEqual(seen(), ['connecting', true]);
    s.disconnect();
    assert.deepEqual(seen(), ['disconnected', false]);
    connect();
    s.connect(profile({ host: '' })); // replaces the session with one that cannot start
    assert.deepEqual(seen(), ['error', false]);
  });

  test('messages are buffered as standalone copies and flushed in a batch', () => {
    const { c } = connect();
    goOnline(c);
    const backing = Buffer.from('xxhelloyy');
    const view = backing.subarray(2, 7);
    c.emit('message', 'a/b', view, { qos: 1, retain: true, properties: { contentType: 'text/plain' } });
    c.emit('message', 'c', Buffer.alloc(0), { qos: 0, retain: false });
    s.flush();
    assert.equal(ev.batch.length, 1);
    const [m1, m2] = ev.batch[0].messages;
    assert.equal(m1.topic, 'a/b');
    assert.ok(m1.payload instanceof Uint8Array);
    assert.ok(!Buffer.isBuffer(m1.payload), 'plain Uint8Array for IPC');
    assert.equal(Buffer.from(m1.payload).toString(), 'hello');
    assert.equal(m1.payload.buffer.byteLength, 5, 'does not retain the socket chunk');
    backing.fill(0);
    assert.equal(Buffer.from(m1.payload).toString(), 'hello', 'copy is independent');
    assert.equal(m1.qos, 1);
    assert.equal(m1.retain, true);
    assert.deepEqual(m1.props, { contentType: 'text/plain' });
    assert.equal(typeof m1.ts, 'number');
    assert.equal(m2.props, null);
    assert.equal(m2.payload.length, 0);
    assert.equal(ev.batch[0].dropped, 0);
  });

  test('messages beyond maxBuffered are dropped and counted', () => {
    s = new MqttSession({ flushIntervalMs: 1_000_000, maxBuffered: 3 });
    ev = recorder(s);
    const { c } = connect();
    goOnline(c);
    for (let i = 0; i < 5; i++) c.emit('message', `t/${i}`, Buffer.from([i]), { qos: 0, retain: false });
    s.flush();
    assert.deepEqual(
      ev.batch[0].messages.map((m) => m.topic),
      ['t/0', 't/1', 't/2'],
    );
    assert.equal(ev.batch[0].dropped, 2);
    c.emit('message', 't/5', Buffer.from([5]), { qos: 0, retain: false });
    s.flush();
    assert.equal(ev.batch[1].dropped, 0);
    assert.equal(ev.batch[1].messages.length, 1);
  });

  test('the flush timer emits batches every flushIntervalMs', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      s = new MqttSession({ flushIntervalMs: 50 });
      ev = recorder(s);
      const { c } = connect();
      goOnline(c);
      c.emit('message', 'a', Buffer.from('1'), { qos: 0, retain: false });
      mock.timers.tick(49);
      assert.equal(ev.batch.length, 0);
      mock.timers.tick(1);
      assert.equal(ev.batch.length, 1);
      mock.timers.tick(500);
      assert.equal(ev.batch.length, 1, 'no empty batches');
      s.disconnect();
      c.emit('message', 'a', Buffer.from('1'), { qos: 0, retain: false });
      mock.timers.tick(500);
      assert.equal(ev.batch.length, 1, 'timer stopped');
    } finally {
      mock.timers.reset();
    }
  });

  test('events from a replaced client are ignored', () => {
    const { c: old } = connect();
    goOnline(old);
    const { c: cur } = connect(profile({ host: 'other' }));
    const statusCount = ev.status.length;
    old.emit('connect');
    old.emit('close');
    old.emit('offline');
    old.emit('reconnect');
    old.emit('error', new Error('stale'));
    assert.equal(ev.status.length, statusCount);
    assert.equal(s.status.state, 'connecting');
    old.emit('message', 'x', Buffer.from('x'), { qos: 0 });
    s.flush();
    assert.deepEqual(ev.batch, []);
    goOnline(cur);
    assert.equal(s.status.state, 'connected');
  });

  test('connect() while connected tears down the previous client first', () => {
    const { c: first } = connect();
    goOnline(first);
    connect(profile({ host: 'second' }));
    assert.deepEqual(first.calls.end, [true]);
    const states = ev.status.map((x) => x.state);
    assert.deepEqual(states, ['connecting', 'connected', 'disconnected', 'connecting']);
  });

  test('disconnect(): ends the client, clears buffers, emits disconnected once', () => {
    const { c } = connect();
    goOnline(c);
    c.emit('message', 'a', Buffer.from('1'), { qos: 0 });
    s.dropped = 4;
    s.disconnect();
    assert.deepEqual(c.calls.end, [true]);
    assert.equal(s.client, null);
    assert.equal(s.timer, null);
    assert.deepEqual(s.buffer, []);
    assert.equal(s.dropped, 0);
    assert.equal(s.connected, false);
    assert.deepEqual(s.status, { state: 'disconnected', url: 'mqtt://broker.test:1883' });
    assert.equal(c.listenerCount('message'), 0);
    const n = ev.status.length;
    s.disconnect();
    assert.equal(ev.status.length, n, 'second disconnect is silent');
    // Errors during teardown must not crash (an 'error' listener remains).
    assert.doesNotThrow(() => c.emit('error', new Error('socket hang up')));
    assert.equal(s.status.state, 'disconnected');
  });

  test('publish: payload types, qos/retain normalization, callback result', async () => {
    const { c } = connect();
    goOnline(c);
    const p1 = s.publish({ topic: 'a', payload: 'text', qos: '2', retain: 1 });
    const call1 = c.calls.publish[0];
    assert.equal(call1.topic, 'a');
    assert.equal(call1.body, 'text');
    assert.deepEqual(call1.opts, { qos: 2, retain: true });
    call1.cb();
    assert.deepEqual(await p1, { ok: true });

    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const p2 = s.publish({ topic: 'b', payload: backing.subarray(2, 5), qos: 7 });
    const call2 = c.calls.publish[1];
    assert.ok(Buffer.isBuffer(call2.body));
    assert.deepEqual([...call2.body], [1, 2, 3], 'respects byteOffset/byteLength');
    assert.deepEqual(call2.opts, { qos: 0, retain: false });
    call2.cb(new Error('Connection closed'));
    assert.deepEqual(await p2, { ok: false, error: 'Connection closed' });

    s.publish({ topic: 'c', payload: null });
    s.publish({ topic: 'c' });
    assert.equal(c.calls.publish[2].body, '');
    assert.equal(c.calls.publish[3].body, '');

    for (const payload of [42, { a: 1 }, [1, 2], true]) {
      assert.deepEqual(await s.publish({ topic: 'd', payload }), { ok: false, error: 'Payload must be text or bytes' });
    }
    assert.equal(c.calls.publish.length, 4);
  });

  test('publish: MQTT 5 properties only on v5 connections', () => {
    const props = { contentType: 'application/json', userProperties: { a: 'b' } };
    const { c } = connect(profile({ mqttVersion: 4 }));
    goOnline(c);
    s.publish({ topic: 'a', payload: 'x', properties: props });
    assert.equal('properties' in c.calls.publish[0].opts, false);
    const { c: c5 } = connect(profile({ mqttVersion: 5 }));
    goOnline(c5);
    s.publish({ topic: 'a', payload: 'x', properties: props });
    assert.deepEqual(c5.calls.publish[0].opts.properties, props);
  });

  test('publish after the client goes offline returns Not connected', async () => {
    const { c } = connect();
    goOnline(c);
    c.connected = false;
    assert.deepEqual(await s.publish({ topic: 'a', payload: 'x' }), { ok: false, error: 'Not connected' });
  });

  test('subscribe: success records the subscription once', async () => {
    const { c } = connect();
    goOnline(c);
    const p = s.subscribe('x/#', '1');
    const call = c.calls.subscribe.at(-1);
    assert.equal(call.topic, 'x/#');
    assert.deepEqual(call.opts, { qos: 1 });
    call.cb(null, [{ topic: 'x/#', qos: 1 }]);
    assert.deepEqual(await p, { ok: true });
    assert.deepEqual(s.subscriptions, [{ topic: 'x/#', qos: 1 }]);
    const p2 = s.subscribe('x/#', 2);
    c.calls.subscribe.at(-1).cb(null, [{ topic: 'x/#', qos: 2 }]);
    await p2;
    assert.equal(s.subscriptions.filter((x) => x.topic === 'x/#').length, 1);
  });

  test('subscribe: re-subscribing with a new qos updates the qos used on reconnect', async () => {
    const { c } = connect(profile({ subscriptions: [{ topic: 'x/#', qos: 0 }] }));
    goOnline(c);
    const p = s.subscribe('x/#', 2);
    c.calls.subscribe.at(-1).cb(null, [{ topic: 'x/#', qos: 2 }]);
    assert.deepEqual(await p, { ok: true });
    assert.deepEqual(s.subscriptions, [{ topic: 'x/#', qos: 2 }]);
    // Reconnect: the session re-subscribes from its list.
    c.emit('connect');
    assert.deepEqual(c.calls.subscribe.at(-1).topic, { 'x/#': { qos: 2 } });
  });

  test('subscribe: errors and broker rejections are not recorded', async () => {
    const { c } = connect();
    goOnline(c);
    const p1 = s.subscribe('a', 0);
    c.calls.subscribe.at(-1).cb(new Error('nope'));
    assert.deepEqual(await p1, { ok: false, error: 'nope' });
    const p2 = s.subscribe('b', 0);
    c.calls.subscribe.at(-1).cb(new Error('Subscribe error: Unspecified error'), [{ topic: 'b', qos: 0 }], { granted: [128] });
    assert.deepEqual(await p2, { ok: false, error: 'Rejected by broker' });
    assert.deepEqual(s.subscriptions, []);
  });

  test('unsubscribe: removes the subscription on success, keeps it on error', async () => {
    const { c } = connect(profile({ subscriptions: [{ topic: 'a', qos: 0 }, { topic: 'b', qos: 1 }] }));
    goOnline(c);
    const p1 = s.unsubscribe('a');
    c.calls.unsubscribe.at(-1).cb();
    assert.deepEqual(await p1, { ok: true });
    assert.deepEqual(s.subscriptions, [{ topic: 'b', qos: 1 }]);
    const p2 = s.unsubscribe('b');
    c.calls.unsubscribe.at(-1).cb(new Error('fail'));
    assert.deepEqual(await p2, { ok: false, error: 'fail' });
    assert.deepEqual(s.subscriptions, [{ topic: 'b', qos: 1 }]);
  });
});
