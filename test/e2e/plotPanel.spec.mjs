// Plot settings panel (Lichtblick-style), colours, boolean state bars,
// synced time bar across plots, and saved layouts with export/import.

import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect, makeUserData, profile, connect, waitForTopic, mockDialogs, dialogCalls, tempDir, waitForFile, readJson } from './fixtures.mjs';

const plotsTab = (page) => page.locator('.right-tabs .tab[data-tab="plots"]');
const panel = (page) => page.locator('.plot-settings');
const chartSeries = (page, i = 0) => page.evaluate((i) => [...window.__mqttscope.plots.charts.values()][i].series.map((s) => ({ label: s.label, display: s.display, color: s.color, width: s.width })), i);

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
  return { broker, userData, ...ctx };
}

test('settings panel: rename, window, legend, y axis, series label, colour, display, visibility', async ({ env }) => {
  const { page, userData, errors } = await setup(env);
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
  await expect.poll(() => page.evaluate(() => [...window.__mqttscope.plots.charts.values()][0].axis)).toEqual({ yMin: 0, yMax: 100 });

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
  await waitForFile(path.join(userData, 'plots.json'), (b) => {
    const p = JSON.parse(b).plots[0];
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

test('layouts: save, change, switch with confirmation, export and import, rename, delete', async ({ env }) => {
  const { app, page, userData, errors } = await setup(env);
  const select = page.locator('.layout-select');
  await expect(select.locator('option:checked')).toHaveText('Unsaved layout');

  // Save as "Robot view".
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Save as…' }).click();
  await page.locator('.modal.prompt .input').fill('Robot view');
  await page.keyboard.press('Enter');
  await expect(select.locator('option:checked')).toHaveText('Robot view');

  // A change marks the layout as modified; Save stores it.
  await page.locator('.plot-card').nth(1).locator('button[title="Remove plot"]').click();
  await expect(select.locator('option:checked')).toHaveText('Robot view •');
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(select.locator('option:checked')).toHaveText('Robot view');

  // A second layout, then switch back (unsaved changes ask first).
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Save as…' }).click();
  await page.locator('.modal.prompt .input').fill('Second');
  await page.keyboard.press('Enter');
  await panel(page).locator('input[name="plot-title"]').fill('Edited');
  await expect(select.locator('option:checked')).toHaveText('Second •');
  await mockDialogs(app, { confirm: false });
  await select.selectOption({ label: 'Robot view' });
  await expect.poll(() => dialogCalls(app)).toContainEqual(expect.objectContaining({ message: 'Discard changes to the current plots?' }));
  await expect(page.locator('.plot-card .plot-title')).toHaveText(['Edited']);
  await expect(select.locator('option:checked')).toHaveText('Second •');
  await mockDialogs(app, { confirm: true });
  await select.selectOption({ label: 'Robot view' });
  await expect(page.locator('.plot-card .plot-title')).toHaveText(['Battery']);
  await expect(page.locator('.plot-card .legend-label')).toHaveText(['Battery', 'Driving']);

  // Export to a file, then import it back as a new layout.
  const dir = tempDir();
  const file = path.join(dir, 'robot.mqtt-scope-layout.json');
  await mockDialogs(app, { saveFile: file });
  await page.locator('.layout-more').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Export layout to a file…' }).click();
  await waitForFile(file);
  const exported = JSON.parse(readFileSync(file, 'utf8'));
  expect(exported).toMatchObject({ format: 'mqtt-scope-plot-layout', version: 1, name: 'Robot view' });
  expect(exported.plots[0].series.map((s) => s.alias)).toEqual(['Battery', 'Driving']);
  await mockDialogs(app, { openFile: file, confirm: true });
  await page.locator('.layout-more').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Import layout from a file…' }).click();
  await expect(select.locator('option:checked')).toHaveText('Robot view (2)');
  // An invalid file is refused with a reason.
  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, '{"format":"something-else"}');
  await mockDialogs(app, { openFile: bad });
  await page.locator('.layout-more').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Import layout from a file…' }).click();
  await expect(page.locator('.toast.error').filter({ hasText: 'Not an MQTT Scope plot layout' })).toBeVisible();

  // Rename and delete.
  await page.locator('.layout-more').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Rename layout…' }).click();
  await page.locator('.modal.prompt .input').fill('Imported');
  await page.keyboard.press('Enter');
  await expect(select.locator('option:checked')).toHaveText('Imported');
  await mockDialogs(app, { confirm: true });
  await page.locator('.layout-more').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Delete layout…' }).click();
  await expect(select.locator('option')).toHaveText(['Unsaved layout', 'Robot view', 'Second']);

  // Layouts persist.
  await waitForFile(path.join(userData, 'plots.json'), (b) => JSON.parse(b).layouts?.length === 2);
  expect(readJson(path.join(userData, 'plots.json')).layouts.map((l) => l.name)).toEqual(['Robot view', 'Second']);
  expect(errors).toEqual([]);
});
