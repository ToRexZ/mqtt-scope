import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireFromRoot } from './_util.mjs';

const { createProfileStore, sanitize, defaultProfiles } = requireFromRoot('./main/profileStore.js');

// Reversible fake of Electron safeStorage.
function fakeCipher({ available = true } = {}) {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isAvailable: () => available,
    encrypt(s) {
      calls.encrypt++;
      return Buffer.from(`enc:${s}`, 'utf8');
    },
    decrypt(buf) {
      calls.decrypt++;
      const s = buf.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext');
      return s.slice(4);
    },
  };
}

const full = (extra = {}) => ({
  id: 'p1',
  name: 'Prod',
  protocol: 'mqtts',
  host: 'broker.example',
  port: 8883,
  wsPath: '/mqtt',
  clientId: 'cid',
  username: 'user',
  password: 's3cret',
  mqttVersion: 5,
  clean: false,
  keepalive: 30,
  rejectUnauthorized: true,
  caFile: '/ca.pem',
  certFile: '/cert.pem',
  keyFile: '/key.pem',
  subscriptions: [{ topic: '#', qos: 1 }],
  ...extra,
});

let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttscope-profiles-'));
  file = path.join(dir, 'profiles.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const readJson = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const backups = () => fs.readdirSync(dir).filter((f) => f.startsWith('profiles.json.corrupt-'));

describe('sanitize', () => {
  test('non-objects and profiles without id/name are rejected', () => {
    for (const p of [null, undefined, 1, 'x', true]) assert.equal(sanitize(p), null);
    assert.equal(sanitize({}), null);
    assert.equal(sanitize({ id: 'a' }), null);
    assert.equal(sanitize({ name: 'a' }), null);
    assert.equal(sanitize({ id: '', name: 'a' }), null);
    assert.equal(sanitize({ id: 'a', name: '' }), null);
    assert.equal(sanitize({ id: 1, name: 'a' }), null, 'id must be a string');
  });

  test('keeps known fields with correct types', () => {
    assert.deepEqual(sanitize(full()), full());
  });

  test('drops unknown fields and wrongly typed values', () => {
    const out = sanitize({
      id: 'a',
      name: 'n',
      evil: '<script>',
      passwordEnc: 'xx',
      passwordLost: true,
      host: 42,
      clean: 'false',
      rejectUnauthorized: 0,
      username: null,
      caFile: ['x'],
    });
    assert.deepEqual(out, { id: 'a', name: 'n', subscriptions: [] });
  });

  test('coerces numeric strings for number fields; drops non-finite', () => {
    const out = sanitize({ id: 'a', name: 'n', port: '1883', mqttVersion: ' 5 ', keepalive: '0' });
    assert.equal(out.port, 1883);
    assert.equal(out.mqttVersion, 5);
    assert.equal(out.keepalive, 0);
    for (const port of ['', '  ', 'abc', NaN, Infinity, -Infinity, '1e999', null, true]) {
      assert.equal('port' in sanitize({ id: 'a', name: 'n', port }), false, String(port));
    }
  });

  test('normalizes subscriptions', () => {
    const out = sanitize({
      id: 'a',
      name: 'n',
      subscriptions: [
        { topic: 'a', qos: 1 },
        { topic: 'b', qos: '2' },
        { topic: 'c', qos: 3 },
        { topic: 'd', qos: -1 },
        { topic: 'e' },
        { topic: 'f', qos: 'x', extra: 1 },
        { topic: '' },
        { topic: 5 },
        null,
        'g',
        { qos: 1 },
      ],
    });
    assert.deepEqual(out.subscriptions, [
      { topic: 'a', qos: 1 },
      { topic: 'b', qos: 2 },
      { topic: 'c', qos: 0 },
      { topic: 'd', qos: 0 },
      { topic: 'e', qos: 0 },
      { topic: 'f', qos: 0 },
    ]);
    assert.deepEqual(sanitize({ id: 'a', name: 'n', subscriptions: 'x' }).subscriptions, []);
  });

  test('does not mutate its input', () => {
    const p = full({ port: '1883', extra: 1 });
    const copy = structuredClone(p);
    sanitize(p);
    assert.deepEqual(p, copy);
  });
});

describe('load', () => {
  test('missing file gives the default profiles and no backup', () => {
    const store = createProfileStore({ file, cipher: fakeCipher() });
    assert.deepEqual(store.load(), defaultProfiles());
    assert.deepEqual(backups(), []);
  });

  test('default profiles are fresh copies', () => {
    const a = defaultProfiles();
    a[0].subscriptions.push({ topic: 'x', qos: 0 });
    assert.equal(defaultProfiles()[0].subscriptions.length, 2);
    assert.deepEqual(defaultProfiles()[0], {
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
    });
  });

  test('corrupt JSON gives defaults and keeps a .corrupt-<timestamp> backup', () => {
    fs.writeFileSync(file, '[{"id": "a", "name": ');
    const before = Date.now();
    const store = createProfileStore({ file, cipher: fakeCipher() });
    assert.deepEqual(store.load(), defaultProfiles());
    const b = backups();
    assert.equal(b.length, 1);
    const m = /^profiles\.json\.corrupt-(\d+)$/.exec(b[0]);
    assert.ok(m, b[0]);
    const ts = Number(m[1]);
    assert.ok(ts >= before && ts <= Date.now() + 1000);
    assert.equal(fs.readFileSync(path.join(dir, b[0]), 'utf8'), '[{"id": "a", "name": ');
    assert.ok(fs.existsSync(file), 'original is left in place');
  });

  test('empty file is treated as corrupt', () => {
    fs.writeFileSync(file, '');
    assert.deepEqual(createProfileStore({ file, cipher: null }).load(), defaultProfiles());
    assert.equal(backups().length, 1);
  });

  test('non-array JSON gives defaults', () => {
    for (const content of ['{}', '{"id":"a","name":"b"}', 'null', '42', '"str"']) {
      fs.writeFileSync(file, content);
      assert.deepEqual(createProfileStore({ file, cipher: null }).load(), defaultProfiles(), content);
    }
  });

  test('an empty array is respected (user deleted every profile)', () => {
    fs.writeFileSync(file, '[]');
    assert.deepEqual(createProfileStore({ file, cipher: null }).load(), []);
  });

  test('invalid entries are dropped, valid ones sanitized', () => {
    fs.writeFileSync(file, JSON.stringify([null, 5, { id: 'x' }, { id: 'a', name: 'A', port: '1884', junk: true }]));
    assert.deepEqual(createProfileStore({ file, cipher: null }).load(), [{ id: 'a', name: 'A', port: 1884, subscriptions: [] }]);
  });

  test('passwordEnc is decrypted; it wins over a stray plaintext password', () => {
    fs.writeFileSync(
      file,
      JSON.stringify([{ id: 'a', name: 'A', password: 'stale', passwordEnc: Buffer.from('enc:pw').toString('base64') }]),
    );
    const [p] = createProfileStore({ file, cipher: fakeCipher() }).load();
    assert.equal(p.password, 'pw');
    assert.equal('passwordEnc' in p, false);
    assert.equal('passwordLost' in p, false);
  });

  test('decrypt failure gives an empty password and passwordLost', () => {
    fs.writeFileSync(file, JSON.stringify([{ id: 'a', name: 'A', passwordEnc: Buffer.from('garbage').toString('base64') }]));
    const [p] = createProfileStore({ file, cipher: fakeCipher() }).load();
    assert.equal(p.password, '');
    assert.equal(p.passwordLost, true);
  });

  test('passwordEnc without any cipher is reported lost, not thrown', () => {
    fs.writeFileSync(file, JSON.stringify([{ id: 'a', name: 'A', passwordEnc: 'abc' }]));
    const [p] = createProfileStore({ file, cipher: null }).load();
    assert.equal(p.password, '');
    assert.equal(p.passwordLost, true);
  });

  test('non-string passwordEnc is ignored', () => {
    fs.writeFileSync(file, JSON.stringify([{ id: 'a', name: 'A', password: 'plain', passwordEnc: 5 }]));
    const [p] = createProfileStore({ file, cipher: fakeCipher() }).load();
    assert.equal(p.password, 'plain');
  });
});

describe('save', () => {
  test('rejects non-arrays', () => {
    const store = createProfileStore({ file, cipher: null });
    for (const v of [null, {}, 'x', undefined]) assert.throws(() => store.save(v), { message: 'Profiles must be an array' });
    assert.equal(fs.existsSync(file), false);
  });

  test('sanitizes, coerces and drops invalid profiles', () => {
    const store = createProfileStore({ file, cipher: null });
    const res = store.save([
      { id: 'a', name: 'A', port: '1885', extra: { deep: 1 }, subscriptions: [{ topic: 't', qos: '1', x: 1 }, { topic: 'u', qos: 9 }] },
      { id: 'b' },
      { name: 'no id' },
      null,
    ]);
    assert.deepEqual(res, { ok: true, count: 1, encrypted: false });
    assert.deepEqual(readJson(), [
      {
        id: 'a',
        name: 'A',
        port: 1885,
        subscriptions: [
          { topic: 't', qos: 1 },
          { topic: 'u', qos: 0 },
        ],
      },
    ]);
  });

  test('passwords are encrypted when the cipher is available and never stored in plaintext', () => {
    const cipher = fakeCipher();
    const store = createProfileStore({ file, cipher });
    const res = store.save([full(), full({ id: 'p2', password: '' })]);
    assert.deepEqual(res, { ok: true, count: 2, encrypted: true });
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('s3cret'));
    const [a, b] = JSON.parse(raw);
    assert.equal('password' in a, false);
    assert.equal(a.passwordEnc, Buffer.from('enc:s3cret').toString('base64'));
    assert.equal('passwordEnc' in b, false, 'empty passwords are not encrypted');
    assert.equal(cipher.calls.encrypt, 1);
    assert.deepEqual(store.load(), [full(), full({ id: 'p2', password: '' })]);
  });

  test('passwords are stored in plaintext when encryption is unavailable', () => {
    for (const cipher of [null, undefined, fakeCipher({ available: false }), { isAvailable: () => { throw new Error('no keyring'); } }]) {
      const store = createProfileStore({ file, cipher });
      assert.equal(store.canEncrypt(), false);
      const res = store.save([full()]);
      assert.equal(res.encrypted, false);
      const [p] = readJson();
      assert.equal(p.password, 's3cret');
      assert.equal('passwordEnc' in p, false);
      assert.equal(store.load()[0].password, 's3cret');
    }
  });

  test('a password that could not be decrypted survives saving until a new one is typed', () => {
    const enc = Buffer.from('enc:secret').toString('base64');
    fs.writeFileSync(file, JSON.stringify([{ id: 'a', name: 'A', passwordEnc: enc }]));
    // Keyring locked at startup: decrypt fails, the UI gets passwordLost.
    const locked = { ...fakeCipher(), decrypt: () => { throw new Error('locked'); } };
    const store = createProfileStore({ file, cipher: locked });
    const [p] = store.load();
    assert.equal(p.passwordLost, true);
    // Saving (e.g. on close, or after editing another field) keeps the stored secret.
    store.save([{ ...p, name: 'A renamed' }]);
    assert.equal(readJson()[0].passwordEnc, enc);
    assert.equal(readJson()[0].name, 'A renamed');
    // Once the keyring is back the password decrypts again.
    assert.equal(createProfileStore({ file, cipher: fakeCipher() }).load()[0].password, 'secret');
    // Typing a new password replaces it (the UI drops passwordLost).
    store.save([{ id: 'a', name: 'A', password: 'new' }]);
    assert.equal(Buffer.from(readJson()[0].passwordEnc, 'base64').toString(), 'enc:new');
  });

  test('a lost password is not resurrected for a different profile id', () => {
    const enc = Buffer.from('enc:secret').toString('base64');
    fs.writeFileSync(file, JSON.stringify([{ id: 'a', name: 'A', passwordEnc: enc }]));
    const store = createProfileStore({ file, cipher: fakeCipher() });
    store.save([{ id: 'b', name: 'B', password: '', passwordLost: true }]);
    assert.equal('passwordEnc' in readJson()[0], false);
  });

  test('passwordLost and passwordEnc fields from callers are not persisted', () => {
    const store = createProfileStore({ file, cipher: fakeCipher() });
    store.save([full({ password: '', passwordLost: true, passwordEnc: 'forged' })]);
    const [p] = readJson();
    assert.equal('passwordLost' in p, false);
    assert.equal('passwordEnc' in p, false);
  });

  test('save then load round-trips a full profile', () => {
    const store = createProfileStore({ file, cipher: fakeCipher() });
    store.save([full(), full({ id: 'p2', name: 'Two', protocol: 'ws', wsPath: '/ws', subscriptions: [] })]);
    assert.deepEqual(store.load(), [full(), full({ id: 'p2', name: 'Two', protocol: 'ws', wsPath: '/ws', subscriptions: [] })]);
  });

  test('atomic write: no .tmp left behind, file mode 0600, parent dirs created', () => {
    const nested = path.join(dir, 'a', 'b', 'profiles.json');
    const store = createProfileStore({ file: nested, cipher: null });
    store.save([full()]);
    assert.ok(fs.existsSync(nested));
    assert.equal(fs.existsSync(`${nested}.tmp`), false);
    assert.deepEqual(fs.readdirSync(path.dirname(nested)), ['profiles.json']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(nested).mode & 0o777, 0o600);
  });

  test('overwriting a world-readable file leaves it 0600', { skip: process.platform === 'win32' }, () => {
    fs.writeFileSync(file, '[]', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    createProfileStore({ file, cipher: null }).save([full()]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  test('saving after a corrupt load replaces the file but keeps the backup', () => {
    fs.writeFileSync(file, 'not json');
    const store = createProfileStore({ file, cipher: null });
    store.load();
    store.save([full()]);
    assert.equal(readJson().length, 1);
    assert.equal(backups().length, 1);
  });
});
