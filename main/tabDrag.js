'use strict';

// A tab dragged from a main window's strip: dropped on another window's top
// bar (it moves there, see tabMove.js), back on its own strip (the strip
// reorders it itself) or let go outside its window where nothing takes it (a
// window of its own takes it). The two ends of a drag reach main from
// different windows: the window it is dropped on reports the drop, the window
// it came from that the drag ended and whether the pointer was over that
// window then. Either may come first, so an end waits up to graceMs for a
// drop; longer (hoverGraceMs) when another window reported the drag over its
// top bar within hoverMs before, as a drop there may come late from a busy
// window. A drag whose end never comes is forgotten after maxAgeMs. No
// Electron dependency, so it can be tested under plain Node.

const GRACE_MS = 250;
// Long enough for a pointer resting on that top bar, whose dragover comes
// only every 350 ms ± 200 ms.
const HOVER_MS = 750;
const HOVER_GRACE_MS = 1500;
const MAX_AGE_MS = 60000;

class TabDrag {
  // onExpire(): a drag was forgotten for its age.
  constructor({
    graceMs = GRACE_MS,
    hoverMs = HOVER_MS,
    hoverGraceMs = HOVER_GRACE_MS,
    maxAgeMs = MAX_AGE_MS,
    onExpire = () => {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    Object.assign(this, { graceMs, hoverMs, hoverGraceMs, maxAgeMs, onExpire, now, setTimer, clearTimer });
    this.drag = null; // { connId, fromWindowId, dropped, waiting: { resolve, timer }, hoveredAt, expiry }
  }

  // The drag going on: { connId, fromWindowId }, or null.
  active() {
    return this.drag && { connId: this.drag.connId, fromWindowId: this.drag.fromWindowId };
  }

  // A new drag ends the one before, should its end still wait.
  start(connId, fromWindowId) {
    this.cancel();
    const drag = { connId, fromWindowId, dropped: null, waiting: null, hoveredAt: -Infinity };
    drag.expiry = this.setTimer(() => {
      if (this.drag !== drag) return;
      this.cancel();
      this.onExpire();
    }, this.maxAgeMs);
    this.drag = drag;
  }

  // Window windowId, not the one the drag came from, has it over its top bar.
  hover(windowId) {
    if (this.drag && windowId !== this.drag.fromWindowId) this.drag.hoveredAt = this.now();
  }

  // The drag dropped on window toWindowId's top bar, at `index` in its strip:
  // what to move where, or null without a drag (or after its drop).
  drop(toWindowId, index) {
    const d = this.drag;
    if (!d || d.dropped) return null;
    d.dropped = { connId: d.connId, fromWindowId: d.fromWindowId, toWindowId, index };
    if (d.waiting) this.finish('dropped');
    return d.dropped;
  }

  // The drag ended in its window: 'dropped' (on a top bar), 'tearOff' (let
  // go outside its window, where nothing took it) or 'none'.
  end({ overSource }) {
    const d = this.drag;
    if (!d || d.waiting) return Promise.resolve('none');
    if (d.dropped) {
      this.forget();
      return Promise.resolve('dropped');
    }
    const grace = this.now() - d.hoveredAt <= this.hoverMs ? this.hoverGraceMs : this.graceMs;
    return new Promise((resolve) => {
      const timer = this.setTimer(() => this.finish(overSource ? 'none' : 'tearOff'), grace);
      d.waiting = { resolve, timer };
    });
  }

  // Forgets the drag (its window or its tab went away); an end waiting for
  // it does nothing.
  cancel() {
    if (this.drag?.waiting) this.finish('none');
    else this.forget();
  }

  finish(outcome) {
    const { resolve, timer } = this.drag.waiting;
    this.clearTimer(timer);
    this.forget();
    resolve(outcome);
  }

  forget() {
    if (this.drag) this.clearTimer(this.drag.expiry);
    this.drag = null;
  }
}

module.exports = { TabDrag, GRACE_MS };
