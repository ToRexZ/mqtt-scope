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
