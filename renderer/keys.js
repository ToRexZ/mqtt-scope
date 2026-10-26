// Keyboard shortcuts: the actions, their default keys, user overrides and
// matching key events. Combos are strings like "Mod+Shift+K", where Mod is
// Ctrl (Cmd on macOS). An empty string means the action has no shortcut.

// Defaults that differ on macOS are chosen once, when ACTIONS is built.
export const isMacPlatform = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || '');
const onMac = isMacPlatform();

export const ACTIONS = [
  { id: 'connections', label: 'Open a new connection tab', default: 'Mod+K' },
  { id: 'newTab', label: 'New connection tab', default: 'Mod+T' },
  { id: 'closeTab', label: 'Close the tab', default: 'Mod+W' },
  { id: 'reopenTab', label: 'Reopen the last closed tab', default: 'Mod+Shift+T' },
  { id: 'nextTab', label: 'Next tab', default: onMac ? 'Ctrl+Tab' : 'Mod+Tab' },
  { id: 'prevTab', label: 'Previous tab', default: onMac ? 'Ctrl+Shift+Tab' : 'Mod+Shift+Tab' },
  { id: 'nextTabAlt', label: 'Next tab (alternative)', default: 'Mod+PageDown' },
  { id: 'prevTabAlt', label: 'Previous tab (alternative)', default: 'Mod+PageUp' },
  { id: 'goToTab1', label: 'Go to tab 1', default: 'Mod+1' },
  { id: 'goToTab2', label: 'Go to tab 2', default: 'Mod+2' },
  { id: 'goToTab3', label: 'Go to tab 3', default: 'Mod+3' },
  { id: 'goToTab4', label: 'Go to tab 4', default: 'Mod+4' },
  { id: 'goToTab5', label: 'Go to tab 5', default: 'Mod+5' },
  { id: 'goToTab6', label: 'Go to tab 6', default: 'Mod+6' },
  { id: 'goToTab7', label: 'Go to tab 7', default: 'Mod+7' },
  { id: 'goToTab8', label: 'Go to tab 8', default: 'Mod+8' },
  { id: 'goToLastTab', label: 'Go to the last tab', default: 'Mod+9' },
  { id: 'connectSelected', label: 'Connect to the selected connection (in the connection list)', default: 'Enter' },
  { id: 'subscriptions', label: 'Subscriptions', default: 'Mod+Shift+S' },
  { id: 'newWindow', label: 'New window (another broker)', default: 'Mod+Shift+N' },
  { id: 'settings', label: 'Settings', default: 'Mod+,' },
  { id: 'find', label: 'Filter topics, or search the message when the inspector has focus', default: 'Mod+F' },
  { id: 'publish', label: 'Publish (in the publisher)', default: 'Mod+Enter' },
  { id: 'maximize', label: 'Maximize the inspector', default: 'F11' },
  { id: 'tabInspector', label: 'Show the Inspector', default: 'Alt+1' },
  { id: 'tabPlots', label: 'Show the Plots', default: 'Alt+2' },
  { id: 'newPlot', label: 'Add data to a new plot', default: 'Mod+Shift+A' },
  { id: 'pause', label: 'Pause or resume updates', default: 'Mod+Shift+P' },
  { id: 'hold', label: 'Hold or follow the message in the inspector (on the Plots tab: freeze or resume)', default: 'Space' },
  { id: 'reset', label: 'Reload: clear received messages and restart the plot timelines', default: 'Mod+R' },
  { id: 'clear', label: 'Clear all topics', default: '' },
];

// Shortcuts the app fixes (they were menu accelerators): shown read-only in
// Settings → Keyboard. Quit is Alt+F4 on Windows (Electron gives it no key there).
export function fixedShortcuts(platform = typeof navigator !== 'undefined' ? navigator.platform || '' : '') {
  const mac = /Mac/i.test(platform);
  const win = /Win/i.test(platform);
  const mod = mac ? '⌘' : 'Ctrl';
  const join = (...p) => p.join(mac ? '' : '+');
  return [
    { label: 'Zoom in', combo: join(mod, 'Plus') },
    { label: 'Zoom out', combo: join(mod, 'Minus') },
    { label: 'Reset zoom', combo: join(mod, '0') },
    { label: 'Full screen', combo: mac ? '⌃⌘F' : 'Shift+F11' },
    { label: 'Developer tools', combo: mac ? '⌥⌘I' : 'Ctrl+Shift+I' },
    { label: 'Quit', combo: win ? 'Alt+F4' : join(mod, 'Q') },
  ];
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS']);

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

const PRESSABLE = 'button, a[href], summary, [role="button"], [role="tab"]';

// Whether the focused element uses this key itself, so a shortcut must not
// take it: plain keys type into text fields, and Space or Enter press a
// button, link or disclosure reached with the keyboard. A button that was
// just clicked keeps focus too, but then Space is still the shortcut:
// byPointer says the element got focus from a mouse press (see pointerFocus).
export function keyBelongsToTarget(combo, el, byPointer = false) {
  if (!isPlainKey(combo) || !el || !el.closest) return false;
  if (isTypingTarget(el)) return true;
  if (combo !== 'Space' && combo !== 'Enter') return false;
  return !!el.closest(PRESSABLE) && !byPointer;
}

// Tracks which pressable element got focus from a mouse press (browsers keep
// focus on a clicked button). Returns isPointerFocused(element).
export function pointerFocus(doc) {
  let pressed = null;
  doc.addEventListener('mousedown', (e) => (pressed = e.target.closest?.(PRESSABLE) || null), true);
  doc.addEventListener('focusin', (e) => {
    if (e.target !== pressed) pressed = null; // focus moved some other way (e.g. Tab)
  });
  return (el) => !!el?.closest && el.closest(PRESSABLE) === pressed && pressed !== null;
}
