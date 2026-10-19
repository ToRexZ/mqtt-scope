// Deleting retained messages from the tree's context menu.

import { test, expect, rowByPath, row, rowNames, waitForTopic, menu, menuLabels, mockDialogs, dialogCalls, toast } from './fixtures.mjs';

// Retained messages a brand-new subscriber gets for `filter`. A marker
// published after subscribing is delivered after any retained messages.
async function retainedFor(env, port, filter, markerTopic) {
  const c = await env.client(port);
  await c.client.subscribeAsync([filter, markerTopic]);
  await c.publish(markerTopic, 'marker');
  await c.waitFor((m) => m.topic === markerTopic).catch((err) => {
    throw new Error(`${err.message}: marker ${markerTopic} (got ${c.received.map((m) => m.topic).join(', ')})`);
  });
  const out = c.received.filter((m) => m.retain).map((m) => `${m.topic}=${m.payload}`);
  await c.end();
  return out.sort();
}

test('delete retained: single topic (cancel and confirm) and a whole branch', async ({ env }) => {
  const broker = await env.broker();
  for (const [t, v] of [
    ['keep', 'K'],
    ['keep/a', 'A'],
    ['del/one', '1'],
    ['del/two', '2'],
    ['branch/x/1', 'x1'],
    ['branch/x/2', 'x2'],
    ['branch/y', 'y'],
  ]) {
    await broker.publish(t, v, { retain: true });
  }
  const { app, page, errors } = await env.connected(broker);
  await waitForTopic(page, 'branch/y');
  await expect(page.locator('#stat-topics')).toHaveText('7 topics');

  // Menu entries are enabled only where they make sense.
  await row(page, 'branch').click({ button: 'right' });
  const branchLabels = await menuLabels(page);
  expect(branchLabels).toContain('Delete retained messages below (3)');
  await expect(page.locator('.ctx-menu .ctx-item.disabled', { hasText: /^Delete retained message \(none received\)$/ })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await (await rowByPath(page, 'del/one')).click({ button: 'right' });
  await expect(page.locator('.ctx-menu .ctx-item:not(.disabled)', { hasText: /^Delete retained message$/ })).toHaveCount(1);
  // Soft (reported bug): a leaf has nothing below it, the count must be 0.
  await expect.soft(page.locator('.ctx-menu .ctx-item.disabled', { hasText: /^Delete retained messages below/ }), 'leaf "below" count').toHaveText('Delete retained messages below (0)', { timeout: 1000 });

  // Cancel: nothing happens.
  await mockDialogs(app, { confirm: false });
  await menu(page, 'Delete retained message');
  await expect.poll(() => dialogCalls(app)).toEqual([
    {
      kind: 'confirm',
      message: 'Delete retained message?',
      detail:
        'An empty retained message is published to this topic, which removes the retained message from the broker. Current subscribers receive the empty message.\n\ndel/one',
    },
  ]);
  await expect(await rowByPath(page, 'del/one')).toBeVisible();
  expect(await retainedFor(env, broker.port, 'del/#', 'zz/marker1')).toEqual(['del/one=1', 'del/two=2']);

  // Confirm: removed from the tree and from the broker.
  await mockDialogs(app, { confirm: true });
  await (await rowByPath(page, 'del/one')).click({ button: 'right' });
  await menu(page, 'Delete retained message');
  await expect(toast(page).filter({ hasText: 'Deleted 1 retained message' })).toBeVisible();
  await expect.poll(() => rowNames(page)).not.toContain('  one');
  await expect(row(page, 'two')).toBeVisible();
  expect(await retainedFor(env, broker.port, 'del/#', 'zz/marker2')).toEqual(['del/two=2']);
  // The broker's echo of the empty message does not bring the topic back.
  await waitForTopic(page, 'zz/marker2');
  expect(await page.evaluate(() => window.__mqttscope.tree.find('del/one'))).toBeNull();
  await expect.poll(() => rowNames(page)).not.toContain('  one');

  // A whole branch.
  await row(page, 'branch').click({ button: 'right' });
  await menu(page, 'Delete retained messages below (3)');
  await expect(toast(page).filter({ hasText: 'Deleted 3 retained messages' })).toBeVisible();
  await expect.poll(() => (dialogCalls(app))).toContainEqual(expect.objectContaining({ message: 'Delete retained messages under branch?' }));
  await expect(row(page, 'branch')).toHaveCount(0);
  expect(await retainedFor(env, broker.port, 'branch/#', 'zz/marker3')).toEqual([]);
  expect(await retainedFor(env, broker.port, '#', 'zz/marker4')).toEqual(['del/two=2', 'keep/a=A', 'keep=K']);
  await waitForTopic(page, 'zz/marker4');
  expect(await page.evaluate(() => window.__mqttscope.tree.find('branch'))).toBeNull();
  // Left: keep, keep/a, del/two and four markers.
  await expect(page.locator('#stat-topics')).toHaveText('7 topics');

  // "Below" on a topic that has its own retained message as well as children
  // removes what is below it, not the topic's own message.
  await row(page, 'keep').click({ button: 'right' });
  const belowItem = page.locator('.ctx-menu .ctx-item', { hasText: /^Delete retained messages below/ });
  await expect.soft(belowItem, '"below" count excludes the topic itself').toHaveText('Delete retained messages below (1)', { timeout: 1000 });
  await belowItem.click();
  await expect.poll(async () => (await dialogCalls(app)).length).toBe(4);
  await expect(toast(page).filter({ hasText: /^Deleted \d retained message/ }).last()).toBeVisible();
  await expect(row(page, 'a')).toHaveCount(0);
  expect.soft(await retainedFor(env, broker.port, 'keep/#', 'zz/marker5'), 'own retained message survives "below"').toEqual(['keep=K']);
  expect(errors).toEqual([]);
});

test('delete retained never publishes to topics that were only seen live', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('fleet/r1/factsheet', '{"type":"agv"}', { retain: true });
  const { app, page, errors } = await env.connected(broker);
  await waitForTopic(page, 'fleet/r1/factsheet');
  // Live (non-retained) traffic on sibling topics, e.g. robot commands.
  await broker.publish('fleet/r1/order', '{"orderId":"o1"}');
  await broker.publish('fleet/r1/instantActions', '{"actions":[]}');
  await waitForTopic(page, 'fleet/r1/instantActions');

  // A live-only topic offers no delete.
  await (await rowByPath(page, 'fleet/r1/order')).click({ button: 'right' });
  await expect(page.locator('.ctx-menu .ctx-item.disabled', { hasText: /^Delete retained message \(none received\)$/ })).toHaveCount(1);
  await page.keyboard.press('Escape');

  // The branch delete counts and lists only the retained topic.
  const robot = await env.client(broker.port);
  await robot.subscribe('fleet/r1/#');
  await mockDialogs(app, { confirm: true });
  await row(page, 'r1').click({ button: 'right' });
  await menu(page, 'Delete retained messages below (1)');
  await expect(toast(page).filter({ hasText: 'Deleted 1 retained message' })).toBeVisible();
  const call = (await dialogCalls(app)).at(-1);
  expect(call.detail.endsWith('\n\nfleet/r1/factsheet')).toBe(true);
  await robot.waitFor((m) => m.topic === 'fleet/r1/factsheet' && m.payload.length === 0);
  // The subscriber ("robot") received nothing on the live topics.
  await broker.publish('zz/marker', 'm');
  await robot.subscribe('zz/marker');
  await broker.publish('zz/marker', 'm2');
  await robot.waitFor((m) => m.topic === 'zz/marker');
  expect(robot.received.filter((m) => m.topic !== 'zz/marker' && m.topic !== 'fleet/r1/factsheet')).toEqual([]);
  expect(errors).toEqual([]);
});
