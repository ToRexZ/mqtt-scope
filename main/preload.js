'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Main asks a window for something on `channel` ({ reqId, ...request });
// cb(request) returns a promise, whose result or error goes back to main.
// sent(request) runs once the result went, in the same task: a result that
// cannot be sent (or copied out of the page) goes back as an error instead.
function answer(channel, cb, sent) {
  ipcRenderer.on(channel, async (_e, { reqId, ...request }) => {
    try {
      ipcRenderer.send('tab:reply', { reqId, result: await cb(request) });
    } catch (err) {
      ipcRenderer.send('tab:reply', { reqId, error: String(err?.message || err) });
      return;
    }
    sent?.(request);
  });
}

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
  // A tab reopened at launch that the user had disconnected holds its profile
  // without connecting; answers like connect.
  bind: (connId, profile) => ipcRenderer.invoke('conn:bind', connId, profile),
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
  // What to open the window with, asked once, with the window's id: the tabs
  // of the last run { windowId, tabs: [{ profileId, connected }], active },
  // { windowId, tabs: [], adopt: true } for a window a tab moves into, or
  // { windowId } for a New connection tab. The window reports its tabs on
  // every change, for the next launch.
  initialTabs: () => ipcRenderer.invoke('tabs:init'),
  reportTabs: (state) => ipcRenderer.send('tabs:report', state),
  // Moving a tab with its connection to another main window (main/tabMove.js):
  // main asks the window it leaves for its state { connId, drop } (answer
  // { state, index, active }; exported(request) once that went to main, and
  // the tab goes) and has the window it joins build it { connId, state,
  // index, activate }. tearOffTab: into a new window of its own.
  tearOffTab: (connId) => ipcRenderer.invoke('tabs:tearOff', { connId }),
  // Dragging a tab (main/tabDrag.js): the window it starts in reports its
  // start and its end (whether the pointer was over that window then), other
  // windows the drag over their top bar (now and then), the window it is
  // dropped on the drop at { index } of its strip. Every window hears
  // onTabDragging({ connId }) at the start and (null) at the end.
  tabDragStart: (connId) => ipcRenderer.invoke('tabs:dragStart', connId),
  tabDragHover: () => ipcRenderer.send('tabs:dragHover'),
  tabDrop: (drop) => ipcRenderer.invoke('tabs:drop', { index: drop?.index }),
  tabDragEnd: (end) => ipcRenderer.invoke('tabs:dragEnd', { overSource: end?.overSource }),
  onTabDragging: (cb) => ipcRenderer.on('tabs:dragging', (_e, data) => cb(data)),
  onTabExport: (cb, exported) => answer('tab:export', cb, exported),
  onTabImport: (cb) => answer('tab:import', cb),
  setMenuShortcuts: (map) => ipcRenderer.send('menu:shortcuts', map),
  flushed: () => ipcRenderer.send('app:flushed'),

  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfiles: (list) => ipcRenderer.invoke('profiles:save', list),
  profileSecurity: () => ipcRenderer.invoke('profiles:security'),
  // [{ id, host, port }] -> { [id]: { online, error } } (main/brokerProbe.js);
  // `first` goes before the probes already waiting
  probeBrokers: (targets, first = false) => ipcRenderer.invoke('profiles:probe', targets, first),
  onStoreChanged: (cb) => ipcRenderer.on('store:changed', (_e, name) => cb(name)),
  storeGet: (name) => ipcRenderer.invoke('store:get', name),
  storeSet: (name, value) => ipcRenderer.invoke('store:set', name, value),
  // The plot tabs of a profile (main/layoutStore.js): { doc, legacy }.
  layoutGet: (profileId) => ipcRenderer.invoke('layouts:get', profileId),
  layoutSet: (profileId, doc) => ipcRenderer.invoke('layouts:set', profileId, doc),

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

  openPopout: ({ connId, topic, title, history }) => ipcRenderer.invoke('popout:open', { connId, topic, title, history }),
  popoutInit: () => ipcRenderer.invoke('child:init'),
  openPlotWindow: (init) => ipcRenderer.invoke('plotwin:open', init), // { connId, title, plot, data, tabName }
  plotWindowInit: () => ipcRenderer.invoke('child:init'),
  resetChildWindows: (connId) => ipcRenderer.send('children:reset', connId),
  onReset: (cb) => ipcRenderer.on('app:reset', () => cb()),
});
