'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, net, safeStorage, screen, session: electronSession, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ConnectionRegistry } = require('./connections');
const { createProfileStore } = require('./profileStore');
const { createJsonStore } = require('./jsonStore');
const { createLayoutStore } = require('./layoutStore');
const { WindowState, placeBounds } = require('./windowState');
const { Requests, TabMover, TIMEOUT_MS } = require('./tabMove');
const { TabDrag } = require('./tabDrag');
const { Updater } = require('./updater');
const { createEngine } = require('./updateEngine');
const { releaseUrl, createFetchRelease } = require('./fetchRelease');
const { installKind, releasePageUrl } = require('./updateCheck');
const { integrateDesktop } = require('./desktopIntegration');
const { frontAfterUpdate } = require('./afterUpdate');
const log = require('./log');

// Lets tests (and portable installs) keep their data in a chosen directory.
if (process.env.MQTTSCOPE_USER_DATA) app.setPath('userData', process.env.MQTTSCOPE_USER_DATA);

const ICON = path.join(__dirname, 'icon.png');
const MAX_FILE_BYTES = 256 * 1024 * 1024; // the MQTT payload limit
const STATE_SAVE_MS = 500;
// A window of its own for a tab: cascaded this far from the tab's window, or
// placed with its top-left corner this far up and left of a drop point, so
// the pointer lands on its tab strip.
const CASCADE = 30;
const DROP_GRAB = { x: 60, y: 15 };

// One process owns the data files; launching the app again opens another
// window in it. Each main window has its own broker connections, which the
// registry keeps by connection id; every MQTT call and event names one.
const windows = new Map(); // webContents.id -> { win, init, started, closing, vacated } (see createMainWindow, pageStarted, closeIfEmpty)
const childWindows = new Map(); // webContents.id -> { win, ownerId, connId, topics: Set, init } (see openChildWindow)
const registry = new ConnectionRegistry();
let profiles;
let stores;
let layouts;
let windowState; // the windows and tabs to reopen at the next launch
let stateTimer = null;
let updater;
let quitting = false;
let menuShortcuts = {}; // action id -> accelerator label, from the renderer's settings

process.on('uncaughtException', (err) => log.error('uncaughtException', err));
process.on('unhandledRejection', (err) => log.error('unhandledRejection', err));

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
});

function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// The id of the main window an IPC sender belongs to (a pop-out belongs to its opener).
function ownerIdOf(sender) {
  if (windows.has(sender.id)) return sender.id;
  const child = childWindows.get(sender.id);
  return child && windows.has(child.ownerId) ? child.ownerId : null;
}

function ownerOf(sender) {
  const id = ownerIdOf(sender);
  return id === null ? null : windows.get(id);
}

// A connection named in an IPC call, if the sender's window owns it. One
// between windows belongs to none (see tabMove.js), nor does a pop-out then.
function connectionOf(e, connId) {
  const ownerId = ownerIdOf(e.sender);
  const entry = registry.get(connId);
  if (ownerId === null || !entry || entry.ownerId !== ownerId) throw new Error('Unknown connection');
  return entry;
}

// Status, warnings and messages go to the window that owns the connection;
// messages also to that connection's pop-outs, for their topics.
function forwardConnectionEvents() {
  const send = (ownerId, channel, data) => {
    const win = windows.get(ownerId)?.win;
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  };
  registry.on('status', (connId, ownerId, status) => {
    if (status.state === 'error') log.warn('mqtt', status.url || '', status.error);
    send(ownerId, 'mqtt:status', { connId, status });
  });
  registry.on('openProfiles', (ids) => {
    for (const { win } of windows.values()) if (!win.isDestroyed()) win.webContents.send('conn:openProfilesChanged', ids);
  });
  registry.on('warning', (connId, ownerId, message) => send(ownerId, 'mqtt:warning', { connId, message }));
  registry.on('batch', (connId, ownerId, batch) => {
    send(ownerId, 'mqtt:messages', { connId, messages: batch.messages, dropped: batch.dropped });
    for (const child of childWindows.values()) {
      if (child.connId !== connId || child.win.isDestroyed()) continue;
      const mine = batch.messages.filter((m) => child.topics.has(m.topic));
      if (mine.length) child.win.webContents.send('mqtt:messages', { connId, messages: mine, dropped: 0 });
    }
  });
}

function closeChildren(pred) {
  for (const child of childWindows.values()) if (pred(child) && !child.win.isDestroyed()) child.win.close();
}

