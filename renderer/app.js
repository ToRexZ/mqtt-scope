// Main window: the shell around its connection tabs. It holds what the window
// shares (settings, shortcuts, the connection dialog, the update button, the
// tab strip), routes each broker event to the tab of its connection and draws
// the active tab. Each tab (connectionTab.js) is one connection with its own
// tree, inspector, plots and publisher; until it connects, the connection
// dialog is drawn in it.

import { ConnectionTab } from './connectionTab.js';
import { ConnectionDialog } from './connectionDialog.js';
import { closeMenu, menuOpen, showMenu, toast } from './ui.js';
import { DEFAULT_SETTINGS, normalizeSettings, openSettings } from './settings.js';
import { TabSet } from './tabSet.js';
import { TabStrip, dotState } from './tabStrip.js';
import { initUpdateButton } from './updateButton.js';
import { ACTIONS, bindingIndex, comboFromEvent, keyBelongsToTarget, pointerFocus, resolveBindings, toAccelerator } from './keys.js';

const api = window.api;
const $ = (sel) => document.querySelector(sel);

const RENDER_INTERVAL_MS = 120;
const RATE_INTERVAL_MS = 1000;

let settings = { ...DEFAULT_SETTINGS };
let bindings = resolveBindings({});
let keyIndex = bindingIndex(bindings);
const tabs = new Map(); // id → ConnectionTab
const order = new TabSet(); // the ids in strip order, and the active one
const stripTabs = () => order.ids().map((id) => tabs.get(id));
const activeTab = () => tabs.get(order.activeId) || null;
let dialogStatus = null; // the active tab's status the connection dialog last saw

function applySettings(next) {
  settings = next;
  for (const tab of tabs.values()) tab.applySettings(settings); // history limits apply to each tab
  bindings = resolveBindings(settings.keys);
  keyIndex = bindingIndex(bindings);
  // The menu shows the current shortcuts (the keys themselves are handled here).
  api.setMenuShortcuts?.(Object.fromEntries(ACTIONS.map((a) => [a.id, toAccelerator(bindings[a.id])])));
}

// The connection dialog, drawn in the active tab while that tab is a picker
// (see placeDialog).
const connections = new ConnectionDialog({
  api,
  getBinding: (id) => bindings[id],
  onProfilesChanged: () => checkTabs(),
});

// ------------------------------------------------------------------ tabs

// What a tab may ask of the window.
const shell = {
  getBinding: (id) => bindings[id],
  setSubscriptions: (profileId, subs) => connections.setSubscriptions(profileId, subs),
  savedProfile: (profile) => connections.profiles.find((p) => p.id === profile.id) || profile,
  showDuplicate: (tab, duplicate) => showDuplicate(tab, duplicate),
  savedMessagesChanged: (tab) => savedMessagesChanged(tab),
  onChange: () => refresh(),
};

const tabOf = (id) => tabs.get(id) || null;

const strip = new TabStrip($('.topbar'), {
  onActivate: (id) => activate(id),
  onClose: (id) => closeTab(id),
  onNew: () => newTab(),
  onContextMenu: (id, x, y) => tabMenu(id, x, y),
  onMove: (id, to) => {
    order.move(id, to);
    refresh();
  },
});
let opening = false;

// +, Mod+T and Mod+K: a New connection tab, whose content is the dialog.
async function newTab() {
  if (opening) return; // a double-click would make two tabs
  opening = true;
  try {
    await openTab();
  } finally {
    opening = false;
  }
}

// A tab gets its own connection in main; its id is the tab's id. A tab to
// connect takes its profile when connect() does; one open in another tab
// closes it again (see showDuplicate).
async function openTab({ profile = null, connect = false, activate: show = true } = {}) {
  const connId = await api.openConnection();
  const tab = new ConnectionTab({ api, connId, settings, shell });
  if (profile && !connect) tab.profile = { ...profile };
  tabs.set(connId, tab);
  savedSeen.set(connId, savedGen); // tab.load() reads them
  order.add(connId, { activate: false });
  if (show || !activeTab().active) activate(connId);
  refresh();
  await tab.load();
  if (profile && connect && tabOf(connId) === tab) await tab.connect(profile);
  return tab;
}

// A profile is open in one tab app-wide: connecting to it shows the tab that
// has it (in another window, that window comes forward). The tab that tried
// goes, unless it is its window's only one.
async function showDuplicate(tab, duplicate) {
  if (duplicate.sameWindow) activate(duplicate.connId);
  else api.focusConnection(duplicate.connId);
  if (tab.mode === 'picker' && tabs.size > 1) await closeTab(tab.connId);
}

// Each session tab compares its profile with the saved one (see checkSaved).
function checkTabs() {
  for (const tab of tabs.values()) tab.checkSaved();
}

