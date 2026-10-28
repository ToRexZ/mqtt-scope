// Plot settings panel (Lichtblick-style), colours, boolean state bars,
// synced time bar across plots, and plot tabs with export/import.

import path from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { test, expect, makeUserData, profile, connect, waitForTopic, mockDialogs, dialogCalls, tempDir, waitForFile, waitForLayout } from './fixtures.mjs';

const plotsTab = (page) => page.locator('.right-tabs .tab[data-tab="plots"]');
const panel = (page) => page.locator('.plot-settings');
const chartSeries = (page, i = 0) => page.evaluate((n) => [...window.__mqttscope.plots.charts.values()][n].series.map((s) => ({ label: s.label, display: s.display, color: s.color, width: s.width })), i);

async function setup(env) {
  const broker = await env.broker();
  await broker.publish('robot/state', JSON.stringify({ battery: 81, speed: 1.2, driving: true }), { retain: true });
  await broker.publish('hall/temp', '21', { retain: true });
  const userData = makeUserData({ profiles: [profile(broker.port)] });
  const ctx = await env.launch({ userData });
  await connect(ctx.page);
  await waitForTopic(ctx.page, 'hall/temp');
  await ctx.page.evaluate(() => {
    const { plots } = window.__mqttscope;
    const id = plots.addSeries(null, 'robot/state', ['battery'], { alias: 'Battery', quiet: true });
    plots.addSeries(id, 'robot/state', ['driving'], { alias: 'Driving', quiet: true });
    plots.addSeries(null, 'hall/temp', null, { quiet: true });
    plots.selectedId = plots.plots[0].id;
    plots.renderAll();
    plots.persist();
  });
  await plotsTab(ctx.page).click();
  return { broker, userData, profileId: `p${broker.port}`, ...ctx };
}

test('settings panel: rename, window, legend, y axis, series label, colour, display, visibility', async ({ env }) => {
  const { page, userData, profileId, errors } = await setup(env);
  const card = page.locator('.plot-card').first();
  await expect(card).toHaveClass(/selected/);
  await expect(panel(page).locator('input[name="plot-title"]')).toHaveValue('Battery');

  // Rename from the panel; the card follows as you type.
  await panel(page).locator('input[name="plot-title"]').fill('Robot');
  await expect(card.locator('.plot-title')).toHaveText('Robot');
  // Time window stays in sync with the card's selector.
  await panel(page).locator('select[name="plot-window"]').selectOption('60');
  await expect(card.locator('select')).toHaveValue('60');
  // Legend values and the legend itself can be hidden.
  await panel(page).locator('input[name="plot-legendValues"]').uncheck();
  await expect(card.locator('.legend-value').first()).toBeHidden();
  await panel(page).locator('input[name="plot-legend"]').uncheck();
  await expect(card.locator('.plot-legend')).toBeHidden();
  await panel(page).locator('input[name="plot-legend"]').check();
  // Fixed y axis.
  await panel(page).locator('input[name="plot-yMin"]').fill('0');
  await panel(page).locator('input[name="plot-yMin"]').press('Tab');
  await panel(page).locator('input[name="plot-yMax"]').fill('100');
  await panel(page).locator('input[name="plot-yMax"]').press('Tab');
  await expect.poll(() => page.evaluate(() => [...window.__mqttscope.plots.charts.values()][0].axis)).toEqual({ yMin: 0, yMax: 100, kind: 'timeseries', timeGrid: true });

  // Booleans default to a state bar.
  expect(await chartSeries(page)).toEqual([
    { label: 'Battery', display: 'line', color: undefined, width: 2 },
    { label: 'Driving', display: 'state', color: undefined, width: 2 },
  ]);

  // Series settings: label, colour picker, palette, display, width, visibility.
  const item = panel(page).locator('.ps-series-item').first();
  await item.locator('summary .ps-series-name').click();
  await item.locator('input[name="series-alias"]').fill('Battery %');
  await expect(card.locator('.legend-label').first()).toHaveText('Battery %');
  await item.locator('input[name="series-color"]').fill('#ff8800');
  await expect.poll(async () => (await chartSeries(page))[0].color).toBe('#ff8800');
  await item.locator('.ps-palette').nth(3).click();
  await expect.poll(async () => (await chartSeries(page))[0].color).toBeUndefined();
  await item.locator('select[name="series-display"]').selectOption('step');
  await item.locator('select[name="series-width"]').selectOption('4');
  await expect.poll(async () => (await chartSeries(page))[0]).toEqual({ label: 'Battery %', display: 'step', color: undefined, width: 4 });
  await item.locator('.ps-eye').click();
  await expect.poll(async () => (await chartSeries(page)).map((s) => s.label)).toEqual(['Driving']);
  await expect(card.locator('.legend-chip').first()).toHaveClass(/off/);
  // The legend swatch toggles it back.
  await card.locator('.legend-chip').first().locator('.swatch-toggle').click();
  await expect.poll(async () => (await chartSeries(page)).map((s) => s.label)).toEqual(['Battery %', 'Driving']);

  // Everything is saved.
  await waitForLayout(userData, profileId, (d) => {
    const p = d.tabs[0].plots[0];
    return p.title === 'Robot' && p.windowSec === 60 && p.legendValues === false && p.yMax === 100 && p.series[0].display === 'step' && p.series[0].slot === 3;
  });
  // Selecting another plot shows its settings.
  await page.locator('.plot-card').nth(1).locator('.plot-head').click();
  await expect(panel(page).locator('input[name="plot-title"]')).toHaveValue('hall/temp');
  expect(errors).toEqual([]);
});

