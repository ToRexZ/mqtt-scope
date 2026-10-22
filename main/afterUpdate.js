'use strict';

// The start after a Windows update. The installer starts the new version with
// --updated (build/installer.nsh). If the user clicked or typed anywhere while
// it installed, Windows' foreground lock opens the new window behind the
// others with a flashing taskbar button. That window is the one the user
// asked to restart into, so it comes to the front, once.

// Topmost for a moment puts it above the other windows (changing the z-order
// is not subject to the foreground lock, unlike activating); show() and
// focus() then activate it where Windows allows.
function bringToFront(win) {
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  win.setAlwaysOnTop(false);
}

// win: the first main window. Returns whether this start came from an update.
// Once its page has loaded: not on 'ready-to-show', which Electron sends a
// window shown when it was created (as main.js makes them) only from its first
// paint, unreliably (electron#25448).
function frontAfterUpdate({ argv, win, log }) {
  if (!argv.includes('--updated')) return false;
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    log.info('update', 'started after an update: bringing the window to the front');
    bringToFront(win);
  });
  return true;
}

module.exports = { frontAfterUpdate };
