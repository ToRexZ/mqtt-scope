// Resilience: broker connection drops and message floods.

import { test, expect, row, rowByPath, waitForTopic, recordStatus } from './fixtures.mjs';

// Publishes live (non-retained) messages until the app has one: right after a
// reconnect the app's subscription may not be active at the broker yet.
async function publishUntilSeen(page, broker, topic) {
  let n = 0;
  await expect
    .poll(async () => {
      await broker.publish(topic, String(++n));
      return page.evaluate((t) => !!window.__mqttscope.tree.find(t)?.messageCount, topic);
    }, { timeout: 10_000 })
    .toBe(true);
}

test('connection drop: reconnects automatically and messages keep flowing', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('r/before', '1', { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'r/before');
  const url = `mqtt://127.0.0.1:${broker.port}`;
  const log = await recordStatus(page);

  broker.dropClients();
  await expect.poll(log, { timeout: 10_000 }).toContainEqual(`Reconnecting… — ${url}`);
  await expect(page.locator('#status-text')).toHaveText(`Connected — ${url}`);
  await expect(page.locator('#conn-label')).toHaveText(`Test broker ${broker.port}`);
  const seen = await log();
  expect(seen.indexOf(`Reconnecting… — ${url}`)).toBeLessThan(seen.lastIndexOf(`Connected — ${url}`));
  // While it reconnects on its own the app must not claim to be "Disconnected".
  // Soft: a failure here is a reported bug; the rest still runs.
  expect.soft(seen.filter((s) => s.startsWith('Disconnected')), `status bar history: ${JSON.stringify(seen)}`).toEqual([]);

  // Messages flow again, and the tree kept what it had.
  await publishUntilSeen(page, broker, 'r/after');
  await expect(row(page, 'r').locator('.badge')).toHaveText(/^\d+ topics · \d+ msgs$/);
  expect(await page.evaluate(() => window.__mqttscope.tree.find('r/before').messageCount)).toBeGreaterThanOrEqual(1);

  // A second drop is handled the same way.
  const connectedCount = async () => (await log()).filter((s) => s === `Connected — ${url}`).length;
  const before = await connectedCount();
  broker.dropClients();
  await expect.poll(connectedCount, { timeout: 10_000 }).toBe(before + 1);
  await publishUntilSeen(page, broker, 'r/after2');
  expect(errors).toEqual([]);
});

test('flood: 20k messages on 5k topics, the UI stays responsive and counts are right', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('probe/a', 'A', { retain: true });
  await broker.publish('probe/b', 'B', { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'probe/b');
  await row(page, 'probe').locator('.caret').click();
  const viewerTopic = page.locator('#viewer-host .viewer-topic');

  // Time from a click on a tree row to the inspector showing that topic.
  const clickLatency = async (name, topic) => {
    const t0 = Date.now();
    await row(page, name).click();
    await expect(viewerTopic).toHaveText(topic);
    return Date.now() - t0;
  };

  const TOPICS = 5000;
  const MESSAGES = 20000;
  const floodTopic = (i) => `flood/g${Math.floor((i % TOPICS) / 100)}/t${i % 100}`;
  // The first flood message creates the "flood" root row, so the rows being
  // clicked do not move under the pointer once the flood is running.
  await broker.publish(floodTopic(0), JSON.stringify({ i: 0 }));
  await waitForTopic(page, floodTopic(0));
  await expect(row(page, 'flood')).toBeVisible();
  const flood = (async () => {
    const pending = [];
    for (let i = 1; i < MESSAGES; i++) {
      pending.push(broker.publish(floodTopic(i), JSON.stringify({ i, v: Math.random() })));
      if (i % 2000 === 1999) await Promise.all(pending.splice(0)); // let the event loop breathe
    }
    await Promise.all(pending);
  })();

  // Clicks while the flood is arriving.
  const during = [];
  for (let k = 0; k < 4; k++) {
    during.push(await clickLatency('a', 'probe/a'));
    during.push(await clickLatency('b', 'probe/b'));
  }
  await flood;

  await expect(page.locator('#stat-topics')).toHaveText(/^5[,.  ]?002 topics$/, { timeout: 20_000 });
  await expect(page.locator('#stat-msgs')).toHaveText(/^20[,.  ]?002 messages$/);
  expect(await page.evaluate(() => [window.__mqttscope.tree.topicCount, window.__mqttscope.tree.messageCount])).toEqual([TOPICS + 2, MESSAGES + 2]);
  await expect(page.locator('#status-dropped')).toBeHidden();
  await expect(row(page, 'flood').locator('.badge')).toHaveText(/^5[,.  ]?000 topics · 20[,.  ]?000 msgs$|^5000 topics · 20000 msgs$/);

  // Clicks after the flood, including into the big branch.
  const after = [await clickLatency('a', 'probe/a')];
  await row(page, 'flood').locator('.caret').click();
  await expect(row(page, 'g49')).toBeVisible();
  const t0 = Date.now();
  await (await rowByPath(page, 'flood/g7/t42')).click();
  await expect(viewerTopic).toHaveText('flood/g7/t42');
  after.push(Date.now() - t0);
  await expect(page.locator('#viewer-host .viewer-meta')).toContainText('4 received');

  const worst = Math.max(...during, ...after);
  test.info().annotations.push({ type: 'click latency (ms)', description: `during flood: ${during.join(', ')}; after: ${after.join(', ')}` });
  expect(worst, `click latencies during flood ${during.join(', ')} ms, after ${after.join(', ')} ms`).toBeLessThan(1000);
  // The filter still answers quickly on 5k topics.
  const t1 = Date.now();
  await page.locator('#tree-filter').fill('flood/+/t99');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.treeView.rows.filter((r) => r.node.name === 't99').length)).toBe(50);
  expect(Date.now() - t1).toBeLessThan(1500);
  expect(errors).toEqual([]);
});
