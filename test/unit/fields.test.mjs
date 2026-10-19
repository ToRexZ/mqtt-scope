import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenFields, visibleFields, messageFields, hasNumbers } from '../../renderer/fields.js';
import { getAt } from '../../renderer/jsonPath.js';

const msg = (s) => ({ payload: new TextEncoder().encode(s) });
const sample = {
  agvPosition: { x: 1.5, y: 2, mapId: 'hall' },
  velocity: { vx: 0 },
  list: [{ a: 1 }, { a: '2' }],
  ok: true,
  s: 'x',
  n: null,
  'odd key': 3,
};

test('flattenFields lists containers and leaves in document order with depth', () => {
  const { rows, truncated } = flattenFields(sample);
  assert.equal(truncated, false);
  assert.deepEqual(
    rows.map((r) => `${r.depth}:${r.path}:${r.kind}`),
    [
      '0:$.agvPosition:object',
      '1:$.agvPosition.x:number',
      '1:$.agvPosition.y:number',
      '1:$.agvPosition.mapId:string',
      '0:$.velocity:object',
      '1:$.velocity.vx:number',
      '0:$.list:array',
      '1:$.list[0]:object',
      '2:$.list[0].a:number',
      '1:$.list[1]:object',
      '2:$.list[1].a:string',
      '0:$.ok:boolean',
      '0:$.s:string',
      '0:$.n:null',
      '0:$["odd key"]:number',
    ],
  );
});

test('segs of every row address the row value', () => {
  for (const r of flattenFields(sample).rows) assert.deepEqual(getAt(sample, r.segs), r.value);
});

test('plottable: numbers, booleans and decimal strings only', () => {
  const by = Object.fromEntries(flattenFields(sample).rows.map((r) => [r.path, r.plottable]));
  assert.equal(by['$.agvPosition.x'], true);
  assert.equal(by['$.ok'], true);
  assert.equal(by['$.list[1].a'], true, '"2" is a decimal string');
  assert.equal(by['$.s'], false);
  assert.equal(by['$.n'], false);
  assert.equal(by['$.agvPosition'], false);
  assert.equal(flattenFields({ h: '0x10', i: 'Infinity' }).rows.every((r) => !r.plottable), true);
});

test('container sizes and the row limit', () => {
  const { rows } = flattenFields(sample);
  assert.equal(rows.find((r) => r.path === '$.list').size, 2);
  assert.equal(rows.find((r) => r.path === '$.agvPosition').size, 3);
  const big = flattenFields({ a: Array.from({ length: 100 }, (_, i) => i) }, 10);
  assert.equal(big.rows.length, 10);
  assert.equal(big.truncated, true);
});

test('primitive roots become a single payload row', () => {
  assert.deepEqual(flattenFields(5).rows.map((r) => [r.path, r.key, r.plottable]), [['$', '(payload)', true]]);
  assert.deepEqual(flattenFields([]).rows, []);
});

test('visibleFields: numbersOnly keeps plottable leaves and their ancestors only', () => {
  const rows = visibleFields(flattenFields(sample).rows, { numbersOnly: true });
  assert.deepEqual(
    rows.map((r) => r.path),
    ['$.agvPosition', '$.agvPosition.x', '$.agvPosition.y', '$.velocity', '$.velocity.vx', '$.list', '$.list[0]', '$.list[0].a', '$.list[1]', '$.list[1].a', '$.ok', '$["odd key"]'],
  );
});

test('visibleFields: query matches paths case-insensitively and keeps ancestors', () => {
  const rows = visibleFields(flattenFields(sample).rows, { query: 'VX' });
  assert.deepEqual(rows.map((r) => r.path), ['$.velocity', '$.velocity.vx']);
  assert.deepEqual(visibleFields(flattenFields(sample).rows, { query: 'nothing' }), []);
  // A container name in the query shows all its leaves.
  assert.deepEqual(
    visibleFields(flattenFields(sample).rows, { query: 'agvposition' }).map((r) => r.path),
    ['$.agvPosition', '$.agvPosition.x', '$.agvPosition.y', '$.agvPosition.mapId'],
  );
});

test('visibleFields: collapsed containers hide their descendants, nested ones too', () => {
  const all = flattenFields(sample).rows;
  assert.deepEqual(
    visibleFields(all, { collapsed: new Set(['$.list']) }).map((r) => r.path).filter((p) => p.startsWith('$.list')),
    ['$.list'],
  );
  assert.deepEqual(
    visibleFields(all, { collapsed: new Set(['$.list[0]']) }).map((r) => r.path).filter((p) => p.startsWith('$.list')),
    ['$.list', '$.list[0]', '$.list[1]', '$.list[1].a'],
  );
});

test('messageFields handles JSON, numbers, text and binary payloads', () => {
  assert.equal(messageFields(msg('{"a":{"b":1}}')).rows.length, 2);
  assert.deepEqual(messageFields(msg(' 42 ')).rows.map((r) => [r.key, r.value, r.plottable]), [['(payload)', 42, true]]);
  assert.deepEqual(messageFields(msg('hello')).rows.map((r) => [r.value, r.plottable]), [['hello', false]]);
  assert.deepEqual(messageFields({ payload: new Uint8Array([0, 1, 2, 255]) }).rows.map((r) => r.plottable), [false]);
  assert.deepEqual(messageFields(msg('')).rows.map((r) => r.plottable), [false]);
});

test('hasNumbers finds nested numbers and caches the answer', () => {
  assert.equal(hasNumbers(msg('{"a":{"b":[{"c":"x"},{"d":2}]}}')), true);
  assert.equal(hasNumbers(msg('{"a":"x","b":null}')), false);
  assert.equal(hasNumbers(msg('7')), true);
  assert.equal(hasNumbers(msg('seven')), false);
  const m = msg('{"x":1}');
  hasNumbers(m);
  assert.equal(m._hasNumbers, true);
});
