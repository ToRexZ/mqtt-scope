'use strict';

// One MQTT connection. Incoming messages are buffered and emitted in batches
// ('batch' events) so a busy broker cannot flood the UI with one event per
// message. Has no Electron dependency so it can be tested under plain Node.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const mqtt = require('mqtt');

const DEFAULTS = {
  flushIntervalMs: 50,
  maxBuffered: 50000,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
};

const PROTOCOLS = new Set(['mqtt', 'mqtts', 'ws', 'wss']);
// Keep in sync with renderer/profiles.js DEFAULT_PORTS.
const DEFAULT_PORTS = { mqtt: 1883, mqtts: 8883, ws: 9001, wss: 443 };

function readTlsFile(readFile, file, label) {
  try {
    return readFile(file);
  } catch (err) {
    throw new Error(`Cannot read ${label} "${file}": ${err.code || err.message}`, { cause: err });
  }
}

function buildConnectOptions(p, { readFile = fs.readFileSync, defaults = DEFAULTS } = {}) {
  const protocol = p.protocol || 'mqtt';
  if (!PROTOCOLS.has(protocol)) throw new Error(`Unsupported protocol "${protocol}"`);
  const host = String(p.host || '').trim();
  if (!host) throw new Error('Host is required');
  const secure = protocol === 'mqtts' || protocol === 'wss';
  const port = p.port === undefined || p.port === '' ? DEFAULT_PORTS[protocol] : Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port "${p.port}"`);

  const keepalive = p.keepalive === undefined || p.keepalive === '' ? 60 : Number(p.keepalive);
  if (!Number.isInteger(keepalive) || keepalive < 0 || keepalive > 65535) throw new Error(`Invalid keep-alive "${p.keepalive}" (0–65535 seconds)`);
  // A persistent session (clean = false) is only resumed with the same client
  // id, so derive a stable one from the profile instead of a random one.
  const stableId = p.clean === false && p.id ? `mqtt-scope-${String(p.id).replace(/[^\w-]/g, '').slice(0, 40)}` : null;
  const opts = {
    protocol,
    host,
    port,
    clientId: p.clientId || stableId || `mqtt-scope-${Math.random().toString(16).slice(2, 10)}`,
    username: p.username || undefined,
    password: p.password || undefined,
    protocolVersion: Number(p.mqttVersion) === 5 ? 5 : 4,
    clean: p.clean !== false,
    keepalive,
    reconnectPeriod: defaults.reconnectPeriod,
    connectTimeout: defaults.connectTimeout,
    // The session re-subscribes itself on every connect; letting mqtt.js do it
    // too would subscribe twice and deliver retained messages twice.
    resubscribe: false,
  };
  if (protocol.startsWith('ws')) opts.path = p.wsPath || '/mqtt';
  if (secure) {
    opts.rejectUnauthorized = p.rejectUnauthorized !== false;
    if (p.caFile) opts.ca = readTlsFile(readFile, p.caFile, 'CA certificate');
    if (p.certFile) opts.cert = readTlsFile(readFile, p.certFile, 'client certificate');
    if (p.keyFile) opts.key = readTlsFile(readFile, p.keyFile, 'client key');
  }
  return opts;
}

function brokerUrl(o) {
  return `${o.protocol}://${o.host}:${o.port}${o.path || ''}`;
}

