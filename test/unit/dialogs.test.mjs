// The buttons of a question, in each platform's order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireFromRoot } from './_util.mjs';

const { question } = requireFromRoot('./main/dialogs.js');

test('Linux puts the action on the right, after Cancel', () => {
  assert.deepEqual(question('Delete', 'linux'), { buttons: ['Cancel', 'Delete'], okId: 1, cancelId: 0, defaultId: 0 });
});

test('Windows and macOS give the action first', () => {
  for (const platform of ['win32', 'darwin']) {
    assert.deepEqual(question('Close', platform), { buttons: ['Close', 'Cancel'], okId: 0, cancelId: 1, defaultId: 1 });
  }
});

test('the action is OK without a label', () => {
  assert.deepEqual(question(undefined, 'win32').buttons, ['OK', 'Cancel']);
  assert.deepEqual(question('', 'linux').buttons, ['Cancel', 'OK']);
});
