// Main window: wires the topic tree, inspector, plots, publisher and the
// connection manager to the MQTT session in the main process.

import { TopicTree } from './topicTree.js';
import { TreeView } from './treeView.js';
import { MessageViewer } from './viewer.js';
import { PlotsPanel } from './plots.js';
import { Publisher } from './publisher.js';
import { ConnectionDialog } from './connectionDialog.js';
import { showMenu, splitter, toast } from './ui.js';
import { decode, extractNumber, hexDump } from './payload.js';
import { DEFAULT_SETTINGS, normalizeSettings, openSettings } from './settings.js';
import { hasNumbers } from './fields.js';
import { openSubscriptions } from './subscriptionsDialog.js';
import { initUpdateButton } from './updateButton.js';
import { ACTIONS, bindingIndex, comboFromEvent, keyBelongsToTarget, pointerFocus, resolveBindings, toAccelerator } from './keys.js';

const api = window.api;
const $ = (sel) => document.querySelector(sel);

const PAUSE_QUEUE_LIMIT = 200000;
const PAUSE_QUEUE_BYTES = 256 * 1024 * 1024;
const RENDER_INTERVAL_MS = 120;
const DELETE_ECHO_MS = 5000;

let settings = { ...DEFAULT_SETTINGS };
let bindings = resolveBindings({});
let keyIndex = bindingIndex(bindings);
const tree = new TopicTree();
applySettings(settings);

function applySettings(next) {
  settings = next;
  tree.historyLimit = settings.historyLimit;
  tree.historyBytes = settings.historyMB * 1024 * 1024;
  tree.trimHistories();
  bindings = resolveBindings(settings.keys);
  keyIndex = bindingIndex(bindings);
  // The menu shows the current shortcuts (the keys themselves are handled here).
  api.setMenuShortcuts?.(Object.fromEntries(ACTIONS.map((a) => [a.id, toAccelerator(bindings[a.id])])));
}
let selected = null;
let selectedDirty = false;
let treeDirty = false;
let paused = false;
let pauseQueue = [];
let pauseBytes = 0;
let rateCount = 0;
let lastMessageAt = 0;
let droppedTotal = 0;
let status = { state: 'disconnected' };
let activeProfile = null;
let lastErrorToast = null;
const pendingDeletes = new Map(); // topic -> expiry; swallows the broker echo of our own delete

// ------------------------------------------------------------------ views

const treeView = new TreeView($('#tree-scroll'), tree, {
  onSelect: selectNode,
  onContextMenu: treeMenu,
});
treeView.setEmptyText('Not connected. Click the connection button above.');

const viewer = new MessageViewer($('#viewer-host'), {
  api,
  onMaximize: toggleMaximize,
  onPopout: (node) => api.openPopout(node.path, node.history.map(stripMessage)),
  onUseInPublisher: (topic, msg) => publisher.loadMessage(topic, msg),
  onSelectTopic: (node) => {
    treeView.reveal(node);
    treeView.select(node);
  },
  plotMenuItems: (topic, segs) => plots.menuItems(topic, segs),
});

const plots = new PlotsPanel($('#plots-host'), {
  api,
  getHistory: (topic) => tree.find(topic)?.history || [],
  getTopicNodes: () => tree.root.topics(),
  onCountChange: (n) => ($('#plot-count').textContent = n ? String(n) : ''),
  onAdded: () => showTab('plots'),
});

const publisher = new Publisher($('#publisher-host'), {
  api,
  getTopics: topicSuggestions,
  getSelectedTopic: () => selected?.path ?? null,
  onToggle: (collapsed) => $('#right').classList.toggle('pub-collapsed', collapsed),
});

const connections = new ConnectionDialog({
  api,
  getBinding: (id) => bindings[id],
  onConnect: async (profile) => {
    // A different broker means a different topic space; reconnecting to the same one keeps the tree.
    const brokerKey = (p) => p && `${p.id}|${p.protocol}|${p.host}|${p.port}|${p.wsPath || ''}`;
    if (brokerKey(activeProfile) !== brokerKey(profile)) clearTree();
    activeProfile = { ...profile };
    const res = await api.connect(profile);
    if (!res.ok) toast(res.error, 'error');
  },
});

