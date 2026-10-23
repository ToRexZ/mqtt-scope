// What the Plots tab looks like is restored after a restart: tabs and the
// one on screen, each tab's arrangement and sizes, plot settings, and the
// settings panel (hidden or not, and its width). Each profile has its own
// (see main/layoutStore.js); the plot files of earlier versions are only read.

import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { test, expect, makeUserData, profile, connect, openTabTo, mockDialogs, waitForTopic, waitForFile, waitForLayout, readJson } from './fixtures.mjs';

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
  await waitForLayout(userData, `p${broker.port}`, (d) => JSON.stringify(d.tabs[0].layout) === before.layout && d.tabs.length === 2);
  await env.closeApp(first);

  ({ page } = await env.launch({ userData }));
  await page.setViewportSize({ width: 1600, height: 1300 });
  await connect(page); // the plots show in a connected tab
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
  await connect(page); // the plots show in a connected tab
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  await expect(page.locator('.plot-tab-name')).toHaveText(['Safety', 'Motion', 'Plots (older version)']);
  await page.locator('.plot-tab', { hasText: 'older version' }).click();
  await expect(page.locator('.plot-card .plot-title')).toHaveText(['Edited in 0.1.0']);
  expect(errors).toEqual([]);
});

const plotsTab = (page) => page.locator('.right-tabs .tab[data-tab="plots"]');
const titles = (page) => page.locator('.plot-card .plot-title');
const plot = (id, title, topic = 'a/b') => ({ id, title, windowSec: 300, series: [{ id: `${id}s`, topic, segs: null, slot: 0 }] });
// The plots of every profile before 0.4.0.
const globalTabs = { version: 2, tabs: [{ id: 'g', name: 'Shared', plots: [plot('p1', 'Seeded')] }], activeTabId: 'g' };

test('plot layouts are kept per profile', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('robot/state', JSON.stringify({ battery: 80, speed: 1 }), { retain: true });
  const profiles = [profile(broker.port, { id: 'A', name: 'Profile A' }), profile(broker.port, { id: 'B', name: 'Profile B' })];
  const userData = makeUserData({ profiles, plotTabs: globalTabs });
  const first = await env.launch({ userData });
  let { page } = first;
  await connect(page); // Profile A
  await waitForTopic(page, 'robot/state');
  await plotsTab(page).click();
  await expect(titles(page)).toHaveText(['Seeded']);
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'robot/state', ['battery'], { alias: 'Battery' }));
  await expect(titles(page)).toHaveText(['Seeded', 'Battery']);
  await waitForLayout(userData, 'A', (d) => d.tabs[0].plots.length === 2);

  // B also starts with the plots of before the upgrade, without A's.
  await openTabTo(page, 'Profile B');
  await plotsTab(page).click();
  await expect(titles(page)).toHaveText(['Seeded']);
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'robot/state', ['speed'], { alias: 'Speed' }));
  await expect(titles(page)).toHaveText(['Seeded', 'Speed']);
  await waitForLayout(userData, 'B', (d) => d.tabs[0].plots.length === 2);
  expect((await waitForLayout(userData, 'A')).tabs[0].plots.map((p) => p.title)).toEqual(['Seeded', 'Battery']);
  await env.closeApp(first);

  // After a restart A opens with its own plots.
  ({ page } = await env.launch({ userData }));
  await connect(page);
  await plotsTab(page).click();
  await expect(titles(page)).toHaveText(['Seeded', 'Battery']);

  // A profile made since starts with a copy of the plots last opened (A's);
  // changing them leaves A's as they are.
  await page.click('.tab-new');
  const dlg = page.locator('.conn-dialog');
  await dlg.locator('.conn-item', { hasText: 'Profile A' }).click();
  await dlg.getByRole('button', { name: 'Duplicate' }).click();
  await expect(dlg.locator('.conn-item.active .conn-name')).toHaveText('Profile A (copy)');
  await dlg.locator('.connect-btn').click();
  await page.waitForFunction(() => window.__mqttscope.status.state === 'connected');
  await plotsTab(page).click();
  await expect(titles(page)).toHaveText(['Seeded', 'Battery']);
  // Kept as its own at once, so opening it again shows the same.
  const copyId = readJson(path.join(userData, 'profiles.json')).find((p) => p.name === 'Profile A (copy)').id;
  await waitForLayout(userData, copyId, (d) => d.tabs[0].plots.length === 2);
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'robot/state', ['speed'], { alias: 'Copy only' }));
  await waitForLayout(userData, copyId, (d) => d.tabs[0].plots.length === 3);
  expect((await waitForLayout(userData, 'A')).tabs[0].plots.map((p) => p.title)).toEqual(['Seeded', 'Battery']);
});

