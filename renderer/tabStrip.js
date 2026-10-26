// The tab strip in the window's top bar: one tab per connection with its
// status dot, name and close button, then + for a new tab. Only the DOM; the
// window shell (app.js) decides what a click does and what the tabs show.

import { el } from './ui.js';
import { stripLayout } from './tabLayout.js';

// Name scrolling: px per second, and the pause at each end in seconds.
const SCROLL_SPEED = 30;
const SCROLL_PAUSE = 1.5;
// What a tab's drag carries its id as: not text, so a text field it is let
// go over gets nothing.
export const TAB_TYPE = 'application/x-mqttscope-tab';
// A drag that left the window this shortly before it ended ended over the
// window: on Esc, or let go where nothing takes it, the browser has the
// pointer leave it first. Leaving to let go outside takes longer. (Esc
// pressed outside the window cannot be told from letting go there, and tears
// off: either way the drag ends with no drop, long after it left.)
const END_LEAVE_MS = 200;
// How often a window reports another window's tab dragged over its top bar.
const HOVER_REPORT_MS = 100;

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
  //           onMove(id, toIndex) (a tab dragged within this strip),
  //           onDragStart(id), onDragEnd(id, { overSource }) (a tab of this
  //           strip dragged; it may go to another window or out of every one),
  //           onDragHover() (now and then while a tab of another window is
  //           over the top bar), onDrop(index) (one let go here)
  constructor(header, handlers) {
    this.handlers = handlers;
    this.list = header.querySelector('.conn-tabs');
    this.items = new Map(); // tab id → its button
    this.header = header;
    this.brand = header.querySelector('.brand');
    this.plus = header.querySelector('.tab-new');
    this.activeId = null;
    this.focusBefore = null; // the focused element when a tab was pressed
    this.dragId = null; // the tab being dragged inside this strip
    this.outgoing = null; // a tab of this strip being dragged: { id, over, leftAt } (see dragEnded)
    this.incoming = false; // main reports a tab being dragged, maybe of another window
    this.hoverReported = -Infinity; // when onDragHover was last called
    this.keyframes = new Set(); // ping-pong keyframes made so far, by name
    this.sheet = document.head.appendChild(document.createElement('style')).sheet;
    // The strip gives way to the window's width; the right-hand buttons
    // (Update comes and goes) take theirs first.
    const observer = new ResizeObserver(() => this.layout());
    observer.observe(header);
    for (const b of header.querySelectorAll('.spacer ~ *')) observer.observe(b);
    header.querySelector('.tab-new').addEventListener('click', () => handlers.onNew());
    // A click on a tab leaves the focus where it was, so the tab being left
    // keeps its focused element for when it is shown again. (Not by
    // cancelling mousedown: that would also cancel the drag.) The middle
    // button must not autoscroll.
    this.list.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.conn-tab')) return;
      if (e.button === 1) e.preventDefault();
      else this.focusBefore = document.activeElement;
    });
    for (const type of ['mouseup', 'dragend']) document.addEventListener(type, () => this.restoreFocus());
    this.list.addEventListener('auxclick', (e) => {
      const item = e.button === 1 && e.target.closest('.conn-tab');
      if (!item) return;
      e.preventDefault();
      handlers.onClose(item.dataset.id);
    });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('dragstart', (e) => {
      const item = e.target.closest?.('.conn-tab');
      if (!item) return;
      this.dragId = item.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(TAB_TYPE, this.dragId);
      this.outgoing = { id: this.dragId, over: true, leftAt: -Infinity };
      // On the tab itself: it ends there also once the tab went to another window.
      item.addEventListener('dragend', () => this.dragEnded(), { once: true });
      handlers.onDragStart?.(this.dragId);
    });
    // Whether the pointer is over the window while its tab is dragged: it
    // leaves the window to no element of it (relatedTarget). Counting enters
    // and leaves would not do: an element re-rendered under the pointer gets
    // its leave once it is out of the document, where it does not bubble.
    for (const type of ['dragenter', 'dragover']) document.addEventListener(type, () => this.outgoing && (this.outgoing.over = true));
    document.addEventListener('dragleave', (e) => {
      const out = this.outgoing;
      if (!out || e.relatedTarget) return;
      out.over = false;
      out.leftAt = performance.now();
    });
    this.list.addEventListener('dragover', (e) => {
      if (!this.dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.mark(this.dropTarget(e));
    });
    this.list.addEventListener('dragleave', (e) => !this.list.contains(e.relatedTarget) && this.mark(null));
    this.list.addEventListener('drop', (e) => {
      if (!this.dragId) return;
      e.preventDefault();
      const target = this.dropTarget(e);
      const id = this.dragId;
      this.endDrag();
      if (!target) return;
      const order = [...this.list.children].map((c) => c.dataset.id);
      let to = order.indexOf(target.item.dataset.id) + (target.after ? 1 : 0);
      const from = order.indexOf(id);
      if (from < to) to--; // the dragged tab leaves its place first
      if (to !== from) handlers.onMove(id, to);
    });
    // A tab of another window, while main reports it dragged (its data may
    // not be readable here): anywhere on the top bar, it goes where it is let go.
    header.addEventListener('dragover', (e) => {
      if (!this.takesDrop(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.mark(this.dropTarget(e) ?? this.slot(this.dropIndex(e)));
      const now = performance.now();
      if (now - this.hoverReported < HOVER_REPORT_MS) return;
      this.hoverReported = now;
      handlers.onDragHover?.();
    });
    header.addEventListener('dragleave', (e) => !header.contains(e.relatedTarget) && this.mark(null));
    header.addEventListener('drop', (e) => {
      if (!this.takesDrop(e)) return;
      e.preventDefault();
      this.mark(null);
      handlers.onDrop(this.dropIndex(e));
    });
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

  // The tab under the pointer and whether the drop goes after it (the right
  // half), or null over nothing.
  dropTarget(e) {
    const item = e.target.closest?.('.conn-tab');
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { item, after: e.clientX > r.left + r.width / 2 };
  }

  // Where a tab let go at e goes in this strip: before the first tab whose
  // middle is right of the pointer.
  dropIndex(e) {
    return [...this.list.children].filter((item) => {
      const r = item.getBoundingClientRect();
      return r.left + r.width / 2 < e.clientX;
    }).length;
  }

  // The marker for place `index` off the tabs: before that tab, or after the last.
  slot(index) {
    const items = [...this.list.children];
    if (index < items.length) return { item: items[index], after: false };
    return items.length ? { item: items.at(-1), after: true } : null;
  }

  // A tab of another window, not one of this window's own drag (its strip
  // handled that drop already: it must not reach main as well).
  takesDrop(e) {
    return !e.defaultPrevented && !this.outgoing && (this.incoming || !!e.dataTransfer?.types.includes(TAB_TYPE));
  }

  // Main reports a tab being dragged ({ connId }), or (null) that none is.
  setDragging(drag) {
    this.incoming = !!drag;
    if (!drag) this.mark(null);
  }

  // The insertion marker: a bar on the near edge of the target tab.
  mark(target) {
    for (const item of this.items.values()) {
      item.classList.toggle('drop-before', target?.item === item && !target.after);
      item.classList.toggle('drop-after', target?.item === item && target.after);
    }
  }

  restoreFocus() {
    const before = this.focusBefore;
    this.focusBefore = null;
    if (!before || !this.list.contains(document.activeElement)) return;
    if (this.list.contains(before)) return; // keyboard navigation continues from the clicked tab
    if (before.isConnected) before.focus({ preventScroll: true });
    else document.activeElement.blur();
  }

  endDrag() {
    this.dragId = null;
    this.mark(null);
  }

  // A drag of this strip's tab ended, over this window or outside it.
  dragEnded() {
    const out = this.outgoing;
    this.outgoing = null;
    this.endDrag();
    if (!out) return;
    const overSource = out.over || performance.now() - out.leftAt < END_LEAVE_MS;
    this.handlers.onDragEnd?.(out.id, { overSource });
  }

  // Arrow keys, Home and End move focus and activate; Delete closes.
  onKey(e) {
    const item = e.target.closest?.('.conn-tab');
    if (!item || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const all = [...this.list.children];
    const i = all.indexOf(item);
    const to = { ArrowLeft: (i + all.length - 1) % all.length, ArrowRight: (i + 1) % all.length, Home: 0, End: all.length - 1 }[e.key];
    if (e.key === 'Delete') {
      // The closed tab's button is gone: focus goes to the tab shown next.
      Promise.resolve(this.handlers.onClose(item.dataset.id)).then(() => {
        if (!item.isConnected && !document.querySelector('.modal-overlay')) this.items.get(this.activeId)?.focus();
      });
    } else if (to !== undefined) {
      this.handlers.onActivate(all[to].dataset.id);
      all[to].focus();
    } else return;
    e.preventDefault();
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
      item.tabIndex = t.active ? 0 : -1; // roving: one tab stop for the strip
      item.title = t.label;
      const label = item.querySelector('.conn-tab-label');
      if (label.textContent !== t.label) label.textContent = t.label;
      if (this.list.children[i] !== item) this.list.insertBefore(item, this.list.children[i] ?? null);
    });
    this.layout();
    const active = tabs.find((t) => t.active)?.id ?? null;
    if (active !== this.activeId) this.items.get(active)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    this.activeId = active;
  }

  // Sizes brand and tabs for the width there is (see stripLayout), then
  // starts or stops the scrolling of every name that is cut off. It measures
  // and applies in one go, so nothing is painted in between.
  layout() {
    const items = [...this.items.values()];
    const px = (v) => parseFloat(v) || 0;
    const head = getComputedStyle(this.header);
    const gap = px(head.columnGap);
    for (const item of items) item.style.maxWidth = 'none';
    const natural = items.map((item) => item.getBoundingClientRect().width);
    const brandWidth = () => this.brand.getBoundingClientRect().width + px(getComputedStyle(this.brand).marginRight);
    this.brand.classList.remove('icon-only');
    const brandFull = brandWidth();
    this.brand.classList.add('icon-only');
    const brandIcon = brandWidth();
    const right = [...this.header.querySelectorAll('.spacer ~ *')].filter((b) => b.offsetWidth > 0);
    const rightWidth = right.reduce((sum, b) => sum + b.offsetWidth + gap, gap);
    // What is left for brand, tabs and +, less the gaps between them.
    const available =
      this.header.clientWidth - px(head.paddingLeft) - px(head.paddingRight) - rightWidth - 2 * gap -
      px(getComputedStyle(this.list).columnGap) * Math.max(items.length - 1, 0) - 1;
    const { brand, maxTab, scroll } = stripLayout({ available, brandFull, brandIcon, plus: this.plus.offsetWidth, tabs: natural });
    this.brand.classList.toggle('icon-only', brand === 'icon');
    this.list.classList.toggle('scrolling', scroll);
    for (const item of items) item.style.maxWidth = maxTab === null ? '' : `${Math.floor(maxTab)}px`;
    for (const item of items) this.scrollName(item.querySelector('.conn-tab-name'));
  }

  // A name wider than its box moves back and forth by the overflow, at
  // SCROLL_SPEED, resting SCROLL_PAUSE at each end (styles.css reads --shift,
  // --dur and --anim; with reduced motion it ends in "…" instead).
  scrollName(name) {
    // offsetWidth ignores the animation's transform, scrollWidth would not.
    const shift = Math.ceil(name.firstChild.offsetWidth - name.clientWidth);
    name.classList.toggle('scrolling', shift > 0);
    if (shift <= 0) return;
    // Untouched while nothing changed, so a running animation does not jump.
    if (name.style.getPropertyValue('--shift') === `${shift}px`) return;
    const cycle = 2 * (SCROLL_PAUSE + shift / SCROLL_SPEED);
    name.style.setProperty('--shift', `${shift}px`);
    name.style.setProperty('--dur', `${cycle.toFixed(2)}s`);
    name.style.setProperty('--anim', this.pingPong(Math.round((SCROLL_PAUSE / cycle) * 1000)));
  }

  // The keyframes for a rest of `rest` per mille of the cycle at each end,
  // made on first use (a keyframe offset cannot be a variable).
  pingPong(rest) {
    const name = `tab-name-${rest}`;
    if (!this.keyframes.has(name)) {
      const a = rest / 10;
      const away = 'transform: translateX(calc(var(--shift) * -1))';
      this.sheet.insertRule(`@keyframes ${name} { 0%, ${a}% { transform: none } 50%, ${50 + a}% { ${away} } 100% { transform: none } }`, this.sheet.cssRules.length);
      this.keyframes.add(name);
    }
    return name;
  }

  create(id) {
    const item = el('button', 'conn-tab');
    item.type = 'button';
    item.dataset.id = id;
    item.setAttribute('role', 'tab');
    item.draggable = true;
    // Mouse only (Delete closes from the keyboard); hidden so the tab's
    // accessible name is just its label.
    const close = el('span', 'conn-tab-close', '×');
    close.title = 'Close tab';
    close.setAttribute('aria-label', 'Close tab');
    close.setAttribute('aria-hidden', 'true');
    const name = el('span', 'conn-tab-name');
    name.append(el('span', 'conn-tab-label'));
    item.append(el('span', 'dot'), name, close);
    this.items.set(id, item);
    return item;
  }
}
