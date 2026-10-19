'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, safeStorage, session: electronSession, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { MqttSession } = require('./mqttSession');
const { createProfileStore } = require('./profileStore');
const { createJsonStore } = require('./jsonStore');
const log = require('./log');

// Lets tests (and portable installs) keep their data in a chosen directory.
if (process.env.MQTTSCOPE_USER_DATA) app.setPath('userData', process.env.MQTTSCOPE_USER_DATA);

const ICON = path.join(__dirname, 'icon.png');
const MAX_FILE_BYTES = 256 * 1024 * 1024; // the MQTT payload limit

// One process owns the data files; launching the app again opens another
// window in it. Each main window has its own broker connection.
const windows = new Map(); // webContents.id -> { win, session }
const popouts = new Map(); // webContents.id -> { win, topic, ownerId, init }
let profiles;
let stores;
let quitting = false;

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

// The main window an IPC sender belongs to (a pop-out belongs to its opener).
function ownerOf(sender) {
  const own = windows.get(sender.id);
  if (own) return own;
  const pop = popouts.get(sender.id);
  return pop ? windows.get(pop.ownerId) || null : null;
}

function sessionOf(e) {
  const owner = ownerOf(e.sender);
  if (!owner) throw new Error('Unknown window');
  return owner.session;
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
  const session = new MqttSession();
  windows.set(id, { win, session });
  const send = (channel, data) => !win.isDestroyed() && win.webContents.send(channel, data);

  session.on('status', (status) => {
    if (status.state === 'error') log.warn('mqtt', status.url || '', status.error);
    send('mqtt:status', status);
  });
  session.on('warning', (message) => send('mqtt:warning', message));
  session.on('batch', (batch) => {
    send('mqtt:messages', batch);
    for (const pop of popouts.values()) {
      if (pop.ownerId !== id || pop.win.isDestroyed()) continue;
      const mine = batch.messages.filter((m) => m.topic === pop.topic);
      if (mine.length) pop.win.webContents.send('mqtt:messages', { messages: mine, dropped: 0 });
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('render-process-gone', async (_e, details) => {
    log.error('renderer gone', details);
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    session.disconnect();
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
    let timer;
    const done = () => {
      clearTimeout(timer);
      ipcMain.off('app:flushed', onFlushed);
      if (!win.isDestroyed()) win.destroy();
    };
    const onFlushed = (ev) => ev.sender.id === id && done();
    ipcMain.on('app:flushed', onFlushed);
    timer = setTimeout(done, 1500);
    win.webContents.send('app:flush');
  });
  win.on('closed', () => {
    windows.delete(id);
    session.disconnect();
    for (const pop of popouts.values()) if (pop.ownerId === id && !pop.win.isDestroyed()) pop.win.close();
    // A quit (e.g. Cmd+Q) was paused by the flush above; resume it.
    if (quitting) app.quit();
  });
  return win;
}

// Tells the other main windows that shared data changed so they reload it.
function broadcastChange(fromId, name) {
  for (const [id, { win }] of windows) if (id !== fromId && !win.isDestroyed()) win.webContents.send('store:changed', name);
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

function registerIpc() {
  const parent = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('mqtt:connect', (e, profile) => sessionOf(e).connect(profile || {}));
  ipcMain.handle('mqtt:disconnect', (e) => sessionOf(e).disconnect());
  ipcMain.handle('mqtt:status', (e) => sessionOf(e).status);
  ipcMain.handle('mqtt:publish', (e, msg) => sessionOf(e).publish(msg));
  ipcMain.handle('mqtt:subscribe', (e, { topic, qos } = {}) => sessionOf(e).subscribe(topic, qos));
  ipcMain.handle('mqtt:unsubscribe', (e, topic) => sessionOf(e).unsubscribe(topic));
  ipcMain.handle('mqtt:subscriptions', (e) => sessionOf(e).subscriptions.map((s) => ({ ...s })));

  ipcMain.handle('profiles:list', () => profiles.load());
  ipcMain.handle('profiles:save', (e, list) => {
    const res = profiles.save(list);
    broadcastChange(e.sender.id, 'profiles');
    return res;
  });
  ipcMain.handle('profiles:security', () => storageSecurity());
  ipcMain.handle('store:get', (_e, name) => stores.get(name));
  ipcMain.handle('store:set', (e, name, value) => {
    const res = stores.set(name, value);
    broadcastChange(e.sender.id, name);
    return res;
  });

  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

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

  ipcMain.handle('popout:open', (e, { topic, history } = {}) => {
    const owner = ownerOf(e.sender);
    if (!owner || typeof topic !== 'string') return;
    const win = new BrowserWindow({
      width: 1200,
      height: 900,
      title: topic,
      backgroundColor: '#0f1115',
      autoHideMenuBar: true,
      icon: ICON,
      show: !process.env.MQTTSCOPE_HIDDEN,
      webPreferences: webPreferences(),
    });
    hardenWindow(win);
    const id = win.webContents.id;
    popouts.set(id, { win, topic, ownerId: owner.win.webContents.id, init: { topic, history: Array.isArray(history) ? history : [] } });
    win.on('closed', () => popouts.delete(id));
    win.loadFile(path.join(__dirname, '..', 'renderer', 'popout.html'));
  });

  ipcMain.handle('popout:init', (e) => {
    const entry = popouts.get(e.sender.id);
    if (!entry) return null;
    const { init } = entry;
    entry.init = null; // the window keeps its own copy; free this one
    return init;
  });
}

function buildMenu() {
  const toRenderer = (action) => () => {
    const w = focusedMain();
    if (w && !w.win.isDestroyed()) w.win.webContents.send('menu', action);
  };
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createMainWindow() },
        { label: 'Connections…', accelerator: 'CmdOrCtrl+K', click: toRenderer('connections') },
        { label: 'Subscriptions…', accelerator: 'CmdOrCtrl+Shift+S', click: toRenderer('subscriptions') },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: toRenderer('settings') },
        { type: 'separator' },
        { label: 'Open Data Folder', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // F11 is handled in the renderer; shown here only as a hint.
        { label: 'Maximize Inspector', accelerator: 'F11', registerAccelerator: false, click: toRenderer('maximize') },
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function start() {
  const userData = app.getPath('userData');
  log.init(path.join(userData, 'logs'));
  log.info(`start ${app.getVersion()} electron ${process.versions.electron} ${process.platform}`);
  // The UI needs no web permissions (camera, notifications, …).
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);
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
  registerIpc();
  createMainWindow();
  app.on('activate', () => {
    if (windows.size === 0) createMainWindow();
  });
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => app.isReady() && createMainWindow());
  app.on('before-quit', () => (quitting = true));
  app.whenReady().then(start);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
} else {
  app.quit();
}
