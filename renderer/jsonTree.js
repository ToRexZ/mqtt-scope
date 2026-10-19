// Collapsible JSON tree. Children are built only when a node is expanded and
// long arrays/objects are rendered in chunks, so multi-megabyte messages open
// instantly. Expansion state lives in a Set of paths owned by the caller, so
// it survives live updates.

import { el } from './ui.js';
import { childPath } from './jsonPath.js';

const CHUNK = 300;

export function countNodes(value, limit = Infinity) {
  let n = 0;
  const stack = [value];
  while (stack.length && n < limit) {
    const v = stack.pop();
    n++;
    if (v && typeof v === 'object') for (const c of Object.values(v)) stack.push(c);
  }
  return n;
}

// Paths of every container node, optionally limited by depth.
export function containerPaths(value, maxDepth = Infinity) {
  const out = [];
  const walk = (v, path, depth) => {
    if (!v || typeof v !== 'object' || depth > maxDepth) return;
    out.push(path);
    const isArr = Array.isArray(v);
    for (const [k, c] of Object.entries(v)) walk(c, childPath(path, isArr ? Number(k) : k), depth + 1);
  };
  walk(value, '$', 0);
  return out;
}

// Finds keys and primitive values containing `query` (case-insensitive).
// Returns { visible, matches, count }: `matches` are the matching nodes,
// `visible` those plus every ancestor, used to show only matching branches.
export function searchJson(value, query) {
  const q = query.toLowerCase();
  const visible = new Set();
  const matches = new Set();
  let count = 0;
  const hit = (p, chain) => {
    count++;
    matches.add(p);
    visible.add(p);
    for (const a of chain) visible.add(a);
  };
  const walk = (v, path, chain) => {
    if (v !== null && typeof v === 'object') {
      const isArr = Array.isArray(v);
      const inner = [...chain, path];
      for (const [k, c] of Object.entries(v)) {
        const p = childPath(path, isArr ? Number(k) : k);
        if (!isArr && k.toLowerCase().includes(q)) hit(p, inner);
        walk(c, p, inner);
      }
    } else if (String(v).toLowerCase().includes(q)) {
      hit(path, chain);
    }
  };
  walk(value, '$', []);
  return { visible, matches, count };
}

const preview = (v) => {
  if (Array.isArray(v)) return `[ ${v.length} items ]`;
  const n = Object.keys(v).length;
  return `{ ${n} ${n === 1 ? 'key' : 'keys'} }`;
};

export class JsonTree {
  // opts: expanded: Set<string>, changed: Set<string>, onContextMenu(e, info)
  constructor(container, value, opts) {
    this.container = container;
    this.value = value;
    this.expanded = opts.expanded;
    // When searching, only branches in `visible` are shown and opened.
    this.visible = opts.search?.visible || null;
    this.matches = opts.search?.matches || new Set();
    this.forced = this.visible ? new Set(this.visible) : new Set();
    this.changed = opts.changed || new Set();
    this.changedAncestors = opts.changedAncestors || new Set();
    this.onContextMenu = opts.onContextMenu;
    this.info = new WeakMap();

    container.textContent = '';
    const root = el('div', 'jt');
    root.append(this.buildNode(undefined, value, '$', [], true, false));
    container.append(root);

    root.addEventListener('click', (e) => {
      const line = e.target.closest('.jt-line');
      const info = line && this.info.get(line);
      // Any click on a container line toggles it, unless the user was selecting text.
      if (info?.container && !line.classList.contains('jt-close') && !window.getSelection().toString()) {
        this.toggle(line, info);
      }
    });
    root.addEventListener('contextmenu', (e) => {
      const line = e.target.closest('.jt-line');
      const info = line && this.info.get(line);
      if (!info) return;
      e.preventDefault();
      this.onContextMenu?.(e, info);
    });
  }

  isOpen(path) {
    return this.expanded.has(path) || this.forced.has(path);
  }

  buildNode(key, value, path, segs, isLast, unfiltered) {
    const isContainer = value !== null && typeof value === 'object';
    const wrap = el('div', 'jt-node');
    const line = el('div', 'jt-line');
    line.title = path;
    // Below a matching key everything is shown, not just further matches.
    this.info.set(line, { path, segs, value, container: isContainer, unfiltered: unfiltered || this.matches.has(path) });
    if (this.changed.has(path)) line.classList.add('jt-changed');

    const caret = el('span', 'jt-caret', isContainer ? '▸' : '');
    line.append(caret);
    if (key !== undefined) {
      line.append(el('span', typeof key === 'number' ? 'jt-index' : 'jt-key', typeof key === 'number' ? String(key) : JSON.stringify(key)));
      line.append(el('span', 'jt-punct', ': '));
    }
    if (isContainer) {
      line.append(el('span', 'jt-punct', Array.isArray(value) ? '[' : '{'));
      const summary = el('span', 'jt-summary', ` ${preview(value)} ${Array.isArray(value) ? ']' : '}'}${isLast ? '' : ','}`);
      line.append(summary);
      if (this.changedAncestors.has(path)) line.append(el('span', 'jt-dot', '●'));
      wrap.append(line);
      if (this.isOpen(path)) this.open(wrap, line, this.info.get(line));
    } else {
      line.append(this.valueSpan(value));
      if (!isLast) line.append(el('span', 'jt-punct', ','));
      wrap.append(line);
    }
    return wrap;
  }

  valueSpan(v) {
    if (v === null) return el('span', 'tk-null', 'null');
    switch (typeof v) {
      case 'string':
        return el('span', 'tk-str', JSON.stringify(v));
      case 'number':
        return el('span', 'tk-num', String(v));
      case 'boolean':
        return el('span', 'tk-bool', String(v));
      default:
        return el('span', '', String(v));
    }
  }

  open(wrap, line, info) {
    const { value, path, segs } = info;
    line.querySelector('.jt-caret').textContent = '▾';
    line.querySelector('.jt-summary').hidden = true;
    const kids = el('div', 'jt-children');
    let entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
    if (this.visible && !info.unfiltered) entries = entries.filter(([k]) => this.visible.has(childPath(path, k)));
    const renderFrom = (start) => {
      const end = Math.min(entries.length, start + CHUNK);
      for (let i = start; i < end; i++) {
        const [k, v] = entries[i];
        kids.append(this.buildNode(k, v, childPath(path, k), [...segs, k], i === entries.length - 1, info.unfiltered));
      }
      if (end < entries.length) {
        const more = el('div', 'jt-more', `Show ${Math.min(CHUNK, entries.length - end)} more of ${entries.length - end} remaining…`);
        more.addEventListener('click', () => {
          more.remove();
          renderFrom(end);
        });
        kids.append(more);
      }
    };
    renderFrom(0);
    const close = el('div', 'jt-line jt-close');
    close.append(el('span', 'jt-caret', ''), el('span', 'jt-punct', Array.isArray(value) ? ']' : '}'));
    wrap.append(kids, close);
  }

  toggle(line, info) {
    const wrap = line.parentElement;
    if (wrap.children.length > 1) {
      while (wrap.children.length > 1) wrap.lastChild.remove();
      line.querySelector('.jt-caret').textContent = '▸';
      line.querySelector('.jt-summary').hidden = false;
      this.expanded.delete(info.path);
      this.forced.delete(info.path);
    } else {
      this.expanded.add(info.path);
      this.open(wrap, line, info);
    }
  }
}
