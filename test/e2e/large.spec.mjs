// Large payloads: a 5 MB JSON document and a 1 MB single-line text message.

import { test, expect, rowByPath, waitForTopic, viewerBody, viewerTab } from './fixtures.mjs';

const line = (page, jsonPath) => viewerBody(page).locator(`.jt-line[title="${jsonPath}"]`);

function bigJson() {
  const items = [];
  let size = 0;
  for (let i = 0; size < 5.2 * 1024 * 1024; i++) {
    const item = { id: i, name: `item-${i}`, tags: ['alpha', 'beta'], pos: { x: i * 0.5, y: -i, label: 'zzzzzzzzzzzzzzzz' } };
    items.push(item);
    size += JSON.stringify(item).length + 1;
  }
  return JSON.stringify({ meta: { count: items.length, kind: 'big' }, items });
}

test('5 MB JSON renders quickly in the tree view and the UI stays responsive', async ({ env }) => {
  const broker = await env.broker();
  const payload = bigJson();
  expect(payload.length).toBeGreaterThan(5 * 1024 * 1024);
  const count = JSON.parse(payload).meta.count;
  await broker.publish('large/json', payload, { retain: true });
  await broker.publish('large/small', '{"ok":true}', { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'large/json');
  await waitForTopic(page, 'large/small');

  await (await rowByPath(page, 'large')).locator('.caret').click();
  const bigRow = await rowByPath(page, 'large/json');
  // The tree row preview is cut short, not the whole 5 MB.
  expect((await bigRow.locator('.value').textContent()).length).toBeLessThanOrEqual(200);

  const t0 = Date.now();
  await bigRow.click();
  await expect(line(page, '$.items')).toBeVisible();
  await expect(line(page, '$.meta.count').locator('.tk-num')).toHaveText(String(count));
  const elapsed = Date.now() - t0;
  expect(elapsed, `5 MB JSON took ${elapsed} ms to render`).toBeLessThan(3000);
  await expect(page.locator('#viewer-host .viewer-meta')).toContainText(/5\.\d\d MB/);

  // Long arrays are rendered in chunks.
  const more = viewerBody(page).locator('.jt-more').first();
  await expect(more).toHaveText(`Show 300 more of ${count - 300} remaining…`);
  await expect(line(page, '$.items[299]')).toBeVisible();
  await expect(line(page, '$.items[300]')).toHaveCount(0);
  await more.click();
  await expect(line(page, '$.items[599]')).toBeVisible();
  await line(page, '$.items[2]').click();
  await expect(line(page, '$.items[2].pos')).toBeVisible();

  // Still responsive: switching topics is immediate.
  const t1 = Date.now();
  await (await rowByPath(page, 'large/small')).click();
  await expect(line(page, '$.ok')).toBeVisible();
  expect(Date.now() - t1).toBeLessThan(1000);

  // And back again (decoded payload is cached).
  const t2 = Date.now();
  await (await rowByPath(page, 'large/json')).click();
  await expect(line(page, '$.items')).toBeVisible();
  expect(Date.now() - t2).toBeLessThan(1500);
  expect(errors).toEqual([]);
});

test('1 MB single-line text is shown in the Text view', async ({ env }) => {
  const broker = await env.broker();
  const payload = 'START ' + 'lorem ipsum dolor sit amet '.repeat(Math.ceil((1024 * 1024) / 27)) + ' END-MARKER';
  await broker.publish('large/text', payload, { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'large/text');
  await (await rowByPath(page, 'large')).locator('.caret').click();
  await viewerTab(page, 'text').click();

  const t0 = Date.now();
  await (await rowByPath(page, 'large/text')).click();
  const src = viewerBody(page).locator('.code .src');
  await expect(src).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(3000);
  await expect(viewerBody(page).locator('.code .gutter')).toHaveText('1');
  expect(await src.evaluate((e) => e.textContent.length)).toBe(payload.length);
  expect(await src.evaluate((e) => e.textContent.endsWith(' END-MARKER'))).toBe(true);
  await expect(page.locator('#viewer-host .viewer-meta')).toContainText('TEXT');

  // The rest of the UI reacts promptly.
  const t1 = Date.now();
  await page.locator('#tree-filter').fill('nothing-matches');
  await expect(page.locator('.tree-empty')).toHaveText('No matching topics');
  expect(Date.now() - t1).toBeLessThan(1500);

  // Search in the long line.
  await page.locator('#viewer-host input.search').fill('END-MARKER');
  await expect(page.locator('#viewer-host .hit-count')).toHaveText('1/1');
  expect(errors).toEqual([]);
});
