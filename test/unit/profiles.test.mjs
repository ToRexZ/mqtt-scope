import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { blankProfile, parseSubscriptions, formatSubscriptions, DEFAULT_PORTS, newId } from '../../renderer/profiles.js';
import { prng } from './_util.mjs';

describe('blankProfile', () => {
  test('defaults', () => {
    const p = blankProfile();
    assert.match(p.id, /^[0-9a-z]{1,8}$/);
    const { id, ...rest } = p;
    assert.deepEqual(rest, {
      name: 'New connection',
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
      subscriptions: [
        { topic: '#', qos: 0 },
        { topic: '$SYS/#', qos: 0 },
      ],
    });
  });

  test('custom name', () => {
    assert.equal(blankProfile('Prod').name, 'Prod');
  });

  test('default port matches DEFAULT_PORTS for its protocol', () => {
    const p = blankProfile();
    assert.equal(p.port, DEFAULT_PORTS[p.protocol]);
  });

  test('each profile gets fresh, unshared subscription objects and ids', () => {
    const a = blankProfile();
    const b = blankProfile();
    assert.notEqual(a.subscriptions, b.subscriptions);
    assert.notEqual(a.subscriptions[0], b.subscriptions[0]);
    a.subscriptions[0].qos = 2;
    a.subscriptions.push({ topic: 'x', qos: 1 });
    assert.deepEqual(blankProfile().subscriptions, [
      { topic: '#', qos: 0 },
      { topic: '$SYS/#', qos: 0 },
    ]);
    assert.notEqual(a.id, b.id);
  });

  test('newId is short and alphanumeric', () => {
    const ids = new Set(Array.from({ length: 200 }, newId));
    for (const id of ids) assert.match(id, /^[0-9a-z]{1,8}$/);
    assert.ok(ids.size > 190);
  });
});

describe('DEFAULT_PORTS', () => {
  test('well-known ports', () => {
    assert.deepEqual(DEFAULT_PORTS, { mqtt: 1883, mqtts: 8883, ws: 9001, wss: 443 });
  });
});

describe('parseSubscriptions', () => {
  test('one topic per line, qos suffix optional', () => {
    assert.deepEqual(parseSubscriptions('a/b\nc/# 1\n+/d 2\ne 0'), [
      { topic: 'a/b', qos: 0 },
      { topic: 'c/#', qos: 1 },
      { topic: '+/d', qos: 2 },
      { topic: 'e', qos: 0 },
    ]);
  });

  test('blank lines, surrounding whitespace, CRLF and tabs', () => {
    assert.deepEqual(parseSubscriptions('\n  a  \r\n\n\t b\t2 \r\n   \n'), [
      { topic: 'a', qos: 0 },
      { topic: 'b', qos: 2 },
    ]);
    assert.deepEqual(parseSubscriptions(''), []);
    assert.deepEqual(parseSubscriptions('\n\n  \n'), []);
  });

  test('several spaces before the qos', () => {
    assert.deepEqual(parseSubscriptions('a    1'), [{ topic: 'a', qos: 1 }]);
  });

  test('an invalid qos digit stays part of the topic', () => {
    assert.deepEqual(parseSubscriptions('a 3'), [{ topic: 'a 3', qos: 0 }]);
    assert.deepEqual(parseSubscriptions('a 12'), [{ topic: 'a 12', qos: 0 }]);
  });

  test('a lone digit is a topic, not a qos', () => {
    assert.deepEqual(parseSubscriptions('1'), [{ topic: '1', qos: 0 }]);
    assert.deepEqual(parseSubscriptions('sensors/1'), [{ topic: 'sensors/1', qos: 0 }]);
  });

  test('topics with inner spaces', () => {
    assert.deepEqual(parseSubscriptions('living room/temp'), [{ topic: 'living room/temp', qos: 0 }]);
    assert.deepEqual(parseSubscriptions('living room/temp 1'), [{ topic: 'living room/temp', qos: 1 }]);
  });
});

describe('formatSubscriptions', () => {
  test('qos 0 is omitted, others appended', () => {
    assert.equal(
      formatSubscriptions([
        { topic: 'a', qos: 0 },
        { topic: 'b', qos: 1 },
        { topic: 'c', qos: 2 },
        { topic: 'd' },
      ]),
      'a\nb 1\nc 2\nd',
    );
  });

  test('null/undefined/empty', () => {
    assert.equal(formatSubscriptions(null), '');
    assert.equal(formatSubscriptions(undefined), '');
    assert.equal(formatSubscriptions([]), '');
  });
});

describe('round-trip', () => {
  const roundTrip = (subs) => assert.deepEqual(parseSubscriptions(formatSubscriptions(subs)), subs, JSON.stringify(subs));

  test('typical subscriptions', () => {
    roundTrip([
      { topic: '#', qos: 0 },
      { topic: '$SYS/#', qos: 0 },
      { topic: 'a/+/c', qos: 1 },
      { topic: 'x/y', qos: 2 },
      { topic: 'living room/temp', qos: 1 },
    ]);
  });

  test('property: random topics without trailing " <digit>"', () => {
    const r = prng(3);
    const pieces = ['a', 'b', '/', '+', '#', '$', ' x', 'é', '1', '0'];
    for (let i = 0; i < 1000; i++) {
      const subs = Array.from({ length: r.int(0, 5) }, () => {
        let t = Array.from({ length: r.int(1, 5) }, () => r.pick(pieces)).join('').trim();
        if (!t) t = 'a';
        if (/\s[012]$/.test(t)) t += 'z';
        return { topic: t, qos: r.int(0, 2) };
      });
      roundTrip(subs);
    }
  });

  test('a qos-0 topic whose last word is 0, 1 or 2 survives the round-trip', () => {
    // MQTT topics may contain spaces: "room 1" at qos 0 must not become "room" at qos 1.
    roundTrip([{ topic: 'room 1', qos: 0 }]);
    roundTrip([{ topic: 'floor 2', qos: 0 }]);
  });

  test('a qos>0 topic ending in " <digit>" round-trips', () => {
    roundTrip([{ topic: 'room 1', qos: 2 }]);
  });
});
