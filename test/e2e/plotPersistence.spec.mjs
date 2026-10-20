// What the Plots tab looks like is restored after a restart: tabs and the
// one on screen, each tab's arrangement and sizes, plot settings, and the
// settings panel (hidden or not, and its width).

import path from 'node:path';
import { test, expect, makeUserData, profile, connect, waitForTopic, waitForFile } from './fixtures.mjs';

const box = (l) => l.boundingBox();

test('tabs, arrangement, sizes and the settings panel survive a restart', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('robot/state', JSON.stringify({ battery: 80, speed: 1, ok: true }), { retain: true });
  const userData = makeUserData({ profiles: [profile(broker.port)] });
  const first = await env.launch({ userData });
  let { page } = first;
  await page.setViewportSize({ width: 1600, height: 1300 });
  await connect(page);
  await waitForTopic(page, 'robot/state');
  await page.evaluate(() => {
    const { plots } = window.__mqttscope;
    for (const [field, alias] of [
      ['battery', 'Battery'],
      ['speed', 'Speed'],
      ['ok', 'OK'],
    ]) {
      plots.addSeries(null, 'robot/state', [field], { alias, quiet: true });
    }
    plots.renderAll();
  });
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  const card = (title) => page.locator('.plot-card').filter({ has: page.locator('.plot-title', { hasText: new RegExp(`^${title}$`) }) });

  // Speed beside Battery, then make the top row taller.
  const t = await box(card('Speed').locator('.plot-title'));
  const target = await box(card('Battery'));
  await page.mouse.move(t.x + 10, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * 0.95, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  const gap = await box(page.locator('.mosaic-handle.col').first());
  await page.mouse.move(gap.x + gap.width / 2, gap.y + gap.height / 2);
  await page.mouse.down();
  await page.mouse.move(gap.x + gap.width / 2, gap.y + gap.height / 2 + 90, { steps: 5 });
  await page.mouse.up();
  // OK shows state transitions; a second tab; the settings panel narrower, then hidden.
  await card('OK').locator('.kind-toggle .seg-btn[data-kind="states"]').click();
  const panel = page.locator('.plot-settings');
  const split = await box(page.locator('.ps-splitter'));
  await page.mouse.move(split.x + 2, split.y + 100);
  await page.mouse.down();
  await page.mouse.move(split.x + 2 - 60, split.y + 100, { steps: 4 });
  await page.mouse.up();
  const panelWidth = (await box(panel)).width;
  await page.locator('.tab-add').click();
  await page.locator('.modal.prompt .input').fill('Second');
  await page.keyboard.press('Enter');
  await page.locator('.plot-tab', { hasText: 'Plots' }).click();
  await panel.locator('.ps-hide').click();
  const before = {
    layout: await page.evaluate(() => JSON.stringify(window.__mqttscope.plots.tab.layout)),
    heights: await Promise.all(['Battery', 'Speed', 'OK'].map(async (n) => Math.round((await box(card(n))).height))),
  };
  await waitForFile(path.join(userData, 'plotTabs.json'), (b) => JSON.stringify(JSON.parse(b).tabs[0].layout) === before.layout && JSON.parse(b).tabs.length === 2);
  await env.closeApp(first);

  ({ page } = await env.launch({ userData }));
  await page.setViewportSize({ width: 1600, height: 1300 });
  await page.locator('.conn-dialog .modal-close').click();
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  await expect(page.locator('.plot-tabs .plot-tab-name')).toHaveText(['Plots', 'Second']);
  await expect(page.locator('.plot-tab.active')).toContainText('Plots');
  expect(await page.evaluate(() => JSON.stringify(window.__mqttscope.plots.tab.layout))).toBe(before.layout);
  const heights = await Promise.all(['Battery', 'Speed', 'OK'].map(async (n) => Math.round((await box(card(n))).height)));
  heights.forEach((h, i) => expect(Math.abs(h - before.heights[i])).toBeLessThan(3));
  const battery = await box(card('Battery'));
  const speed = await box(card('Speed'));
  expect(Math.abs(battery.y - speed.y)).toBeLessThan(2);
  await expect(card('OK')).toHaveClass(/kind-states/);
  const panelNow = page.locator('.plot-settings');
  await expect(panelNow).toBeHidden();
  await page.locator('.ps-rail button').click();
  expect(Math.abs((await box(panelNow)).width - panelWidth)).toBeLessThan(2);
});

test('plots saved by the released 0.1.0 after an upgrade are kept as an extra tab', async ({ env }) => {
  const broker = await env.broker();
  const plot = (id, title) => ({ id, title, windowSec: 300, series: [{ id: `${id}s`, topic: 'a/b', segs: null, slot: 0 }] });
  const tabs = [
    { id: 't1', name: 'Safety', plots: [plot('p1', 'Brakes')] },
    { id: 't2', name: 'Motion', plots: [plot('p2', 'Speed')] },
  ];
  const userData = makeUserData({
    profiles: [profile(broker.port)],
    // The 0.1.0 app rewrote plots.json since this version last saved.
    plots: { plots: [plot('old', 'Edited in 0.1.0')] },
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(userData, 'plotTabs.json'), JSON.stringify({ version: 2, tabs, activeTabId: 't1', legacyMirror: tabs[0].plots }));
  const { page, errors } = await env.launch({ userData });
  await page.locator('.conn-dialog .modal-close').click();
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  await expect(page.locator('.plot-tab-name')).toHaveText(['Safety', 'Motion', 'Plots (older version)']);
  await page.locator('.plot-tab', { hasText: 'older version' }).click();
  await expect(page.locator('.plot-card .plot-title')).toHaveText(['Edited in 0.1.0']);
  expect(errors).toEqual([]);
});
