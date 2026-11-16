// The Custom… time-window picker: a small popover under the time-window menu
// with an hours and a minutes field (digits only; arrows, ↑/↓ and the scroll
// wheel step them). Apply takes 1 min to 24 h. Enter applies; Esc or a click
// outside cancels. Keys typed in it never reach the app's shortcuts.
//
//   openWindowPicker(select, plot.windowSec, { onApply: (sec) => …, onCancel: () => … });

import { el, button, overlayHost } from './ui.js';
import { isValidWindow } from './plotLayouts.js';
import { splitWindow } from './plotView.js';

let current = null; // the open picker's cancel()

export function openWindowPicker(anchor, sec, { onApply, onCancel = () => {} }) {
  current?.();
  const start = splitWindow(sec);
  const root = el('div', 'window-picker');
  const hours = field('window-hours', start.hours, 24, 'h', 'Hours');
  const minutes = field('window-minutes', start.minutes, 59, 'min', 'Minutes');
  const apply = button('Apply', 'Use this time window', () => finish(true), 'btn small primary');
  const fields = el('div', 'window-picker-fields');
  fields.append(hours.label, minutes.label);
  const actions = el('div', 'window-picker-actions');
  actions.append(button('Cancel', '', () => finish(false), 'btn small'), apply);
  root.append(fields, actions);

  // Whole hours 0–24 and minutes 0–59, together 1 min to 24 h; null otherwise.
  const total = () => {
    const h = whole(hours.input.value);
    const m = whole(minutes.input.value);
    if (h === null || m === null || h > 24 || m > 59) return null;
    const s = h * 3600 + m * 60;
    return s >= 60 && isValidWindow(s) ? s : null;
  };
  const update = () => (apply.disabled = total() === null);

  function field(name, value, max, unit, label) {
    const input = Object.assign(el('input', 'input'), { type: 'number', name, min: 0, max, step: 1, value: String(value) });
    input.setAttribute('aria-label', label);
    // Digits only: no signs, decimals or exponents.
    input.addEventListener('keydown', (e) => {
      if (e.key.length === 1 && !/\d/.test(e.key) && !e.ctrlKey && !e.metaKey) e.preventDefault();
    });
    input.addEventListener('beforeinput', (e) => e.data && /\D/.test(e.data) && e.preventDefault());
    input.addEventListener('input', () => update());
    input.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const v = Math.min(max, Math.max(0, (whole(input.value) ?? 0) + (e.deltaY < 0 ? 1 : -1)));
        input.value = String(v);
        update();
      },
      { passive: false },
    );
    const wrap = el('label', 'window-picker-field');
    wrap.append(input, el('span', 'muted', unit));
    return { label: wrap, input };
  }

  function finish(ok) {
    const s = ok ? total() : null;
    if (ok && s === null) return;
    root.remove();
    document.removeEventListener('mousedown', outside, true);
    current = null;
    if (ok) onApply(s);
    else onCancel();
  }
  const outside = (e) => !root.contains(e.target) && finish(false);

  root.addEventListener('keydown', (e) => {
    e.stopPropagation(); // Esc must not also reset a zoom; Space must not freeze
    if (e.key === 'Escape') finish(false);
    else if (e.key === 'Enter' && !e.target.closest('button')) {
      // (On a focused button Enter presses that button.)
      e.preventDefault();
      finish(true);
    }
  });
  document.addEventListener('mousedown', outside, true);
  current = () => finish(false);

  update();
  overlayHost().append(root);
  const a = anchor.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  root.style.left = `${Math.max(4, Math.min(a.left, window.innerWidth - r.width - 4))}px`;
  root.style.top = `${a.bottom + 4 + r.height > window.innerHeight ? Math.max(4, a.top - r.height - 4) : a.bottom + 4}px`;
  hours.input.focus();
  hours.input.select();
}

// A whole, non-negative number typed in a field, else null.
const whole = (text) => (/^\d+$/.test(text) ? Number(text) : null);
