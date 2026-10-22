// Preloaded into the app's main process by an e2e test (electron -r, before
// main.js runs).
// - Records every BrowserWindow.setAlwaysOnTop call in globalThis.__alwaysOnTop,
//   so a test sees a toggle that is over before it could look.
// - Drops 'ready-to-show' for a window that is already visible: Electron sends
//   it for such a window only from the first paint, which its own source calls
//   unreliable across machines (electron#25448), and on some it never comes.

const { BrowserWindow } = require('electron');

globalThis.__alwaysOnTop = [];
const setAlwaysOnTop = BrowserWindow.prototype.setAlwaysOnTop;
BrowserWindow.prototype.setAlwaysOnTop = function (...args) {
  const result = setAlwaysOnTop.apply(this, args);
  globalThis.__alwaysOnTop.push({ id: this.id, set: args[0], visible: this.isVisible() });
  return result;
};

const emit = BrowserWindow.prototype.emit;
BrowserWindow.prototype.emit = function (name, ...args) {
  if (name === 'ready-to-show' && this.isVisible()) return false;
  return emit.call(this, name, ...args);
};
