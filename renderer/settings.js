// App settings: defaults, validation and the settings dialog.

import { el, button, toast } from './ui.js';

export const DEFAULT_SETTINGS = {
  historyLimit: 100, // messages kept per topic
  historyMB: 64, // payload megabytes kept per topic
};

const LIMITS = {
  historyLimit: [1, 10000],
  historyMB: [1, 4096],
};

export function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    const r = raw?.[k];
    const usable = typeof r === 'number' || (typeof r === 'string' && r.trim() !== '');
    const v = usable ? Number(r) : NaN;
    if (Number.isFinite(v)) out[k] = Math.min(max, Math.max(min, Math.round(v)));
  }
  return out;
}

// Resolves to the saved settings, or null when cancelled.
export function openSettings(api, current) {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay');
    const form = el('form', 'modal prompt settings');
    const fields = {};
    const field = (key, label, hint) => {
      const input = el('input', 'input');
      input.type = 'number';
      input.name = key;
      input.min = String(LIMITS[key][0]);
      input.max = String(LIMITS[key][1]);
      input.value = String(current[key]);
      fields[key] = input;
      const wrap = el('label', 'field');
      wrap.append(el('span', 'field-label', label), input, el('span', 'field-hint', hint));
      return wrap;
    };
    const done = (v) => {
      overlay.remove();
      resolve(v);
    };
    const actions = el('div', 'modal-actions');
    actions.append(button('Cancel', '', () => done(null)), Object.assign(el('button', 'btn primary', 'Save'), { type: 'submit' }));
    form.append(
      el('h3', '', 'Settings'),
      field('historyLimit', 'Messages kept per topic', 'Older messages are dropped. Used by History, Diff and Chart.'),
      field('historyMB', 'History size per topic (MB)', 'Caps memory for topics with large payloads. The latest message is always kept.'),
      actions,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const next = normalizeSettings(Object.fromEntries(Object.entries(fields).map(([k, i]) => [k, i.value])));
      try {
        await api.storeSet('settings', next);
      } catch (err) {
        toast(`Could not save settings: ${err.message}`, 'error');
      }
      done(next);
    });
    form.addEventListener('keydown', (e) => e.key === 'Escape' && done(null));
    overlay.append(form);
    document.body.append(overlay);
    fields.historyLimit.focus();
  });
}
