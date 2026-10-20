// Small DOM helpers shared by the views.

export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Where overlays (menus, dialogs, toasts) go: inside the element shown full
// screen, if any, since nothing outside it is visible then.
export const overlayHost = () => document.fullscreenElement || document.body;

export function button(label, title, onClick, className = 'btn') {
  const b = el('button', className, label);
  b.type = 'button'; // never the implicit submit button of a surrounding form
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

// ------------------------------------------------------------ context menu

let openMenu = null;

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

// items: [{ label, action, disabled }] or 'separator'
export function showMenu(x, y, items) {
  closeMenu();
  const menu = el('div', 'ctx-menu');
  for (const item of items) {
    if (item === 'separator') {
      menu.append(el('div', 'ctx-sep'));
      continue;
    }
    const row = el('div', 'ctx-item' + (item.disabled ? ' disabled' : ''), item.label);
    if (!item.disabled) {
      row.addEventListener('click', () => {
        closeMenu();
        item.action();
      });
    }
    menu.append(row);
  }
  overlayHost().append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  openMenu = menu;
}

// Guarded so modules importing ui.js can be loaded in Node for unit tests.
if (typeof document !== 'undefined') {
  document.addEventListener('mousedown', (e) => {
    if (openMenu && !openMenu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  window.addEventListener('blur', closeMenu);
}

// ------------------------------------------------------------ toast

export function toast(message, kind = 'info') {
  const t = el('div', `toast ${kind}`, message);
  overlayHost().append(t);
  setTimeout(() => t.classList.add('fade'), 2600);
  setTimeout(() => t.remove(), 3200);
}

// ------------------------------------------------------------ splitter

// Drag `handle` to resize; `apply(px)` receives the new size. Sizes persist.
export function splitter(handle, { axis, storageKey, initial, min, max, apply, invert = false }) {
  let size = initial;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (saved) size = saved;
  } catch {}
  apply(size);
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const startSize = size;
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    const move = (ev) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      size = Math.max(min, Math.min(max(), startSize + (invert ? -delta : delta)));
      apply(size);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-x', 'resizing-y');
      try {
        localStorage.setItem(storageKey, String(size));
      } catch {}
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// ------------------------------------------------------------ search marks

const MAX_MARKS = 5000;

// Wraps case-insensitive matches of `query` inside `root` in <mark> elements.
export function markMatches(root, query) {
  if (!query) return [];
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = [];
  const textNodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n);
  for (const node of textNodes) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    if (idx === -1) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (idx !== -1 && hits.length < MAX_MARKS) {
      frag.append(text.slice(last, idx));
      const m = el('mark', 'hit', text.slice(idx, idx + q.length));
      frag.append(m);
      hits.push(m);
      last = idx + q.length;
      idx = lower.indexOf(q, last);
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
    if (hits.length >= MAX_MARKS) break;
  }
  return hits;
}

// ------------------------------------------------------------ prompt

// Modal text prompt (Electron has no window.prompt). Resolves to the entered
// text, or null when cancelled. `suggestions(query)` feeds a datalist.
export function promptText({ title, label, value = '', okLabel = 'OK', allowEmpty = false, suggestions }) {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay');
    const box = el('form', 'modal prompt');
    const input = el('input', 'input');
    input.value = value;
    input.spellcheck = false;
    const listId = `prompt-list-${Math.random().toString(36).slice(2)}`;
    const list = el('datalist');
    list.id = listId;
    if (suggestions) {
      input.setAttribute('list', listId);
      const fill = () => {
        list.textContent = '';
        for (const s of suggestions(input.value).slice(0, 200)) {
          const o = el('option');
          o.value = s;
          list.append(o);
        }
      };
      input.addEventListener('input', fill);
      fill();
    }
    const actions = el('div', 'modal-actions');
    const done = (result) => {
      overlay.remove();
      resolve(result);
    };
    actions.append(
      button('Cancel', '', () => done(null)),
      Object.assign(el('button', 'btn primary', okLabel), { type: 'submit' }),
    );
    box.append(el('h3', '', title), el('label', 'field-label', label), input, list, actions);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!allowEmpty && !input.value.trim()) return input.focus();
      done(input.value);
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    });
    overlay.addEventListener('mousedown', (e) => e.target === overlay && done(null));
    overlay.append(box);
    overlayHost().append(overlay);
    input.focus();
    input.select();
  });
}
