'use strict';

// A tab dragged from a main window's strip: dropped on another window's strip
// (it moves there, see tabMove.js), back on its own (the strip reorders it
// itself) or let go outside every window (a window of its own takes it). The
// two ends of a drag reach main from different windows: the window it is
// dropped on reports the drop, the window it came from that the drag ended
// and whether the pointer was over that window then. Either may come first,
// so an end waits up to graceMs for a drop. No Electron dependency, so it can
// be tested under plain Node.

const GRACE_MS = 250;

class TabDrag {
  constructor({ graceMs = GRACE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { graceMs, setTimer, clearTimer });
    this.drag = null; // { connId, fromWindowId, dropped, waiting: { resolve, timer } }
  }

  // The drag going on: { connId, fromWindowId }, or null.
  active() {
    return this.drag && { connId: this.drag.connId, fromWindowId: this.drag.fromWindowId };
  }

  // A new drag ends the one before, should its end still wait.
  start(connId, fromWindowId) {
    this.cancel();
    this.drag = { connId, fromWindowId, dropped: null, waiting: null };
  }

  // The drag dropped on window toWindowId's strip, at `index`: what to move
  // where, or null without a drag (or after its drop).
  drop(toWindowId, index) {
    const d = this.drag;
    if (!d || d.dropped) return null;
    d.dropped = { connId: d.connId, fromWindowId: d.fromWindowId, toWindowId, index };
    if (d.waiting) this.finish('dropped');
    return d.dropped;
  }

  // The drag ended in its window: 'dropped' (on a strip), 'tearOff' (let go
  // outside its window, where no strip took it) or 'none'.
  end({ overSource }) {
    const d = this.drag;
    if (!d || d.waiting) return Promise.resolve('none');
    if (d.dropped) {
      this.drag = null;
      return Promise.resolve('dropped');
    }
    return new Promise((resolve) => {
      const timer = this.setTimer(() => this.finish(overSource ? 'none' : 'tearOff'), this.graceMs);
      d.waiting = { resolve, timer };
    });
  }

  // Forgets the drag (its window went away); an end waiting for it does nothing.
  cancel() {
    if (this.drag?.waiting) this.finish('none');
    this.drag = null;
  }

  finish(outcome) {
    const { resolve, timer } = this.drag.waiting;
    this.clearTimer(timer);
    this.drag = null;
    resolve(outcome);
  }
}

module.exports = { TabDrag, GRACE_MS };
