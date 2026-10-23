// One broker connection in a window: its topic tree, inspector, plots,
// publisher, toolbar and status bar. The window shell (app.js) makes one per
// tab. Only the active tab's DOM is in the document, so the element ids of
// the tab template stay unique. A hidden tab keeps its connection and keeps
// recording (tree, history, plot data) but draws nothing. Until it first
// connects, a tab is a "picker": it shows the window's connection dialog
// (mounted by the shell) instead of all that.

import { TopicTree } from './topicTree.js';
import { TreeView } from './treeView.js';
import { MessageViewer } from './viewer.js';
import { PlotsPanel } from './plots.js';
import { Publisher } from './publisher.js';
import { el, showMenu, splitter, toast } from './ui.js';
import { decode, extractNumber, hexDump } from './payload.js';
import { hasNumbers } from './fields.js';
import { openSubscriptions } from './subscriptionsDialog.js';
import { bindConnection } from './tabApi.js';
import { connectSignature } from './profiles.js';

const PAUSE_QUEUE_LIMIT = 200000;
const PAUSE_QUEUE_BYTES = 256 * 1024 * 1024;
const DELETE_ECHO_MS = 5000;
const NOT_CONNECTED = 'Not connected.';
// Scrolled elements whose position is kept while the tab is hidden (a
// detached element forgets it).
const SCROLLERS = '.tree-scroll, .viewer-body, .history-list, .payload-editor, .lib-list, .plot-settings';

export const STATE_LABELS = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
  disconnected: 'Disconnected',
  error: 'Error',
};

// A different broker means a different topic space; reconnecting to the same one keeps the tree.
const brokerKey = (p) => p && `${p.id}|${p.protocol}|${p.host}|${p.port}|${p.wsPath || ''}`;

// A narrow window puts the tree above the inspector (styles.css), so the same
// handle then resizes the tree's height, which is remembered separately.
const stacked = matchMedia('(max-width: 899px)');
const INITIAL_TREE_HEIGHT = Math.round(window.innerHeight * 0.35);

function stripMessage(m) {
  return { topic: m.topic, payload: m.payload, qos: m.qos, retain: m.retain, ts: m.ts, props: m.props };
}

export class ConnectionTab {
  // shell: getBinding(id), setSubscriptions(profileId, subs),
  //        savedProfile(profile) — its saved version,
  //        showDuplicate(tab, duplicate) — the profile is open in another tab,
  //        savedMessagesChanged(tab) — this tab wrote the saved or recent
  //        messages, onChange(tab) — the label, state, mode or data changed
  constructor({ api, connId, settings, shell }) {
    this.api = api;
    this.connId = connId; // also the tab's id
    this.shell = shell;
    this.tabApi = bindConnection(api, connId, { name: () => this.profile?.name || '' });
    this.profile = null; // snapshot of the profile last connected
    this.status = { state: 'disconnected' };
    this.mode = 'picker'; // 'session' from the first 'connected' on (or a restore), for good
    this.failed = false; // the last attempt failed (a picker's dialog offers Retry)
    this.everConnected = false;
    this.canReconnect = false; // disconnected by the user after connecting
    this.active = false;

    this.tree = new TopicTree();
    this.selected = null;
    this.selectedDirty = false;
    this.treeDirty = false;
    this.paused = false;
    this.pauseQueue = [];
    this.pauseBytes = 0;
    this.rateCount = 0;
    this.rate = 0;
    this.lastMessageAt = 0;
    this.droppedTotal = 0;
    this.lastErrorToast = null;
    this.pendingDeletes = new Map(); // topic -> expiry; swallows the broker echo of our own delete
    this.rightPanel = 'inspector'; // or 'plots'
    this.savedScroll = [];
    this.applySettings(settings);

    this.pickerRoot = el('div', 'tab-root tab-picker'); // the shell mounts the dialog here
    this.root = document.importNode(document.querySelector('#tab-template').content, true).firstElementChild;
    this.els = {
      layout: this.$('#layout'),
      right: this.$('#right'),
      pause: this.$('#btn-pause'),
      disconnect: this.$('#btn-disconnect'),
      subscriptions: this.$('#btn-subscriptions'),
      hint: this.$('.reconnect-hint'),
      topics: this.$('#stat-topics'),
      msgs: this.$('#stat-msgs'),
      rate: this.$('#stat-rate'),
      dropped: this.$('#status-dropped'),
      statusText: this.$('#status-text'),
      selected: this.$('#status-selected'),
      filter: this.$('#tree-filter'),
    };
    this.buildViews();
    this.wireChrome();

    // What each per-connection shortcut does (see keys.js); the shell calls
    // these for the active tab.
    this.handlers = {
      subscriptions: () => this.showSubscriptions(),
      find: (e) => {
        if (e?.target?.closest?.('.viewer')) return this.viewer.focusSearch();
        this.els.filter.focus();
        this.els.filter.select();
      },
      publish: (e) => !e?.repeat && this.publisher.publish(),
      maximize: () => this.toggleMaximize(),
      tabInspector: () => this.showPanel('inspector'),
      tabPlots: () => this.showPanel('plots'),
      newPlot: () => {
        this.showPanel('plots');
        this.plots.openPicker();
      },
      pause: () => this.togglePause(),
      // Space: the Plots tab freezes its time axis, the inspector holds its message.
      hold: (e) => {
        if (e?.repeat) return;
        if (this.rightPanel === 'plots') this.plots.toggleFreeze();
        else this.viewer.toggleLive();
      },
      reset: (e) => !e?.repeat && this.reloadSession(),
      clear: () => this.clearTree(),
    };
  }

