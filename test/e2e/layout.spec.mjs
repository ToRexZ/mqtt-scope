// Window layout: a window narrower than its minimum width (tiling window
// managers ignore it) stacks the tree above the inspector, and a saved tree
// width never squeezes the inspector in a smaller window.

import { test, expect, rowByPath } from './fixtures.mjs';

const box = (page, selector) =>
  page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  }, selector);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('narrow window: tree above the inspector, nothing cut off, splitter resizes the tree height', async ({ env }) => {
  const broker = await env.broker();
  const topic = 'capra/robot/link/hitch/endstops/status';
  await broker.publish(topic, '{"state":"RECORDING"}', { retain: true });
  const { page, errors } = await env.connected(broker);
  await page.setViewportSize({ width: 598, height: 1300 });
  await (await rowByPath(page, topic)).click();
  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText(topic);

  const tree = await box(page, '.tree-pane');
  const right = await box(page, '#right');
  expect(tree.bottom).toBeLessThanOrEqual(right.top);
  expect(right.width).toBe(598);
  expect(await overflow(page)).toBe(0);

  // The history sits below the message instead of beside it.
  const body = await box(page, '#viewer-host .viewer-body');
  const history = await box(page, '#viewer-host .viewer-history');
  expect(history.top).toBeGreaterThanOrEqual(body.bottom);
  expect(body.width).toBeGreaterThan(500);

  // The splitter between them now drags vertically and remembers the height.
  const split = await box(page, '#split-main');
  const y = split.top + split.height / 2;
  await page.mouse.move(300, y);
  await page.mouse.down();
  await page.mouse.move(300, y + 100, { steps: 5 });
  await page.mouse.up();
  expect((await box(page, '.tree-pane')).height).toBeCloseTo(tree.height + 100, 0);
  expect(await page.evaluate(() => localStorage.getItem('mqttscope.treeHeight'))).toBe(String(Math.round(tree.height + 100)));
  expect(await page.evaluate(() => localStorage.getItem('mqttscope.treeWidth'))).toBeNull();

  // A narrow inspector that is also short keeps the history beside the message.
  await page.setViewportSize({ width: 1000, height: 700 });
  expect((await box(page, '#viewer-host .viewer-history')).left).toBeGreaterThanOrEqual((await box(page, '#viewer-host .viewer-body')).right);

  // Wide again: side by side.
  await page.setViewportSize({ width: 1600, height: 1000 });
  expect((await box(page, '.tree-pane')).right).toBeLessThanOrEqual((await box(page, '#right')).left);
  expect(await overflow(page)).toBe(0);
  expect(errors).toEqual([]);
});

test('a saved tree width wider than the window leaves the inspector its room', async ({ env }) => {
  const broker = await env.broker();
  const { page, errors } = await env.connected(broker);
  await page.evaluate(() => document.querySelector('#layout').style.setProperty('--tree-w', '900px'));
  await page.setViewportSize({ width: 1000, height: 800 });
  expect((await box(page, '#right')).width).toBe(420);
  expect(await overflow(page)).toBe(0);
  expect(errors).toEqual([]);
});
