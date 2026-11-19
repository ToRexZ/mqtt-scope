// repeat: the publisher's repeat rates and its send loop (fake clock).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RATES, parseRate, formatRate, Repeater } from '../../renderer/repeat.js';

const flush = () => new Promise((r) => setImmediate(r));

// Timers on a clock that only moves when told to.
function fakeTimers() {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => t,
    set: (fn, ms) => {
      pending.set(++seq, { at: t + ms, fn });
      return seq;
    },
    clear: (id) => pending.delete(id),
    pending: () => pending.size,
    async advance(ms) {
      const end = t + ms;
      await flush();
      for (;;) {
        const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        t = next[1].at;
        pending.delete(next[0]);
        next[1].fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

function setup({ send } = {}) {
  const timers = fakeTimers();
  const log = { sent: 0, ticks: [], stops: [] };
  const r = new Repeater({
    send: send ? () => (log.sent++, send(timers)) : async () => (log.sent++, { ok: true }),
    onTick: (n) => log.ticks.push(n),
    onStop: (reason, error) => log.stops.push([reason, error]),
    timers,
  });
  return { r, timers, log };
}

describe('rates', () => {
  test('presets', () => {
    assert.deepEqual(RATES, [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]);
  });
  test('parseRate: a plain number of Hz from 0.01 to 100', () => {
    for (const [text, hz] of [['1', 1], [' 2 ', 2], ['.5', 0.5], ['0.01', 0.01], ['100', 100], ['12.5', 12.5], ['3.', 3]]) assert.equal(parseRate(text), hz, text);
    for (const text of ['0', '-1', 'abc', '', '  ', '1e3', '100.5', '0.001', '0x10', '1,5', 'Infinity', null, undefined]) assert.equal(parseRate(text), null, String(text));
  });
  test('formatRate', () => {
    assert.equal(formatRate(0.5), '0.5');
    assert.equal(formatRate(10), '10');
    assert.equal(formatRate(1 / 3), '0.333333');
  });
});

describe('Repeater', () => {
  test('sends at once, then at the rate; counts what was sent', async () => {
    const { r, timers, log } = setup();
    r.start(10);
    assert.equal(r.running, true);
    await timers.advance(0);
    assert.deepEqual([log.sent, r.count], [1, 1]);
    await timers.advance(100);
    assert.equal(log.sent, 2);
    await timers.advance(300);
    assert.equal(log.sent, 5);
    assert.deepEqual(log.ticks, [1, 2, 3, 4, 5]);
    r.stop();
    assert.deepEqual(log.stops, [['stopped', undefined]]);
    await timers.advance(1000);
    assert.equal(log.sent, 5);
    assert.equal(timers.pending(), 0);
    r.stop();
    assert.equal(log.stops.length, 1, 'stopping twice reports once');
  });

  test('a slow send is never overlapped: the next one waits for it', async () => {
    let inFlight = 0;
    let most = 0;
    const { r, timers, log } = setup({
      send: (t) =>
        new Promise((res) => {
          most = Math.max(most, ++inFlight);
          t.set(() => {
            inFlight--;
            res({ ok: true });
          }, 250);
        }),
    });
    r.start(10);
    await timers.advance(900);
    assert.equal(most, 1);
    assert.equal(log.sent, 4, 'one send per 250 ms: at 0, 250, 500, 750');
    r.stop();
  });

  test('stopping while a send is out: its reply neither counts nor schedules', async () => {
    const replies = [];
    const { r, timers, log } = setup({ send: () => new Promise((res) => replies.push(res)) });
    r.start(10);
    await timers.advance(0);
    r.stop();
    replies[0]({ ok: true });
    await timers.advance(1000);
    assert.deepEqual([log.sent, r.count, timers.pending()], [1, 0, 0]);
    assert.deepEqual(log.stops, [['stopped', undefined]]);
  });

  test('a failed send stops it with the error', async () => {
    const { r, timers, log } = setup({ send: async () => ({ ok: false, error: 'not authorized' }) });
    r.start(50);
    await timers.advance(1000);
    assert.equal(log.sent, 1);
    assert.equal(r.running, false);
    assert.deepEqual(log.stops, [['failed', 'not authorized']]);
  });

  test('a send that throws stops it too', async () => {
    const { r, timers, log } = setup({ send: async () => Promise.reject(new Error('gone')) });
    r.start(1);
    await timers.advance(0);
    assert.deepEqual(log.stops, [['failed', 'gone']]);
  });

  test('start, stop, start: the first run has no effect on the second', async () => {
    const replies = [];
    const { r, timers } = setup({ send: () => new Promise((res) => replies.push(res)) });
    r.start(10);
    await timers.advance(0);
    r.stop();
    r.start(10);
    await timers.advance(0);
    replies[0]({ ok: true }); // the first run's late reply
    await timers.advance(0);
    assert.deepEqual([r.count, timers.pending()], [0, 0]);
    replies[1]({ ok: true });
    await timers.advance(0);
    assert.equal(r.count, 1);
    assert.equal(timers.pending(), 1);
    r.stop();
  });

  test('a new rate applies from the next message', async () => {
    const { r, timers, log } = setup();
    r.start(10);
    await timers.advance(0);
    r.setRate(1);
    await timers.advance(100);
    assert.equal(log.sent, 2, 'the wait already set still runs out');
    await timers.advance(500);
    assert.equal(log.sent, 2);
    await timers.advance(500);
    assert.equal(log.sent, 3);
    r.stop();
  });

  test('stop with a reason', async () => {
    const { r, timers, log } = setup();
    r.start(1);
    await timers.advance(0);
    r.stop('disconnected');
    assert.deepEqual(log.stops, [['disconnected', undefined]]);
  });
});
