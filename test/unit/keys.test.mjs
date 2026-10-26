import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS,
  comboFromEvent,
  resolveBindings,
  normalizeOverrides,
  conflicts,
  bindingIndex,
  displayCombo,
  fixedShortcuts,
  toAccelerator,
  isPlainKey,
  keyBelongsToTarget,
  isTypingTarget,
} from '../../renderer/keys.js';

const ev = (key, mods = {}, code = '') => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('comboFromEvent', () => {
  test('Ctrl is Mod on Linux/Windows, Cmd is Mod on macOS', () => {
    assert.equal(comboFromEvent(ev('k', { ctrlKey: true }), false), 'Mod+K');
    assert.equal(comboFromEvent(ev('k', { metaKey: true }), true), 'Mod+K');
    assert.equal(comboFromEvent(ev('k', { metaKey: true }), false), 'K', 'Meta is not Mod off macOS');
    assert.equal(comboFromEvent(ev('k', { ctrlKey: true }), true), 'Ctrl+K', 'Ctrl stays Ctrl on macOS');
  });
  test('modifier order is Mod, Alt, Shift and letters are upper-cased', () => {
    assert.equal(comboFromEvent(ev('S', { ctrlKey: true, shiftKey: true, altKey: true }), false), 'Mod+Alt+Shift+S');
  });
  test('Shift+digit keeps the digit, not the symbol', () => {
    assert.equal(comboFromEvent(ev('!', { ctrlKey: true, shiftKey: true }, 'Digit1'), false), 'Mod+Shift+1');
  });
  test('named keys and space', () => {
    assert.equal(comboFromEvent(ev('Enter'), false), 'Enter');
    assert.equal(comboFromEvent(ev('F11'), false), 'F11');
    assert.equal(comboFromEvent(ev(' ', { ctrlKey: true }), false), 'Mod+Space');
    assert.equal(comboFromEvent(ev(',', { ctrlKey: true }), false), 'Mod+,');
  });
  test('lone modifiers and dead keys give no combo', () => {
    for (const k of ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Dead', 'Unidentified']) assert.equal(comboFromEvent(ev(k), false), '', k);
  });
});

describe('bindings', () => {
  test('defaults, overrides and unbinding', () => {
    const b = resolveBindings({ connections: 'Mod+J', maximize: '' });
    assert.equal(b.connections, 'Mod+J');
    assert.equal(b.maximize, '');
    assert.equal(b.settings, 'Mod+,');
    assert.equal(Object.keys(b).length, ACTIONS.length);
  });
  test('every action has a unique id and the defaults do not conflict', () => {
    assert.equal(new Set(ACTIONS.map((a) => a.id)).size, ACTIONS.length);
    assert.equal(conflicts(resolveBindings({})).size, 0);
  });
  test('Enter connects by default', () => {
    assert.equal(resolveBindings({}).connectSelected, 'Enter');
  });
  test('Space holds, Ctrl/Cmd+R reloads', () => {
    const b = resolveBindings({});
    assert.equal(b.hold, 'Space');
    assert.equal(b.reset, 'Mod+R');
    assert.equal(isPlainKey(b.hold), true, 'Space must still type in text fields');
    assert.equal(toAccelerator(b.hold), 'Space');
    assert.equal(toAccelerator(b.reset), 'CmdOrCtrl+R');
  });
  test('normalizeOverrides keeps only real changes to known actions', () => {
    assert.deepEqual(normalizeOverrides({ connections: 'Mod+J', settings: 'Mod+,', nope: 'X', find: 3, clear: 'Mod+L' }), { connections: 'Mod+J', clear: 'Mod+L' });
    assert.deepEqual(normalizeOverrides(null), {});
    assert.deepEqual(normalizeOverrides({ connections: 'x'.repeat(41) }), {});
  });
  test('conflicts lists combos used by more than one action', () => {
    const c = conflicts(resolveBindings({ settings: 'Mod+K' }));
    assert.deepEqual([...c.entries()], [['Mod+K', ['connections', 'settings']]]);
  });
  test('bindingIndex maps combos to actions and skips unbound ones', () => {
    const idx = bindingIndex(resolveBindings({ maximize: '' }));
    assert.equal(idx.get('Mod+K'), 'connections');
    assert.equal(idx.get('F11'), undefined);
  });
});

describe('display and menu labels', () => {
  test('displayCombo', () => {
    assert.equal(displayCombo('Mod+Shift+S', false), 'Ctrl+Shift+S');
    assert.equal(displayCombo('Mod+Shift+S', true), '⌘⇧S');
    assert.equal(displayCombo('', false), '—');
  });
  test('toAccelerator converts what Electron menus can show', () => {
    assert.equal(toAccelerator('Mod+K'), 'CmdOrCtrl+K');
    assert.equal(toAccelerator('Mod+,'), 'CmdOrCtrl+,');
    assert.equal(toAccelerator('F11'), 'F11');
    assert.equal(toAccelerator('Mod+Shift+ArrowUp'), 'CmdOrCtrl+Shift+Up');
    assert.equal(toAccelerator('Enter'), 'Enter');
    assert.equal(toAccelerator(''), null);
    assert.equal(toAccelerator('Mod+ø'), null);
  });
});

describe('typing guards', () => {
  test('isPlainKey: no Ctrl/Cmd/Alt and not a function key', () => {
    for (const c of ['Enter', 'K', 'Shift+K', 'Space']) assert.equal(isPlainKey(c), true, c);
    for (const c of ['Mod+K', 'Alt+K', 'Ctrl+K', 'F11', 'Shift+F5']) assert.equal(isPlainKey(c), false, c);
  });
  test('isTypingTarget looks for editable ancestors', () => {
    const at = (match) => ({ closest: (sel) => (sel.includes(match) ? {} : null) });
    assert.equal(isTypingTarget(at('input')), true);
    assert.equal(isTypingTarget({ closest: () => null }), false);
    assert.equal(isTypingTarget(null), false);
  });
});

describe('keys the focused element uses itself', () => {
  // A stand-in for a DOM element: closest() matches by tag or role.
  const elem = (tag, role = '') => ({
    closest: (selector) => (selector.split(',').some((sel) => sel.trim() === tag || sel.trim().startsWith(`${tag}[`) || (role && sel.includes(`role="${role}"`))) ? {} : null),
  });
  test('plain keys type into text fields', () => {
    assert.equal(keyBelongsToTarget('H', elem('input')), true);
    assert.equal(keyBelongsToTarget('Space', elem('textarea')), true);
    assert.equal(keyBelongsToTarget('Mod+R', elem('input')), false, 'modified shortcuts still work');
  });
  test('Space and Enter press a focused button, link, disclosure or tab', () => {
    for (const target of [elem('button'), elem('summary'), elem('div', 'button'), elem('div', 'tab')]) {
      assert.equal(keyBelongsToTarget('Space', target), true);
      assert.equal(keyBelongsToTarget('Enter', target), true);
    }
    assert.equal(keyBelongsToTarget('H', elem('button')), false, 'other plain keys are free');
  });
  test('a button that was clicked (focused by the mouse) leaves Space to the shortcut', () => {
    assert.equal(keyBelongsToTarget('Space', elem('button'), true), false);
    assert.equal(keyBelongsToTarget('Space', elem('input'), true), true, 'text fields always keep their keys');
  });
  test('anywhere else the shortcut gets the key', () => {
    assert.equal(keyBelongsToTarget('Space', elem('div')), false);
    assert.equal(keyBelongsToTarget('Space', null), false);
  });
});

describe('tab shortcuts', () => {
  test('default shortcuts do not clash', () => {
    assert.equal(conflicts(resolveBindings({})).size, 0);
  });
  test('Ctrl+Tab is Mod+Tab off macOS and Ctrl+Tab on macOS', () => {
    assert.equal(comboFromEvent({ key: 'Tab', ctrlKey: true }, false), 'Mod+Tab');
    assert.equal(comboFromEvent({ key: 'Tab', ctrlKey: true }, true), 'Ctrl+Tab');
  });
  test('tab shortcuts have menu accelerators', () => {
    assert.equal(toAccelerator('Mod+Shift+T'), 'CmdOrCtrl+Shift+T');
    assert.equal(toAccelerator('Mod+PageDown'), 'CmdOrCtrl+PageDown');
  });
  test('a saved custom binding for the Plots tab is kept', () => {
    assert.equal(resolveBindings(normalizeOverrides({ tabPlots: 'Mod+3' })).tabPlots, 'Mod+3');
  });
  test('the defaults', () => {
    const b = resolveBindings({});
    assert.equal(b.newTab, 'Mod+T');
    assert.equal(b.closeTab, 'Mod+W');
    assert.equal(b.reopenTab, 'Mod+Shift+T');
    assert.equal(b.nextTabAlt, 'Mod+PageDown');
    assert.equal(b.goToTab1, 'Mod+1');
    assert.equal(b.goToTab8, 'Mod+8');
    assert.equal(b.goToLastTab, 'Mod+9');
    assert.equal(b.tabInspector, 'Alt+1');
    assert.equal(b.tabPlots, 'Alt+2');
    assert.equal(ACTIONS.find((a) => a.id === 'connections').label, 'Open a new connection tab');
  });
  test('no tab default takes a fixed shortcut, on any platform', () => {
    for (const [platform, mac] of [['Linux x86_64', false], ['Win32', false], ['MacIntel', true]]) {
      const bound = new Set(ACTIONS.map((a) => displayCombo(a.default, mac)));
      for (const { combo } of fixedShortcuts(platform)) assert.ok(!bound.has(combo), `${platform}: ${combo}`);
    }
  });
});

describe('fixedShortcuts', () => {
  const combos = (platform) => Object.fromEntries(fixedShortcuts(platform).map((s) => [s.label, s.combo]));

  test('the keys the menu bar used to show, per platform', () => {
    assert.deepEqual(combos('Linux x86_64'), {
      'Zoom in': 'Ctrl+Plus',
      'Zoom out': 'Ctrl+Minus',
      'Reset zoom': 'Ctrl+0',
      'Full screen': 'Shift+F11',
      'Developer tools': 'Ctrl+Shift+I',
      Quit: 'Ctrl+Q',
    });
    assert.equal(combos('Win32').Quit, 'Alt+F4');
    assert.equal(combos('Win32')['Zoom in'], 'Ctrl+Plus');
    assert.equal(combos('MacIntel').Quit, '⌘Q');
    assert.equal(combos('MacIntel')['Full screen'], '⌃⌘F');
  });

  test('none of them is also a rebindable action key', () => {
    const bound = new Set(ACTIONS.map((a) => displayCombo(a.default, false)));
    for (const { combo } of fixedShortcuts('Linux')) assert.ok(!bound.has(combo), combo);
  });
});
