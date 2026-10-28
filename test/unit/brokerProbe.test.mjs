// brokerProbe: whether a broker's host and port take a TCP connection. Real
// sockets on 127.0.0.1; host names go through a fake resolver.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { requireFromRoot } from './_util.mjs';

const { probe, probeAll, validTargets, createLimiter } = requireFromRoot('./main/brokerProbe.js');

async function listening() {
  const sockets = [];
  let closed = 0;
  const srv = net.createServer((s) => {
    sockets.push(s);
    s.on('close', () => closed++);
    s.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    accepted: () => sockets.length,
    closed: () => closed,
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      srv.close(r);
    }),
  };
}

async function closedPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const noResolve = () => assert.fail('an IP address is not resolved');

test('a listening port is online, and the probe closes its socket', async () => {
  const srv = await listening();
  try {
    assert.deepEqual(await probe({ host: '127.0.0.1', port: srv.port }, { resolve: noResolve }), { online: true });
    assert.equal(srv.accepted(), 1);
    for (let i = 0; i < 100 && !srv.closed(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(srv.closed(), 1, 'the broker sees the connection close');
  } finally {
    await srv.close();
  }
});

test('a closed port is offline with the reason', async () => {
  const port = await closedPort();
  const r = await probe({ host: '127.0.0.1', port }, { resolve: noResolve });
  assert.equal(r.online, false);
  assert.match(r.error, /refused/i);
});

test('no answer within the timeout is offline', async () => {
  // A connect that never completes.
  const connect = () => Object.assign(new net.Socket(), { setNoDelay() {} });
  const t0 = Date.now();
  const r = await probe({ host: '10.255.255.1', port: 1883 }, { timeout: 80, connect, resolve: noResolve });
  assert.equal(r.online, false);
  assert.match(r.error, /no answer/i);
  assert.ok(Date.now() - t0 < 1000);
});

test('a host name is resolved first; any of its addresses that answers counts', async () => {
  const srv = await listening();
  const closed = await closedPort();
  try {
    const asked = [];
    const resolve = async (host) => {
      asked.push(host);
      return ['::1', '127.0.0.1'];
    };
    // Nothing listens on ::1 (refused, or no IPv6 at all); 127.0.0.1 answers.
    const r = await probe({ host: 'broker.test', port: srv.port }, { resolve });
    assert.deepEqual(r, { online: true });
    assert.deepEqual(asked, ['broker.test']);
    const off = await probe({ host: 'broker.test', port: closed }, { resolve: async () => ['127.0.0.1'] });
    assert.equal(off.online, false);
  } finally {
    await srv.close();
  }
});

test('a host name that does not resolve is offline', async () => {
  const resolve = async () => {
    throw Object.assign(new Error('net::ERR_NAME_NOT_RESOLVED'), {});
  };
  const r = await probe({ host: 'nowhere.invalid', port: 1883 }, { resolve });
  assert.deepEqual(r, { online: false, error: 'Host not found' });
  assert.deepEqual(await probe({ host: 'empty.test', port: 1883 }, { resolve: async () => [] }), { online: false, error: 'Host not found' });
});

test('a name lookup that takes too long is offline, after the timeout', async () => {
  const t0 = Date.now();
  const r = await probe({ host: 'slow.test', port: 1883 }, { timeout: 80, resolve: () => new Promise(() => {}) });
  assert.deepEqual(r, { online: false, error: 'Name lookup timed out' });
  assert.ok(Date.now() - t0 < 1000);
});

test('a connect that throws is offline, not a hang', async () => {
  const connect = () => {
    throw new Error('bad address');
  };
  assert.deepEqual(await probe({ host: '127.0.0.1', port: 1883 }, { connect, resolve: noResolve }), { online: false, error: 'bad address' });
});

test('probeAll answers by id and probes each host and port once', async () => {
  const srv = await listening();
  const closed = await closedPort();
  try {
    const out = await probeAll(
      [
        { id: 'a', host: '127.0.0.1', port: srv.port },
        { id: 'b', host: '127.0.0.1', port: srv.port },
        { id: 'c', host: '127.0.0.1', port: closed },
      ],
      { resolve: noResolve },
    );
    assert.deepEqual(Object.keys(out).sort(), ['a', 'b', 'c']);
    assert.equal(out.a.online, true);
    assert.equal(out.b.online, true);
    assert.equal(out.c.online, false);
    assert.equal(srv.accepted(), 1);
  } finally {
    await srv.close();
  }
});

test('probeAll runs a limited number of probes at once', async () => {
  let running = 0;
  let most = 0;
  const connect = () => {
    const s = new net.Socket();
    running++;
    most = Math.max(most, running);
    setTimeout(() => {
      running--;
      s.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    }, 5);
    return s;
  };
  const targets = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, host: '127.0.0.1', port: 1000 + i }));
  const out = await probeAll(targets, { connect, resolve: noResolve, parallel: 6 });
  assert.equal(Object.keys(out).length, 40);
  assert.ok(most <= 6, `at most 6 at once, saw ${most}`);
});