function stripMessage(m) {
  return { topic: m.topic, payload: m.payload, qos: m.qos, retain: m.retain, ts: m.ts, props: m.props };
}

function topicSuggestions(prefix) {
  const q = (prefix || '').toLowerCase();
  const out = [];
  for (const node of tree.root.topics()) {
    if (!q || node.path.toLowerCase().includes(q)) out.push(node.path);
    if (out.length >= 200) break;
  }
  return out;
}

// ------------------------------------------------------------------ messages

api.onMessages(({ messages, dropped }) => {
  if (dropped) droppedTotal += dropped;
  if (paused) {
    for (const m of messages) {
      pauseQueue.push(m);
      pauseBytes += m.payload.length;
    }
    // Keep the newest messages within the caps; older ones are dropped and counted.
    let drop = 0;
    while (pauseQueue.length - drop > PAUSE_QUEUE_LIMIT || (pauseBytes > PAUSE_QUEUE_BYTES && pauseQueue.length - drop > 1)) {
      pauseBytes -= pauseQueue[drop++].payload.length;
    }
    if (drop) {
      droppedTotal += drop;
      pauseQueue = pauseQueue.slice(drop);
    }
    return;
  }
  ingest(messages);
});

function ingest(messages) {
  const now = Date.now();
  for (const m of messages) {
    if (m.payload.length === 0 && pendingDeletes.has(m.topic)) {
      pendingDeletes.delete(m.topic);
      continue;
    }
    const node = tree.addMessage(m);
    plots.ingest(m);
    // A selected branch (no message of its own) shows its children's values.
    if (node === selected || (selected && !selected.messageCount && m.topic.startsWith(`${selected.path}/`))) selectedDirty = true;
  }
  for (const [topic, expiry] of pendingDeletes) if (expiry < now) pendingDeletes.delete(topic);
  rateCount += messages.length;
  lastMessageAt = now;
  treeDirty = true;
}

setInterval(() => {
  if (treeDirty) {
    treeDirty = false;
    treeView.refresh();
  } else if (Date.now() - lastMessageAt < 1500) {
    treeView.renderViewport(); // fade out update highlights
  }
  if (selectedDirty) {
    selectedDirty = false;
    viewer.update();
  }
  updateStats();
}, RENDER_INTERVAL_MS);

let rate = 0;
setInterval(() => {
  rate = rateCount;
  rateCount = 0;
}, 1000);

function updateStats() {
  $('#stat-topics').textContent = `${tree.topicCount.toLocaleString()} topics`;
  $('#stat-msgs').textContent = `${tree.messageCount.toLocaleString()} messages`;
  $('#stat-rate').textContent = paused ? `paused · ${pauseQueue.length.toLocaleString()} queued` : `${rate.toLocaleString()} msg/s`;
  const dropEl = $('#status-dropped');
  dropEl.hidden = !droppedTotal;
  dropEl.textContent = `${droppedTotal.toLocaleString()} messages dropped (too fast)`;
}

// Ctrl+R: start over without reconnecting — forget received messages and
// restart every plot's timeline.
function reloadSession() {
  clearTree();
  plots.reset();
  api.resetChildWindows?.(); // pop-out windows start over too
  droppedTotal = 0;
  rateCount = 0;
  rate = 0;
  updateStats();
  toast('Cleared received messages and restarted the plots');
}

function clearTree() {
  tree.clear();
  selected = null;
  pauseQueue = [];
  pauseBytes = 0;
  treeView.selected = null;
  viewer.source = null;
  viewer.render(true);
  treeView.refresh();
  $('#status-selected').textContent = '';
}

// ------------------------------------------------------------------ selection

