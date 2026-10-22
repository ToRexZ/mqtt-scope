// The start after a Windows update (main/afterUpdate.js): the installer starts
// the new version with --updated, and its first main window comes to the
// front, once. The wiring in main.js, with a really shown window:
// test/e2e/updates.spec.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { requireFromRoot } from './_util.mjs';

const { frontAfterUpdate } = requireFromRoot('./main/afterUpdate.js');

// A window shown when it was created, as main.js makes them: Electron may send
// it no 'ready-to-show' (only its first paint does, unreliably); its page's
// 'did-finish-load' always comes.
class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.destroyed = false;
    this.webContents = new EventEmitter();
  }
  setAlwaysOnTop(on) {
    this.calls.push(['setAlwaysOnTop', on]);
  }
  show() {
    this.calls.push(['show']);
  }
  focus() {
    this.calls.push(['focus']);
  }
  isDestroyed() {
    return this.destroyed;
  }
}

function fakeLog() {
  const lines = [];
  const at = (level) => (...args) => lines.push([level, ...args]);
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

test('started with --updated: once its page has loaded the window comes to the front, only once', () => {
  const win = new FakeWindow();
  const log = fakeLog();
  assert.equal(frontAfterUpdate({ argv: ['C:\\MQTT Scope\\MQTT Scope.exe', '--updated'], win, log }), true);
  assert.deepEqual(win.calls, [], 'not before its page has loaded');
  win.webContents.emit('did-finish-load');
  assert.deepEqual(win.calls, [['setAlwaysOnTop', true], ['show'], ['focus'], ['setAlwaysOnTop', false]]);
  win.webContents.emit('did-finish-load'); // a reload
  win.emit('ready-to-show');
  assert.equal(win.calls.length, 4, 'only once');
  assert.deepEqual(log.lines, [['info', 'update', 'started after an update: bringing the window to the front']]);
});

test('any other start leaves the window alone', () => {
  for (const argv of [['MQTT Scope.exe'], ['MQTT Scope.exe', 'updated'], ['MQTT Scope.exe', '--updated=1'], ['MQTT Scope.exe', '--force-run']]) {
    const win = new FakeWindow();
    assert.equal(frontAfterUpdate({ argv, win, log: fakeLog() }), false, argv.join(' '));
    win.webContents.emit('did-finish-load');
    win.emit('ready-to-show');
    assert.deepEqual(win.calls, [], argv.join(' '));
    assert.equal(win.webContents.listenerCount('did-finish-load') + win.listenerCount('ready-to-show'), 0);
  }
});

test('a window closed before its page loaded is left alone', () => {
  const win = new FakeWindow();
  const log = fakeLog();
  frontAfterUpdate({ argv: ['x', '--updated'], win, log });
  win.destroyed = true;
  win.webContents.emit('did-finish-load');
  assert.deepEqual(win.calls, []);
  assert.deepEqual(log.lines, []);
});