  // The shell's way to the handlers: a picker shows none of what they act
  // on, but Subscriptions still says to connect first.
  handlerFor(action) {
    return this.mode === 'session' || action === 'subscriptions' ? this.handlers[action] : null;
  }

  $(sel) {
    return this.root.querySelector(sel);
  }

  get label() {
    return this.profile?.name || 'New connection';
  }

  // Whether any plotted series has recorded points.
  get hasPlotData() {
    for (const s of this.plots.data.series.values()) if (s.points.length) return true;
    return false;
  }

  applySettings(settings) {
    this.settings = settings;
    this.tree.historyLimit = settings.historyLimit;
    this.tree.historyBytes = settings.historyMB * 1024 * 1024;
    this.tree.trimHistories();
  }

  // Saved messages, and the plots of the tab's profile (none before it has one).
  load() {
    return Promise.all([this.publisher.load(), this.plots.loadProfile(this.profile?.id ?? null)]);
  }

  // ---------------------------------------------------------------- views

  buildViews() {
    this.treeView = new TreeView(this.$('#tree-scroll'), this.tree, {
      onSelect: (node, source) => this.selectNode(node, source),
      onContextMenu: (node, x, y) => this.treeMenu(node, x, y),
    });
    this.treeView.setEmptyText(NOT_CONNECTED);

    this.viewer = new MessageViewer(this.$('#viewer-host'), {
      api: this.tabApi,
      onMaximize: () => this.toggleMaximize(),
      onPopout: (node) => this.tabApi.openPopout(node.path, node.history.map(stripMessage)),
      onUseInPublisher: (topic, msg) => this.publisher.loadMessage(topic, msg),
      onSelectTopic: (node) => {
        this.treeView.reveal(node);
        this.treeView.select(node);
      },
      plotMenuItems: (topic, segs) => this.plots.menuItems(topic, segs),
    });

    const plotCount = this.$('#plot-count');
    this.plots = new PlotsPanel(this.$('#plots-host'), {
      api: this.tabApi,
      getHistory: (topic) => this.tree.find(topic)?.history || [],
      getTopicNodes: () => this.tree.root.topics(),
      onCountChange: (n) => (plotCount.textContent = n ? String(n) : ''),
      onAdded: () => this.showPanel('plots'),
    });

    this.publisher = new Publisher(this.$('#publisher-host'), {
      api: this.tabApi,
      getTopics: (prefix) => this.topicSuggestions(prefix),
      getSelectedTopic: () => this.selected?.path ?? null,
      onToggle: (collapsed) => this.els.right.classList.toggle('pub-collapsed', collapsed),
      onPersist: () => this.shell.savedMessagesChanged(this),
    });
  }