// Ends a connection; its pop-outs close with it, and a drag of its tab ends.
function closeConnection(connId) {
  registry.close(connId);
  closeChildren((child) => child.connId === connId);
  if (tabDrag.active()?.connId === connId) endDrag();
}

// A window closing, crashing or reloading ends all of its connections and a
// drag of its tab, and will not answer what main asked of it. A page that
// starts over is not left empty by tabs that went out of it before (see
// closeIfEmpty).
function closeConnectionsOf(ownerId) {
  registry.closeOwner(ownerId);
  closeChildren((child) => child.ownerId === ownerId);
  requests.windowGone(ownerId);
  if (tabDrag.active()?.fromWindowId === ownerId) endDrag();
  const entry = windows.get(ownerId);
  if (entry) entry.vacated = false;
}

function bringForward(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// A tab moves with its connection between main windows (see tabMove.js); the
// windows answer main's requests on tab:reply. A connection's pop-outs
// belong to the window that has its tab.
const requests = new Requests((id, channel, message) => {
  const win = windows.get(id)?.win;
  if (!win || win.isDestroyed()) return false;
  win.webContents.send(channel, message);
  return true;
});
const mover = new TabMover({
  registry,
  ask: (id, channel, data) => requests.ask(id, channel, data),
  isWindow: (id) => takesTabs(id),
  setOwner: (connId, ownerId) => {
    registry.setOwner(connId, ownerId);
    for (const child of childWindows.values()) if (child.connId === connId) child.ownerId = ownerId;
  },
  closeConnection: (connId) => closeConnection(connId),
  left: (id, out) => {
    const entry = windows.get(id);
    if (entry && out) entry.vacated = true;
    closeIfEmpty(id);
  },
});

// A main window that is not closing (or asking whether to): a tab that moved
// into one that is would end with it.
function takesTabs(id) {
  const entry = windows.get(id);
  return !!entry && !entry.closing && !entry.win.isDestroyed();
}

// Moves a tab to another main window, at `index` in its strip; that window
// comes forward. Resolves with whether it moved (one that could not stays,
// or is back, where it was).
async function moveTab(connId, toWindowId, index = 0) {
  const moved = await mover.move(connId, toWindowId, index);
  const win = windows.get(toWindowId)?.win;
  if (moved && win && !win.isDestroyed()) bringForward(win);
  return moved;
}

// A new window for just this tab (the tab menu's Move to new window, a tab
// dropped outside every window): near `point` on the screen (Wayland places
// it where it likes) or, without one, cascaded from the tab's window; the
// size of that window.
async function tearOff(connId, point = null) {
  const source = windows.get(registry.get(connId)?.ownerId)?.win;
  if (!source || source.isDestroyed() || mover.moving(connId)) throw new Error('Unknown connection');
  const { x, y, width, height } = source.getNormalBounds();
  const at = point ? { x: Math.round(point.x) - DROP_GRAB.x, y: Math.round(point.y) - DROP_GRAB.y } : { x: x + CASCADE, y: y + CASCADE };
  const win = createMainWindow({ bounds: { ...at, width, height }, adopt: true });
  const id = win.webContents.id;
  let moved = false;
  try {
    await pageStarted(id);
    moved = await moveTab(connId, id, 0);
    return moved;
  } finally {
    // It did not get the tab: it goes again.
    const entry = windows.get(id);
    if (entry && !moved) {
      entry.vacated = true;
      closeIfEmpty(id);
    }
  }
}

// Resolves once the window's page has asked what to open with (tabs:init),
// from when on it takes tabs that move in.
function pageStarted(id) {
  const entry = windows.get(id);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The new window did not open')), TIMEOUT_MS);
    entry.started = () => {
      clearTimeout(timer);
      resolve();
    };
    entry.win.once('closed', () => {
      clearTimeout(timer);
      reject(new Error('The new window closed'));
    });
  });
}

// A main window whose tabs all went to other windows (vacated) closes, once.
// Its flush runs as for any close; with no connections left, nothing asks
// first. One that a tab is still on its way from or to waits for that move.
// A window whose page crashed or reloaded has no connections either, and
// stays (see closeConnectionsOf).
function closeIfEmpty(id) {
  const entry = windows.get(id);
  if (!entry?.vacated || entry.closing || entry.win.isDestroyed() || mover.busy(id)) return;
  entry.vacated = false;
  if (registry.ofOwner(id).length) return;
  entry.closing = true; // a second close() during the flush would skip it
  entry.win.close();
}