test('hovering one plot moves the time bar on all plots and shows values at that moment', async ({ env }) => {
  const { page, errors } = await setup(env);
  const canvas = page.locator('.plot-card').first().locator('canvas');
  const box = await canvas.boundingBox();
  // Freeze the time axis, then hover just after the (only) data point.
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Freeze' }).click();
  const x = await page.evaluate(() => {
    const c = [...window.__mqttscope.plots.charts.values()][0];
    const t = c.series[0].points.at(-1).t;
    const g = c.geom;
    return g.left + ((t - g.t0) / (g.t1 - g.t0)) * (g.right - g.left) + 3;
  });
  await page.mouse.move(box.x + Math.min(x, box.width - 20), box.y + 40);
  await expect.poll(() => page.evaluate(() => [...window.__mqttscope.plots.charts.values()].map((c) => c.hoverTime !== null))).toEqual([true, true]);
  await expect(page.locator('.plot-card').nth(1).locator('.legend-value.at-hover')).toHaveCount(1);
  // The tooltip only shows on the plot under the mouse; state bars read true/false.
  await expect(page.locator('.plot-card').first().locator('.chart-tip')).toBeVisible();
  await expect(page.locator('.plot-card').first().locator('.chart-tip')).toContainText('true');
  await expect(page.locator('.plot-card').nth(1).locator('.chart-tip')).toBeHidden();
  await page.mouse.move(5, 5);
  await expect.poll(() => page.evaluate(() => [...window.__mqttscope.plots.charts.values()].map((c) => c.hoverTime))).toEqual([null, null]);
  expect(errors).toEqual([]);
});

