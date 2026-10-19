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
  toAccelerator,
  isPlainKey,
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
