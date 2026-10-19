// Keyboard shortcuts: the actions, their default keys, user overrides and
// matching key events. Combos are strings like "Mod+Shift+K", where Mod is
// Ctrl (Cmd on macOS). An empty string means the action has no shortcut.

export const ACTIONS = [
  { id: 'connections', label: 'Open connections', default: 'Mod+K' },
  { id: 'connectSelected', label: 'Connect to the selected connection (in the connection list)', default: 'Enter' },
  { id: 'subscriptions', label: 'Subscriptions', default: 'Mod+Shift+S' },
  { id: 'newWindow', label: 'New window (another broker)', default: 'Mod+Shift+N' },
  { id: 'settings', label: 'Settings', default: 'Mod+,' },
  { id: 'find', label: 'Filter topics, or search the message when the inspector has focus', default: 'Mod+F' },
  { id: 'publish', label: 'Publish (in the publisher)', default: 'Mod+Enter' },
  { id: 'maximize', label: 'Maximize the inspector', default: 'F11' },
  { id: 'tabInspector', label: 'Show the Inspector', default: 'Mod+1' },
  { id: 'tabPlots', label: 'Show the Plots', default: 'Mod+2' },
  { id: 'newPlot', label: 'Add data to a new plot', default: 'Mod+Shift+A' },
  { id: 'pause', label: 'Pause or resume updates', default: 'Mod+Shift+P' },
  { id: 'clear', label: 'Clear all topics', default: '' },
];

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS']);

export const isMacPlatform = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || '');

// The combo for a keydown event, or '' for a lone modifier key.
export function comboFromEvent(e, mac = isMacPlatform()) {
  if (MODIFIER_KEYS.has(e.key)) return '';
  let key;
  if (/^Digit\d$/.test(e.code || '')) key = e.code.slice(5); // Shift+1 stays "1", not "!"
  else if (e.key === ' ') key = 'Space';
  else if (e.key && e.key.length === 1) key = e.key.toUpperCase();
  else key = e.key || '';
  if (!key || key === 'Unidentified' || key === 'Dead') return '';
  const parts = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (mac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

// Effective shortcut per action: overrides win, '' unbinds.
export function resolveBindings(overrides = {}) {
  const out = {};
  for (const a of ACTIONS) out[a.id] = typeof overrides[a.id] === 'string' ? overrides[a.id] : a.default;
  return out;
}

// Keeps only overrides for known actions that differ from the default.
export function normalizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const a of ACTIONS) {
    const v = raw[a.id];
    if (typeof v === 'string' && v !== a.default && v.length <= 40) out[a.id] = v;
  }
  return out;
}

// combo -> [action ids] for combos used by more than one action.
export function conflicts(bindings) {
  const by = new Map();
  for (const [id, combo] of Object.entries(bindings)) {
    if (!combo) continue;
    if (!by.has(combo)) by.set(combo, []);
    by.get(combo).push(id);
  }
  return new Map([...by].filter(([, ids]) => ids.length > 1));
}

// combo -> action id, for dispatching.
export function bindingIndex(bindings) {
  const map = new Map();
  for (const [id, combo] of Object.entries(bindings)) if (combo && !map.has(combo)) map.set(combo, id);
  return map;
}

export function displayCombo(combo, mac = isMacPlatform()) {
  if (!combo) return '—';
  return combo
    .split('+')
    .map((p) => (p === 'Mod' ? (mac ? '⌘' : 'Ctrl') : p === 'Shift' && mac ? '⇧' : p === 'Alt' && mac ? '⌥' : p))
    .join(mac ? '' : '+');
}

const ACCELERATOR_KEYS = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus' };

// Electron menu accelerator for a combo (shown next to menu items), or null.
export function toAccelerator(combo) {
  if (!combo) return null;
  const parts = combo.split('+');
  const key = parts.pop() || '+';
  const mods = parts.map((p) => (p === 'Mod' ? 'CmdOrCtrl' : p === 'Ctrl' ? 'Ctrl' : p));
  const k = ACCELERATOR_KEYS[key] || key;
  if (!/^([A-Z0-9]|F\d{1,2}|Enter|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Escape|Up|Down|Left|Right|Plus|[,.\-=/;'[\]\\`])$/.test(k)) return null;
  return [...mods, k].join('+');
}

// A plain key (no Ctrl/Cmd/Alt, not a function key) should not fire while the
// user is typing in a text field.
export function isPlainKey(combo) {
  return !/(^|\+)(Mod|Ctrl|Alt)\+/.test(combo) && !/^(Shift\+)?F\d{1,2}$/.test(combo);
}

export function isTypingTarget(el) {
  if (!el || !el.closest) return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"]');
}
