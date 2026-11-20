// Repeat publish: the rates a message can be repeated at, and the loop that
// sends it. No DOM, so it runs in Node for tests.

export const RATES = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]; // Hz, offered in a menu
export const MIN_RATE = 0.01; // Hz: once every 100 s
export const MAX_RATE = 100; // Hz: every 10 ms

const PLAIN = /^(\d+\.?\d*|\.\d+)$/;

// A typed rate in Hz ("2", "0.5", ".5", or "0,5" with a decimal comma), or
// null when it isn't a plain number from MIN_RATE to MAX_RATE.
export function parseRate(text) {
  let t = typeof text === 'string' ? text.trim() : '';
  if (/^[^.,]*,[^.,]*$/.test(t)) t = t.replace(',', '.');
  if (!PLAIN.test(t)) return null;
  const hz = Number(t);
  return hz >= MIN_RATE && hz <= MAX_RATE ? hz : null;
}

export const formatRate = (hz) => String(Number(hz.toPrecision(6)));

const realTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id), now: () => performance.now() };

// Sends at once, then again at `rate` Hz until stopped. A send is never
// started before the previous one answered; the wait counts from the
// previous send's start. A failed send stops it.
//   send() -> Promise<{ ok, error? }>, onTick(count) after each sent message,
//   onStop(reason, error): 'stopped' (or the reason given to stop) or 'failed'.
export class Repeater {
  constructor({ send, onTick = () => {}, onStop = () => {}, timers = realTimers }) {
    Object.assign(this, { send, onTick, onStop, timers });
    this.running = false;
    this.count = 0;
    this.rate = 1;
    this.run = 0; // replies and timers of an earlier run are ignored
    this.timer = null;
  }

  // Starting again while running restarts it (no stop is reported).
  start(rate) {
    this.halt();
    this.running = true;
    this.count = 0;
    this.rate = rate;
    this.tick(++this.run);
  }

  // Takes effect at once: a send waiting to go is re-timed to the new rate,
  // counted from the last send's start.
  setRate(rate) {
    this.rate = rate;
    if (!this.running || this.timer === null) return;
    this.timers.clear(this.timer);
    const run = this.run;
    this.timer = this.timers.set(() => this.tick(run), Math.max(0, this.lastStart + 1000 / rate - this.timers.now()));
  }

  stop(reason = 'stopped', error) {
    if (!this.running) return;
    this.halt();
    this.onStop(reason, error);
  }

  halt() {
    this.running = false;
    this.run++;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  async tick(run) {
    this.timer = null;
    const started = (this.lastStart = this.timers.now());
    let res;
    try {
      res = await this.send();
    } catch (err) {
      res = { ok: false, error: err?.message || String(err) };
    }
    if (run !== this.run) return;
    if (!res?.ok) return this.stop('failed', res?.error);
    this.count++;
    this.onTick(this.count);
    if (run !== this.run) return; // stopped from onTick
    const wait = Math.max(0, 1000 / this.rate - (this.timers.now() - started));
    this.timer = this.timers.set(() => this.tick(run), wait);
  }
}
