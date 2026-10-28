// The status dot of a connection tab.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dotState } from '../../renderer/tabStrip.js';

test('connected: green', () => {
  assert.equal(dotState({ state: 'connected', url: 'mqtt://h:1883' }, true), 'connected');
});

test('connecting, reconnecting and offline: amber', () => {
  assert.equal(dotState({ state: 'connecting' }, false), 'connecting');
  assert.equal(dotState({ state: 'reconnecting' }, true), 'connecting');
  assert.equal(dotState({ state: 'offline' }, true), 'connecting');
});

test('a failed connection or an unexpected drop: red', () => {
  assert.equal(dotState({ state: 'error', error: 'ECONNREFUSED' }, true), 'error');
  assert.equal(dotState({ state: 'error', error: 'ECONNREFUSED' }, false), 'error');
  assert.equal(dotState({ state: 'disconnected', unexpected: true }, true), 'error');
});

test('disconnected by the user: grey', () => {
  assert.equal(dotState({ state: 'disconnected', url: 'mqtt://h:1883' }, true), 'disconnected');
});

test('never connected and not connecting: no dot', () => {
  assert.equal(dotState({ state: 'disconnected' }, false), 'new');
  assert.equal(dotState(undefined, false), 'new');
});
