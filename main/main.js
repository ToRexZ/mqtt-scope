'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, net, safeStorage, session: electronSession, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ConnectionRegistry } = require('./connections');
const { createProfileStore } = require('./profileStore');
const { createJsonStore } = require('./jsonStore');
const { createLayoutStore } = require('./layoutStore');
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

// One process owns the data files; launching the app again opens another
// window in it. Each main window has its own broker connections, which the
// registry keeps by connection id; every MQTT call and event names one.
const windows = new Map(); // webContents.id -> { win }
const childWindows = new Map(); // webContents.id -> { win, ownerId, connId, topics: Set, init } (see openChildWindow)
const registry = new ConnectionRegistry();
let profiles;
let stores;
let layouts;
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

// A connection named in an IPC call, if the sender's window owns it.
function connectionOf(e, connId) {
  const entry = registry.get(connId);
  if (!entry || entry.ownerId !== ownerIdOf(e.sender)) throw new Error('Unknown connection');
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

// Ends a connection; its pop-outs close with it.
function closeConnection(connId) {
  registry.close(connId);
  closeChildren((child) => child.connId === connId);
}

// A window closing, crashing or reloading ends all of its connections.
function closeConnectionsOf(ownerId) {
  registry.closeOwner(ownerId);
  closeChildren((child) => child.ownerId === ownerId);
}

function focusedMain() {
  const w = BrowserWindow.getFocusedWindow();
  return (w && ownerOf(w.webContents)) || windows.values().next().value || null;
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
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
  windows.set(id, { win });

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
  win.on('close', (e) => {
    if (flushed) return;
    e.preventDefault();
    flushed = true;
    const done = () => {
      clearTimeout(timer);
      ipcMain.off('app:flushed', onFlushed);
      if (!win.isDestroyed()) win.destroy();
    };
    const onFlushed = (ev) => ev.sender.id === id && done();
    ipcMain.on('app:flushed', onFlushed);
    const timer = setTimeout(done, 1500);
    win.webContents.send('app:flush');
  });
  win.on('closed', () => {
    windows.delete(id);
    closeConnectionsOf(id);
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
  ipcMain.handle('mqtt:connect', (e, connId, profile) => {
    connectionOf(e, connId);
    const res = registry.connect(connId, profile || {});
    // The other tab may be in this very window, which then shows it itself.
    if (res.duplicate) res.duplicate = { ...res.duplicate, sameWindow: res.duplicate.ownerId === ownerIdOf(e.sender) };
    return res;
  });
  // Brings the window that owns a connection forward and has it show that tab.
  ipcMain.handle('conn:focus', (e, connId) => {
    if (!windows.has(e.sender.id)) return;
    const win = windows.get(registry.get(connId)?.ownerId)?.win;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
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
  layouts = createLayoutStore({ stores, profileIds: () => profiles.load().map((p) => p.id) });
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
  if (!app.isPackaged) globalThis.__mqttscopeConnections = registry; // for tests, like __mqttscopeUpdater
  registerIpc();
  // Started by the Windows installer after Restart to update: that window comes to the front.
  frontAfterUpdate({ argv: process.argv, win: createMainWindow(), log });
  updater.start();
  // No check starts while the app shuts down.
  app.on('will-quit', () => updater.stop());
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