function selectNode(node, source) {
  // Clicking a topic opens it one level so its sub-topics show (Settings → General).
  if (source === 'click' && settings.autoExpand && node.children.size && !node.expanded) {
    node.expanded = true;
    treeView.refresh();
  }
  selected = node;
  viewer.show(node);
  publisher.setTopic(node.path);
  $('#status-selected').textContent = node.path;
}

// Only topics that were received as retained are offered: deleting publishes
// an empty message, which every current subscriber of the topic receives.
async function deleteRetained(nodes, what) {
  const topics = nodes.map((n) => n.path);
  const shown = topics.slice(0, 15).join('\n');
  const more = topics.length > 15 ? `\n…and ${topics.length - 15} more` : '';
  const ok = await api.confirm({
    message: `Delete retained ${what}?`,
    detail: `An empty retained message is published to ${topics.length === 1 ? 'this topic' : `these ${topics.length} topics`}, which removes the retained message from the broker. Current subscribers receive the empty message.\n\n${shown}${more}`,
    okLabel: 'Delete',
  });
  if (!ok) return;
  let failed = 0;
  for (const n of nodes) {
    pendingDeletes.set(n.path, Date.now() + DELETE_ECHO_MS);
    const res = await api.publish({ topic: n.path, payload: '', qos: 1, retain: true });
    if (res.ok) {
      tree.removeTopic(n);
    } else {
      failed++;
      pendingDeletes.delete(n.path);
    }
  }
  if (selected && !tree.isAttached(selected)) selected = null;
  treeDirty = true;
  selectedDirty = true;
  toast(failed ? `${failed} deletes failed` : `Deleted ${topics.length} retained message${topics.length === 1 ? '' : 's'}`, failed ? 'error' : 'info');
}

function treeMenu(node, x, y) {
  const msg = node.message;
  const numeric = msg && extractNumber(msg, null) !== undefined;
  const below = [...node.topics()].filter((n) => n !== node && n.retained);
  const items = [
    { label: 'Copy topic', action: () => api.copyText(node.path).then(() => toast('Topic copied')) },
    {
      label: 'Copy value',
      disabled: !msg,
      action: () => {
        const d = decode(msg);
        api.copyText(d.kind === 'binary' ? hexDump(msg.payload, Infinity) : d.text).then(() => toast('Value copied'));
      },
    },
    { label: 'Publish to this topic…', action: () => (msg ? publisher.loadMessage(node.path, msg) : publisher.useTopic(node.path)) },
    { label: 'Open in new window', disabled: !msg, action: () => api.openPopout(node.path, node.history.map(stripMessage)) },
    'separator',
    ...(numeric
      ? plots.menuItems(node.path, null)
      : msg && hasNumbers(msg)
        ? [{ label: 'Choose values to plot…', action: () => plots.openPicker(null, node.path) }]
        : [{ label: 'Add to plot (needs a numeric value)', disabled: true, action() {} }]),
    'separator',
    { label: 'Expand all below', disabled: !node.children.size, action: () => (tree.setExpandedRecursive(node, true), treeView.refresh()) },
    { label: 'Collapse all below', disabled: !node.children.size, action: () => (tree.setExpandedRecursive(node, false), treeView.refresh()) },
    { label: 'Hide from tree (until next message)', action: () => (tree.remove(node), (treeDirty = true)) },
    'separator',
    {
      label: node.retained ? 'Delete retained message' : 'Delete retained message (none received)',
      disabled: !node.retained,
      action: () => deleteRetained([node], 'message'),
    },
    {
      label: `Delete retained messages below (${below.length})`,
      disabled: !below.length,
      action: () => deleteRetained(below, `messages under ${node.path}`),
    },
  ];
  showMenu(x, y, items);
}

// ------------------------------------------------------------------ status

const STATE_LABELS = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
  disconnected: 'Disconnected',
  error: 'Error',
};

