// App settings: defaults, validation and the settings dialog (General and
// Keyboard tabs).

import { el, button, toast, overlayHost } from './ui.js';
import { iconButton } from './icons.js';
import { ACTIONS, comboFromEvent, conflicts, displayCombo, normalizeOverrides, resolveBindings } from './keys.js';

export const DEFAULT_SETTINGS = {
  historyLimit: 100, // messages kept per topic
  historyMB: 64, // payload megabytes kept per topic
  autoExpand: true, // clicking a topic in the tree also expands it one level
  keys: {}, // keyboard shortcut overrides: action id -> combo
};

const LIMITS = {
  historyLimit: [1, 10000],
  historyMB: [1, 4096],
};

export function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS, keys: {} };
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    const r = raw?.[k];
    const usable = typeof r === 'number' || (typeof r === 'string' && r.trim() !== '');
    const v = usable ? Number(r) : NaN;
    if (Number.isFinite(v)) out[k] = Math.min(max, Math.max(min, Math.round(v)));
  }
  if (typeof raw?.autoExpand === 'boolean') out.autoExpand = raw.autoExpand;
  out.keys = normalizeOverrides(raw?.keys);
  return out;
}

// Resolves to the saved settings, or null when cancelled.
export function openSettings(api, current, { tab = 'general' } = {}) {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay');
    const form = el('form', 'modal prompt settings');
    const bindings = resolveBindings(current.keys);
    let recording = null; // action id waiting for a key press

    // ---- General
    const fields = {};
    const numberField = (key, label, hint) => {
      const input = Object.assign(el('input', 'input'), { type: 'number', name: key, min: String(LIMITS[key][0]), max: String(LIMITS[key][1]), value: String(current[key]) });
      fields[key] = input;
      const wrap = el('label', 'field');
      wrap.append(el('span', 'field-label', label), input, el('span', 'field-hint', hint));
      return wrap;
    };
    const autoExpand = Object.assign(el('input'), { type: 'checkbox', name: 'autoExpand', checked: current.autoExpand });
    const autoLabel = el('label', 'check');
    autoLabel.append(autoExpand, document.createTextNode(' Expand a topic one level when you click it in the tree'));
    const general = el('div', 'settings-page');
    general.dataset.page = 'general';
    general.append(
      numberField('historyLimit', 'Messages kept per topic', 'Older messages are dropped. Used by History, Diff and Chart.'),
      numberField('historyMB', 'History size per topic (MB)', 'Caps memory for topics with large payloads. The latest message is always kept.'),
      autoLabel,
    );

    // ---- Keyboard
    const keyboard = el('div', 'settings-page keys-page');
    keyboard.dataset.page = 'keyboard';
    const table = el('div', 'keys-table');
    const conflictNote = el('div', 'field-hint bad');
    const renderKeys = () => {
      table.textContent = '';
      const clash = conflicts(bindings);
      const clashing = new Set([...clash.values()].flat());
      for (const a of ACTIONS) {
        const row = el('div', 'keys-row' + (clashing.has(a.id) ? ' conflict' : ''));
        row.dataset.action = a.id;
        const combo = button(recording === a.id ? 'Press keys…' : displayCombo(bindings[a.id]), 'Click, then press the new shortcut. Esc cancels, Backspace removes it.', () => {
          recording = recording === a.id ? null : a.id;
          renderKeys();
        }, 'btn key-combo' + (recording === a.id ? ' on' : ''));
        const reset = iconButton('reset', `Reset to ${displayCombo(a.default)}`, () => {
          bindings[a.id] = a.default;
          recording = null;
          renderKeys();
        }, 'btn icon small');
        reset.disabled = bindings[a.id] === a.default;
        row.append(el('span', 'keys-label', a.label), combo, reset);
        table.append(row);
      }
      conflictNote.textContent = clash.size
        ? `Used twice: ${[...clash.keys()].map((c) => displayCombo(c)).join(', ')}. Change one of them to save.`
        : '';
      saveBtn.disabled = clash.size > 0;
    };
    const resetAll = button('Reset all to defaults', '', () => {
      for (const a of ACTIONS) bindings[a.id] = a.default;
      recording = null;
      renderKeys();
    });
    keyboard.append(el('div', 'field-hint', 'Click a shortcut, then press the keys you want.'), table, conflictNote, resetAll);

    // Records the next key press for the selected action.
    const onRecord = (e) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        recording = null;
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        bindings[recording] = '';
        recording = null;
      } else {
        const combo = comboFromEvent(e);
        if (!combo) return; // a lone modifier: keep waiting
        bindings[recording] = combo;
        recording = null;
      }
      renderKeys();
    };

    // ---- Tabs and actions
    const tabs = el('div', 'tabs settings-tabs');
    const pages = [general, keyboard];
    const showTab = (name) => {
      for (const p of pages) p.hidden = p.dataset.page !== name;
      for (const t of tabs.children) t.classList.toggle('active', t.dataset.tab === name);
    };
    for (const [name, label] of [
      ['general', 'General'],
      ['keyboard', 'Keyboard'],
    ]) {
      const t = button(label, '', () => showTab(name), 'tab');
      t.dataset.tab = name;
      tabs.append(t);
    }
    const saveBtn = Object.assign(el('button', 'btn primary', 'Save'), { type: 'submit' });
    const actions = el('div', 'modal-actions');
    actions.append(button('Cancel', '', () => done(null)), saveBtn);
    form.append(el('h3', '', 'Settings'), tabs, general, keyboard, actions);

    const done = (v) => {
      document.removeEventListener('keydown', onRecord, true);
      overlay.remove();
      resolve(v);
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (conflicts(bindings).size) return showTab('keyboard');
      const raw = Object.fromEntries(Object.entries(fields).map(([k, i]) => [k, i.value]));
      const next = normalizeSettings({ ...raw, autoExpand: autoExpand.checked, keys: bindings });
      try {
        await api.storeSet('settings', next);
      } catch (err) {
        toast(`Could not save settings: ${err.message}`, 'error');
      }
      done(next);
    });
    form.addEventListener('keydown', (e) => e.key === 'Escape' && !recording && done(null));
    document.addEventListener('keydown', onRecord, true);
    overlay.append(form);
    overlayHost().append(overlay);
    renderKeys();
    showTab(tab);
    if (tab === 'general') fields.historyLimit.focus();
  });
}
