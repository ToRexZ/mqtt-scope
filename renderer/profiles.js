// Connection profile helpers (no DOM).

export const DEFAULT_PORTS = { mqtt: 1883, mqtts: 8883, ws: 9001, wss: 443 };
const DEFAULT_SUBS = [
  { topic: '#', qos: 0 },
  { topic: '$SYS/#', qos: 0 },
];
export const newId = () => Math.random().toString(36).slice(2, 10);

export function blankProfile(name = 'New connection') {
  return {
    id: newId(),
    name,
    protocol: 'mqtt',
    host: 'localhost',
    port: 1883,
    wsPath: '/mqtt',
    mqttVersion: 4,
    clientId: '',
    username: '',
    password: '',
    keepalive: 60,
    clean: true,
    rejectUnauthorized: true,
    caFile: '',
    certFile: '',
    keyFile: '',
    subscriptions: DEFAULT_SUBS.map((s) => ({ ...s })),
  };
}

// What a connection is made with: a tab whose snapshot differs from the saved
// profile in this needs a reconnect to apply it. Not the name or subscriptions.
const SIGNATURE_FIELDS = ['protocol', 'host', 'port', 'wsPath', 'mqttVersion', 'username', 'password', 'clientId', 'keepalive', 'clean', 'rejectUnauthorized', 'caFile', 'certFile', 'keyFile'];
const NUMBER_FIELDS = new Set(['port', 'mqttVersion', 'keepalive']);

export function connectSignature(profile) {
  // Missing and empty count the same; the two flags are on unless false; a
  // number counts the same as typed in the form ('5') and as saved (5).
  const value = (k) => {
    if (k === 'clean' || k === 'rejectUnauthorized') return profile[k] !== false;
    const v = profile[k] ?? '';
    if (!NUMBER_FIELDS.has(k)) return v;
    return String(v).trim() === '' ? '' : Number(v);
  };
  return JSON.stringify(SIGNATURE_FIELDS.map(value));
}

// How the connection list is ordered (the sort button in its header).
export const SORT_MODES = [
  { id: 'saved', label: 'Saved order' },
  { id: 'name', label: 'Name' },
  { id: 'status', label: 'Open and online first' },
];

export const normalizeSort = (mode) => (SORT_MODES.some((m) => m.id === mode) ? mode : 'saved');

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// A sorted copy. 'name' puts unnamed profiles last; 'status' puts profiles
// open in a tab first, then brokers that answered, then ones not checked
// yet, then ones that did not answer, by name within each. online(id) is
// true, false or undefined (not checked yet). Ties keep the saved order.
export function sortProfiles(profiles, mode, { openIds = new Set(), online = () => undefined } = {}) {
  const indexed = profiles.map((p, i) => ({ p, i }));
  const byName = (a, b) => !a.p.name - !b.p.name || collator.compare(a.p.name || '', b.p.name || '');
  const rank = ({ p }) => (openIds.has(p.id) ? 0 : { true: 1, undefined: 2, false: 3 }[String(online(p.id))]);
  const compare = {
    name: byName,
    status: (a, b) => rank(a) - rank(b) || byName(a, b),
  }[normalizeSort(mode)];
  if (compare) indexed.sort((a, b) => compare(a, b) || a.i - b.i);
  return indexed.map((x) => x.p);
}

// What main probes for a profile (see main/brokerProbe.js), or null when it
// has no host or port yet. `key` tells whether a result still fits the
// profile after an edit.
export function probeTarget(p) {
  const host = String(p.host ?? '').trim();
  const port = String(p.port ?? '').trim() === '' ? NaN : Number(p.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { id: p.id, host, port, key: `${host.toLowerCase()}:${port}` };
}

export function parseSubscriptions(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(.*?)(?:\s+([012]))?$/.exec(l);
      return { topic: m[1].trim(), qos: m[2] ? Number(m[2]) : 0 };
    });
}

export function formatSubscriptions(subs) {
  // A topic ending in " 0", " 1" or " 2" needs its QoS spelled out to round-trip.
  return (subs || []).map((s) => (s.qos || /\s[012]$/.test(s.topic) ? `${s.topic} ${s.qos || 0}` : s.topic)).join('\n');
}
