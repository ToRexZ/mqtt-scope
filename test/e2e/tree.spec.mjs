// Topic tree: building from retained and live messages, counts, expand and
// collapse (mouse and keyboard), natural sort, empty levels, filtering,
// pause/resume and clear.

import { test, expect, row, rowNames, treeRows, waitForTopic } from './fixtures.mjs';

const selectedName = (page) => page.locator('#tree-scroll .tree-row.selected:not([hidden]) .name');

test('topic tree: counts, expand/collapse, keyboard, sort, empty levels', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('sensors/robot-10/temp', '21.5', { retain: true });
  await broker.publish('sensors/robot-2/temp', '19.25', { retain: true });
  await broker.publish('sensors/robot-2/humidity', '40', { retain: true });
  await broker.publish('sensors/robot-1/temp', '18', { retain: true });
  await broker.publish('a//b', 'empty middle level', { retain: true });
  await broker.publish('/leading', 'empty first level', { retain: true });
  const { page, errors } = await env.connected(broker);

  await expect(page.locator('#stat-topics')).toHaveText('6 topics');
  await expect(page.locator('#stat-msgs')).toHaveText('6 messages');
  // Root level, collapsed, naturally sorted; '' renders as "(empty)".
  await expect.poll(() => rowNames(page)).toEqual(['(empty)', 'a', 'sensors']);
  const rows = await treeRows(page);
  expect(rows[0]).toMatchObject({ name: '(empty)', emptyLevel: true, caret: '▸', badge: '1 topics · 1 msgs' });
  expect(rows[2]).toMatchObject({ name: 'sensors', caret: '▸', badge: '4 topics · 4 msgs', value: null });

  // Live messages update the counters.
  await broker.publish('sensors/robot-2/temp', '19.5');
  await broker.publish('sensors/robot-2/temp', '19.75');
  await expect(row(page, 'sensors').locator('.badge')).toHaveText('4 topics · 6 msgs');
  await expect(page.locator('#stat-topics')).toHaveText('6 topics');
  await expect(page.locator('#stat-msgs')).toHaveText('8 messages');

  // Caret click expands; children are naturally sorted (robot-2 before robot-10).
  await row(page, 'sensors').locator('.caret').click();
  await expect.poll(() => rowNames(page)).toEqual(['(empty)', 'a', 'sensors', '  robot-1', '  robot-2', '  robot-10']);
  await expect(row(page, 'sensors').locator('.caret')).toHaveText('▾');
  // A caret click does not select.
  await expect(page.locator('#tree-scroll .tree-row.selected')).toHaveCount(0);

  // Double-click toggles a branch.
  await row(page, 'robot-2').dblclick();
  await expect.poll(() => rowNames(page)).toEqual([
    '(empty)', 'a', 'sensors', '  robot-1', '  robot-2', '    humidity', '    temp', '  robot-10',
  ]);
  const temp = (await treeRows(page)).find((r) => r.name === 'temp');
  expect(temp.value).toBe('19.75');
  await row(page, 'robot-2').dblclick();
  await expect.poll(() => rowNames(page)).toEqual(['(empty)', 'a', 'sensors', '  robot-1', '  robot-2', '  robot-10']);

  // Empty levels in the middle of a topic.
  await row(page, 'a').locator('.caret').click();
  await expect.poll(() => rowNames(page)).toContain('  (empty)');
  const empties = page.locator('#tree-scroll .tree-row:not([hidden]) .name.empty-level');
  await expect(empties).toHaveCount(2);
  await row(page, 'a').locator('.caret').click();

  // Keyboard navigation.
  await row(page, 'sensors').click();
  await expect(selectedName(page)).toHaveText('sensors');
  await expect(page.locator('#status-selected')).toHaveText('sensors');
  const kb = page.locator('#tree-scroll');
  await expect(kb).toBeFocused();
  await kb.press('ArrowDown');
  await expect(selectedName(page)).toHaveText('robot-1');
  await kb.press('ArrowDown');
  await expect(selectedName(page)).toHaveText('robot-2');
  await expect(page.locator('#status-selected')).toHaveText('sensors/robot-2');
  await kb.press('ArrowRight'); // expands
  await expect.poll(() => rowNames(page)).toContain('    humidity');
  await expect(selectedName(page)).toHaveText('robot-2');
  await kb.press('ArrowRight'); // moves into the branch
  await expect(selectedName(page)).toHaveText('humidity');
  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText('sensors/robot-2/humidity');
  await kb.press('ArrowDown');
  await expect(selectedName(page)).toHaveText('temp');
  await kb.press('ArrowLeft'); // leaf: go to parent
  await expect(selectedName(page)).toHaveText('robot-2');
  await kb.press('ArrowLeft'); // expanded: collapse
  await expect.poll(() => rowNames(page)).not.toContain('    humidity');
  await expect(selectedName(page)).toHaveText('robot-2');
  await kb.press('ArrowUp');
  await expect(selectedName(page)).toHaveText('robot-1');
  await kb.press('ArrowLeft'); // leaf: go to parent
  await expect(selectedName(page)).toHaveText('sensors');
  await kb.press('Enter'); // toggle collapse
  await expect.poll(() => rowNames(page)).toEqual(['(empty)', 'a', 'sensors']);
  await kb.press('Enter'); // toggle expand
  await expect.poll(() => rowNames(page)).toEqual(['(empty)', 'a', 'sensors', '  robot-1', '  robot-2', '  robot-10']);
  await kb.press('ArrowUp');
  await expect(selectedName(page)).toHaveText('a');

  // Collapse all.
  await row(page, 'robot-10').locator('.caret').click();
  await expect.poll(() => rowNames(page)).toContain('    temp');
  await page.locator('#btn-collapse-all').click();
  await expect.poll(() => rowNames(page)).toEqual(['(empty)', 'a', 'sensors']);
  expect(errors).toEqual([]);
});

