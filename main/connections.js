'use strict';

// Owns many MqttSessions keyed by an app-wide connection id ('c1', 'c2', ...).
// Each connection belongs to one window (ownerId = webContents id) and may be
// bound to a profile id; a profile can be open in one connection at a time,
// and so can an explicit client ID on one broker. Has no Electron dependency
// so it can be tested under plain Node.

const { EventEmitter } = require('node:events');
const { MqttSession } = require('./mqttSession');

const EVENTS = ['status', 'warning', 'batch'];
// Messages held for a tab on its way between windows, at most (as many as a
// session buffers between two batches).
const HOLD_MAX = 50000;
// Keep in sync with mqttSession.js DEFAULT_PORTS.
const DEFAULT_PORTS = { mqtt: 1883, mqtts: 8883, ws: 9001, wss: 443 };

// The explicit client ID of a profile with the broker it connects to, as one
// key; null without one (an empty client ID gets a random or a per-profile
// one, see mqttSession.js). The broker is normalised the way the session
// connects to it: a missing or empty port is the protocol's default, '1883'
// is 1883, the host's case and surrounding spaces do not count, and the
// WebSocket path only counts for ws and wss.
function clientKey(p) {
  if (typeof p?.clientId !== 'string' || !p.clientId) return null;
  const protocol = String(p.protocol || 'mqtt');
  const rawPort = String(p.port ?? '').trim();
  const port = rawPort === '' ? DEFAULT_PORTS[protocol] : Number(rawPort);
  const wsPath = protocol.startsWith('ws') ? p.wsPath || '/mqtt' : '';
  return JSON.stringify([p.clientId, protocol, String(p.host ?? '').trim().toLowerCase(), port, wsPath]);
}

class ConnectionRegistry extends EventEmitter {
  constructor({ createSession = () => new MqttSession(), holdMax = HOLD_MAX } = {}) {
    super();
    this._createSession = createSession;
    this._holdMax = holdMax;
    this._entries = new Map();
    this._counter = 0;
  }

  get size() {
    return this._entries.size;
  }

  create(ownerId) {
    const connId = `c${++this._counter}`;
    // clientKey and name: of the profile bound (see bind).
    const entry = { session: this._createSession(), ownerId, profileId: null, clientKey: null, name: '', held: null };
    this._entries.set(connId, entry);
    // A closed connection is gone from the map; its session may still emit
    // while tearing down, and that must not reach anyone.
    for (const name of EVENTS) {
      entry.session.on(name, (arg) => {
        if (this._entries.get(connId) !== entry) return;
        if (entry.held) this._hold(entry, name, arg);
        else this.emit(name, connId, entry.ownerId, arg);
      });
    }
    return connId;
  }

  get(connId) {
    return this._entries.get(connId) || null;
  }

  ofOwner(ownerId) {
    return [...this._entries].filter(([, e]) => e.ownerId === ownerId).map(([id]) => id);
  }

  connect(connId, profile) {
    const res = this.bind(connId, profile);
    return res.ok ? this._entries.get(connId).session.connect(profile) : res;
  }

  // Takes the profile without connecting (a tab reopened at launch that the
  // user had disconnected): from then on no other connection may open it,
  // nor another profile with the same explicit client ID on the same broker
  // (the two clients would throw each other off it). Refused, it answers
  // { duplicate } or { clientIdInUse } naming the connection that has it.
  bind(connId, profile) {
    const entry = this._entries.get(connId);
    if (!entry) return { ok: false, error: 'Unknown connection' };
    const other = profile.id != null ? this.findProfile(profile.id) : null;
    if (other && other.connId !== connId) return { ok: false, duplicate: other };
    const key = clientKey(profile);
    const user = key && this._findClientKey(key, connId);
    if (user) return { ok: false, clientIdInUse: { ...user, clientId: profile.clientId } };
    entry.clientKey = key;
    entry.name = String(profile.name ?? '');
    this._bind(entry, profile.id ?? null);
    return { ok: true };
  }

  _findClientKey(key, exceptConnId) {
    for (const [connId, e] of this._entries) {
      if (connId !== exceptConnId && e.clientKey === key) return { connId, ownerId: e.ownerId, profileId: e.profileId, name: e.name };
    }
    return null;
  }

  disconnect(connId) {
    this._entries.get(connId)?.session.disconnect();
  }

  // Forgotten first: the session reports 'disconnected' while it tears down,
  // and that must not reach the window either.
  close(connId) {
    const entry = this._entries.get(connId);
    if (!entry) return;
    this._entries.delete(connId);
    entry.session.disconnect();
    if (entry.profileId != null) this._emitOpenProfiles();
  }

  closeOwner(ownerId) {
    for (const connId of this.ofOwner(ownerId)) this.close(connId);
  }

  findProfile(profileId) {
    for (const [connId, e] of this._entries) {
      if (e.profileId === profileId) return { connId, ownerId: e.ownerId };
    }
    return null;
  }

  openProfileIds() {
    return [...this._entries.values()].map((e) => e.profileId).filter((id) => id != null);
  }

  // Of every window, or of one.
  activeCount(ownerId) {
    let n = 0;
    for (const e of this._entries.values()) if (e.session.active && (ownerId === undefined || e.ownerId === ownerId)) n++;
    return n;
  }

  // While a tab moves between windows its events are queued, then delivered to
  // the new owner on release so none are lost or reordered. Past holdMax
  // messages, more are dropped and counted, in a batch after the queued ones.
  hold(connId) {
    const entry = this._entries.get(connId);
    if (entry && !entry.held) Object.assign(entry, { held: [], heldCount: 0, heldDropped: 0 });
  }

  _hold(entry, name, arg) {
    if (name !== 'batch') return entry.held.push([name, arg]);
    const { messages = [], dropped = 0 } = arg;
    const room = this._holdMax - entry.heldCount;
    if (room <= 0) {
      entry.heldDropped += messages.length + dropped;
      return;
    }
    const kept = Math.min(messages.length, room);
    entry.heldCount += kept;
    entry.heldDropped += messages.length - kept;
    entry.held.push([name, kept < messages.length ? { messages: messages.slice(0, kept), dropped } : arg]);
  }

  setOwner(connId, ownerId) {
    const entry = this._entries.get(connId);
    if (entry) entry.ownerId = ownerId;
  }

  release(connId) {
    const entry = this._entries.get(connId);
    if (!entry || !entry.held) return;
    const queued = entry.held;
    if (entry.heldDropped) queued.push(['batch', { messages: [], dropped: entry.heldDropped }]);
    entry.held = null;
    for (const [name, arg] of queued) this.emit(name, connId, entry.ownerId, arg);
  }

  _bind(entry, profileId) {
    if (entry.profileId === profileId) return;
    entry.profileId = profileId;
    this._emitOpenProfiles();
  }

  _emitOpenProfiles() {
    this.emit('openProfiles', this.openProfileIds());
  }
}

module.exports = { ConnectionRegistry, clientKey };