test('without a limit of its own, probeAll shares one limit of 16 with every other call', async () => {
  let running = 0;
  let most = 0;
  const connect = () => {
    const s = new net.Socket();
    running++;
    most = Math.max(most, running);
    setTimeout(() => {
      running--;
      s.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    }, 5);
    return s;
  };
  const call = (n) => probeAll(Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, host: '127.0.0.1', port: 2000 + n * 100 + i })), { connect, resolve: noResolve });
  const out = await Promise.all([call(0), call(1), call(2)]);
  assert.deepEqual(out.map((o) => Object.keys(o).length), [20, 20, 20]);
  assert.ok(most <= 16, `at most 16 at once, saw ${most}`);
  assert.ok(most > 6, 'the calls do run in parallel');
});

test('createLimiter runs the next function when one settles, also when it throws', async () => {
  const limit = createLimiter(1);
  const order = [];
  const a = limit(async () => {
    order.push('a');
    throw new Error('x');
  });
  const b = limit(async () => order.push('b'));
  const [ra] = await Promise.allSettled([a, b]);
  assert.equal(ra.status, 'rejected');
  assert.deepEqual(order, ['a', 'b']);
});

test('createLimiter runs one given first before those waiting', async () => {
  const limit = createLimiter(1);
  const order = [];
  let release;
  const blocker = limit(() => new Promise((r) => (release = r)));
  const queued = ['q1', 'q2'].map((n) => limit(async () => order.push(n)));
  const urgent = limit(async () => order.push('urgent'), { first: true });
  await new Promise((r) => setImmediate(r)); // the blocker has started
  release();
  await Promise.all([blocker, ...queued, urgent]);
  assert.deepEqual(order, ['urgent', 'q1', 'q2']);
});

test('an id named __proto__ is kept', async () => {
  const out = await probeAll([{ id: '__proto__', host: 'nowhere.test', port: 1 }], { resolve: async () => [] });
  assert.deepEqual(Object.keys(out), ['__proto__']);
});

test('validTargets keeps well-formed targets only, and at most 500', () => {
  const ok = { id: 'a', host: ' broker.local ', port: 1883 };
  assert.deepEqual(validTargets([ok]), [{ id: 'a', host: 'broker.local', port: 1883 }]);
  assert.deepEqual(validTargets([{ id: 'b', host: 'h', port: '8883' }]), [{ id: 'b', host: 'h', port: 8883 }]);
  for (const bad of [null, 'x', { id: 'a', host: '', port: 1883 }, { id: 'a', host: 'h', port: 0 }, { id: 'a', host: 'h', port: 70000 }, { id: 'a', host: 'h', port: 1.5 }, { host: 'h', port: 1883 }, { id: 'a', host: 'h'.repeat(300), port: 1 }]) {
    assert.deepEqual(validTargets([bad]), [], JSON.stringify(bad));
  }
  assert.deepEqual(validTargets('nope'), []);
  assert.equal(validTargets(Array.from({ length: 600 }, (_, i) => ({ id: `p${i}`, host: 'h', port: 1 }))).length, 500);
});