test('tabs: create, rename, switch, duplicate, export and import, delete; each tab keeps its own plots', async ({ env }) => {
  const { app, page, userData, profileId, errors } = await setup(env);
  const tabs = page.locator('.plot-tabs .plot-tab');
  const titles = page.locator('.plot-card .plot-title');
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toContainText('Plots');
  await expect(titles).toHaveText(['Battery', 'hall/temp']);

  // A new tab starts empty; plots added now go to it.
  await page.locator('.tab-add').click();
  await page.locator('.modal.prompt .input').fill('Safety');
  await page.keyboard.press('Enter');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveClass(/active/);
  await expect(page.locator('.plot-card')).toHaveCount(0);
  await expect(page.locator('.plots-grid .placeholder')).toBeVisible();
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'robot/state', ['driving']));
  await expect(titles).toHaveText(['robot/state › $.driving']);
  // Only booleans: a new plot shows state transitions.
  await expect(page.locator('.plot-card').first()).toHaveClass(/kind-states/);

  // Switching shows each tab's own plots.
  await tabs.first().click();
  await expect(titles).toHaveText(['Battery', 'hall/temp']);
  await tabs.nth(1).click();
  await expect(titles).toHaveText(['robot/state › $.driving']);

  // Rename by double-click; duplicate from the tab's context menu.
  await tabs.nth(1).dblclick();
  await page.locator('.modal.prompt .input').fill('Safety signals');
  await page.keyboard.press('Enter');
  await expect(tabs.nth(1)).toContainText('Safety signals');
  await tabs.nth(1).click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Duplicate tab' }).click();
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(2)).toContainText('Safety signals copy');
  await expect(tabs.nth(2)).toHaveClass(/active/);
  await expect(titles).toHaveText(['robot/state › $.driving']);

  // Export a tab, import it back as a new tab; invalid files are refused.
  const dir = tempDir();
  const file = path.join(dir, 'safety.mqtt-scope-layout.json');
  await tabs.nth(1).click();
  await mockDialogs(app, { saveFile: file });
  await page.locator('.tab-more').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Export tab to a file…' }).click();
  await waitForFile(file);
  const exported = JSON.parse(readFileSync(file, 'utf8'));
  expect(exported).toMatchObject({ format: 'mqtt-scope-plot-layout', version: 1, name: 'Safety signals', columns: 0 });
  expect(exported.plots[0]).toMatchObject({ kind: 'states', series: [expect.objectContaining({ topic: 'robot/state', segs: ['driving'] })] });
  await mockDialogs(app, { openFile: file });
  await page.locator('.tab-more').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Import tab from a file…' }).click();
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(3)).toContainText('Safety signals (2)');
  await expect(tabs.nth(3)).toHaveClass(/active/);
  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, '{"format":"something-else"}');
  await mockDialogs(app, { openFile: bad });
  await page.locator('.tab-more').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Import tab from a file…' }).click();
  await expect(page.locator('.toast.error').filter({ hasText: 'Not an MQTT Scope plot layout' })).toBeVisible();

  // Deleting a tab with plots asks first.
  await mockDialogs(app, { confirm: false });
  await page.locator('.tab-more').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Delete tab…' }).click();
  await expect.poll(() => dialogCalls(app)).toContainEqual(expect.objectContaining({ message: 'Delete the tab “Safety signals (2)”?' }));
  await expect(tabs).toHaveCount(4);
  await mockDialogs(app, { confirm: true });
  await page.locator('.tab-more').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Delete tab…' }).click();
  await expect(tabs).toHaveCount(3);

  // Tabs persist, with the one on screen.
  const saved = await waitForLayout(userData, profileId, (d) => d.tabs?.length === 3);
  expect(saved.tabs.map((t) => [t.name, t.plots.length])).toEqual([
    ['Plots', 2],
    ['Safety signals', 1],
    ['Safety signals copy', 1],
  ]);
  expect(saved.tabs.some((t) => t.id === saved.activeTabId)).toBe(true);
  // Plots are kept per profile: nothing is written in the format of older versions.
  expect(existsSync(path.join(userData, 'plots.json'))).toBe(false);
  expect(errors).toEqual([]);
});

test('plot counts: per tab and in total, hidden when there are none, updated when plots move', async ({ env }) => {
  const { page, errors } = await setup(env);
  const total = page.locator('#plot-count');
  const tabCount = (name) => page.locator('.plot-tab', { hasText: name }).locator('.count');
  await expect(total).toHaveText('2');
  await expect(tabCount('Plots')).toHaveText('2');
  await page.locator('.tab-add').click();
  await page.locator('.modal.prompt .input').fill('Empty');
  await page.keyboard.press('Enter');
  await expect(tabCount('Empty')).toBeHidden();
  await page.locator('.plot-tab', { hasText: 'Plots' }).click();
  // Move a plot onto the other tab: both counts follow, the total stays.
  const title = await page.locator('.plot-card').first().locator('.plot-title').boundingBox();
  const tab = await page.locator('.plot-tab', { hasText: 'Empty' }).boundingBox();
  await page.mouse.move(title.x + 10, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(tabCount('Plots')).toHaveText('1');
  await expect(tabCount('Empty')).toHaveText('1');
  await expect(total).toHaveText('2');
  // Removing the last plot of a tab hides its count.
  await page.locator('.plot-card').first().locator('button[title="Remove plot"]').click();
  await expect(tabCount('Plots')).toBeHidden();
  await expect(total).toHaveText('1');
  expect(errors).toEqual([]);
});
