// Main window: the shell around its connection tabs. It holds what the window
// shares (settings, shortcuts, the connection dialog, the update button),
// routes each broker event to the tab of its connection and draws the active
// tab. Each tab (connectionTab.js) is one connection with its own tree,
// inspector, plots and publisher.

import { ConnectionTab, STATE_LABELS } from './connectionTab.js';
import { ConnectionDialog } from './connectionDialog.js';
import { closeMenu, toast } from './ui.js';
import { DEFAULT_SETTINGS, normalizeSettings, openSettings } from './settings.js';
import { initUpdateButton } from './updateButton.js';
import { ACTIONS, bindingIndex, comboFromEvent, keyBelongsToTarget, pointerFocus, resolveBindings, toAccelerator } from './keys.js';

const api = window.api;
const $ = (sel) => document.querySelector(sel);

const RENDER_INTERVAL_MS = 120;
const RATE_INTERVAL_MS = 1000;

let settings = { ...DEFAULT_SETTINGS };
let bindings = resolveBindings({});
let keyIndex = bindingIndex(bindings);
const tabs = []; // in strip order
let active = null;
let dialogStatus = null; // the active tab's status the connection dialog last saw

function applySettings(next) {
  settings = next;
  for (const tab of tabs) tab.applySettings(settings); // history limits apply to each tab
  bindings = resolveBindings(settings.keys);
  keyIndex = bindingIndex(bindings);
  // The menu shows the current shortcuts (the keys themselves are handled here).
  api.setMenuShortcuts?.(Object.fromEntries(ACTIONS.map((a) => [a.id, toAccelerator(bindings[a.id])])));
}

// The connection dialog connects the active tab.
const connections = new ConnectionDialog({
  api,
  getBinding: (id) => bindings[id],
  onConnect: (profile) => active?.connect(profile),
});

// ------------------------------------------------------------------ tabs

// What a tab may ask of the window.
const shell = {
  getBinding: (id) => bindings[id],
  showConnections: () => connections.open(),
  connectionsOpen: () => connections.isOpen(),
  setSubscriptions: (profileId, subs) => connections.setSubscriptions(profileId, subs),
  onChange: (tab) => tab === active && showActive(),
};

const tabOf = (id) => tabs.find((t) => t.connId === id) || null;

// A tab gets its own connection in main; its id is the tab's id.
async function openTab({ profile = null, connect = false, activate: show = true } = {}) {
  const connId = await api.openConnection();
  const tab = new ConnectionTab({ api, connId, settings, shell });
  if (profile) tab.profile = { ...profile };
  tabs.push(tab);
  if (show || !active) activate(connId);
  await tab.load();
  if (profile && connect) await tab.connect(profile);
  return tab;
}

// Closes the tab and its connection. The window always keeps a tab: closing
// the last one opens a fresh one.
async function closeTab(id) {
  const tab = tabOf(id);
  if (!tab) return;
  const index = tabs.indexOf(tab);
  tabs.splice(index, 1);
  const saved = tab.flush(); // before dispose stops its save timer
  tab.dispose();
  if (tab === active) {
    active = null;
    // The neighbour on the right takes its place, else the one on the left.
    const next = tabs[index] || tabs[index - 1];
    if (next) activate(next.connId);
  }
  await Promise.allSettled([saved, api.closeConnection(id)]);
  if (!tabs.length) {
    await openTab();
    if (!updates.installing()) connections.open();
  }
}

function activate(id) {
  const tab = tabOf(id);
  if (!tab || tab === active) return;
  closeMenu(); // a menu of the tab being left would act on it
  active?.deactivate();
  active = tab;
  tab.activate($('#tab-host'));
  // Saved and recent messages are shared; another tab may have changed them.
  tab.publisher.load();
  showActive();
}

// The connection button and the dialog follow the active tab.
function showActive() {
  const s = active.status;
  const name = active.profile?.name || '';
  const label = s.state === 'connected' ? name : `${name ? `${name} · ` : ''}${STATE_LABELS[s.state] || s.state}`;
  $('#conn-label').textContent = label || 'Not connected';
  $('#btn-connections').dataset.state = s.state;
  if (s !== dialogStatus) {
    dialogStatus = s;
    connections.onStatus(s);
  }
}

// ------------------------------------------------------------------ events

api.onMessages((batch) => tabOf(batch.connId)?.ingestBatch(batch));
api.onStatus((event) => tabOf(event.connId)?.onStatus(event.status));
api.onWarning((event) => tabOf(event.connId)?.onWarning(event.message));

// Hidden tabs record but are not drawn; message rates count for every tab.
setInterval(() => active?.render(), RENDER_INTERVAL_MS);
setInterval(() => {
  for (const tab of tabs) tab.tickRate();
}, RATE_INTERVAL_MS);

// The main process asks for this before closing the window.
api.onFlush(async () => {
  await Promise.allSettled([connections.flush(), ...tabs.map((t) => t.flush())]);
  api.flushed();
});

api.onMenu((action) => {
  if (updates.installing()) return; // nothing opens over the Installing dialog
  if (document.querySelector('.modal-overlay') && action !== 'connections') return;
  handlerFor(action)?.();
});

// Another window saved shared data: pick up its changes.
api.onStoreChanged(async (name) => {
  if (name === 'profiles') await connections.reload();
  else if (name === 'savedMessages') await Promise.all(tabs.map((t) => t.publisher.load()));
  else if (name === 'plotTabs') await Promise.all(tabs.map((t) => t.plots.reload()));
  else if (name === 'settings') applySettings(normalizeSettings(await api.storeGet('settings')));
});

window.addEventListener('error', (e) => toast(`Unexpected error: ${e.message}`, 'error'));
window.addEventListener('unhandledrejection', (e) => toast(`Unexpected error: ${e.reason?.message || e.reason}`, 'error'));

// ------------------------------------------------------------------ chrome

$('#btn-connections').addEventListener('click', () => connections.open());
$('#btn-settings').addEventListener('click', () => showSettings());
const updates = initUpdateButton(api, $('#btn-update'));

async function showSettings(page) {
  const next = await openSettings(api, settings, { tab: page });
  if (next) applySettings(next);
}

// ------------------------------------------------------------------ keyboard

// Shortcuts of the window (see keys.js; rebindable in Settings → Keyboard).
// The others act on the active tab (ConnectionTab.handlers).
const WINDOW_ACTIONS = {
  connections: () => connections.open(),
  newWindow: () => api.newWindow(),
  settings: () => showSettings(),
  keyboardSettings: () => showSettings('keyboard'),
};
const handlerFor = (action) => WINDOW_ACTIONS[action] || active?.handlers[action];

const isPointerFocused = pointerFocus(document);
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-overlay')) return; // dialogs handle their own keys
  if (e.key === 'Escape' && active?.handleEscape()) return;
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
    return active?.tree;
  },
  get treeView() {
    return active?.treeView;
  },
  get viewer() {
    return active?.viewer;
  },
  get plots() {
    return active?.plots;
  },
  get publisher() {
    return active?.publisher;
  },
  get status() {
    return active?.status;
  },
  connections,
  get settings() {
    return settings;
  },
  shell: {
    get tabs() {
      return [...tabs];
    },
    get active() {
      return active;
    },
    openTab,
    closeTab,
    activate,
  },
};

if (active.status.state === 'disconnected' && !updates.installing()) connections.open();
