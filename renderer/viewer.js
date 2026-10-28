// Message inspector: shows one message of a topic in several views, with a
// history list, search, diff and charting. Re-renders keep scroll position
// and JSON expansion state so live updates do not move what you are reading.

import { el, button, showMenu, markMatches, toast } from './ui.js';
import { iconButton } from './icons.js';
import {
  decode,
  plainMessage,
  preview,
  formatBytes,
  formatTime,
  formatDateTime,
  prettyText,
  highlightJson,
  escapeHtml,
  hexDump,
  extractNumber,
  unsafeJson,
} from './payload.js';
import { JsonTree, countNodes, containerPaths, searchJson } from './jsonTree.js';
import { diffJson, diffLines } from './jsonDiff.js';
import { ancestorPaths, pathFromSegments } from './jsonPath.js';
import { LineChart } from './chart.js';

const MODES = [
  ['tree', 'Tree'],
  ['text', 'Text'],
  ['raw', 'Raw'],
  ['hex', 'Hex'],
  ['diff', 'Diff'],
  ['chart', 'Chart'],
];
const DIFF_HIGHLIGHT_LIMIT = 512 * 1024;
const DEFAULT_EXPAND_ALL_NODES = 400;
const HISTORY_LIST_MAX = 300; // newest entries rendered in the history list
const MAX_RENDER_BACKOFF_MS = 2000;

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(`mqttscope.viewer.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem(`mqttscope.viewer.${key}`, JSON.stringify(value));
  } catch {}
}

export class MessageViewer {
  // opts: api, standalone, onMaximize, onPopout, onUseInPublisher, onSelectTopic, onDeleteRetained
  constructor(host, opts) {
    this.opts = opts;
    this.api = opts.api;
    this.source = null;
    this.pinned = null; // message being held; null = follow latest
    this.mode = loadPref('mode', 'tree');
    this.wrap = loadPref('wrap', false);
    this.showHistory = loadPref('history', true);
    this.query = '';
    this.hits = [];
    this.hitIndex = 0;
    this.expandedByTopic = new Map();
    this.plotByTopic = new Map();
    this.lastRender = null;
    this.disposeChart = null;
    this.nextRenderAt = 0;
    this.updateTimer = null;
    // History rows map to message objects: indices shift as old messages drop out.
    this.itemMessages = new WeakMap();
    this.build(host);
    this.renderEmpty();
  }

  build(host) {
    this.root = el('div', 'viewer');
    host.append(this.root);

    const head = el('div', 'viewer-head');
    this.topicEl = el('div', 'viewer-topic');
    this.metaEl = el('div', 'viewer-meta');
    const topicRow = el('div', 'viewer-topic-row');
    const topicGroup = el('div', 'viewer-topic-group');
    topicGroup.append(
      this.topicEl,
      iconButton('copy', 'Copy topic', () => this.source && this.copy(this.source.path, 'Topic copied')),
    );
    topicRow.append(topicGroup);
    head.append(topicRow, this.metaEl);
    const actions = el('div', 'viewer-actions');
    topicRow.append(actions);

    const bar = el('div', 'viewer-toolbar');
    this.tabs = el('div', 'tabs');
    for (const [id, label] of MODES) {
      const t = button(label, `${label} view`, () => this.setMode(id), 'tab');
      t.dataset.mode = id;
      this.tabs.append(t);
    }
    this.liveBtn = button('', 'Follow the latest message or hold the one shown', () => this.toggleLive(), 'btn live');
    this.search = el('input', 'search');
    this.search.placeholder = 'Search message…';
    this.search.spellcheck = false;
    this.search.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.query = this.search.value;
        this.hitIndex = 0;
        this.render(true);
      }, 150);
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.stepHit(e.shiftKey ? -1 : 1);
      if (e.key === 'Escape') {
        this.search.value = '';
        this.query = '';
        this.render(true);
      }
    });
    this.hitCount = el('span', 'hit-count');
    this.expandBtn = button('Expand all', 'Expand every node', () => this.expandAll(true));
    this.collapseBtn = button('Collapse', 'Collapse to top level', () => this.expandAll(false));
    this.wrapBtn = button('Wrap', 'Toggle line wrapping', () => {
      this.wrap = !this.wrap;
      savePref('wrap', this.wrap);
      this.render(true);
    });
    actions.append(
      button('Copy', 'Copy payload', () => this.copyPayload()),
      button('Save', 'Save payload to file', () => this.savePayload()),
      ...(this.opts.onUseInPublisher
        ? [
            button('Edit & publish', 'Load this message into the publisher', () => {
              const msg = this.current();
              if (msg) this.opts.onUseInPublisher(this.source.path, msg);
            }),
          ]
        : []),
      button('History', 'Show or hide message history', () => {
        this.showHistory = !this.showHistory;
        savePref('history', this.showHistory);
        this.root.classList.toggle('no-history', !this.showHistory);
      }),
    );
    if (!this.opts.standalone) {
      actions.append(
        button('⤢ Pop out', 'Open this topic in its own window', () => this.source && this.opts.onPopout?.(this.source)),
        (this.maxBtn = button('Maximize', 'Give the inspector the whole window (F11, Esc to restore)', () => this.opts.onMaximize?.())),
      );
    }
    const searchBox = el('div', 'search-box');
    searchBox.append(
      this.search,
      this.hitCount,
      iconButton('arrow-up', 'Previous match (Shift+Enter)', () => this.stepHit(-1)),
      iconButton('arrow-down', 'Next match (Enter)', () => this.stepHit(1)),
    );
    bar.append(this.tabs, this.liveBtn, this.expandBtn, this.collapseBtn, this.wrapBtn, searchBox);

    const main = el('div', 'viewer-main');
    this.body = el('div', 'viewer-body');
    this.body.tabIndex = 0;
    const hist = el('div', 'viewer-history');
    this.histHead = el('div', 'history-head');
    this.histList = el('div', 'history-list');
    hist.append(this.histHead, this.histList);
    main.append(this.body, hist);
    // Hold the list still while the pointer is over it so rows do not move
    // under the cursor on busy topics.
    this.histList.addEventListener('mouseenter', () => (this.histHover = true));
    this.histList.addEventListener('mouseleave', () => {
      this.histHover = false;
      if (this.source) this.renderHistory();
    });
    this.histList.addEventListener('click', (e) => {
      const item = e.target.closest('.history-item');
      if (!item || !this.source) return;
      const msg = this.itemMessages.get(item);
      if (msg) {
        this.pinned = msg === this.latest() ? null : msg;
        this.render(true);
        this.renderHistory(true);
      }
    });

    this.root.append(head, bar, main);
    this.root.classList.toggle('no-history', !this.showHistory);
  }

  // The view mode, wrapping and history column are shared through
  // localStorage; another tab may have changed them while this one was hidden.
  reloadPrefs() {
    const mode = loadPref('mode', 'tree');
    const wrap = loadPref('wrap', false);
    const showHistory = loadPref('history', true);
    if (showHistory !== this.showHistory) {
      this.showHistory = showHistory;
      this.root.classList.toggle('no-history', !showHistory);
    }
    if (mode === this.mode && wrap === this.wrap) return;
    this.mode = mode;
    this.wrap = wrap;
    this.render(true);
  }

  // Stops pending renders and the chart (the tab closed).
  dispose() {
    clearTimeout(this.updateTimer);
    clearTimeout(this.searchTimer);
    this.updateTimer = null;
    this.disposeChart?.();
    this.disposeChart = null;
    this.root.remove();
  }

  focusSearch() {
    this.search.focus();
    this.search.select();
  }

  setMaximized(on) {
    if (this.maxBtn) this.maxBtn.textContent = on ? 'Restore' : 'Maximize';
  }

  // ---------------------------------------------------------- state

  show(source) {
    if (source !== this.source) {
      this.pinned = null;
      this.lastRender = null;
    }
    this.source = source;
    this.render(true);
  }

  // Live update. Renders that are slow (huge messages) back off in proportion
  // to their cost so a fast topic cannot monopolise the UI thread.
  update() {
    if (!this.source) return;
    const wait = this.nextRenderAt - performance.now();
    if (wait > 0) {
      this.updateTimer ??= setTimeout(() => {
        this.updateTimer = null;
        this.update();
      }, wait);
      return;
    }
    this.render(false);
  }

  latest() {
    const h = this.source?.history;
    return h && h.length ? h[h.length - 1] : null;
  }

  current() {
    return this.pinned || this.latest();
  }

  previousOf(msg) {
    const h = this.source.history;
    const i = h.indexOf(msg);
    return i > 0 ? h[i - 1] : null;
  }

  setMode(mode) {
    this.mode = mode;
    savePref('mode', mode);
    this.render(true);
  }

  toggleLive() {
    this.pinned = this.pinned ? null : this.current();
    this.render(true);
  }

  // What restore() brings back (structured-clone friendly). The held message
  // is named by its time and its place from the newest, since the restored
  // history holds copies of the messages; it comes along itself too, for
  // when it is no longer in the history (trimmed).
  snapshot() {
    const h = this.source?.history;
    return {
      pinned: this.pinned && { topic: this.source.path, ts: this.pinned.ts, back: h.length - 1 - h.indexOf(this.pinned), message: plainMessage(this.pinned) },
      expandedByTopic: [...this.expandedByTopic].map(([topic, paths]) => [topic, [...paths]]),
      plotByTopic: [...this.plotByTopic],
      query: this.query,
    };
  }

  // After show() of the topic that was shown: the held message is looked up
  // in its history (gone from it, the copy that came along is held).
  restore(s) {
    this.expandedByTopic = new Map(s.expandedByTopic.map(([topic, paths]) => [topic, new Set(paths)]));
    this.plotByTopic = new Map(s.plotByTopic);
    this.query = this.search.value = s.query;
    if (s.pinned && this.source?.path === s.pinned.topic) {
      const h = this.source.history;
      const at = h[h.length - 1 - s.pinned.back];
      this.pinned = at?.ts === s.pinned.ts ? at : s.pinned.message;
    }
    this.render(true);
  }

  expandedFor(topic, value) {
    let set = this.expandedByTopic.get(topic);
    if (!set) {
      const small = countNodes(value, DEFAULT_EXPAND_ALL_NODES + 1) <= DEFAULT_EXPAND_ALL_NODES;
      set = new Set(containerPaths(value, small ? Infinity : 1));
      this.expandedByTopic.set(topic, set);
    }
    return set;
  }

  expandAll(open) {
    const msg = this.current();
    if (!msg) return;
    const d = decode(msg);
    if (d.kind !== 'json') return;
    const set = this.expandedFor(this.source.path, d.value);
    set.clear();
    for (const p of containerPaths(d.value, open ? Infinity : 0)) set.add(p);
    this.render(true);
  }

  // ---------------------------------------------------------- rendering

  renderEmpty() {
    this.topicEl.textContent = 'No topic selected';
    this.metaEl.textContent = 'Pick a topic in the tree. Messages appear here as they arrive.';
    this.liveBtn.hidden = true;
    this.body.textContent = '';
    this.body.append(el('div', 'placeholder', 'Select a topic to inspect its messages'));
    this.histHead.textContent = 'History';
    this.histList.textContent = '';
  }

  render(force) {
    if (!this.source) return this.renderEmpty();
    const msg = this.current();
    const src = this.source;
    const key = `${this.mode}|${this.query}|${this.wrap}`;
    // Live updates for a held message only refresh the history list.
    const unchanged = !force && this.lastRender && this.lastRender.msg === msg && this.lastRender.key === key;
    this.renderHistory();
    this.renderHeader(msg);
    // Charts depend on the whole history and branch summaries on child topics.
    if (unchanged && msg && this.mode !== 'chart') return;
    const started = performance.now();

    const sameView = this.lastRender && this.lastRender.src === src && this.lastRender.mode === this.mode;
    const scrollTop = sameView ? this.body.scrollTop : 0;
    const scrollLeft = sameView ? this.body.scrollLeft : 0;
    this.disposeChart?.();
    this.disposeChart = null;
    this.totalMatches = 0;
    this.body.textContent = '';
    this.body.className = `viewer-body mode-${this.mode}${this.wrap ? ' wrap' : ''}`;

    for (const t of this.tabs.children) t.classList.toggle('active', t.dataset.mode === this.mode);
    this.expandBtn.hidden = this.collapseBtn.hidden = this.mode !== 'tree';
    this.wrapBtn.hidden = !['text', 'raw'].includes(this.mode);
    this.wrapBtn.classList.toggle('on', this.wrap);

    if (!msg) {
      this.renderBranch();
    } else {
      switch (this.mode) {
        case 'tree':
          this.renderTree(msg);
          break;
        case 'text':
          this.renderText(msg, true);
          break;
        case 'raw':
          this.renderText(msg, false);
          break;
        case 'hex':
          this.body.append(el('pre', 'code-plain', hexDump(msg.payload)));
          break;
        case 'diff':
          this.renderDiff(msg);
          break;
        case 'chart':
          this.renderChartView(msg);
          break;
      }
    }

    // Only mark matches in message content, never in hints or placeholders.
    const content = this.mode === 'chart' ? null : this.body.querySelector('.jt, .code, pre, .diff-table, .branch');
    this.hits = content ? markMatches(content, this.query) : [];
    this.hitIndex = Math.min(this.hitIndex, Math.max(0, this.hits.length - 1));
    this.updateHits(false);
    this.body.scrollTop = scrollTop;
    this.body.scrollLeft = scrollLeft;
    this.lastRender = { msg, key, src, mode: this.mode };
    const cost = performance.now() - started;
    this.nextRenderAt = performance.now() + Math.min(MAX_RENDER_BACKOFF_MS, cost * 3);
  }

  renderHeader(msg) {
    const src = this.source;
    this.topicEl.textContent = src.path;
    this.liveBtn.hidden = !msg;
    this.liveBtn.textContent = this.pinned ? '❚❚ Held' : '● Live';
    this.liveBtn.classList.toggle('held', !!this.pinned);
    this.metaEl.textContent = '';
    if (!msg) {
      this.metaEl.textContent = `${src.subtreeTopics ?? 0} topics below · ${src.subtreeMessages ?? 0} messages`;
      return;
    }
    const d = decode(msg);
    const idx = src.history.indexOf(msg);
    const parts = [
      formatDateTime(msg.ts),
      `QoS ${msg.qos}`,
      formatBytes(d.size),
      d.kind.toUpperCase(),
      idx >= 0 ? `#${idx + 1} of ${src.history.length} kept` : 'evicted from history',
      `${src.messageCount} received`,
    ];
    for (const p of parts) this.metaEl.append(el('span', 'meta-item', p));
    if (msg.retain) this.metaEl.append(el('span', 'meta-item tag', 'RETAINED'));
    const props = msg.props;
    if (props) {
      if (props.contentType) this.metaEl.append(el('span', 'meta-item', `content-type: ${props.contentType}`));
      if (props.responseTopic) this.metaEl.append(el('span', 'meta-item', `response-topic: ${props.responseTopic}`));
      for (const [k, v] of Object.entries(props.userProperties || {})) {
        this.metaEl.append(el('span', 'meta-item tag', `${k}=${Array.isArray(v) ? v.join(',') : v}`));
      }
    }
  }

  renderHistory(force = false) {
    const h = this.source.history;
    const cur = this.current();
    if (this.histHover && !force) {
      for (const item of this.histList.querySelectorAll('.history-item')) item.classList.toggle('active', this.itemMessages.get(item) === cur);
      const shown = this.histList.querySelectorAll('.history-item').length;
      this.histHead.textContent = `History (${h.length})${h.length !== shown ? ' · paused while pointing' : ''}`;
      return;
    }
    this.histHead.textContent = `History (${h.length})`;
    this.histList.textContent = '';
    const oldest = Math.max(0, h.length - HISTORY_LIST_MAX);
    if (cur && h.indexOf(cur) < oldest && h.indexOf(cur) >= 0) {
      // Keep a held message visible even when it is older than the rendered window.
      this.histList.append(this.historyItem(h, h.indexOf(cur), cur));
    }
    for (let i = h.length - 1; i >= oldest; i--) this.histList.append(this.historyItem(h, i, cur));
    if (oldest > 0) this.histList.append(el('div', 'placeholder small history-more', `${oldest} older messages not listed`));
  }

  historyItem(h, i, cur) {
    const m = h[i];
    const item = el('div', 'history-item' + (m === cur ? ' active' : ''));
    this.itemMessages.set(item, m);
    const top = el('div', 'history-top');
    top.append(el('span', 'history-time', formatTime(m.ts)), el('span', 'history-size', formatBytes(m.payload.length)));
    item.append(top, el('div', 'history-preview', preview(m, 80)));
    return item;
  }

  renderBranch() {
    const node = this.source;
    const wrap = el('div', 'branch');
    wrap.append(el('div', 'placeholder small', 'No message on this exact topic. Latest values below it:'));
    const table = el('div', 'branch-table');
    const kids = node.sortedChildren ? node.sortedChildren() : [];
    for (const child of kids.slice(0, 500)) {
      const row = el('div', 'branch-row');
      row.append(
        el('span', 'branch-name', child.name + (child.children.size ? '/' : '')),
        el('span', 'branch-value', child.message ? preview(child.message, 300) : `${child.subtreeTopics} topics`),
      );
      row.addEventListener('click', () => this.opts.onSelectTopic?.(child));
      table.append(row);
    }
    wrap.append(table);
    this.body.append(wrap);
  }

  // Integers beyond 2^53 cannot survive JSON.parse; say so where it matters.
  unsafeNote(text) {
    this.body.append(el('div', 'search-note warn-note', text));
  }

  renderTree(msg) {
    const d = decode(msg);
    if (d.kind !== 'json') return this.renderText(msg, true);
    if (unsafeJson(d)) this.unsafeNote('This message has integers larger than 2^53. The Tree view shows them rounded; Raw and Text show the exact values.');
    const expanded = this.expandedFor(this.source.path, d.value);
    let changed;
    let changedAncestors;
    const prev = this.previousOf(msg);
    if (prev && d.size <= DIFF_HIGHLIGHT_LIMIT) {
      const pd = decode(prev);
      if (pd.kind === 'json') {
        const diffs = diffJson(pd.value, d.value);
        changed = new Set(diffs.map((x) => x.path));
        changedAncestors = new Set(diffs.flatMap((x) => ancestorPaths(x.segs)));
      }
    }
    const search = this.query ? searchJson(d.value, this.query) : null;
    this.totalMatches = search ? search.count : 0;
    if (search && !search.count) {
      this.body.append(el('div', 'placeholder', `No keys or values contain “${this.query}”`));
      return;
    }
    if (search) this.body.append(el('div', 'search-note', `Showing only branches that match “${this.query}” (${search.count} matches). Clear the search to see everything.`));
    const treeHost = el('div');
    this.body.append(treeHost);
    new JsonTree(treeHost, d.value, {
      expanded,
      search,
      changed,
      changedAncestors,
      onContextMenu: (e, info) => this.jsonMenu(e, info),
    });
  }

  jsonMenu(e, info) {
    const json = info.container ? JSON.stringify(info.value, null, 2) : String(info.value);
    const numeric = typeof info.value === 'number' || typeof info.value === 'boolean';
    showMenu(e.clientX, e.clientY, [
      { label: 'Copy value', action: () => this.copy(json, 'Value copied') },
      { label: 'Copy path', action: () => this.copy(info.path, 'Path copied') },
      'separator',
      {
        label: 'Chart this field (kept history)',
        disabled: !numeric,
        action: () => {
          this.plotByTopic.set(this.source.path, { segs: info.segs, label: info.path });
          this.setMode('chart');
        },
      },
      ...(numeric && this.opts.plotMenuItems ? this.opts.plotMenuItems(this.source.path, info.segs) : []),
    ]);
  }

  renderText(msg, pretty) {
    const d = decode(msg);
    if (d.kind === 'binary') {
      this.body.append(el('div', 'placeholder small', 'Binary payload — shown as hex'));
      this.body.append(el('pre', 'code-plain', hexDump(msg.payload)));
      return;
    }
    if (d.kind === 'empty') {
      this.body.append(el('div', 'placeholder', 'Empty payload'));
      return;
    }
    // Pretty-printing re-serialises parsed JSON, which would round huge integers.
    const unsafe = pretty && unsafeJson(d);
    if (unsafe) this.unsafeNote('Shown as received (not re-indented) because the message has integers larger than 2^53.');
    const text = pretty && !unsafe ? prettyText(d) : d.text;
    const code = el('div', 'code');
    if (!this.wrap) {
      const lines = text.split('\n').length;
      const gutter = el('pre', 'gutter');
      gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
      code.append(gutter);
    }
    const src = el('pre', 'src');
    if (pretty && d.kind === 'json') src.innerHTML = highlightJson(text);
    else src.textContent = text;
    code.append(src);
    this.body.append(code);
  }

  renderDiff(msg) {
    const prev = this.previousOf(msg);
    if (!prev) {
      this.body.append(el('div', 'placeholder', 'No earlier message in history to compare with'));
      return;
    }
    const a = decode(prev);
    const b = decode(msg);
    const head = el('div', 'diff-head', `Compared with the previous message at ${formatTime(prev.ts)}`);
    this.body.append(head);
    if (a.kind === 'json' && b.kind === 'json') {
      if (unsafeJson(a) || unsafeJson(b)) this.unsafeNote('Integers larger than 2^53 are compared after rounding.');
      const changes = diffJson(a.value, b.value);
      head.textContent += ` — ${changes.length} change${changes.length === 1 ? '' : 's'}`;
      if (!changes.length) return this.body.append(el('div', 'placeholder small', 'Identical payload'));
      const table = el('div', 'diff-table');
      for (const c of changes.slice(0, 5000)) {
        const row = el('div', `diff-row ${c.type}`);
        row.append(
          el('span', 'diff-type', c.type),
          el('span', 'diff-path', c.path),
          el('span', 'diff-from', c.from === undefined ? '' : short(c.from)),
          el('span', 'diff-arrow', c.type === 'changed' ? '→' : ''),
          el('span', 'diff-to', c.to === undefined ? '' : short(c.to)),
        );
        table.append(row);
      }
      this.body.append(table);
      return;
    }
    if (a.kind === 'binary' || b.kind === 'binary') {
      this.body.append(el('div', 'placeholder small', 'Binary payloads cannot be diffed'));
      return;
    }
    const lines = diffLines(prettyText(a), prettyText(b));
    if (!lines) {
      this.body.append(el('div', 'placeholder small', 'Too large for a line diff'));
      return;
    }
    const pre = el('pre', 'diff-lines');
    let html = '';
    let run = [];
    const flushRun = () => {
      if (run.length > 8) {
        html += run.slice(0, 3).map((l) => `<span class="dl ctx">  ${escapeHtml(l)}</span>`).join('');
        html += `<span class="dl skip">  … ${run.length - 6} unchanged lines</span>`;
        html += run.slice(-3).map((l) => `<span class="dl ctx">  ${escapeHtml(l)}</span>`).join('');
      } else {
        html += run.map((l) => `<span class="dl ctx">  ${escapeHtml(l)}</span>`).join('');
      }
      run = [];
    };
    for (const l of lines) {
      if (l.op === ' ') {
        run.push(l.text);
        continue;
      }
      flushRun();
      html += `<span class="dl ${l.op === '+' ? 'add' : 'del'}">${l.op} ${escapeHtml(l.text)}</span>`;
    }
    flushRun();
    pre.innerHTML = html;
    this.body.append(pre);
  }

  renderChartView(msg) {
    const spec = this.plotByTopic.get(this.source.path);
    const segs = spec ? spec.segs : null;
    const points = [];
    for (const m of this.source.history) {
      const v = extractNumber(m, segs);
      if (v !== undefined) points.push({ t: m.ts, v });
    }
    if (!points.length) {
      const hint = spec
        ? `No numeric values for ${spec.label} in the kept history`
        : decode(msg).kind === 'json'
          ? 'Right-click a number in the Tree view and choose “Chart this field”'
          : 'This topic has no numeric payloads to chart';
      this.body.append(el('div', 'placeholder', hint));
      return;
    }
    const label = segs ? pathFromSegments(segs) : 'payload';
    const head = el('div', 'chart-head');
    head.append(el('span', 'chart-title', `${label} · ${points.length} points in kept history`));
    if (this.opts.plotMenuItems) {
      head.append(
        button('Add to plots', 'Track this value live in the Plots tab', (e) => {
          const r = e.target.getBoundingClientRect();
          showMenu(r.left, r.bottom + 4, this.opts.plotMenuItems(this.source.path, segs));
        }),
      );
    }
    if (spec) {
      head.append(
        button('Chart whole payload', 'Stop charting this field', () => {
          this.plotByTopic.delete(this.source.path);
          this.render(true);
        }),
      );
    }
    this.body.append(head);
    const chart = new LineChart(this.body);
    chart.setData([{ label, slot: 0, points }]);
    this.disposeChart = () => chart.dispose();
  }

  // ---------------------------------------------------------- search

  stepHit(dir) {
    if (!this.hits.length) return;
    this.hitIndex = (this.hitIndex + dir + this.hits.length) % this.hits.length;
    this.updateHits(true);
  }

  updateHits(scroll) {
    const shown = this.hits.length ? `${this.hitIndex + 1}/${this.hits.length}` : '0/0';
    const more = this.totalMatches > this.hits.length ? ` of ${this.totalMatches}` : '';
    this.hitCount.textContent = this.query ? shown + more : '';
    this.hits.forEach((h, i) => h.classList.toggle('current', i === this.hitIndex));
    if (scroll && this.hits[this.hitIndex]) this.hits[this.hitIndex].scrollIntoView({ block: 'center' });
  }

  // ---------------------------------------------------------- actions

  copy(text, note) {
    this.api.copyText(text);
    toast(note);
  }

  copyPayload() {
    const msg = this.current();
    if (!msg) return;
    const d = decode(msg);
    this.copy(d.kind === 'binary' ? hexDump(msg.payload, Infinity) : d.text, 'Payload copied');
  }

  async savePayload() {
    const msg = this.current();
    if (!msg) return;
    const d = decode(msg);
    const ext = d.kind === 'json' ? 'json' : d.kind === 'binary' ? 'bin' : 'txt';
    const name = `${this.source.path.replace(/[^\w.-]+/g, '_')}.${ext}`;
    const saved = await this.api.saveFile(name, msg.payload);
    if (saved) toast(`Saved ${saved}`);
  }
}

function short(v) {
  const s = JSON.stringify(v);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}