api.onStatus((s) => {
  status = s;
  connections.onStatus(s);
  const name = activeProfile?.name || '';
  const label = s.state === 'connected' ? name : `${name ? `${name} · ` : ''}${STATE_LABELS[s.state] || s.state}`;
  $('#conn-label').textContent = label || 'Not connected';
  $('#btn-connections').dataset.state = s.state;
  $('#btn-disconnect').hidden = s.state === 'disconnected' && !s.unexpected;
  $('#btn-subscriptions').hidden = s.state !== 'connected';
  $('#status-text').textContent =
    s.state === 'error' ? `Error: ${s.error}` : `${STATE_LABELS[s.state] || s.state}${s.url ? ` — ${s.url}` : ''}`;
  if (s.state === 'connected') treeView.setEmptyText('Connected. Waiting for messages…');
  else if (s.state === 'disconnected') treeView.setEmptyText('Not connected. Click the connection button above.');
  // Retries repeat the same error every few seconds; show each distinct one once.
  if (s.state === 'error' && !connections.isOpen() && s.error !== lastErrorToast) toast(s.error, 'error');
  lastErrorToast = s.state === 'error' ? s.error : s.state === 'connected' ? null : lastErrorToast;
  treeView.refresh();
});

api.onWarning((message) => toast(message, 'error'));

// The main process asks for this before closing the window.
api.onFlush(async () => {
  await Promise.allSettled([connections.flush(), plots.flushSave()]);
  api.flushed();
});

api.onMenu((action) => {
  if (document.querySelector('.modal-overlay') && action !== 'connections') return;
  ACTION_HANDLERS[action]?.();
});

// Another window saved shared data: pick up its changes.
api.onStoreChanged(async (name) => {
  if (name === 'profiles') await connections.reload();
  else if (name === 'savedMessages') await publisher.load();
  else if (name === 'plotTabs') await plots.reload();
  else if (name === 'settings') applySettings(normalizeSettings(await api.storeGet('settings')));
});

window.addEventListener('error', (e) => toast(`Unexpected error: ${e.message}`, 'error'));
window.addEventListener('unhandledrejection', (e) => toast(`Unexpected error: ${e.reason?.message || e.reason}`, 'error'));

// ------------------------------------------------------------------ chrome

$('#btn-connections').addEventListener('click', () => connections.open());
$('#btn-disconnect').addEventListener('click', () => api.disconnect());
$('#btn-subscriptions').addEventListener('click', showSubscriptions);

function showSubscriptions() {
  if (status.state !== 'connected') return toast('Connect first to change subscriptions', 'error');
  openSubscriptions({
    api,
    profileName: activeProfile?.name,
    onSaved: (subs) => activeProfile && connections.setSubscriptions(activeProfile.id, subs),
  });
}
$('#btn-pause').addEventListener('click', () => {
  paused = !paused;
  $('#btn-pause').textContent = paused ? 'Resume' : 'Pause';
  $('#btn-pause').classList.toggle('on', paused);
  if (!paused && pauseQueue.length) {
    const q = pauseQueue;
    pauseQueue = [];
    pauseBytes = 0;
    ingest(q);
  }
});
$('#btn-clear').addEventListener('click', clearTree);
$('#btn-settings').addEventListener('click', () => showSettings());
initUpdateButton(api, $('#btn-update'));

async function showSettings(tab) {
  const next = await openSettings(api, settings, { tab });
  if (next) applySettings(next);
}
$('#btn-collapse-all').addEventListener('click', () => {
  tree.setExpandedRecursive(tree.root, false);
  treeView.refresh();
});

let filterTimer;
const applyFilter = () => treeView.setFilter($('#tree-filter').value, $('#filter-values').checked);
$('#tree-filter').addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyFilter, 150);
});
$('#tree-filter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('#tree-filter').value = '';
    applyFilter();
  }
  if (e.key === 'ArrowDown') $('#tree-scroll').focus();
});
$('#filter-values').addEventListener('change', applyFilter);

