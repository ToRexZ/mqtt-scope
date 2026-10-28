// Virtualised topic tree: only the rows in view exist in the DOM, so trees
// with tens of thousands of topics stay responsive.

import { el } from './ui.js';
import { preview, topicMatches, searchableText } from './payload.js';

const ROW_HEIGHT = 22;
const OVERSCAN = 12;
const RECENT_MS = 1200;

export class TreeView {
  constructor(scrollEl, tree, { onSelect, onContextMenu }) {
    this.scrollEl = scrollEl;
    this.tree = tree;
    this.onSelect = onSelect;
    this.onContextMenu = onContextMenu;
    this.rows = [];
    this.pool = [];
    this.selected = null;
    this.filter = null;

    this.inner = el('div', 'tree-inner');
    this.empty = el('div', 'tree-empty');
    scrollEl.append(this.inner, this.empty);
    scrollEl.tabIndex = 0;

    scrollEl.addEventListener('scroll', () => this.renderViewport());
    this.resizeObserver = new ResizeObserver(() => this.renderViewport());
    this.resizeObserver.observe(scrollEl);
    this.inner.addEventListener('click', (e) => this.handleClick(e));
    // A double-click toggles relative to the state before its first click,
    // which may already have expanded the node (auto-expand on select).
    this.inner.addEventListener('mousedown', (e) => {
      const row = this.rowAt(e);
      if (row && e.detail === 1) this.beforeClick = { node: row.node, expanded: row.node.expanded };
    });
    this.inner.addEventListener('dblclick', (e) => {
      const row = this.rowAt(e);
      if (!row || !row.node.children.size) return;
      const before = this.beforeClick?.node === row.node ? this.beforeClick.expanded : row.node.expanded;
      this.toggle(row.node, !before);
    });
    this.inner.addEventListener('contextmenu', (e) => {
      const row = this.rowAt(e);
      if (!row) return;
      e.preventDefault();
      this.select(row.node);
      this.onContextMenu(row.node, e.clientX, e.clientY);
    });
    scrollEl.addEventListener('keydown', (e) => this.handleKey(e));
  }

