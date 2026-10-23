'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  connect: (profile) => ipcRenderer.invoke('mqtt:connect', profile),
  disconnect: () => ipcRenderer.invoke('mqtt:disconnect'),
  status: () => ipcRenderer.invoke('mqtt:status'),
  publish: (msg) => ipcRenderer.invoke('mqtt:publish', msg),
  subscribe: (topic, qos) => ipcRenderer.invoke('mqtt:subscribe', { topic, qos }),
  unsubscribe: (topic) => ipcRenderer.invoke('mqtt:unsubscribe', topic),
  subscriptions: () => ipcRenderer.invoke('mqtt:subscriptions'),
  onMessages: (cb) => ipcRenderer.on('mqtt:messages', (_e, data) => cb(data)),
  onStatus: (cb) => ipcRenderer.on('mqtt:status', (_e, status) => cb(status)),
  onWarning: (cb) => ipcRenderer.on('mqtt:warning', (_e, message) => cb(message)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  onFlush: (cb) => ipcRenderer.on('app:flush', () => cb()),
  newWindow: () => ipcRenderer.invoke('app:newWindow'),
  setMenuShortcuts: (map) => ipcRenderer.send('menu:shortcuts', map),
  flushed: () => ipcRenderer.send('app:flushed'),

  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfiles: (list) => ipcRenderer.invoke('profiles:save', list),
  profileSecurity: () => ipcRenderer.invoke('profiles:security'),
  onStoreChanged: (cb) => ipcRenderer.on('store:changed', (_e, name) => cb(name)),
  storeGet: (name) => ipcRenderer.invoke('store:get', name),
  storeSet: (name, value) => ipcRenderer.invoke('store:set', name, value),

  // Update state lives in main. Register onUpdateState before reading
  // updateState(), so no change falls between the two.
  updateState: () => ipcRenderer.invoke('update:state'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, state) => cb(state)),
  onUpdateChecked: (cb) => ipcRenderer.on('update:checked', (_e, result) => cb(result)),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateRestart: (force) => ipcRenderer.invoke('update:restart', force === true),
  updateSkip: () => ipcRenderer.invoke('update:skip'),
  updateOpenRelease: () => ipcRenderer.invoke('update:openRelease'),
  // The Settings footer: main builds every path itself.
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  showLogFile: () => ipcRenderer.invoke('app:showLogFile'),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),

  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  pickFile: (title) => ipcRenderer.invoke('dialog:pickFile', title),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
  saveFile: (defaultName, data) => ipcRenderer.invoke('file:save', { defaultName, data }),
  readFileBytes: () => ipcRenderer.invoke('file:readBytes'),

  openPopout: (topic, history) => ipcRenderer.invoke('popout:open', { topic, history }),
  popoutInit: () => ipcRenderer.invoke('child:init'),
  openPlotWindow: (init) => ipcRenderer.invoke('plotwin:open', init),
  plotWindowInit: () => ipcRenderer.invoke('child:init'),
  resetChildWindows: () => ipcRenderer.send('children:reset'),
  onReset: (cb) => ipcRenderer.on('app:reset', () => cb()),
});
