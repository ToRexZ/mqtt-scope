'use strict';

// Whether a broker is online: a plain TCP connection to its host and port,
// closed as soon as it opens. No TLS handshake and no MQTT login: no
// credentials leave the app, and a broker sees (and may log) a connection
// that closes before it says anything.

const net = require('node:net');

const TIMEOUT_MS = 3000; // for the name lookup, and again for the connection
const PARALLEL = 16; // probes at once, over all calls (see shared)
const MAX_TARGETS = 500;
const MAX_ADDRESSES = 4;

const ERRORS = {
  ECONNREFUSED: 'Connection refused',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  ECONNRESET: 'Connection reset',
  EADDRNOTAVAIL: 'Address not available',
};

// Runs at most `n` of the functions given to it at once.
function createLimiter(n) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= n || !waiting.length) return;
    running++;
    const { fn, resolve } = waiting.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, resolve)
      .finally(() => {
        running--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve) => {
      waiting.push({ fn, resolve });
      next();
    });
}

// One limit for every window's calls together.
const shared = createLimiter(PARALLEL);

// Tries one address; resolves to null when it answers, else the reason.
function tryAddress(address, port, { timeout, connect }) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = connect({ host: address, port });
    } catch (err) {
      resolve(err.message || 'No answer');
      return;
    }
    const done = (error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => {}); // a late error after destroy() is not news
      socket.destroy();
      resolve(error);
    };
    const timer = setTimeout(() => done('No answer'), timeout);
    socket.once('connect', () => done(null));
    socket.once('error', (err) => done(ERRORS[err.code] || err.message || 'No answer'));
  });
}

// Resolves to the addresses of `host`, [] when it has none, or 'timeout'.
function lookup(host, resolve, timeout) {
  let timer;
  return Promise.race([
    Promise.resolve()
      .then(() => resolve(host))
      .catch(() => []),
    new Promise((r) => (timer = setTimeout(() => r('timeout'), timeout))),
  ]).finally(() => clearTimeout(timer));
}

// target: { host, port }. opts.resolve(host) gives a host name's addresses
// (main passes Chromium's resolver, which does not tie up Node's thread pool
// the way dns.lookup does while a name times out). Resolves to
// { online: true } or { online: false, error }.
async function probe({ host, port }, { timeout = TIMEOUT_MS, connect = net.connect, resolve } = {}) {
  let addresses = [host];
  if (!net.isIP(host)) {
    const found = await lookup(host, resolve, timeout);
    if (found === 'timeout') return { online: false, error: 'Name lookup timed out' };
    addresses = Array.isArray(found) ? found.slice(0, MAX_ADDRESSES) : [];
    if (!addresses.length) return { online: false, error: 'Host not found' };
  }
  // Every address at once; the first that answers settles it.
  const errors = await new Promise((settle) => {
    const out = [];
    let left = addresses.length;
    for (const a of addresses) {
      tryAddress(a, port, { timeout, connect }).then((error) => {
        if (error === null) return settle(null);
        out.push(error);
        if (--left === 0) settle(out);
      });
    }
  });
  return errors === null ? { online: true } : { online: false, error: errors[0] };
}

// targets: [{ id, host, port }]. Resolves to { [id]: probe result }; targets
// with the same host and port share one probe. opts.parallel gives the call
// a limit of its own instead of the shared one.
async function probeAll(targets, { parallel, ...opts } = {}) {
  const limit = parallel ? createLimiter(parallel) : shared;
  const byKey = new Map();
  for (const t of targets) {
    const key = `${t.host.toLowerCase()}:${t.port}`;
    if (!byKey.has(key)) byKey.set(key, { host: t.host, port: t.port, ids: [] });
    byKey.get(key).ids.push(t.id);
  }
  const out = Object.create(null);
  await Promise.all(
    [...byKey.values()].map(async (job) => {
      const result = await limit(() => probe(job, opts));
      for (const id of job.ids) out[id] = result;
    }),
  );
  return out;
}

// What a window may ask for: ids with a host name and a TCP port.
function validTargets(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    if (out.length >= MAX_TARGETS) break;
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id) continue;
    const host = typeof t.host === 'string' ? t.host.trim() : '';
    const port = Number(t.port);
    if (!host || host.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    out.push({ id: t.id, host, port });
  }
  return out;
}

module.exports = { probe, probeAll, validTargets, createLimiter, TIMEOUT_MS };