// Dragging a tab (see tabDrag.js). Every main window hears when a drag starts
// and ends: its strip takes a drop of it meanwhile, also where the drag's own
// data cannot be read.
const tabDrag = new TabDrag({ onExpire: () => broadcastDragging(null) });

function broadcastDragging(data) {
  for (const { win } of windows.values()) if (!win.isDestroyed()) win.webContents.send('tabs:dragging', data);
}

function endDrag() {
  tabDrag.cancel();
  broadcastDragging(null);
}

// Where the pointer is on the screen, for a window torn off there; null where
// that is not known (Electron does not support it on Wayland: it may throw or
// make one up), and the window is cascaded instead.
function cursorPoint() {
  try {
    const p = screen.getCursorScreenPoint();
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y) || (p.x === 0 && p.y === 0)) return null;
    const on = (b) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    return screen.getAllDisplays().some((d) => on(d.bounds)) ? p : null;
  } catch {
    return null;
  }
}

function focusedMain() {
  const w = BrowserWindow.getFocusedWindow();
  return (w && ownerOf(w.webContents)) || windows.values().next().value || null;
}

// What to reopen at the next launch (see windowState.js): written soon after
// each change, so that it survives a crash, and when the app quits.
function saveWindowStateSoon() {
  if (!stateTimer) stateTimer = setTimeout(saveWindowState, STATE_SAVE_MS);
}

function saveWindowState() {
  clearTimeout(stateTimer);
  stateTimer = null;
  try {
    stores.set('windowState', windowState.toDoc());
  } catch (err) {
    log.error('windowState', err);
  }
}

// Reopening the last run's windows and tabs (Settings → General, on unless set to false).
const restoreTabsOn = () => stores.get('settings')?.restoreTabs !== false;

// The windows of the last run to reopen: none with the setting off.
function windowsToRestore(doc) {
  if (!restoreTabsOn()) return [];
  return WindowState.restorable(doc, new Set(profiles.load().map((p) => p.id)));
}

// bounds: where it was in the last run; restore: { tabs, active } to reopen
// in it; adopt: it opens for a tab that moves in, with no tab of its own. The
// window asks for these once (tabs:init); without them it opens with a New
// connection tab.
function createMainWindow({ bounds = null, restore = null, adopt = false } = {}) {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    ...placeBounds(bounds, screen.getAllDisplays().map((d) => d.workArea)),
    minWidth: 900,
    minHeight: 600,
    title: 'MQTT Scope',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: ICON,
    show: !process.env.MQTTSCOPE_HIDDEN,
    webPreferences: webPreferences(),
  });
  hardenWindow(win);
  const id = win.webContents.id;
  const entry = { win, init: restore ? { tabs: restore.tabs, active: restore.active } : adopt ? { tabs: [], adopt: true } : null, closing: false, vacated: false };
  windows.set(id, entry);
  // Until its page reports its tabs, it holds what it reopens.
  if (restore) windowState.report(id, restore);
  // The size and place it has when not maximized or full screen.
  const trackBounds = () => {
    if (win.isDestroyed()) return;
    windowState.setBounds(id, win.getNormalBounds());
    saveWindowStateSoon();
  };
  trackBounds();
  win.on('resize', trackBounds);
  win.on('move', trackBounds);

  // A reloaded page starts with no connections; the first load has none yet.
  // Not 'did-start-loading': a navigation blocked below fires that too, and
  // the page stays.
  win.webContents.on('did-navigate', () => closeConnectionsOf(id));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('render-process-gone', async (_e, details) => {
    log.error('renderer gone', details);
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    closeConnectionsOf(id);
    const res = await dialog.showMessageBox(win, {
      type: 'error',
      message: 'The window crashed',
      detail: `Reason: ${details.reason}. Reload to continue, then connect again.`,
      buttons: ['Reload', 'Close window'],
    });
    if (win.isDestroyed()) return;
    if (res.response === 0) win.reload();
    else win.destroy();
  });

  // Give the UI a moment to write debounced edits (connections, plots) first.
  let flushed = false;
  const flushAndClose = () => {
    if (flushed) return;
    flushed = true;
    entry.closing = true;
    const done = () => {
      clearTimeout(timer);
      ipcMain.off('app:flushed', onFlushed);
      if (!win.isDestroyed()) win.destroy();
    };
    const onFlushed = (ev) => ev.sender.id === id && done();
    ipcMain.on('app:flushed', onFlushed);
    const timer = setTimeout(done, 1500);
    win.webContents.send('app:flush');
  };
  // With restore off, the connections of a window closing would not come
  // back: several of them are worth a question. Quitting never asks.
  let asking = false;
  const confirmClose = async (n) => {
    asking = true;
    entry.closing = true;
    try {
      const res = await dialog.showMessageBox(win, { type: 'warning', message: `Close ${n} connections?`, buttons: ['Close', 'Cancel'], defaultId: 1, cancelId: 1 });
      return res.response === 0;
    } finally {
      asking = false;
      entry.closing = flushed;
    }
  };
  win.on('close', (e) => {
    if (flushed) return;
    e.preventDefault();
    if (quitting) return flushAndClose();
    if (asking) return;
    const n = registry.activeCount(id);
    if (n < 2 || restoreTabsOn()) return flushAndClose();
    confirmClose(n).then((ok) => ok && !win.isDestroyed() && flushAndClose());
  });
  win.on('closed', () => {
    windows.delete(id);
    closeConnectionsOf(id);
    // Quitting keeps every window for the next launch; otherwise only the
    // last one is (see windowState.js).
    if (!quitting) {
      windowState.closed(id, { last: windows.size === 0 });
      saveWindowStateSoon();
    }
    // A quit (e.g. Cmd+Q) was paused by the flush above; resume it.
    if (quitting) app.quit();
  });
  return win;
}

