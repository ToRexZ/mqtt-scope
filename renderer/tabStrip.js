// The tab strip in the window's top bar: one tab per connection with its
// status dot, name and close button, then + for a new tab. Only the DOM; the
// window shell (app.js) decides what a click does and what the tabs show.

import { el } from './ui.js';
import { stripLayout } from './tabLayout.js';

// Name scrolling: px per second, and the pause at each end in seconds.
const SCROLL_SPEED = 30;
const SCROLL_PAUSE = 1.5;

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
    this.header = header;
    this.brand = header.querySelector('.brand');
    this.plus = header.querySelector('.tab-new');
    this.activeId = null;
    this.keyframes = new Set(); // ping-pong keyframes made so far, by name
    this.sheet = document.head.appendChild(document.createElement('style')).sheet;
    // The strip gives way to the window's width; the right-hand buttons
    // (Update comes and goes) take theirs first.
    const observer = new ResizeObserver(() => this.layout());
    observer.observe(header);
    for (const b of header.querySelectorAll('.spacer ~ *')) observer.observe(b);
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
    const close = el('span', 'conn-tab-close', '×');
    close.title = 'Close tab';
    const name = el('span', 'conn-tab-name');
    name.append(el('span', 'conn-tab-label'));
    item.append(el('span', 'dot'), name, close);
    this.items.set(id, item);
    return item;
  }
}
