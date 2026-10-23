'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // A window can hold several broker connections; main gives each an id
  // (see renderer/tabApi.js), and every MQTT call and event names one.
  openConnection: () => ipcRenderer.invoke('conn:open'),
  closeConnection: (connId) => ipcRenderer.invoke('conn:close', connId),
  // A profile is open in at most one tab app-wide: openProfiles() are the ids
  // of those. focusConnection shows a tab of any window; its window answers
  // with onActivateTab.
  focusConnection: (connId) => ipcRenderer.invoke('conn:focus', connId),
  openProfiles: () => ipcRenderer.invoke('conn:openProfiles'),
  onOpenProfilesChanged: (cb) => ipcRenderer.on('conn:openProfilesChanged', (_e, ids) => cb(ids)),
  onActivateTab: (cb) => ipcRenderer.on('tabs:activate', (_e, data) => cb(data)),
  connect: (connId, profile) => ipcRenderer.invoke('mqtt:connect', connId, profile),
  disconnect: (connId) => ipcRenderer.invoke('mqtt:disconnect', connId),
  status: (connId) => ipcRenderer.invoke('mqtt:status', connId),
  publish: (connId, msg) => ipcRenderer.invoke('mqtt:publish', connId, msg),
  subscribe: (connId, topic, qos) => ipcRenderer.invoke('mqtt:subscribe', connId, { topic, qos }),
  unsubscribe: (connId, topic) => ipcRenderer.invoke('mqtt:unsubscribe', connId, topic),
  subscriptions: (connId) => ipcRenderer.invoke('mqtt:subscriptions', connId),
  // { connId, messages, dropped }, { connId, status }, { connId, message }
  onMessages: (cb) => ipcRenderer.on('mqtt:messages', (_e, data) => cb(data)),
  onStatus: (cb) => ipcRenderer.on('mqtt:status', (_e, data) => cb(data)),
  onWarning: (cb) => ipcRenderer.on('mqtt:warning', (_e, data) => cb(data)),
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

  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  pickFile: (title) => ipcRenderer.invoke('dialog:pickFile', title),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
  saveFile: (defaultName, data) => ipcRenderer.invoke('file:save', { defaultName, data }),
  readFileBytes: () => ipcRenderer.invoke('file:readBytes'),

  openPopout: ({ connId, topic, title, history }) => ipcRenderer.invoke('popout:open', { connId, topic, title, history }),
  popoutInit: () => ipcRenderer.invoke('child:init'),
  openPlotWindow: (init) => ipcRenderer.invoke('plotwin:open', init), // { connId, title, plot, data, tabName }
  plotWindowInit: () => ipcRenderer.invoke('child:init'),
  resetChildWindows: (connId) => ipcRenderer.send('children:reset', connId),
  onReset: (cb) => ipcRenderer.on('app:reset', () => cb()),
});