for (const tab of document.querySelectorAll('.right-tabs .tab')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
}
let currentTab = 'inspector';
function showTab(name) {
  currentTab = name;
  for (const t of document.querySelectorAll('.right-tabs .tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('#viewer-host').hidden = name !== 'inspector';
  $('#plots-host').hidden = name !== 'plots';
  plots.setVisible(name === 'plots');
}

function toggleMaximize(force) {
  const on = $('#layout').classList.toggle('max-viewer', force);
  viewer.setMaximized(on);
  if (on) showTab('inspector');
}

// ------------------------------------------------------------------ keyboard

// What each shortcut does (see keys.js; rebindable in Settings → Keyboard).
const ACTION_HANDLERS = {
  connections: () => connections.open(),
  subscriptions: () => showSubscriptions(),
  newWindow: () => api.newWindow(),
  settings: () => showSettings(),
  find: (e) => {
    if (e?.target?.closest?.('.viewer')) return viewer.focusSearch();
    $('#tree-filter').focus();
    $('#tree-filter').select();
  },
  publish: (e) => !e?.repeat && publisher.publish(),
  maximize: () => toggleMaximize(),
  tabInspector: () => showTab('inspector'),
  tabPlots: () => showTab('plots'),
  newPlot: () => {
    showTab('plots');
    plots.openPicker();
  },
  pause: () => $('#btn-pause').click(),
  // Space: the Plots tab freezes its time axis, the inspector holds its message.
  hold: (e) => {
    if (e?.repeat) return;
    if (currentTab === 'plots') plots.toggleFreeze();
    else viewer.toggleLive();
  },
  reset: (e) => !e?.repeat && reloadSession(),
  clear: () => $('#btn-clear').click(),
  keyboardSettings: () => showSettings('keyboard'),
};

const isPointerFocused = pointerFocus(document);
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-overlay')) return; // dialogs handle their own keys
  if (e.key === 'Escape' && $('#layout').classList.contains('max-viewer')) return toggleMaximize(false);
  if (e.key === 'Escape' && currentTab === 'plots' && plots.handleEscape()) return;
  const combo = comboFromEvent(e);
  const action = combo && keyIndex.get(combo);
  if (!action || !ACTION_HANDLERS[action]) return;
  if (keyBelongsToTarget(combo, e.target, isPointerFocused(e.target))) return; // e.g. typing, or Space pressing a focused button
  if (action === 'publish' && !e.target.closest?.('.publisher')) return;
  e.preventDefault();
  ACTION_HANDLERS[action](e);
});

// A narrow window puts the tree above the inspector (styles.css), so the same
// handle then resizes the tree's height, which is remembered separately.
const stacked = matchMedia('(max-width: 899px)');
splitter($('#split-main'), {
  axis: 'x',
  storageKey: 'mqttscope.treeWidth',
  initial: 460,
  min: 220,
  max: () => window.innerWidth - 420,
  active: () => !stacked.matches,
  apply: (px) => $('#layout').style.setProperty('--tree-w', `${px}px`),
});
splitter($('#split-main'), {
  axis: 'y',
  storageKey: 'mqttscope.treeHeight',
  initial: Math.round(window.innerHeight * 0.35),
  min: 80,
  max: () => $('#layout').clientHeight - 260,
  active: () => stacked.matches,
  apply: (px) => $('#layout').style.setProperty('--tree-h', `${px}px`),
});
splitter($('#split-right'), {
  axis: 'y',
  storageKey: 'mqttscope.publisherHeight',
  initial: 300,
  min: 140,
  max: () => window.innerHeight - 260,
  invert: true,
  apply: (px) => $('#right').style.setProperty('--pub-h', `${px}px`),
});

// ------------------------------------------------------------------ start

(async () => {
  const [saved] = await Promise.all([api.storeGet('settings').catch(() => null), connections.load(), publisher.load(), plots.load()]);
  applySettings(normalizeSettings(saved));
  const s = await api.status();
  if (s.state === 'disconnected') connections.open();
})();

// Exposed for end-to-end tests and debugging from DevTools.
window.__mqttscope = {
  tree,
  treeView,
  viewer,
  plots,
  publisher,
  connections,
  get status() {
    return status;
  },
  get settings() {
    return settings;
  },
};