// Tells the other main windows that shared data changed so they reload it.
function broadcastChange(fromId, name) {
  for (const [id, { win }] of windows) if (id !== fromId && !win.isDestroyed()) win.webContents.send('store:changed', name);
}

// The Settings switch (on unless set to false) governs automatic checks only.
const updateChecksOn = () => stores.get('settings')?.checkForUpdates !== false;

// How this build was installed. Without MQTTSCOPE_UPDATE_URL, unpackaged runs
// (npm start, tests) are 'dev', whatever MQTTSCOPE_UPDATE_KIND says.
function currentInstallKind() {
  if (!app.isPackaged && !process.env.MQTTSCOPE_UPDATE_URL) return 'dev';
  const realpath = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  return installKind({
    platform: process.platform,
    env: process.env,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    exists: fs.existsSync,
    realpath,
  });
}

// The update notice. MQTTSCOPE_UPDATE_URL (tests, the release gate) stands in
// for GitHub and for electron-updater's feed. Without it, unpackaged runs
// (npm start, tests) never contact anything.
function createUpdater(kind) {
  const base = process.env.MQTTSCOPE_UPDATE_URL || '';
  log.info('update', `install kind: ${kind}`);
  const u = new Updater({
    currentVersion: app.getVersion(),
    kind,
    fetchRelease: createFetchRelease({ fetch: (url, init) => net.fetch(url, init), url: releaseUrl(base), version: app.getVersion() }),
    engine: createEngine({
      kind,
      feedUrl: base || null,
      log,
      // The menu entry follows the AppImage to its new name, also when the
      // update installs on quit and the new version does not start.
      onRenamed: (file) => integrateDesktop({ kind, isPackaged: app.isPackaged, log, env: { ...process.env, APPIMAGE: file } }),
    }),
    store: { get: () => stores.get('updates'), set: (value) => stores.set('updates', value) },
    isEnabled: updateChecksOn,
    // A restart drops brokers still connecting or reconnecting too.
    connectedCount: () => registry.activeCount(),
    log,
  });
  // Every main window shows the same state. A window closing mid-broadcast
  // must not keep the others from hearing it.
  u.on('state', (state) => {
    for (const { win } of windows.values()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send('update:state', state);
      } catch (err) {
        log.warn('update', `could not send the update state: ${err.message}`);
      }
    }
  });
  if (base) globalThis.__mqttscopeUpdater = u; // for tests, like the renderer's window.__mqttscope
  return u;
}

// The install has started the new version, which comes up while this one
// still closes its windows (each waits up to 1.5 s for its flush). Hand it the
// single-instance lock now, or it would quit and leave this one opening a
// window for it on the way out.
function quitForUpdate() {
  quitting = true;
  saveWindowState(); // the new version reads it before this one has quit
  app.releaseSingleInstanceLock();
}

// Help → Check for Updates…: always asks, and tells the window it came from.
async function checkForUpdatesNow() {
  const asked = focusedMain();
  const result = await updater.check({ manual: true });
  const w = asked && !asked.win.isDestroyed() ? asked : focusedMain();
  if (w && !w.win.isDestroyed()) w.win.webContents.send('update:checked', result);
}

