// The application menu's template, for macOS and for Linux and Windows (no
// Electron: the menu of every platform is tested on any).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireFromRoot } from './_util.mjs';

const { menuTemplate } = requireFromRoot('./main/menu.js');

// The template with every action recorded.
function build(isMac, shortcuts = {}) {
  const calls = [];
  const act = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  return { menu: menuTemplate({ isMac, shortcuts, act }), calls };
}
const submenu = (menu, label) => menu.find((m) => m.label === label).submenu;
const item = (menu, top, label) => submenu(menu, top).find((i) => i.label === label);

test('macOS: Close Window has a fixed key of its own, which the menu registers', () => {
  const { menu, calls } = build(true, { closeTab: 'CmdOrCtrl+W' });
  const close = item(menu, 'File', 'Close Window');
  assert.equal(close.accelerator, 'Cmd+Shift+W');
  assert.equal('registerAccelerator' in close, false, 'registered: no page handles it');
  const win = { id: 'focused' };
  close.click(close, win);
  assert.deepEqual(calls, [['closeWindow', win]]);
  assert.equal(submenu(menu, 'File').some((i) => i.role === 'quit'), false, 'Quit is in the app menu');
  assert.equal(menu[0].role, 'appMenu');
});

test('Close Tab is for the focused window, which may be a pop-out; the key is the renderer\'s', () => {
  for (const isMac of [true, false]) {
    const { menu, calls } = build(isMac, { closeTab: 'CmdOrCtrl+W' });
    const close = item(menu, 'File', 'Close Tab');
    assert.deepEqual([close.accelerator, close.registerAccelerator], ['CmdOrCtrl+W', false]);
    const win = { id: 'popout' };
    close.click(close, win);
    assert.deepEqual(calls, [['closeTab', win]]);
  }
});

test('Linux and Windows: no Close Window; Quit in File', () => {
  const { menu } = build(false);
  assert.equal(item(menu, 'File', 'Close Window'), undefined);
  assert.equal(submenu(menu, 'File').at(-1).role, 'quit');
  assert.equal(menu.some((m) => m.label === 'Help'), false);
  assert.equal(menu.some((m) => m.role === 'appMenu'), false);
});

test('the renderer\'s keys are shown, never registered; other items send their action', () => {
  for (const isMac of [true, false]) {
    const { menu, calls } = build(isMac, { newTab: 'CmdOrCtrl+T', pause: 'CmdOrCtrl+Shift+P' });
    for (const [top, label, id, key] of [
      ['File', 'New Tab', 'newTab', 'CmdOrCtrl+T'],
      ['View', 'Pause / Resume Updates', 'pause', 'CmdOrCtrl+Shift+P'],
    ]) {
      const it = item(menu, top, label);
      assert.deepEqual([it.accelerator, it.registerAccelerator], [key, false], label);
      it.click();
      assert.deepEqual(calls.at(-1), ['send', id]);
    }
    // Unbound: no key at all.
    assert.equal('accelerator' in item(menu, 'File', 'Reopen Closed Tab'), false);
    const full = submenu(menu, 'View').find((i) => i.role === 'togglefullscreen');
    assert.equal(full.accelerator, isMac ? 'Ctrl+Cmd+F' : 'Shift+F11');
  }
});
