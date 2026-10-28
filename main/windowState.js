'use strict';

// The windows and tabs to reopen at the next launch, kept in the windowState
// store:
//   { version: 1, windows: [{ bounds, maximized?, fullScreen?, tabs: [{ profileId, connected }], active }] }
// Each main window reports its tabs (renderer/app.js: New connection tabs are
// left out; connected is false only for a tab the user disconnected) and main
// its bounds (when not maximized or full screen) and whether it is maximized
// or full screen (written only when it is). A window closed while others
// stay open is forgotten; the last one is kept, since closing it quits (and
// on macOS until another opens). Pure: main.js does the reading, writing and
// window handling.

const VERSION = 1;
// How much of a window's top edge must be on a display to drag it back.
const GRIP = { width: 80, height: 30 };

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// { width, height } and, when both are numbers, { x, y }; null without a
// usable size.
function cleanBounds(b) {
  if (!isObject(b) || !isNumber(b.width) || !isNumber(b.height) || b.width <= 0 || b.height <= 0) return null;
  const size = { width: Math.round(b.width), height: Math.round(b.height) };
  return isNumber(b.x) && isNumber(b.y) ? { x: Math.round(b.x), y: Math.round(b.y), ...size } : size;
}

function cleanTabs(tabs) {
  if (!Array.isArray(tabs)) return [];
  return tabs.filter((t) => isObject(t) && typeof t.profileId === 'string' && t.profileId).map((t) => ({ profileId: t.profileId, connected: t.connected !== false }));
}

// The active index among `count` tabs: a whole number in range, else 0.
const clampActive = (active, count) => (Number.isInteger(active) && active > 0 ? Math.min(active, Math.max(0, count - 1)) : 0);

// maximized and fullScreen, each only when true.
const cleanShape = (w) => ({ ...(w?.maximized === true && { maximized: true }), ...(w?.fullScreen === true && { fullScreen: true }) });

// A window as reported or saved, every field usable.
function cleanWindow(w) {
  const tabs = cleanTabs(w?.tabs);
  return { bounds: cleanBounds(w?.bounds), ...cleanShape(w), tabs, active: clampActive(w?.active, tabs.length) };
}

const docWindows = (doc) => (isObject(doc) && doc.version === VERSION && Array.isArray(doc.windows) ? doc.windows : []);

class WindowState {
  // doc: the stored document. Its windows are written back as they are until
  // a window reports, so a launch that ends before then loses nothing.
  constructor(doc) {
    this.windows = new Map(); // window id -> { bounds, maximized?, fullScreen?, tabs, active, closed }, in creation order
    this.saved = docWindows(doc)
      .map(cleanWindow)
      .filter((w) => w.tabs.length);
  }

  report(windowId, state) {
    this.saved = null;
    this.dropClosed(windowId);
    const { tabs, active } = cleanWindow(state);
    this.entry(windowId).tabs = tabs;
    this.entry(windowId).active = active;
  }

  // bounds: the window's when it is not maximized or full screen; shape:
  // { maximized, fullScreen }.
  setBounds(windowId, bounds, shape = {}) {
    this.dropClosed(windowId);
    const w = this.entry(windowId);
    w.bounds = cleanBounds(bounds);
    delete w.maximized;
    delete w.fullScreen;
    Object.assign(w, cleanShape(shape));
  }

  // last: no other main window is open. Closing it quits on Linux and
  // Windows, so it is what comes back; on macOS too, unless another window
  // opens first.
  closed(windowId, { last }) {
    const w = this.windows.get(windowId);
    if (!w) return;
    if (last) w.closed = true;
    else this.windows.delete(windowId);
  }

  toDoc() {
    const windows = this.saved || [...this.windows.values()].filter((w) => w.tabs.length).map((w) => ({ bounds: w.bounds, ...cleanShape(w), tabs: w.tabs, active: w.active }));
    return { version: VERSION, windows: structuredClone(windows) };
  }

  entry(windowId) {
    if (!this.windows.has(windowId)) this.windows.set(windowId, { bounds: null, tabs: [], active: 0, closed: false });
    return this.windows.get(windowId);
  }

  // A window opened after the last one closed replaces it.
  dropClosed(windowId) {
    for (const [id, w] of this.windows) if (w.closed && id !== windowId) this.windows.delete(id);
  }

  // The windows to reopen: tabs of profiles that no longer exist are left
  // out (and a profile's second tab, which cannot be), and so are windows left
  // without tabs. The active tab stays the same one, or the one that took its
  // place. Never throws: a broken document reopens nothing.
  static restorable(doc, profileIds) {
    try {
      const seen = new Set();
      const out = [];
      for (const raw of docWindows(doc)) {
        const w = cleanWindow(raw);
        const kept = w.tabs.map((t) => {
          if (!profileIds.has(t.profileId) || seen.has(t.profileId)) return false;
          seen.add(t.profileId);
          return true;
        });
        const tabs = w.tabs.filter((_, i) => kept[i]);
        if (!tabs.length) continue;
        const before = kept.slice(0, w.active).filter(Boolean).length;
        out.push({ bounds: w.bounds, ...cleanShape(w), tabs, active: Math.min(before, tabs.length - 1) });
      }
      return out;
    } catch {
      return [];
    }
  }
}

// The bounds to open a window with: a saved position is kept while enough of
// the window's top edge is on one of the displays' work areas; otherwise the
// system places it (on `primary`, the primary display's work area). Its saved
// size, no larger than the work area of the display it opens on (one with
// less room than the display it was on).
function placeBounds(bounds, workAreas, primary = workAreas[0]) {
  if (!bounds) return null;
  const fit = (area) => (area ? { width: Math.min(bounds.width, area.width), height: Math.min(bounds.height, area.height) } : { width: bounds.width, height: bounds.height });
  if (!isNumber(bounds.x) || !isNumber(bounds.y)) return fit(primary);
  const on = workAreas.find((a) => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + GRIP.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return w >= Math.min(GRIP.width, bounds.width) && h > 0;
  });
  return on ? { x: bounds.x, y: bounds.y, ...fit(on) } : fit(primary);
}

module.exports = { WindowState, placeBounds };
