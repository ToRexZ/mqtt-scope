// The tab strip in the window's top bar: one tab per connection with its
// status dot, name and close button, then + for a new tab. Only the DOM; the
// window shell (app.js) decides what a click does and what the tabs show.

import { el } from './ui.js';

// The dot of a tab: green when connected, amber while connecting or retrying,
// red when the connection failed or dropped, grey when the user disconnected,
// and none before the tab has connected (or tried to).
export function dotState(status, everConnected) {
  switch (status?.state) {
    case 'connected':
      return 'connected';
    case 'connecting':
    case 'reconnecting':
    case 'offline':
      return 'connecting';
    case 'error':
      return 'error';
    default:
      if (status?.unexpected) return 'error';
      return everConnected ? 'disconnected' : 'new';
  }
}

export class TabStrip {
  // handlers: onActivate(id), onClose(id), onNew(), onContextMenu(id, x, y),
  //           onMove(id, toIndex)
  constructor(header, handlers) {
    this.handlers = handlers;
    this.list = header.querySelector('.conn-tabs');
    this.items = new Map(); // tab id → its button
    header.querySelector('.tab-new').addEventListener('click', () => handlers.onNew());
    // A click on a tab leaves the focus where it was, so the tab being left
    // keeps its focused element for when it is shown again.
    this.list.addEventListener('mousedown', (e) => e.target.closest('.conn-tab') && e.preventDefault());
    this.list.addEventListener('click', (e) => {
      const item = e.target.closest('.conn-tab');
      if (!item) return;
      if (e.target.closest('.conn-tab-close')) handlers.onClose(item.dataset.id);
      else handlers.onActivate(item.dataset.id);
    });
    this.list.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.conn-tab');
      if (!item || !handlers.onContextMenu) return;
      e.preventDefault();
      handlers.onContextMenu(item.dataset.id, e.clientX, e.clientY);
    });
  }

  // tabs: [{ id, label, state (see dotState), active }] in strip order. Tabs
  // are updated in place, so a tab keeps its element while it stays open.
  render(tabs) {
    const ids = new Set(tabs.map((t) => t.id));
    for (const [id, item] of this.items) {
      if (ids.has(id)) continue;
      item.remove();
      this.items.delete(id);
    }
    tabs.forEach((t, i) => {
      const item = this.items.get(t.id) || this.create(t.id);
      item.dataset.state = t.state;
      item.classList.toggle('active', t.active);
      item.setAttribute('aria-selected', String(t.active));
      item.title = t.label;
      const name = item.querySelector('.conn-tab-name');
      if (name.textContent !== t.label) name.textContent = t.label;
      if (this.list.children[i] !== item) this.list.insertBefore(item, this.list.children[i] ?? null);
    });
  }

  create(id) {
    const item = el('button', 'conn-tab');
    item.type = 'button';
    item.dataset.id = id;
    item.setAttribute('role', 'tab');
    const close = el('span', 'conn-tab-close', '×');
    close.title = 'Close tab';
    item.append(el('span', 'dot'), el('span', 'conn-tab-name'), close);
    this.items.set(id, item);
    return item;
  }
}
