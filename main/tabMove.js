'use strict';

// Moving a tab, with its connection, from one main window to another. The
// connection stays open: its events are held in the registry meanwhile and
// delivered, in order, to the window that has the tab afterwards. The tab's
// state goes from the window it leaves through main to the one it joins:
//
//   hold → tab:export to the source (it answers with the tab's state, and the
//   tab goes from it once that answer is sent; one that cannot be sent fails
//   the move, the tab still there) → tab:import to the target (it answers
//   once the tab is built) → the connection and its pop-outs belong to the
//   target → release
//
// A step that fails, a window that takes longer than timeoutMs or one that
// starts closing gives the tab back to the window it came from, at its place
// there. main.js wires this to Electron; no Electron dependency, so it can be
// tested under plain Node.

const TIMEOUT_MS = 10000;

// Requests main makes of a window's renderer, which answers on tab:reply with
// the same reqId: { reqId, result } or { reqId, error }. An answer is awaited
// however long it takes; a window that goes away fails its requests.
class Requests {
  // send(windowId, channel, message): false when there is no such window.
  constructor(send) {
    this._send = send;
    this._pending = new Map(); // reqId -> { windowId, resolve, reject }
    this._last = 0;
  }

  ask(windowId, channel, data) {
    const reqId = ++this._last;
    return new Promise((resolve, reject) => {
      this._pending.set(reqId, { windowId, resolve, reject });
      if (this._send(windowId, channel, { ...data, reqId })) return;
      this._pending.delete(reqId);
      reject(new Error('The window is closed'));
    });
  }

  // Taken from the window that was asked only.
  answer(windowId, reply) {
    const p = this._pending.get(reply?.reqId);
    if (!p || p.windowId !== windowId) return;
    this._pending.delete(reply.reqId);
    if ('error' in reply) p.reject(new Error(String(reply.error)));
    else p.resolve(reply.result);
  }

  // The window closed, crashed or reloaded: it will not answer.
  windowGone(windowId) {
    for (const [reqId, p] of this._pending) {
      if (p.windowId !== windowId) continue;
      this._pending.delete(reqId);
      p.reject(new Error('The window closed'));
    }
  }
}

class TabMover {
  // registry: the ConnectionRegistry. ask(windowId, channel, data): a
  // window's answer (Requests.ask). isWindow(id): a main window is open and
  // not closing. setOwner(connId, windowId): the connection and its pop-outs
  // belong to that window (null: to none, while the tab is between windows).
  // closeConnection(connId). left(windowId, out): a move from or to the
  // window ended, out: a tab went out of it; main closes a window that tabs
  // going out left without connections.
  constructor({ registry, ask, isWindow, setOwner, closeConnection, left, timeoutMs = TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { registry, ask, isWindow, setOwner, closeConnection, left, timeoutMs, setTimer, clearTimer });
    this.moves = new Map(); // connId -> { from, to }
  }

  moving(connId) {
    return this.moves.has(connId);
  }

  // Whether a tab is on its way from or to the window.
  busy(windowId) {
    for (const { from, to } of this.moves.values()) if (from === windowId || to === windowId) return true;
    return false;
  }

  // Resolves with whether the tab moved to window `to`, at `index` in its
  // strip (0 for anything but a whole number from 0); one that did not
  // stays, or is back, where it was.
  async move(connId, to, index = 0) {
    const entry = this.registry.get(connId);
    if (!entry || this.moving(connId)) throw new Error('Unknown connection');
    const from = entry.ownerId;
    if (to === from || !this.isWindow(to)) throw new Error('Unknown window');
    this.moves.set(connId, { from, to });
    this.registry.hold(connId);
    let moved = false;
    try {
      moved = await this.run(connId, from, to, Number.isInteger(index) && index > 0 ? index : 0);
      return moved;
    } finally {
      this.moves.delete(connId);
      this.registry.release(connId); // to the window that has it now
      this.left(from, moved);
      this.left(to, false);
    }
  }

  async run(connId, from, to, index) {
    // The window it leaves answers however long that takes (its events stay
    // held); too late, and the tab goes back to it.
    let late = false;
    const timer = this.setTimer(() => (late = true), this.timeoutMs);
    let out; // { state, index, active }
    try {
      out = await this.ask(from, 'tab:export', { connId });
    } catch {
      return false; // still there, or gone with its window and the connection
    } finally {
      this.clearTimer(timer);
    }
    if (late || !this.isWindow(to)) return this.giveBack(connId, from, out);
    this.setOwner(connId, null); // between windows: neither one closing ends it
    const imported = this.ask(to, 'tab:import', { connId, state: out.state, index, activate: true });
    let inTime;
    try {
      inTime = await this.within(imported);
    } catch {
      return this.giveBack(connId, from, out);
    }
    // Built too late, or in a window that started closing meanwhile (the
    // connection would end with it): the tab goes back, and that copy goes.
    if (!inTime || !this.isWindow(to)) {
      this.dropCopy(imported, connId, to);
      return this.giveBack(connId, from, out);
    }
    this.setOwner(connId, to);
    return true;
  }

  // Back to the window it came from, at its place there (shown if it was).
  // Gone, or taking longer than timeoutMs, it takes the connection with it
  // (its events are not held any longer); a copy it builds later goes.
  async giveBack(connId, from, { state, index, active }) {
    const back = this.ask(from, 'tab:import', { connId, state, index, activate: active });
    try {
      if (await this.within(back)) {
        this.setOwner(connId, from);
        return false;
      }
      this.dropCopy(back, connId, from);
    } catch {}
    this.closeConnection(connId);
    return false;
  }

  // Once `built` (the window answered its tab:import), the window lets its
  // copy of the tab go again.
  dropCopy(built, connId, windowId) {
    built
      .then(() => this.ask(windowId, 'tab:export', { connId, drop: true }))
      .then(() => this.left(windowId, true))
      .catch(() => {});
  }

  // Whether `answer` succeeds within timeoutMs (false: not yet); rejects
  // when it fails in time.
  within(answer) {
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => resolve(false), this.timeoutMs);
      answer.then(
        () => {
          this.clearTimer(timer);
          resolve(true);
        },
        (err) => {
          this.clearTimer(timer);
          reject(err);
        },
      );
    });
  }
}

module.exports = { Requests, TabMover, TIMEOUT_MS };
