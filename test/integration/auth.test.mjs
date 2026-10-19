// Username/password authentication against the broker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBroker, until, sleep } from '../helpers/broker.mjs';
import { recorder } from './_session.mjs';

async function authBroker(t) {
  const broker = await startBroker({ users: { alice: 's3cret', 'zoë': 'pä$$wörd' } });
  t.after(() => broker.close());
  const seen = []; // [username, password] per authentication attempt
  const orig = broker.aedes.authenticate;
  broker.aedes.authenticate = (client, username, password, done) => {
    seen.push([username, password?.toString()]);
    orig(client, username, password, done);
  };
  return { broker, seen };
}

test('correct username/password connects', async (t) => {
  const { broker, seen } = await authBroker(t);
  const rec = recorder(t);
  rec.s.connect({ host: '127.0.0.1', port: broker.port, username: 'alice', password: 's3cret' });
  await rec.waitState('connected');
  assert.deepEqual(seen, [['alice', 's3cret']]);
  assert.deepEqual(rec.states(), ['connecting', 'connected']);
});

test('non-ASCII credentials are sent as UTF-8', async (t) => {
  const { broker, seen } = await authBroker(t);
  const rec = recorder(t);
  rec.s.connect({ host: '127.0.0.1', port: broker.port, username: 'zoë', password: 'pä$$wörd' });
  await rec.waitState('connected');
  assert.deepEqual(seen, [['zoë', 'pä$$wörd']]);
});

test('wrong password → error status with a not-authorized style message, and no reconnect hammering', async (t) => {
  const { broker, seen } = await authBroker(t);
  const rec = recorder(t, { reconnectPeriod: 100 }); // a retry loop would make ~20 attempts in 2 s
  const url = `mqtt://127.0.0.1:${broker.port}`;
  rec.s.connect({ host: '127.0.0.1', port: broker.port, username: 'alice', password: 'wrong' });
  await rec.waitState('error');
  assert.deepEqual(rec.statuses.at(-1), { state: 'error', url, error: 'Connection refused: Bad username or password' });
  await sleep(2000);
  t.diagnostic(`auth attempts in ~2s with reconnectPeriod 100ms: ${seen.length}`);
  assert.ok(seen.length <= 2, `session re-sent bad credentials ${seen.length} times in 2 s`);
  assert.equal(rec.s.status.state, 'error', 'error stays visible (not overwritten by close/offline)');
  assert.ok(!rec.states().includes('connected'));
  assert.equal(rec.s.connected, false);
});

test('missing credentials on an auth-required broker → error', async (t) => {
  const { broker, seen } = await authBroker(t);
  const rec = recorder(t);
  rec.s.connect({ host: '127.0.0.1', port: broker.port });
  await rec.waitState('error');
  assert.match(rec.s.status.error, /Bad username or password|Not authorized/i);
  assert.deepEqual(seen, [[undefined, undefined]]);
});

test('empty username/password strings are omitted from CONNECT', async (t) => {
  const { broker, seen } = await authBroker(t);
  const rec = recorder(t);
  rec.s.connect({ host: '127.0.0.1', port: broker.port, username: '', password: '' });
  await rec.waitState('error');
  assert.deepEqual(seen, [[undefined, undefined]]);
});

test('broker returning "Not authorized" (rc 5) is reported as such', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  broker.aedes.authenticate = (client, username, password, done) => {
    const err = new Error('nope');
    err.returnCode = 5;
    done(err, false);
  };
  const rec = recorder(t);
  rec.s.connect({ host: '127.0.0.1', port: broker.port, username: 'bob', password: 'x' });
  await rec.waitState('error');
  assert.equal(rec.s.status.error, 'Connection refused: Not authorized');
});

test('after an auth failure, reconnecting with the right password works', async (t) => {
  const { broker } = await authBroker(t);
  const rec = recorder(t);
  rec.s.connect({ host: '127.0.0.1', port: broker.port, username: 'alice', password: 'wrong' });
  await rec.waitState('error');
  rec.s.connect({ host: '127.0.0.1', port: broker.port, username: 'alice', password: 's3cret' });
  await rec.waitState('connected');
  await until(() => broker.aedes.connectedClients === 1, { message: 'exactly one live client' });
});