  // Stops watching the element's size (the tab closed); null afterwards.
  dispose() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  // text: substring match on the topic path, or an MQTT filter when it
  // contains + or #. matchValues also searches the latest payload.
  setFilter(text, matchValues) {
    const q = text.trim();
    if (!q) {
      this.filter = null;
    } else if (/[+#]/.test(q)) {
      this.filter = (n) => n.messageCount > 0 && topicMatches(q, n.path);
    } else {
      const lower = q.toLowerCase();
      this.filter = (n) =>
        n.path.toLowerCase().includes(lower) ||
        (matchValues && n.message !== null && searchableText(n.message).includes(lower));
    }
    this.refresh();
  }

  setEmptyText(text) {
    this.emptyText = text;
  }

  refresh() {
    this.rows = this.tree.rows(this.filter);
    this.inner.style.height = `${this.rows.length * ROW_HEIGHT}px`;
    this.empty.textContent = this.rows.length ? '' : this.filter ? 'No matching topics' : this.emptyText || '';
    this.empty.hidden = this.rows.length > 0;
    this.renderViewport();
  }

  renderViewport() {
    const top = this.scrollEl.scrollTop;
    const height = this.scrollEl.clientHeight;
    const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(this.rows.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    const needed = end - start;
    while (this.pool.length < needed) this.pool.push(this.makeRow());
    const now = Date.now();
    for (let i = 0; i < this.pool.length; i++) {
      const r = this.pool[i];
      if (i >= needed) {
        r.root.hidden = true;
        continue;
      }
      r.root.hidden = false;
      this.fillRow(r, start + i, this.rows[start + i], now);
    }
  }

  makeRow() {
    const root = el('div', 'tree-row');
    const caret = el('span', 'caret');
    const name = el('span', 'name');
    const value = el('span', 'value');
    const badge = el('span', 'badge');
    root.append(caret, name, value, badge);
    this.inner.append(root);
    return { root, caret, name, value, badge };
  }

  fillRow(r, index, { node, depth }, now) {
    r.root.dataset.index = index;
    r.root.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
    r.root.style.paddingLeft = `${depth * 16 + 4}px`;
    const hasKids = node.children.size > 0;
    const open = hasKids && (node.expanded || this.filter);
    r.caret.textContent = hasKids ? (open ? '▾' : '▸') : '';
    r.name.textContent = node.name === '' ? '(empty)' : node.name;
    r.name.classList.toggle('empty-level', node.name === '');
    if (node.message) {
      r.value.textContent = preview(node.message, 200);
      r.value.hidden = false;
    } else {
      r.value.hidden = true;
    }
    r.badge.textContent = hasKids ? `${node.subtreeTopics} topics · ${node.subtreeMessages} msgs` : '';
    r.root.classList.toggle('selected', node === this.selected);
    r.root.classList.toggle('recent', now - node.selfUpdate < RECENT_MS);
    r.badge.classList.toggle('active', hasKids && !open && now - node.lastUpdate < RECENT_MS);
    r.root.classList.toggle('retained', node.retained);
  }

  rowAt(e) {
    const rowEl = e.target.closest('.tree-row');
    return rowEl ? this.rows[Number(rowEl.dataset.index)] : null;
  }

  handleClick(e) {
    const row = this.rowAt(e);
    if (!row) return;
    if (e.target.classList.contains('caret') && row.node.children.size) {
      this.toggle(row.node);
      return;
    }
    this.select(row.node, 'click');
  }

  toggle(node, expanded = !node.expanded) {
    node.expanded = expanded;
    this.refresh();
  }

  // source: 'click' for mouse selection, 'key' for keyboard navigation.
  select(node, source = 'api') {
    this.selected = node;
    this.renderViewport();
    this.onSelect(node, source);
  }

  scrollToIndex(i) {
    const top = i * ROW_HEIGHT;
    const view = this.scrollEl;
    if (top < view.scrollTop) view.scrollTop = top;
    else if (top + ROW_HEIGHT > view.scrollTop + view.clientHeight) view.scrollTop = top + ROW_HEIGHT - view.clientHeight;
  }

  reveal(node) {
    for (let p = node.parent; p && p.parent; p = p.parent) p.expanded = true;
    this.refresh();
    const i = this.rows.findIndex((r) => r.node === node);
    if (i >= 0) this.scrollToIndex(i);
  }

  handleKey(e) {
    if (!this.rows.length) return;
    let i = this.rows.findIndex((r) => r.node === this.selected);
    const node = this.selected;
    switch (e.key) {
      case 'ArrowDown':
        i = Math.min(this.rows.length - 1, i + 1);
        break;
      case 'ArrowUp':
        i = Math.max(0, i - 1);
        break;
      case 'PageDown':
        i = Math.min(this.rows.length - 1, i + Math.floor(this.scrollEl.clientHeight / ROW_HEIGHT));
        break;
      case 'PageUp':
        i = Math.max(0, i - Math.floor(this.scrollEl.clientHeight / ROW_HEIGHT));
        break;
      case 'ArrowRight':
        if (node?.children.size && !node.expanded) return this.toggle(node, true), e.preventDefault();
        i = Math.min(this.rows.length - 1, i + 1);
        break;
      case 'ArrowLeft':
        if (node?.children.size && node.expanded) return this.toggle(node, false), e.preventDefault();
        if (node?.parent?.parent) i = this.rows.findIndex((r) => r.node === node.parent);
        break;
      case 'Enter': // (Space is the global Hold shortcut)
        if (node?.children.size) this.toggle(node);
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    if (i < 0) i = 0;
    this.select(this.rows[i].node, 'key');
    this.scrollToIndex(i);
  }
}
