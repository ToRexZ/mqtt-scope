'use strict';

// Connection profiles stored as JSON. Passwords are encrypted with the
// supplied cipher (Electron safeStorage in the app) when it is available.

const fs = require('node:fs');
const path = require('node:path');

const FIELDS = {
  id: 'string',
  name: 'string',
  protocol: 'string',
  host: 'string',
  port: 'number',
  wsPath: 'string',
  clientId: 'string',
  username: 'string',
  password: 'string',
  mqttVersion: 'number',
  clean: 'boolean',
  keepalive: 'number',
  rejectUnauthorized: 'boolean',
  caFile: 'string',
  certFile: 'string',
  keyFile: 'string',
};

function defaultProfiles() {
  return [
    {
      id: 'local',
      name: 'Local broker',
      protocol: 'mqtt',
      host: 'localhost',
      port: 1883,
      mqttVersion: 4,
      subscriptions: [
        { topic: '#', qos: 0 },
        { topic: '$SYS/#', qos: 0 },
      ],
    },
  ];
}

// Keeps only known fields with the right types; drops anything else.
function sanitize(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  for (const [k, type] of Object.entries(FIELDS)) {
    let v = p[k];
    if (type === 'number' && typeof v === 'string' && v.trim() !== '') v = Number(v);
    if (typeof v === type && !(type === 'number' && !Number.isFinite(v))) out[k] = v;
  }
  if (!out.id || !out.name) return null;
  out.subscriptions = Array.isArray(p.subscriptions)
    ? p.subscriptions
        .filter((s) => s && typeof s.topic === 'string' && s.topic)
        .map((s) => ({ topic: s.topic, qos: [0, 1, 2].includes(Number(s.qos)) ? Number(s.qos) : 0 }))
    : [];
  return out;
}

function createProfileStore({ file, cipher }) {
  const canEncrypt = () => {
    try {
      return !!cipher && cipher.isAvailable();
    } catch {
      return false;
    }
  };

  function load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the unreadable file for the user instead of silently overwriting it.
        try {
          fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
        } catch {}
      }
      return defaultProfiles();
    }
    if (!Array.isArray(raw)) return defaultProfiles();
    return raw
      .map((p) => {
        const out = sanitize(p);
        if (out && typeof p.passwordEnc === 'string') {
          try {
            out.password = cipher.decrypt(Buffer.from(p.passwordEnc, 'base64'));
          } catch {
            out.password = '';
            out.passwordLost = true;
          }
        }
        return out;
      })
      .filter(Boolean);
  }

  // Encrypted passwords currently on disk, by profile id.
  function storedPasswords() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return new Map(raw.filter((p) => p && p.id && typeof p.passwordEnc === 'string').map((p) => [p.id, p.passwordEnc]));
    } catch {
      return new Map();
    }
  }

  function save(list) {
    if (!Array.isArray(list)) throw new Error('Profiles must be an array');
    const encrypt = canEncrypt();
    const previous = storedPasswords();
    const stored = list
      .map((raw) => {
        const p = sanitize(raw);
        // A password that could not be decrypted at load (e.g. keyring locked)
        // stays stored as it was until the user types a new one.
        if (p && raw.passwordLost && !p.password && previous.has(p.id)) p.passwordEnc = previous.get(p.id);
        return p;
      })
      .filter(Boolean)
      .map((p) => {
        if (p.password && encrypt) {
          const { password, ...rest } = p;
          return { ...rest, passwordEnc: cipher.encrypt(password).toString('base64') };
        }
        return p;
      });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write atomically so a crash mid-write cannot destroy saved connections.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true, count: stored.length, encrypted: encrypt };
  }

  return { load, save, canEncrypt };
}

module.exports = { createProfileStore, sanitize, defaultProfiles };