  wireChrome() {
    this.els.disconnect.addEventListener('click', () => this.toggleConnection());
    this.els.subscriptions.addEventListener('click', () => this.showSubscriptions());
    this.els.hint.addEventListener('click', () => this.reconnect());
    this.els.pause.addEventListener('click', () => this.togglePause());
    this.$('#btn-clear').addEventListener('click', () => this.clearTree());
    this.$('#btn-collapse-all').addEventListener('click', () => {
      this.tree.setExpandedRecursive(this.tree.root, false);
      this.treeView.refresh();
    });

    const filter = this.els.filter;
    const values = this.$('#filter-values');
    const applyFilter = () => this.treeView.setFilter(filter.value, values.checked);
    filter.addEventListener('input', () => {
      clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(applyFilter, 150);
    });
    filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        filter.value = '';
        applyFilter();
      }
      if (e.key === 'ArrowDown') this.treeView.scrollEl.focus();
    });
    values.addEventListener('change', applyFilter);

    for (const tab of this.root.querySelectorAll('.right-tabs .tab')) {
      tab.addEventListener('click', () => this.showPanel(tab.dataset.tab));
    }

    // Panel sizes are CSS variables on the body, so every tab shares them.
    const body = document.body.style;
    splitter(this.$('#split-main'), {
      axis: 'x',
      storageKey: 'mqttscope.treeWidth',
      initial: 460,
      min: 220,
      max: () => window.innerWidth - 420,
      active: () => !stacked.matches,
      apply: (px) => body.setProperty('--tree-w', `${px}px`),
    });
    splitter(this.$('#split-main'), {
      axis: 'y',
      storageKey: 'mqttscope.treeHeight',
      initial: INITIAL_TREE_HEIGHT,
      min: 80,
      max: () => this.els.layout.clientHeight - 260,
      active: () => stacked.matches,
      apply: (px) => body.setProperty('--tree-h', `${px}px`),
    });
    splitter(this.$('#split-right'), {
      axis: 'y',
      storageKey: 'mqttscope.publisherHeight',
      initial: 300,
      min: 140,
      max: () => window.innerHeight - 260,
      invert: true,
      apply: (px) => body.setProperty('--pub-h', `${px}px`),
    });
  }

  // Inspector or Plots on the right.
  showPanel(name) {
    this.rightPanel = name;
    for (const t of this.root.querySelectorAll('.right-tabs .tab')) t.classList.toggle('active', t.dataset.tab === name);
    this.$('#viewer-host').hidden = name !== 'inspector';
    this.$('#plots-host').hidden = name !== 'plots';
    this.plots.setVisible(this.active && name === 'plots');
  }

  toggleMaximize(force) {
    const on = this.els.layout.classList.toggle('max-viewer', force);
    this.viewer.setMaximized(on);
    if (on) this.showPanel('inspector');
  }

  // Esc: restore a maximized inspector, or leave a full-screen plot or zoom.
  // Returns whether there was something to undo.
  handleEscape() {
    if (this.els.layout.classList.contains('max-viewer')) {
      this.toggleMaximize(false);
      return true;
    }
    return this.rightPanel === 'plots' && this.plots.handleEscape();
  }

  // ---------------------------------------------------------------- showing

  // What the tab shows: the place of the connection dialog, or the session.
  get content() {
    return this.mode === 'session' ? this.root : this.pickerRoot;
  }

  activate(host) {
    host.append(this.content);
    this.active = true;
    if (this.mode === 'session') this.drawSession();
  }

  // The session as the tab left it (scroll positions, focus), with everything
  // that arrived while it was hidden.
  drawSession() {
    for (const [scroller, top, left] of this.savedScroll) {
      scroller.scrollTop = top;
      scroller.scrollLeft = left;
    }
    this.savedScroll = [];
    this.viewer.reloadPrefs();
    this.plots.setVisible(this.rightPanel === 'plots');
    this.treeDirty = true;
    this.render();
    if (this.focused?.isConnected) this.focused.focus({ preventScroll: true });
    this.focused = null;
  }

  deactivate() {
    this.savedScroll = [...this.root.querySelectorAll(SCROLLERS)].filter((s) => s.scrollTop || s.scrollLeft).map((s) => [s, s.scrollTop, s.scrollLeft]);
    this.focused = this.root.contains(document.activeElement) ? document.activeElement : null;
    this.active = false;
    this.plots.setVisible(false);
    this.content.remove();
  }

  // The first connect: the session replaces the dialog, for good.
  becomeSession() {
    this.mode = 'session';
    if (!this.active) return;
    this.pickerRoot.replaceWith(this.root);
    this.drawSession();
  }

  // One frame of the active tab: the tree, the inspector and the stats.
  render() {
    if (this.mode !== 'session') return;
    if (this.treeDirty) {
      this.treeDirty = false;
      this.treeView.refresh();
    } else if (Date.now() - this.lastMessageAt < 1500) {
      this.treeView.renderViewport(); // fade out update highlights
    }
    if (this.selectedDirty) {
      this.selectedDirty = false;
      this.viewer.update();
    }
    this.updateStats();
  }

  tickRate() {
    this.rate = this.rateCount;
    this.rateCount = 0;
  }

  updateStats() {
    const { topics, msgs, rate, dropped } = this.els;
    topics.textContent = `${this.tree.topicCount.toLocaleString()} topics`;
    msgs.textContent = `${this.tree.messageCount.toLocaleString()} messages`;
    rate.textContent = this.paused ? `paused · ${this.pauseQueue.length.toLocaleString()} queued` : `${this.rate.toLocaleString()} msg/s`;
    dropped.hidden = !this.droppedTotal;
    dropped.textContent = `${this.droppedTotal.toLocaleString()} messages dropped (too fast)`;
  }

  // ---------------------------------------------------------------- connection

  async connect(profile) {
    // The profile's plots first, so the session shows them from its start. A
    // picker reads them on every attempt (nothing changes them there, and the
    // profile may have been open in another tab meanwhile). A session only
    // ever reconnects to its own profile and keeps its plots, and the data
    // they collected.
    if (this.mode === 'picker') await this.plots.loadProfile(profile.id ?? null);
    const res = await this.tabApi.connect(profile);
    // Open in another tab: two clients with one client ID would throw each
    // other off the broker. The shell shows that tab; this one stays as it was.
    if (res.duplicate) {
      await this.shell.showDuplicate(this, res.duplicate);
      return res;
    }
    if (brokerKey(this.profile) !== brokerKey(profile)) this.clearTree();
    this.profile = { ...profile };
    this.checkSaved();
    this.shell.onChange(this);
    // A picker's dialog already shows it on its status line.
    if (!res.ok && !(this.mode === 'picker' && this.status.error === res.error)) toast(res.error, 'error');
    return res;
  }

  // A tab reopened at launch (app.js restoreTabs) is a session from the
  // start: it connected when the app last ran. Set before it is first shown.
  restoreAs(profile) {
    this.profile = { ...profile };
    this.everConnected = true;
    this.mode = 'session';
  }

  // A restored tab the user had disconnected: it holds its profile in main
  // (no other tab opens it, and it cannot be deleted) and offers Reconnect.
  async bind() {
    const res = await this.tabApi.bind(this.profile);
    if (res.ok) {
      this.onStatus({ state: 'disconnected' });
      this.checkSaved();
    }
    return res;
  }

  // The profile was edited (here or in another window) or loaded: a rename
  // renames the tab; a change to how it connects shows the hint until the
  // tab reconnects with the saved profile.
  checkSaved() {
    if (!this.profile) return;
    const saved = this.shell.savedProfile(this.profile);
    this.els.hint.hidden = connectSignature(saved) === connectSignature(this.profile);
    if (saved.name !== this.profile.name) {
      this.profile = { ...this.profile, name: saved.name };
      this.shell.onChange(this);
    }
  }

  // The toolbar button and the tab menu: Reconnect once the user
  // disconnected, else Disconnect.
  toggleConnection() {
    return this.canReconnect ? this.reconnect() : this.tabApi.disconnect();
  }

  // Connects again to the profile the user disconnected from, as saved now
  // (edits made since apply).
  reconnect() {
    return this.connect(this.shell.savedProfile(this.profile));
  }

  onStatus(s) {
    this.status = s;
    if (s.state === 'connected') this.everConnected = true;
    // The client's own retries keep a failure; a new attempt, a connection or
    // the user disconnecting end it.
    if (s.state === 'error' || (s.state === 'disconnected' && s.unexpected)) this.failed = true;
    else if (s.state !== 'reconnecting' && s.state !== 'offline') this.failed = false;
    // Disconnect while connected or trying to; Reconnect once the user
    // disconnected a tab that had connected. A tab that never did has nothing
    // to resume.
    const byUser = s.state === 'disconnected' && !s.unexpected;
    this.canReconnect = byUser && this.everConnected && !!this.profile;
    this.els.disconnect.hidden = byUser && !this.canReconnect;
    this.els.disconnect.textContent = this.canReconnect ? 'Reconnect' : 'Disconnect';
    this.els.subscriptions.hidden = s.state !== 'connected';
    this.els.statusText.textContent = s.state === 'error' ? `Error: ${s.error}` : `${STATE_LABELS[s.state] || s.state}${s.url ? ` — ${s.url}` : ''}`;
    if (s.state === 'connected') this.treeView.setEmptyText('Connected. Waiting for messages…');
    else if (s.state === 'disconnected') this.treeView.setEmptyText(NOT_CONNECTED);
    // Retries repeat the same error every few seconds; show each distinct one
    // once. A hidden tab shows none (its dot turns red), so a retry toasts it
    // once the tab is shown. A picker shows it in its dialog instead.
    if (s.state === 'error' && this.active && s.error !== this.lastErrorToast) {
      if (this.mode === 'session') toast(s.error, 'error');
      this.lastErrorToast = s.error;
    }
    if (s.state === 'connected') this.lastErrorToast = null;
    if (s.state === 'connected' && this.mode === 'picker') this.becomeSession();
    else if (this.active && this.mode === 'session') this.treeView.refresh();
    else this.treeDirty = true;
    this.shell.onChange(this);
  }

  onWarning(message) {
    toast(message, 'error');
  }

  showSubscriptions() {
    if (this.status.state !== 'connected') return toast('Connect first to change subscriptions', 'error');
    openSubscriptions({
      api: this.tabApi,
      profileName: this.profile?.name,
      onSaved: (subs) => this.profile && this.shell.setSubscriptions(this.profile.id, subs),
    });
  }

  // ---------------------------------------------------------------- messages

  ingestBatch({ messages, dropped }) {
    if (dropped) this.droppedTotal += dropped;
    if (!this.paused) return this.ingest(messages);
    for (const m of messages) {
      this.pauseQueue.push(m);
      this.pauseBytes += m.payload.length;
    }
    // Keep the newest messages within the caps; older ones are dropped and counted.
    let drop = 0;
    while (this.pauseQueue.length - drop > PAUSE_QUEUE_LIMIT || (this.pauseBytes > PAUSE_QUEUE_BYTES && this.pauseQueue.length - drop > 1)) {
      this.pauseBytes -= this.pauseQueue[drop++].payload.length;
    }
    if (drop) {
      this.droppedTotal += drop;
      this.pauseQueue = this.pauseQueue.slice(drop);
    }
  }

  // Into the tree and the plot data only; drawing waits for render().
  ingest(messages) {
    const now = Date.now();
    const selected = this.selected;
    for (const m of messages) {
      if (m.payload.length === 0 && this.pendingDeletes.has(m.topic)) {
        this.pendingDeletes.delete(m.topic);
        continue;
      }
      const node = this.tree.addMessage(m);
      this.plots.ingest(m);
      // A selected branch (no message of its own) shows its children's values.
      if (node === selected || (selected && !selected.messageCount && m.topic.startsWith(`${selected.path}/`))) this.selectedDirty = true;
    }
    for (const [topic, expiry] of this.pendingDeletes) if (expiry < now) this.pendingDeletes.delete(topic);
    this.rateCount += messages.length;
    this.lastMessageAt = now;
    this.treeDirty = true;
  }

  togglePause() {
    this.paused = !this.paused;
    this.els.pause.textContent = this.paused ? 'Resume' : 'Pause';
    this.els.pause.classList.toggle('on', this.paused);
    if (!this.paused && this.pauseQueue.length) {
      const q = this.pauseQueue;
      this.pauseQueue = [];
      this.pauseBytes = 0;
      this.ingest(q);
    }
  }

  // Ctrl+R: start over without reconnecting — forget received messages and
  // restart every plot's timeline.
  reloadSession() {
    this.clearTree();
    this.plots.reset();
    this.tabApi.resetChildWindows(); // pop-out windows start over too
    this.droppedTotal = 0;
    this.rateCount = 0;
    this.rate = 0;
    this.updateStats();
    toast('Cleared received messages and restarted the plots');
    this.shell.onChange(this);
  }

  clearTree() {
    this.tree.clear();
    this.selected = null;
    this.pauseQueue = [];
    this.pauseBytes = 0;
    this.treeView.selected = null;
    this.viewer.source = null;
    this.viewer.render(true);
    this.treeView.refresh();
    this.els.selected.textContent = '';
  }

  topicSuggestions(prefix) {
    const q = (prefix || '').toLowerCase();
    const out = [];
    for (const node of this.tree.root.topics()) {
      if (!q || node.path.toLowerCase().includes(q)) out.push(node.path);
      if (out.length >= 200) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- selection

  selectNode(node, source) {
    // Clicking a topic opens it one level so its sub-topics show (Settings → General).
    if (source === 'click' && this.settings.autoExpand && node.children.size && !node.expanded) {
      node.expanded = true;
      this.treeView.refresh();
    }
    this.selected = node;
    this.viewer.show(node);
    this.publisher.setTopic(node.path);
    this.els.selected.textContent = node.path;
  }

  // Only topics that were received as retained are offered: deleting publishes
  // an empty message, which every current subscriber of the topic receives.
  async deleteRetained(nodes, what) {
    const topics = nodes.map((n) => n.path);
    const shown = topics.slice(0, 15).join('\n');
    const more = topics.length > 15 ? `\n…and ${topics.length - 15} more` : '';
    const ok = await this.api.confirm({
      message: `Delete retained ${what}?`,
      detail: `An empty retained message is published to ${topics.length === 1 ? 'this topic' : `these ${topics.length} topics`}, which removes the retained message from the broker. Current subscribers receive the empty message.\n\n${shown}${more}`,
      okLabel: 'Delete',
    });
    if (!ok) return;
    let failed = 0;
    for (const n of nodes) {
      this.pendingDeletes.set(n.path, Date.now() + DELETE_ECHO_MS);
      const res = await this.tabApi.publish({ topic: n.path, payload: '', qos: 1, retain: true });
      if (res.ok) {
        this.tree.removeTopic(n);
      } else {
        failed++;
        this.pendingDeletes.delete(n.path);
      }
    }
    if (this.selected && !this.tree.isAttached(this.selected)) this.selected = null;
    this.treeDirty = true;
    this.selectedDirty = true;
    toast(failed ? `${failed} deletes failed` : `Deleted ${topics.length} retained message${topics.length === 1 ? '' : 's'}`, failed ? 'error' : 'info');
  }

  treeMenu(node, x, y) {
    const { api, tabApi, tree, treeView, plots, publisher } = this;
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
      { label: 'Open in new window', disabled: !msg, action: () => tabApi.openPopout(node.path, node.history.map(stripMessage)) },
      'separator',
      ...(numeric
        ? plots.menuItems(node.path, null)
        : msg && hasNumbers(msg)
          ? [{ label: 'Choose values to plot…', action: () => plots.openPicker(null, node.path) }]
          : [{ label: 'Add to plot (needs a numeric value)', disabled: true, action() {} }]),
      'separator',
      { label: 'Expand all below', disabled: !node.children.size, action: () => (tree.setExpandedRecursive(node, true), treeView.refresh()) },
      { label: 'Collapse all below', disabled: !node.children.size, action: () => (tree.setExpandedRecursive(node, false), treeView.refresh()) },
      { label: 'Hide from tree (until next message)', action: () => (tree.remove(node), (this.treeDirty = true)) },
      'separator',
      {
        label: node.retained ? 'Delete retained message' : 'Delete retained message (none received)',
        disabled: !node.retained,
        action: () => this.deleteRetained([node], 'message'),
      },
      {
        label: `Delete retained messages below (${below.length})`,
        disabled: !below.length,
        action: () => this.deleteRetained(below, `messages under ${node.path}`),
      },
    ];
    showMenu(x, y, items);
  }

  // ---------------------------------------------------------------- teardown

  // Saves pending plot changes (to the tab's profile).
  flush() {
    return this.plots.saveTimer ? this.plots.flushSave() : Promise.resolve();
  }

  // Stops the views' timers, observers and listeners. The connection is the
  // shell's to close.
  dispose() {
    clearTimeout(this.filterTimer);
    this.treeView.dispose();
    this.viewer.dispose();
    this.plots.dispose();
    this.publisher.dispose();
    this.root.remove();
    this.pickerRoot.remove();
    this.active = false;
  }
}