function validatePublishTopic(topic) {
  if (typeof topic !== 'string' || topic.length === 0) return 'Topic is required';
  if (/[+#]/.test(topic)) return 'Topic must not contain wildcards (+ or #)';
  if (topic.includes('\u0000')) return 'Topic must not contain NUL characters';
  return null;
}

function validateFilter(filter) {
  if (typeof filter !== 'string' || filter.length === 0) return 'Topic filter is required';
  if (filter.includes('\u0000')) return 'Topic filter must not contain NUL characters';
  const levels = filter.split('/');
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    if (l.includes('#') && (l !== '#' || i !== levels.length - 1)) return '"#" must be the last level on its own';
    if (l.includes('+') && l !== '+') return '"+" must occupy a whole level';
  }
  return null;
}

const toQos = (q) => (q === 1 || q === 2 || q === '1' || q === '2' ? Number(q) : 0);

// Filters the broker refused, from a mqtt.js subscribe callback (err, subs, suback).
function rejectedFilters(subs, packet) {
  const granted = packet?.granted;
  if (!Array.isArray(subs) || !Array.isArray(granted)) return [];
  return subs.filter((_, i) => (granted[i] & 0x80) !== 0).map((s) => s.topic);
}

// Shallow copy of MQTT 5 properties with binary values (correlationData)
// copied out of the shared socket buffer, like payloads.
function copyProps(props) {
  if (!props) return null;
  const out = {};
  for (const [k, v] of Object.entries(props)) out[k] = v instanceof Uint8Array ? new Uint8Array(v) : v;
  return out;
}

const LOST = 'Connection closed before the broker acknowledged the message';

class MqttSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULTS, ...options };
    this.client = null;
    this.buffer = [];
    this.dropped = 0;
    this.timer = null;
    this.status = { state: 'disconnected' };
    this.subscriptions = [];
  }

  setStatus(state, extra = {}) {
    this.status = { state, ...extra };
    this.emit('status', this.status);
  }

  get connected() {
    return !!this.client && this.client.connected;
  }

  connect(profile) {
    this.disconnect();
    let opts;
    try {
      opts = buildConnectOptions(profile, { readFile: this.options.readFile, defaults: this.options });
    } catch (err) {
      this.setStatus('error', { error: err.message });
      return { ok: false, error: err.message };
    }
    const url = brokerUrl(opts);
    this.url = url;
    this.subscriptions = (profile.subscriptions || []).filter((s) => s && s.topic);
    this.setStatus('connecting', { url });

    const c = mqtt.connect(opts);
    this.client = c;
    const mine = () => c === this.client;

    c.on('connect', () => {
      if (!mine()) return;
      this.setStatus('connected', { url });
      this.subscribeInitial(c);
    });
    c.on('reconnect', () => mine() && this.setStatus('reconnecting', { url }));
    // After an error, keep the error visible until the next attempt starts.
    c.on('offline', () => mine() && this.status.state !== 'error' && this.setStatus('offline', { url }));
    c.on('close', () => {
      if (!mine()) return;
      // Fail unacknowledged QoS 1/2 publishes instead of letting mqtt.js resend
      // them on reconnect: a publish the broker rejects by disconnecting would
      // otherwise cause an endless reconnect loop.
      this.failPending(c);
      // While mqtt.js is going to retry, 'offline'/'error' stay visible until 'reconnecting'.
      const willRetry = !c.disconnecting && c.options.reconnectPeriod > 0;
      if (this.status.state !== 'error' && !willRetry) this.setStatus('disconnected', { url, unexpected: true });
    });
    c.on('error', (err) => mine() && this.setStatus('error', { url, error: err.message }));
    c.on('message', (topic, payload, packet) => {
      if (!mine()) return;
      if (this.buffer.length >= this.options.maxBuffered) {
        this.dropped++;
        return;
      }
      this.buffer.push({
        topic,
        // Copy into a standalone buffer: the parser hands out views into large
        // socket chunks, and IPC would otherwise serialise the whole backing store.
        payload: new Uint8Array(payload),
        qos: packet.qos,
        retain: packet.retain,
        ts: Date.now(),
        props: copyProps(packet.properties),
      });
    });

    this.timer = setInterval(() => this.flush(), this.options.flushIntervalMs);
    return { ok: true, url };
  }

  // Runs on every connect. Invalid or rejected filters are reported once and
  // dropped so they are not retried (and re-reported) on every reconnect.
  subscribeInitial(c) {
    const valid = [];
    const invalid = [];
    for (const s of this.subscriptions) (validateFilter(s.topic) ? invalid : valid).push(s);
    if (invalid.length) {
      this.emit('warning', `Skipped invalid subscriptions: ${invalid.map((s) => s.topic).join(', ')}`);
      this.subscriptions = valid;
    }
    if (!valid.length) return;
    const map = {};
    for (const s of valid) map[s.topic] = { qos: toQos(s.qos) };
    c.subscribe(map, (err, subs, packet) => {
      if (c !== this.client || !err) return;
      const rejected = rejectedFilters(subs, packet);
      if (rejected.length) {
        this.emit('warning', `Broker rejected subscription: ${rejected.join(', ')}`);
        this.subscriptions = this.subscriptions.filter((s) => !rejected.includes(s.topic));
      } else if (c.connected) {
        this.emit('warning', `Subscribe failed: ${err.message}`);
      }
    });
  }

  failPending(c) {
    for (const id of Object.keys(c.outgoing || {})) c.removeOutgoingMessage(Number(id));
  }

  disconnect() {
    clearInterval(this.timer);
    this.timer = null;
    this.buffer = [];
    this.dropped = 0;
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    c.removeAllListeners('message');
    c.on('error', () => {}); // errors during teardown are irrelevant
    this.failPending(c);
    c.end(true);
    this.setStatus('disconnected', { url: this.url });
  }

  flush() {
    if (!this.buffer.length && !this.dropped) return;
    const batch = { messages: this.buffer, dropped: this.dropped };
    this.buffer = [];
    this.dropped = 0;
    this.emit('batch', batch);
  }

  publish({ topic, payload, qos, retain, properties } = {}) {
    const bad = validatePublishTopic(topic);
    if (bad) return Promise.resolve({ ok: false, error: bad });
    if (!this.connected) return Promise.resolve({ ok: false, error: 'Not connected' });
    let body;
    if (typeof payload === 'string') body = payload;
    else if (payload instanceof Uint8Array) body = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    else if (payload == null) body = '';
    else return Promise.resolve({ ok: false, error: 'Payload must be text or bytes' });
    const opts = { qos: toQos(qos), retain: !!retain };
    if (properties && this.client.options.protocolVersion === 5) opts.properties = properties;
    const c = this.client;
    return new Promise((resolve) => {
      c.publish(topic, body, opts, (err) => {
        if (!err) return resolve({ ok: true });
        resolve({ ok: false, error: err.message === 'Message removed' ? LOST : err.message });
      });
    });
  }

  subscribe(topic, qos) {
    const bad = validateFilter(topic);
    if (bad) return Promise.resolve({ ok: false, error: bad });
    if (!this.connected) return Promise.resolve({ ok: false, error: 'Not connected' });
    const c = this.client;
    return new Promise((resolve) => {
      c.subscribe(topic, { qos: toQos(qos) }, (err, subs, packet) => {
        if (err) return resolve({ ok: false, error: rejectedFilters(subs, packet).length ? 'Rejected by broker' : err.message });
        const existing = this.subscriptions.find((s) => s.topic === topic);
        if (existing) existing.qos = toQos(qos);
        else this.subscriptions.push({ topic, qos: toQos(qos) });
        resolve({ ok: true });
      });
    });
  }

  unsubscribe(topic) {
    if (!this.connected) return Promise.resolve({ ok: false, error: 'Not connected' });
    const c = this.client;
    return new Promise((resolve) => {
      c.unsubscribe(topic, (err) => {
        if (err) return resolve({ ok: false, error: err.message });
        this.subscriptions = this.subscriptions.filter((s) => s.topic !== topic);
        resolve({ ok: true });
      });
    });
  }
}

module.exports = { MqttSession, buildConnectOptions, validatePublishTopic, validateFilter };