test('topic tree: filter (substring, wildcard, values), pause/resume and clear', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('sensors/robot-1/temp', '18', { retain: true });
  await broker.publish('sensors/robot-1/humidity', '41', { retain: true });
  await broker.publish('sensors/robot-2/temp', '19', { retain: true });
  await broker.publish('sensors/robot-2/temp/raw', '1900', { retain: true });
  await broker.publish('notes/n1', 'contains needle-xyz somewhere', { retain: true });
  const { page, errors } = await env.connected(broker);
  await expect(page.locator('#stat-topics')).toHaveText('5 topics');
  await expect.poll(() => rowNames(page)).toEqual(['notes', 'sensors']);

  const filter = page.locator('#tree-filter');
  // Ctrl+F focuses the filter box.
  await page.locator('#tree-scroll').click();
  await page.keyboard.press('Control+f');
  await expect(filter).toBeFocused();

  // Substring: matching topics with their ancestors, expanded.
  await filter.fill('humid');
  await expect.poll(() => rowNames(page)).toEqual(['sensors', '  robot-1', '    humidity']);

  // MQTT wildcard filter.
  await filter.fill('sensors/+/temp');
  await expect.poll(() => rowNames(page)).toEqual(['sensors', '  robot-1', '    temp', '  robot-2', '    temp']);
  await filter.fill('sensors/robot-2/#');
  await expect.poll(() => rowNames(page)).toEqual(['sensors', '  robot-2', '    temp', '      raw']);

  // Escape clears the filter.
  await filter.press('Escape');
  await expect(filter).toHaveValue('');
  await expect.poll(() => rowNames(page)).toEqual(['notes', 'sensors']);

  // Searching values needs the "values" checkbox.
  await filter.fill('needle-xyz');
  await expect(page.locator('.tree-empty')).toHaveText('No matching topics');
  await expect.poll(() => rowNames(page)).toEqual([]);
  await page.locator('#filter-values').check();
  await expect.poll(() => rowNames(page)).toEqual(['notes', '  n1']);
  await page.locator('#filter-values').uncheck();
  await expect.poll(() => rowNames(page)).toEqual([]);
  await filter.press('Escape');
  await expect.poll(() => rowNames(page)).toEqual(['notes', 'sensors']);

  // Pause: messages are queued, the tree does not change.
  await page.locator('#btn-pause').click();
  await expect(page.locator('#btn-pause')).toHaveText('Resume');
  await broker.publish('live/one', 'a');
  await broker.publish('live/two', 'b');
  await broker.publish('sensors/robot-1/temp', '18.5');
  await expect(page.locator('#stat-rate')).toHaveText('paused · 3 queued');
  await expect(page.locator('#stat-topics')).toHaveText('5 topics');
  await expect(page.locator('#stat-msgs')).toHaveText('5 messages');
  expect(await rowNames(page)).toEqual(['notes', 'sensors']);

  // Resume applies the queue.
  await page.locator('#btn-pause').click();
  await expect(page.locator('#btn-pause')).toHaveText('Pause');
  await expect.poll(() => rowNames(page)).toEqual(['live', 'notes', 'sensors']);
  await expect(page.locator('#stat-topics')).toHaveText('7 topics');
  await expect(page.locator('#stat-msgs')).toHaveText('8 messages');
  await expect(page.locator('#stat-rate')).toHaveText(/^\d+ msg\/s$/);
  await expect(row(page, 'sensors').locator('.badge')).toHaveText('4 topics · 5 msgs');

  // Clear empties the tree; new messages rebuild it.
  await row(page, 'notes').click();
  await page.locator('#btn-clear').click();
  await expect.poll(() => rowNames(page)).toEqual([]);
  await expect(page.locator('#stat-topics')).toHaveText('0 topics');
  await expect(page.locator('#stat-msgs')).toHaveText('0 messages');
  await expect(page.locator('.tree-empty')).toHaveText('Connected. Waiting for messages…');
  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText('No topic selected');
  await broker.publish('after/clear', '1');
  await waitForTopic(page, 'after/clear');
  await expect.poll(() => rowNames(page)).toEqual(['after']);
  await expect(page.locator('#stat-topics')).toHaveText('1 topics');
  expect(errors).toEqual([]);
});