// Closes the tab and its connection, after asking when its plots hold
// recorded data (a picker never has any). The window always keeps a tab:
// closing the last one opens a fresh one.
async function closeTab(id, { confirmed = false } = {}) {
  const tab = tabOf(id);
  if (!tab) return;
  if (tab.hasPlotData && !confirmed) {
    const ok = await api.confirm({
      message: `Close “${tab.label}”?`,
      detail: 'Its plots hold recorded data, which is lost when the tab closes. The plots themselves are kept.',
      okLabel: 'Close',
    });
    if (!ok || tabOf(id) !== tab) return;
  }
  tabs.delete(id);
  savedSeen.delete(id);
  order.remove(id); // an active tab's right neighbour becomes active, else its left one
  const saved = tab.flush(); // before dispose stops its save timer
  tab.dispose();
  // Reopen brings back what had worked: not a tab that never connected.
  if (tab.mode === 'session' && tab.profile) order.pushClosed({ profileId: tab.profile.id });
  if (order.activeId) activate(order.activeId); // draws it, unless it already is
  refresh();
  await Promise.allSettled([saved, api.closeConnection(id)]);
  if (!tabs.size) await openTab();
}

// Closes several tabs with one question when any of their plots holds data.
async function closeTabs(ids) {
  const list = ids.map(tabOf).filter(Boolean);
  if (list.some((t) => t.hasPlotData)) {
    const ok = await api.confirm({
      message: `Close ${list.length} tabs?`,
      detail: 'Some plots hold recorded data, which is lost when their tabs close. The plots themselves are kept.',
      okLabel: 'Close',
    });
    if (!ok) return;
  }
  for (const tab of list) if (tabOf(tab.connId) === tab) await closeTab(tab.connId, { confirmed: true });
}

// Opens the newest closed tab whose profile still exists, connected; its
// data starts empty.
async function reopenClosed() {
  for (let entry = order.popClosed(); entry; entry = order.popClosed()) {
    const profile = connections.profiles.find((p) => p.id === entry.profileId);
    if (!profile) continue;
    const open = stripTabs().find((t) => t.mode === 'session' && t.profile?.id === profile.id);
    if (open) {
      activate(open.connId);
      return open;
    }
    return openTab({ profile, connect: true });
  }
  return null;
}

function tabMenu(id, x, y) {
  const tab = tabOf(id);
  if (!tab) return;
  const others = order.othersOf(id);
  const right = order.rightOf(id);
  showMenu(x, y, [
    { label: 'Close', action: () => closeTab(id) },
    { label: 'Close other tabs', disabled: !others.length, action: () => closeTabs(others) },
    { label: 'Close tabs to the right', disabled: !right.length, action: () => closeTabs(right) },
    { label: 'Move to new window', disabled: true }, // enabled by moving tabs between windows
    'separator',
    // A tab that never connected has nothing to disconnect or resume.
    tab.canReconnect
      ? { label: 'Reconnect', action: () => tab.toggleConnection() }
      : { label: 'Disconnect', disabled: tab.status.state === 'disconnected', action: () => tab.toggleConnection() },
  ]);
}

// Draws the tab in the window. The tab shown is always the TabSet's active one.
function activate(id) {
  const tab = tabOf(id);
  if (!tab || tab.active) return;
  closeMenu(); // a menu of the tab being left would act on it
  const shown = activeTab();
  if (shown?.active) shown.deactivate();
  order.activate(id);
  tab.activate($('#tab-host'));
  refreshSaved(tab);
  refresh();
}

// The strip shows every tab; the window title and the connection dialog
// follow the active one.
function refresh() {
  const current = activeTab();
  strip.render(stripTabs().map((t) => ({ id: t.connId, label: t.label, state: dotState(t.status, t.everConnected), active: t === current })));
  if (current) {
    document.title = `MQTT Scope — ${current.label}`;
    if (current.status !== dialogStatus) {
      dialogStatus = current.status;
      connections.onStatus(current.status);
    }
  }
  placeDialog(current);
}

// The dialog is drawn in the active tab while it is a picker; Connect
// connects that tab, Cancel closes it, except the window's only tab. It takes
// the focus unless a dialog shows over the window (the Installing dialog).
function placeDialog(tab) {
  if (tab?.mode !== 'picker' || !tab.active) return connections.unmount();
  connections.mount(tab.pickerRoot, {
    closable: tabs.size > 1,
    failed: tab.failed,
    profileId: tab.profile?.id,
    focus: !document.querySelector('.modal-overlay'),
    onConnect: (profile) => tab.connect(profile),
    onCancel: () => closeTab(tab.connId),
  });
}

// Saved and recent messages are shared by all tabs (and windows). Each change
// bumps a generation; a tab reloads its copy when it is shown with an older
// one (reloading on every switch would reset its list's scroll).
let savedGen = 0;
const savedSeen = new Map(); // tab id → the generation its publisher shows

function savedMessagesChanged(byTab = null) {
  savedGen++;
  if (byTab) savedSeen.set(byTab.connId, savedGen); // its copy is what is saved
  const current = activeTab();
  if (current) refreshSaved(current);
}

function refreshSaved(tab) {
  if (savedSeen.get(tab.connId) === savedGen) return;
  savedSeen.set(tab.connId, savedGen);
  return tab.publisher.load();
}

// ------------------------------------------------------------------ events