function storageSecurity() {
  let available = false;
  try {
    available = safeStorage.isEncryptionAvailable();
  } catch {}
  // On Linux without a keyring Electron falls back to a fixed key ("basic_text").
  const backend = process.platform === 'linux' && safeStorage.getSelectedStorageBackend ? safeStorage.getSelectedStorageBackend() : null;
  return { available, secure: available && backend !== 'basic_text', backend };
}

// Stores a window may read but not write: main writes them, or (the plot
// files of earlier versions) nothing does.
const MAIN_STORES = new Set(['plots', 'plotTabs', 'profileLayouts', 'windowState']);

function registerIpc() {
  const parent = (e) => BrowserWindow.fromWebContents(e.sender);

  // A main window opens its connections; the id names one in every call after.
  ipcMain.handle('conn:open', (e) => {
    if (!windows.has(e.sender.id)) throw new Error('Unknown window');
    return registry.create(e.sender.id);
  });
  ipcMain.handle('conn:close', (e, connId) => {
    connectionOf(e, connId);
    closeConnection(connId);
  });
  const sessionOf = (e, connId) => connectionOf(e, connId).session;
  // A profile open in another tab: that tab may be in this very window,
  // which then shows it itself.
  const withSameWindow = (e, res) => (res.duplicate ? { ...res, duplicate: { ...res.duplicate, sameWindow: res.duplicate.ownerId === ownerIdOf(e.sender) } } : res);
  ipcMain.handle('mqtt:connect', (e, connId, profile) => {
    connectionOf(e, connId);
    return withSameWindow(e, registry.connect(connId, profile || {}));
  });
  // A tab reopened at launch that the user had disconnected takes its profile
  // without connecting.
  ipcMain.handle('conn:bind', (e, connId, profile) => {
    connectionOf(e, connId);
    return withSameWindow(e, registry.bind(connId, profile || {}));
  });
  // Brings the window that owns a connection forward and has it show that tab.
  ipcMain.handle('conn:focus', (e, connId) => {
    if (!windows.has(e.sender.id)) return;
    const win = windows.get(registry.get(connId)?.ownerId)?.win;
    if (!win || win.isDestroyed()) return;
    bringForward(win);
    win.webContents.send('tabs:activate', { connId });
  });
  ipcMain.handle('conn:openProfiles', () => registry.openProfileIds());
  ipcMain.handle('mqtt:disconnect', (e, connId) => sessionOf(e, connId).disconnect());
  ipcMain.handle('mqtt:status', (e, connId) => sessionOf(e, connId).status);
  ipcMain.handle('mqtt:publish', (e, connId, msg) => sessionOf(e, connId).publish(msg));
  ipcMain.handle('mqtt:subscribe', (e, connId, { topic, qos } = {}) => sessionOf(e, connId).subscribe(topic, qos));
  ipcMain.handle('mqtt:unsubscribe', (e, connId, topic) => sessionOf(e, connId).unsubscribe(topic));
  ipcMain.handle('mqtt:subscriptions', (e, connId) => sessionOf(e, connId).subscriptions.map((s) => ({ ...s })));

  ipcMain.handle('profiles:list', () => profiles.load());
  ipcMain.handle('profiles:save', (e, list) => {
    const before = profiles.load().map((p) => p.id);
    const res = profiles.save(list);
    // A deleted profile's plots go with it; a renamed one keeps its id.
    const kept = new Set(list.map((p) => p?.id));
    try {
      layouts.remove(before.filter((id) => !kept.has(id)));
    } catch (err) {
      log.error('layouts', err); // the profiles themselves are saved
    }
    broadcastChange(e.sender.id, 'profiles');
    return res;
  });
  ipcMain.handle('profiles:security', () => storageSecurity());
  // A profile is open in one tab app-wide, so its layout needs no broadcast.
  ipcMain.handle('layouts:get', (_e, profileId) => layouts.get(profileId));
  ipcMain.handle('layouts:set', (_e, profileId, doc) => layouts.set(profileId, doc));
  ipcMain.handle('store:get', (_e, name) => stores.get(name));
  ipcMain.handle('store:set', (e, name, value) => {
    if (MAIN_STORES.has(name)) throw new Error(`"${name}" is kept by the main process`);
    const checkedBefore = name === 'settings' && updateChecksOn();
    const res = stores.set(name, value);
    broadcastChange(e.sender.id, name);
    // Turning update checks back on checks now rather than in up to 6 hours.
    if (name === 'settings' && !checkedBefore && updateChecksOn()) updater.tick();
    return res;
  });

  // The renderer only sends intents; main builds every URL it opens.
  ipcMain.handle('update:state', () => updater.state);
  ipcMain.handle('update:download', () => updater.download());
  // Answers once the install has started (the Installing dialog shows meanwhile).
  ipcMain.handle('update:restart', async (_e, force) => {
    const res = await updater.restart({ force });
    if (res.ok) quitForUpdate();
    return res;
  });
  ipcMain.handle('update:skip', () => updater.skip());
  ipcMain.handle('update:openRelease', async () => {
    const version = updater.state.latest?.version;
    if (version) await shell.openExternal(releasePageUrl(version));
  });

  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('app:newWindow', () => {
    createMainWindow();
  });
  // A main window asks once what to open with (see createMainWindow), and
  // learns its id; it then reports its tabs whenever they change.
  ipcMain.handle('tabs:init', (e) => {
    const entry = windows.get(e.sender.id);
    if (!entry) return null;
    const { init } = entry;
    entry.init = null;
    entry.started?.();
    entry.started = null;
    return { windowId: e.sender.id, ...init };
  });
  ipcMain.on('tabs:report', (e, state) => {
    if (!windows.has(e.sender.id)) return;
    windowState.report(e.sender.id, state);
    saveWindowStateSoon();
  });
  // A window moves its own tabs (see moveTab, tearOff).
  const ownTab = (e, connId) => {
    if (!windows.has(e.sender.id)) throw new Error('Unknown window');
    connectionOf(e, connId);
  };
  ipcMain.handle('tabs:move', (e, { connId, toWindowId, index } = {}) => {
    ownTab(e, connId);
    return moveTab(connId, toWindowId, index);
  });
  ipcMain.handle('tabs:tearOff', (e, { connId } = {}) => {
    ownTab(e, connId);
    return tearOff(connId, null);
  });
  // A tab dragged from a window's strip (see tabDrag.js): its window reports
  // the start and the end, other windows the drag over their top bar, the
  // window it is dropped on the drop. A drop on another window moves it there
  // and answers whether it moved; one on its own window (which reorders it
  // itself) answers { reorder }. Let go outside its window with no drop, it
  // gets a window of its own under the pointer, and the end answers whether
  // it moved; else null. Esc pressed outside its window cannot be told from
  // that (both end with no drop, the pointer long gone from it): it tears off
  // too. A window's only tab stays, as with the menu's Move to new window.
  ipcMain.handle('tabs:dragStart', (e, connId) => {
    ownTab(e, connId);
    tabDrag.start(connId, e.sender.id);
    broadcastDragging({ connId });
  });
  ipcMain.on('tabs:dragHover', (e) => windows.has(e.sender.id) && tabDrag.hover(e.sender.id));
  ipcMain.handle('tabs:drop', (e, { index } = {}) => {
    if (!windows.has(e.sender.id)) throw new Error('Unknown window');
    const drop = tabDrag.drop(e.sender.id, index);
    if (!drop) return null;
    broadcastDragging(null);
    if (drop.toWindowId === drop.fromWindowId) return { reorder: drop.connId };
    return moveTab(drop.connId, drop.toWindowId, drop.index);
  });
  ipcMain.handle('tabs:dragEnd', async (e, { overSource } = {}) => {
    const drag = tabDrag.active();
    if (drag?.fromWindowId !== e.sender.id) return null;
    const outcome = await tabDrag.end({ overSource: overSource !== false });
    if (!tabDrag.active()) broadcastDragging(null); // unless another drag started meanwhile
    if (outcome !== 'tearOff' || registry.ofOwner(drag.fromWindowId).length < 2) return null;
    // By design, also when let go on another window's content (not its top bar).
    return tearOff(drag.connId, cursorPoint());
  });
  ipcMain.on('tab:reply', (e, reply) => requests.answer(e.sender.id, reply));
  ipcMain.on('menu:shortcuts', (_e, map) => {
    if (!map || typeof map !== 'object') return;
    menuShortcuts = Object.fromEntries(Object.entries(map).filter(([k, v]) => typeof k === 'string' && (typeof v === 'string' || v === null)));
    buildMenu();
  });

  ipcMain.handle('dialog:pickFile', async (e, title) => {
    const res = await dialog.showOpenDialog(parent(e), { title: String(title || 'Choose file'), properties: ['openFile'] });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('dialog:confirm', async (e, { message, detail, okLabel } = {}) => {
    const res = await dialog.showMessageBox(parent(e), {
      type: 'warning',
      buttons: [String(okLabel || 'OK'), 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: String(message),
      detail: detail ? String(detail) : undefined,
    });
    return res.response === 0;
  });

  ipcMain.handle('file:save', async (e, { defaultName, data } = {}) => {
    const res = await dialog.showSaveDialog(parent(e), { defaultPath: String(defaultName || 'payload') });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, typeof data === 'string' ? data : Buffer.from(data));
    return res.filePath;
  });

  ipcMain.handle('file:readBytes', async (e) => {
    const res = await dialog.showOpenDialog(parent(e), { properties: ['openFile'] });
    if (res.canceled) return null;
    const file = res.filePaths[0];
    const { size } = fs.statSync(file);
    if (size > MAX_FILE_BYTES) throw new Error(`File is ${Math.round(size / 1048576)} MB; MQTT payloads are limited to 256 MB`);
    return { name: path.basename(file), bytes: new Uint8Array(fs.readFileSync(file)) };
  });

  // An inspector pop-out: one topic of one connection, with the history the
  // main window kept.
  ipcMain.handle('popout:open', (e, { connId, topic, title, history } = {}) => {
    if (typeof topic !== 'string') return;
    const { ownerId } = connectionOf(e, connId);
    const name = String(title || topic);
    openChildWindow(ownerId, connId, {
      page: 'popout.html',
      title: name,
      size: { width: 1200, height: 900 },
      topics: [topic],
      init: { topic, title: name, history: Array.isArray(history) ? history : [] },
    });
  });

  // A plot in its own window: the plot and the points collected so far.
  ipcMain.handle('plotwin:open', (e, { connId, title, plot, data, tabName } = {}) => {
    if (!plot || !Array.isArray(plot.series)) return;
    const { ownerId } = connectionOf(e, connId);
    const name = String(title || plot.title || 'Plot');
    openChildWindow(ownerId, connId, {
      page: 'plotWindow.html',
      title: name,
      size: { width: 1100, height: 650, minWidth: 360, minHeight: 240 },
      topics: plot.series.map((s) => s && s.topic),
      init: { title: name, plot, data, tabName },
    });
  });

  // Reload (Ctrl+R) of a connection in a main window: its child windows start over too.
  ipcMain.on('children:reset', (e, connId) => {
    if (!windows.has(e.sender.id) || registry.get(connId)?.ownerId !== e.sender.id) return;
    for (const child of childWindows.values()) if (child.connId === connId && !child.win.isDestroyed()) child.win.webContents.send('app:reset');
  });

  // A child window asks once for what it was opened with.
  ipcMain.handle('child:init', (e) => {
    const entry = childWindows.get(e.sender.id);
    if (!entry) return null;
    const { init } = entry;
    entry.init = null; // the window keeps its own copy; free this one
    return init;
  });
}

// Windows opened from a main window (inspector pop-outs, pop-out plots). Each
// gets its init data once, then its connection's messages of its topics; it
// closes with its connection.
function openChildWindow(ownerId, connId, { page, title, size, topics, init }) {
  const win = new BrowserWindow({
    ...size,
    title,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: ICON,
    show: !process.env.MQTTSCOPE_HIDDEN,
    webPreferences: webPreferences(),
  });
  hardenWindow(win);
  const id = win.webContents.id;
  childWindows.set(id, { win, ownerId, connId, topics: new Set(topics.filter((t) => typeof t === 'string')), init });
  win.on('closed', () => childWindows.delete(id));
  win.loadFile(path.join(__dirname, '..', 'renderer', page));
}

function buildMenu() {
  const toRenderer = (action) => () => {
    const w = focusedMain();
    if (w && !w.win.isDestroyed()) w.win.webContents.send('menu', action);
  };
  // Shortcuts are handled (and rebindable) in the renderer; the menu only
  // shows them, so it must not register them a second time.
  const keys = (id) => (menuShortcuts[id] ? { accelerator: menuShortcuts[id], registerAccelerator: false } : {});
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', click: () => createMainWindow(), ...keys('newWindow') },
        { label: 'New Tab', click: toRenderer('newTab'), ...keys('newTab') },
        { label: 'Close Tab', click: toRenderer('closeTab'), ...keys('closeTab') },
        { label: 'Reopen Closed Tab', click: toRenderer('reopenTab'), ...keys('reopenTab') },
        ...(isMac ? [{ label: 'Close Window', accelerator: 'Cmd+Shift+W', registerAccelerator: false, click: () => BrowserWindow.getFocusedWindow()?.close() }] : []),
        { type: 'separator' },
        { label: 'New Connection Tab…', click: toRenderer('connections'), ...keys('connections') },
        { label: 'Subscriptions…', click: toRenderer('subscriptions'), ...keys('subscriptions') },
        { label: 'Settings…', click: toRenderer('settings'), ...keys('settings') },
        { type: 'separator' },
        { label: 'Open Data Folder', click: () => shell.openPath(app.getPath('userData')) },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Inspector', click: toRenderer('tabInspector'), ...keys('tabInspector') },
        { label: 'Plots', click: toRenderer('tabPlots'), ...keys('tabPlots') },
        { label: 'Add Data to New Plot…', click: toRenderer('newPlot'), ...keys('newPlot') },
        { label: 'Maximize Inspector', click: toRenderer('maximize'), ...keys('maximize') },
        { type: 'separator' },
        { label: 'Pause / Resume Updates', click: toRenderer('pause'), ...keys('pause') },
        { label: 'Hold / Follow (Freeze Plots)', click: toRenderer('hold'), ...keys('hold') },
        { label: 'Reload: Clear Messages and Restart Plots', click: toRenderer('reset'), ...keys('reset') },
        { label: 'Clear Topics', click: toRenderer('clear'), ...keys('clear') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: isMac ? 'Ctrl+Cmd+F' : 'Shift+F11' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts…', click: toRenderer('keyboardSettings') },
        { label: 'Check for Updates…', click: () => checkForUpdatesNow() },
        {
          label: 'About MQTT Scope',
          click: () =>
            dialog.showMessageBox(focusedMain()?.win, {
              type: 'info',
              message: `MQTT Scope ${app.getVersion()}`,
              detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}\nData: ${app.getPath('userData')}`,
              icon: ICON,
            }),
        },
        { label: 'Show Log File', click: () => log.file && shell.showItemInFolder(log.file) },
      ],
    },
  ];
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } catch (err) {
    // A shortcut Electron cannot display must never break the menu.
    log.warn('menu', err.message);
    if (Object.keys(menuShortcuts).length) {
      menuShortcuts = {};
      buildMenu();
    }
  }
}

function start() {
  const userData = app.getPath('userData');
  log.init(path.join(userData, 'logs'));
  log.info(`start ${app.getVersion()} electron ${process.versions.electron} ${process.platform}`);
  // The UI needs no web permissions (camera, notifications, …) except full
  // screen, for showing a plot on its own.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen'));
  electronSession.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen');
  buildMenu();
  profiles = createProfileStore({
    file: path.join(userData, 'profiles.json'),
    cipher: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    },
  });
  stores = createJsonStore(userData);
  // Read once: a broken file is set aside as it is read (see jsonStore.js).
  const lastRun = stores.get('windowState');
  windowState = new WindowState(lastRun);
  layouts = createLayoutStore({ stores, profileIds: () => profiles.load().map((p) => p.id), log });
  try {
    // Every profile there is now starts with the plots of the version before.
    layouts.migrate();
  } catch (err) {
    log.error('layouts', err);
  }
  const kind = currentInstallKind();
  // Before the first window, so the desktop finds the entry for it.
  integrateDesktop({ kind, isPackaged: app.isPackaged, log });
  updater = createUpdater(kind);
  forwardConnectionEvents();
  // For tests, like __mqttscopeUpdater.
  if (!app.isPackaged) {
    globalThis.__mqttscopeConnections = registry;
    globalThis.__mqttscopeMoveTab = moveTab;
    globalThis.__mqttscopeTabDrag = tabDrag;
  }
  registerIpc();
  // The windows of the last run, each where it was with its tabs; else one
  // with a New connection tab.
  const restore = windowsToRestore(lastRun);
  const created = restore.length ? restore.map((w) => createMainWindow({ bounds: w.bounds, restore: w })) : [createMainWindow()];
  // Started by the Windows installer after Restart to update: that window comes to the front.
  frontAfterUpdate({ argv: process.argv, win: created[0], log });
  updater.start();
  app.on('will-quit', () => {
    updater.stop(); // no check starts while the app shuts down
    saveWindowState();
  });
  app.on('activate', () => {
    if (windows.size === 0) createMainWindow();
  });
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => app.isReady() && !quitting && createMainWindow());
  app.on('before-quit', () => (quitting = true));
  app.whenReady().then(start);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
} else {
  app.quit();
}