test('renaming a profile keeps its layout; deleting removes it', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('robot/state', JSON.stringify({ battery: 80, speed: 1 }), { retain: true });
  const profiles = [profile(broker.port, { id: 'A', name: 'Profile A' }), profile(broker.port, { id: 'B', name: 'Profile B' })];
  const userData = makeUserData({ profiles });
  const first = await env.launch({ userData });
  let { page } = first;
  await connect(page); // Profile A
  await waitForTopic(page, 'robot/state');
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'robot/state', ['battery'], { alias: 'Battery' }));
  const idB = await openTabTo(page, 'Profile B');
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'robot/state', ['speed'], { alias: 'Speed' }));
  await waitForLayout(userData, 'A', (d) => d.tabs[0].plots.length === 1);
  await waitForLayout(userData, 'B', (d) => d.tabs[0].plots.length === 1);

  // Renamed in the dialog of a new tab (while A's tab is open).
  await page.click('.tab-new');
  const dlg = page.locator('.conn-dialog');
  await dlg.locator('.conn-item', { hasText: 'Profile A' }).click();
  await dlg.locator('[name="name"]').fill('Renamed A');
  await waitForFile(path.join(userData, 'profiles.json'), (b) => JSON.parse(b)[0].name === 'Renamed A');
  expect((await waitForLayout(userData, 'A')).tabs[0].plots.map((p) => p.title)).toEqual(['Battery']);

  // Deleted once its tab is closed: its layout goes too.
  await page.evaluate((id) => window.__mqttscope.shell.closeTab(id, { confirmed: true }), idB);
  await mockDialogs(first.app, { confirm: true });
  await dlg.locator('.conn-item', { hasText: 'Profile B' }).click();
  await expect(dlg.getByRole('button', { name: 'Delete' })).toBeEnabled();
  await dlg.getByRole('button', { name: 'Delete' }).click();
  await expect(dlg.locator('.conn-item .conn-name')).toHaveText(['Renamed A']);
  const file = path.join(userData, 'profileLayouts.json');
  await waitForFile(file, (b) => !Object.hasOwn(JSON.parse(b).byProfile, 'B'));
  const saved = readJson(file);
  expect(Object.keys(saved.byProfile)).toEqual(['A']);
  expect(saved.legacyProfiles).toEqual(['A']);
  expect(saved.lastUsed).toBeNull(); // B was opened last
  await env.closeApp(first);

  // After a restart the renamed profile opens with its plots.
  ({ page } = await env.launch({ userData }));
  await connect(page);
  await plotsTab(page).click();
  await expect(titles(page)).toHaveText(['Battery']);
});

test('plotTabs.json and plots.json are never rewritten', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('robot/state', JSON.stringify({ battery: 80 }), { retain: true });
  const userData = makeUserData({ profiles: [profile(broker.port)], plotTabs: globalTabs, plots: { plots: [plot('old', 'Edited in 0.1.0')] } });
  const files = ['plotTabs.json', 'plots.json'].map((n) => path.join(userData, n));
  const snapshot = () => files.map((f) => ({ text: readFileSync(f, 'utf8'), mtime: statSync(f).mtimeMs }));
  const before = snapshot();
  const first = await env.launch({ userData });
  const { page } = first;
  await connect(page);
  await waitForTopic(page, 'robot/state');
  await plotsTab(page).click();
  // Both are read: the tabs, and the plots an older version changed.
  await expect(page.locator('.plot-tab-name')).toHaveText(['Shared', 'Plots (older version)']);
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'robot/state', ['battery'], { alias: 'Battery' }));
  await page.locator('.plot-card .window-select').first().selectOption('60');
  await waitForLayout(userData, `p${broker.port}`, (d) => d.tabs.length === 2 && d.tabs[0].plots.length === 2 && d.tabs[0].plots[0].windowSec === 60);
  // The window cannot write them either.
  for (const name of ['plotTabs', 'plots', 'profileLayouts']) {
    await expect(page.evaluate((n) => window.api.storeSet(n, {}), name)).rejects.toThrow(/kept by the main process/);
  }
  await env.closeApp(first);
  expect(snapshot()).toEqual(before);
});