api.onMessages((batch) => tabOf(batch.connId)?.ingestBatch(batch));
api.onStatus((event) => tabOf(event.connId)?.onStatus(event.status));
api.onWarning((event) => tabOf(event.connId)?.onWarning(event.message));
api.onActivateTab(({ connId }) => activate(connId)); // another window opened a profile this one has

// Hidden tabs record but are not drawn; message rates count for every tab.
setInterval(() => activeTab()?.render(), RENDER_INTERVAL_MS);
setInterval(() => {
  for (const tab of tabs.values()) tab.tickRate();
}, RATE_INTERVAL_MS);

// The main process asks for this before closing the window.
api.onFlush(async () => {
  await Promise.allSettled([connections.flush(), ...stripTabs().map((t) => t.flush())]);
  api.flushed();
});

api.onMenu((action) => {
  if (updates.installing()) return; // nothing opens over the Installing dialog
  if (document.querySelector('.modal-overlay')) return;
  handlerFor(action)?.();
});

// Another window saved shared data: pick up its changes.
api.onStoreChanged(async (name) => {
  if (name === 'profiles') {
    await connections.reload();
    checkTabs();
  }
  else if (name === 'savedMessages') savedMessagesChanged();
  else if (name === 'plotTabs') await Promise.all(stripTabs().map((t) => t.plots.reload()));
  else if (name === 'settings') applySettings(normalizeSettings(await api.storeGet('settings')));
});

window.addEventListener('error', (e) => toast(`Unexpected error: ${e.message}`, 'error'));
window.addEventListener('unhandledrejection', (e) => toast(`Unexpected error: ${e.reason?.message || e.reason}`, 'error'));

// ------------------------------------------------------------------ chrome

$('#btn-settings').addEventListener('click', () => showSettings());
const updates = initUpdateButton(api, $('#btn-update'));

async function showSettings(page) {
  const next = await openSettings(api, settings, { tab: page });
  if (next) applySettings(next);
}

// ------------------------------------------------------------------ keyboard

// Shortcuts of the window (see keys.js; rebindable in Settings → Keyboard).
// The others act on the active tab (ConnectionTab.handlerFor).
const goTo = (id) => id && activate(id);
const WINDOW_ACTIONS = {
  // A tab that connected belongs to its profile: another broker gets a new
  // tab. A picker already shows the dialog.
  connections: () => (activeTab()?.mode === 'picker' ? connections.focus() : newTab()),
  newTab: () => newTab(),
  closeTab: () => closeTab(order.activeId),
  reopenTab: () => reopenClosed(),
  nextTab: () => goTo(order.next(1)),
  prevTab: () => goTo(order.next(-1)),
  nextTabAlt: () => goTo(order.next(1)),
  prevTabAlt: () => goTo(order.next(-1)),
  goToLastTab: () => goTo(order.last()),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`goToTab${n}`, () => goTo(order.nth(n))])),
  newWindow: () => api.newWindow(),
  settings: () => showSettings(),
  keyboardSettings: () => showSettings('keyboard'),
};
const handlerFor = (action) => WINDOW_ACTIONS[action] || activeTab()?.handlerFor(action);

// Esc closes a New connection tab (not the window's only one) wherever the
// focus is, unless a menu, the update panel or a dialog is open: Esc closes
// that. Caught before anything else sees it, while those are still open.
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || e.isComposing || menuOpen() || updates.panelOpen() || document.querySelector('.modal-overlay')) return;
    if (!connections.cancel()) return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

// The connection dialog is part of its tab, not a dialog over the window, so
// shortcuts work in it (its fields keep their plain keys).
const isPointerFocused = pointerFocus(document);
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-overlay')) return; // dialogs handle their own keys
  if (e.key === 'Escape' && activeTab()?.handleEscape()) return;
  const combo = comboFromEvent(e);
  const action = combo && keyIndex.get(combo);
  const handler = action && handlerFor(action);
  if (!handler) return;
  if (keyBelongsToTarget(combo, e.target, isPointerFocused(e.target))) return; // e.g. typing, or Space pressing a focused button
  if (action === 'publish' && !e.target.closest?.('.publisher')) return;
  e.preventDefault();
  handler(e);
});

// ------------------------------------------------------------------ start

const [saved] = await Promise.all([api.storeGet('settings').catch(() => null), connections.load()]);
applySettings(normalizeSettings(saved));
await openTab();

// Exposed for end-to-end tests and debugging from DevTools. The views are
// the active tab's.
window.__mqttscope = {
  get tree() {
    return activeTab()?.tree;
  },
  get treeView() {
    return activeTab()?.treeView;
  },
  get viewer() {
    return activeTab()?.viewer;
  },
  get plots() {
    return activeTab()?.plots;
  },
  get publisher() {
    return activeTab()?.publisher;
  },
  get status() {
    return activeTab()?.status;
  },
  connections,
  get settings() {
    return settings;
  },
  shell: {
    get tabs() {
      return stripTabs();
    },
    get active() {
      return activeTab();
    },
    openTab,
    closeTab,
    closeTabs,
    reopenClosed,
    activate,
  },
};
