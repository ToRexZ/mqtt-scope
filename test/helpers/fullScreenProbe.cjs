// Preloaded into the app's main process by an e2e test (electron -r, before
// main.js runs). The headless platform has no full screen (setFullScreen does
// nothing there): a window keeps the state it was set to, isFullScreen()
// answers with it, and the window hears the events a desktop sends.

const { BrowserWindow } = require('electron');

const fullScreen = new WeakSet();
BrowserWindow.prototype.setFullScreen = function (on) {
  if (fullScreen.has(this) === !!on) return;
  if (on) fullScreen.add(this);
  else fullScreen.delete(this);
  this.emit(on ? 'enter-full-screen' : 'leave-full-screen');
};
BrowserWindow.prototype.isFullScreen = function () {
  return fullScreen.has(this);
};
