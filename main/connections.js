'use strict';

// Owns many MqttSessions keyed by an app-wide connection id ('c1', 'c2', ...).
// Each connection belongs to one window (ownerId = webContents id) and may be
// bound to a profile id; a profile can be open in one connection at a time.
// Has no Electron dependency so it can be tested under plain Node.

const { EventEmitter } = require('node:events');
const { MqttSession } = require('./mqttSession');

const EVENTS = ['status', 'warning', 'batch'];

class ConnectionRegistry extends EventEmitter {
  constructor({ createSession = () => new MqttSession() } = {}) {
    super();
    this._createSession = createSession;
    this._entries = new Map();
    this._counter = 0;
  }

  get size() {
    return this._entries.size;
  }

  create(ownerId) {
    const connId = `c${++this._counter}`;
    const entry = { session: this._createSession(), ownerId, profileId: null, held: null };
    this._entries.set(connId, entry);
    // A closed connection is gone from the map; its session may still emit
    // while tearing down, and that must not reach anyone.
    for (const name of EVENTS) {
      entry.session.on(name, (arg) => {
        if (this._entries.get(connId) !== entry) return;
        if (entry.held) entry.held.push([name, arg]);
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
  // user had disconnected): from then on no other connection may open it.
  bind(connId, profile) {
    const entry = this._entries.get(connId);
    if (!entry) return { ok: false, error: 'Unknown connection' };
    const other = profile.id != null ? this.findProfile(profile.id) : null;
    if (other && other.connId !== connId) return { ok: false, duplicate: other };
    this._bind(entry, profile.id ?? null);
    return { ok: true };
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
  // the new owner on release so none are lost or reordered.
  hold(connId) {
    const entry = this._entries.get(connId);
    if (entry && !entry.held) entry.held = [];
  }

  setOwner(connId, ownerId) {
    const entry = this._entries.get(connId);
    if (entry) entry.ownerId = ownerId;
  }

  release(connId) {
    const entry = this._entries.get(connId);
    if (!entry || !entry.held) return;
    const queued = entry.held;
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

module.exports = { ConnectionRegistry };
