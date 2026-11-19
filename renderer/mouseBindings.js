// Plot mouse bindings: which drag pans the timeline and which draws a zoom
// box (Settings → Keyboard → Plot mouse). No DOM, so it runs in Node too.

export const MOUSE_CHOICES = [
  ['left', 'Left drag'],
  ['right', 'Right drag'],
  ['middle', 'Middle drag'],
  ['shift-left', 'Shift + left drag'],
  ['ctrl-left', 'Ctrl/Cmd + left drag'],
];
export const DEFAULT_MOUSE = { pan: 'left', box: 'right' };

const IDS = new Set(MOUSE_CHOICES.map(([id]) => id));

// Saved bindings: each a known choice, and not both the same (else defaults).
export function normalizeMouse(raw) {
  const pick = (k) => (IDS.has(raw?.[k]) ? raw[k] : DEFAULT_MOUSE[k]);
  const out = { pan: pick('pan'), box: pick('box') };
  return out.pan === out.box ? { ...DEFAULT_MOUSE } : out;
}

// What a mouse-down starts: 'pan', 'box' or null. A modified left drag that
// isn't bound does what the plain left drag does.
export function dragAction(e, bindings) {
  const mod = e.shiftKey ? 'shift-left' : e.ctrlKey || e.metaKey ? 'ctrl-left' : 'left';
  const choice = e.button === 0 ? mod : e.button === 1 ? 'middle' : e.button === 2 ? 'right' : null;
  if (!choice) return null;
  const of = (c) => (bindings.pan === c ? 'pan' : bindings.box === c ? 'box' : null);
  return of(choice) ?? (choice !== 'left' && e.button === 0 ? of('left') : null);
}
