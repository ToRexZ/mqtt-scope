// Plots: adding topics and JSON fields from the tree's and the inspector's
// context menus; live values, time window, freeze, removal, CSV export and
// persistence of plot definitions. (The "+ New plot" / "+ Series" picker is
// covered by its own spec, owned by the picker's author.)

import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  test,
  expect,
  makeUserData,
  profile,
  connect,
  reconnected,
  rowByPath,
  waitForTopic,
  menu,
  menuLabels,
  answerPrompt,
  mockDialogs,
  dialogCalls,
  tempDir,
  toast,
  viewerBody,
  viewerTab,
  waitForLayout,
} from './fixtures.mjs';

const card = (page, title) => page.locator('.plot-card').filter({ has: page.locator('.plot-title', { hasText: new RegExp(`^${title.replace(/[$.*+?()[\]]/g, '\\$&')}$`) }) });
const chip = (c, label) => c.locator('.legend-chip').filter({ has: c.page().locator('.legend-label', { hasText: label }) });
const plotsTab = (page) => page.locator('.right-tabs .tab[data-tab="plots"]');
const inspectorTab = (page) => page.locator('.right-tabs .tab[data-tab="inspector"]');

test('plots: add from tree and inspector, live values, window, freeze, remove, CSV, persistence', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('m/temp', '20', { retain: true });
  await broker.publish('m/hum', '40', { retain: true });
  await broker.publish('m/robot', JSON.stringify({ battery: { charge: 80, volt: 12.1 }, name: 'r1' }), { retain: true });
  await broker.publish('m/text', 'hello', { retain: true });
  const userData = makeUserData({ profiles: [profile(broker.port)] });
  const first = await env.launch({ userData });
  const { app, page } = first;
  await connect(page);
  await waitForTopic(page, 'm/text');
  await expect(page.locator('#plot-count')).toHaveText('');

  // Non-numeric topics cannot be plotted.
  await (await rowByPath(page, 'm/text')).click({ button: 'right' });
  expect(await menuLabels(page)).toContain('Add to plot (needs a numeric value)');
  await expect(page.locator('.ctx-menu .ctx-item.disabled', { hasText: 'Add to plot (needs a numeric value)' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctx-menu')).toHaveCount(0);

  // Right-click a numeric topic → Add to new plot.
  await (await rowByPath(page, 'm/temp')).click({ button: 'right' });
  await menu(page, 'Add to new plot');
  await expect(toast(page).filter({ hasText: 'Plotting m/temp' })).toBeVisible();
  await expect(page.locator('#plot-count')).toHaveText('1');

  await plotsTab(page).click();
  const p1 = card(page, 'm/temp');
  await expect(p1).toBeVisible();
  await expect(chip(p1, 'm/temp').locator('.legend-value')).toHaveText('20'); // back-filled from history
  await broker.publish('m/temp', '21.5');
  await expect(chip(p1, 'm/temp').locator('.legend-value')).toHaveText('21.5');
  await expect(p1.locator('canvas.chart')).toBeVisible();

  // Second series into the same plot.
  await (await rowByPath(page, 'm/hum')).click({ button: 'right' });
  await menu(page, 'Add to plot “m/temp”');
  await expect(page.locator('#plot-count')).toHaveText('1');
  await expect(p1.locator('.legend-label')).toHaveText(['m/temp', 'm/hum']);
  await expect(chip(p1, 'm/hum').locator('.legend-value')).toHaveText('40');
  // A series already in the plot cannot be added again.
  await (await rowByPath(page, 'm/temp')).click({ button: 'right' });
  await expect(page.locator('.ctx-menu .ctx-item.disabled', { hasText: 'Add to plot “m/temp”' })).toHaveCount(1);
  await page.keyboard.press('Escape');

  // A JSON field from the inspector's Tree view.
  await inspectorTab(page).click();
  await (await rowByPath(page, 'm/robot')).click();
  await viewerTab(page, 'tree').click();
  const charge = viewerBody(page).locator('.jt-line[title="$.battery.charge"]');
  await charge.click({ button: 'right' });
  expect(await menuLabels(page)).toEqual(['Copy value', 'Copy path', 'Chart this field (kept history)', 'Choose values to plot…', 'Add to new plot', 'Add to plot “m/temp”']);
  await menu(page, 'Add to new plot');
  await expect(page.locator('#plot-count')).toHaveText('2');
  // Strings cannot be charted.
  await viewerBody(page).locator('.jt-line[title="$.name"]').click({ button: 'right' });
  expect(await menuLabels(page)).toEqual(['Copy value', 'Copy path', 'Chart this field (kept history)']);
  await expect(page.locator('.ctx-menu .ctx-item.disabled')).toHaveText(['Chart this field (kept history)']);
  await page.keyboard.press('Escape');
  // "Chart this field" charts the kept history inside the inspector.
  await charge.click({ button: 'right' });
  await menu(page, 'Chart this field (kept history)');
  await expect(viewerBody(page).locator('.chart-title')).toHaveText('$.battery.charge · 1 points in kept history');
  await viewerTab(page, 'tree').click();

  await plotsTab(page).click();
  const p2 = card(page, 'm/robot › $.battery.charge');
  await expect(chip(p2, 'm/robot › $.battery.charge').locator('.legend-value')).toHaveText('80');
  await broker.publish('m/robot', JSON.stringify({ battery: { charge: 75, volt: 12 }, name: 'r1' }));
  await expect(chip(p2, 'm/robot › $.battery.charge').locator('.legend-value')).toHaveText('75');

  // A second JSON field into the same plot, from the inspector's context menu.
  await inspectorTab(page).click();
  await viewerBody(page).locator('.jt-line[title="$.battery.volt"]').click({ button: 'right' });
  await menu(page, 'Add to plot “m/robot › $.battery.charge”');
  await plotsTab(page).click();
  await expect(p2.locator('.legend-label')).toHaveText(['m/robot › $.battery.charge', 'm/robot › $.battery.volt']);
  await expect(chip(p2, '$.battery.volt').locator('.legend-value')).toHaveText('12');

  // Another new plot from the tree's context menu (a topic may be in several plots).
  await (await rowByPath(page, 'm/hum')).click({ button: 'right' });
  await menu(page, 'Add to new plot');
  await expect(page.locator('#plot-count')).toHaveText('3');
  const p3 = card(page, 'm/hum');
  await expect(chip(p3, 'm/hum').locator('.legend-value')).toHaveText('40');

  // Rename a plot by double-clicking its title.
  await p1.locator('.plot-title').dblclick();
  await answerPrompt(page, 'Climate');
  const climate = card(page, 'Climate');
  await expect(climate.locator('.legend-label')).toHaveText(['m/temp', 'm/hum']);

  // Time window.
  const windowSelect = climate.locator('select');
  await expect(windowSelect).toHaveValue('300');
  await windowSelect.selectOption('60');

  // Freeze stops the time axis; Resume follows live data again.
  const freeze = page.locator('.plots-toolbar').getByRole('button', { name: 'Freeze' });
  await freeze.click();
  const resume = page.locator('.plots-toolbar').getByRole('button', { name: 'Resume' });
  await expect(resume).toHaveClass(/\bon\b/);
  const frozenAt = await page.evaluate(() => window.__mqttscope.plots.frozenAt);
  expect(frozenAt).toBeGreaterThan(0);
  await broker.publish('m/temp', '30');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('m/temp').message.payload.length)).toBe(2);
  await expect(chip(climate, 'm/temp').locator('.legend-value')).toHaveText('21.5');
  expect(await page.evaluate(() => window.__mqttscope.plots.frozenAt)).toBe(frozenAt);
  await resume.click();
  await expect(freeze).toBeVisible();
  await expect(chip(climate, 'm/temp').locator('.legend-value')).toHaveText('30');

  // Remove a series and a plot.
  await chip(climate, 'm/hum').locator('.chip-x').click();
  await expect(climate.locator('.legend-label')).toHaveText(['m/temp']);
  await p3.locator('button[title="Remove plot"]').click();
  await expect(page.locator('#plot-count')).toHaveText('2');
  await expect(page.locator('.plot-card')).toHaveCount(2);
  // The removed series can be added again from the menu.
  await (await rowByPath(page, 'm/hum')).click({ button: 'right' });
  await expect(page.locator('.ctx-menu .ctx-item:not(.disabled)', { hasText: 'Add to plot “Climate”' })).toHaveCount(1);
  await page.keyboard.press('Escape');

  // CSV export.
  const csvFile = path.join(tempDir(), 'climate.csv');
  await mockDialogs(app, { saveFile: csvFile });
  await climate.getByRole('button', { name: 'CSV' }).click();
  await expect(toast(page).filter({ hasText: `Saved ${csvFile}` })).toBeVisible();
  expect(await dialogCalls(app)).toContainEqual({ kind: 'save', defaultPath: 'Climate.csv' });
  const csv = readFileSync(csvFile, 'utf8').split('\n');
  expect(csv[0]).toBe('time_iso,epoch_ms,series,topic,path,value');
  const rows = csv.slice(1).map((l) => l.split(','));
  expect(rows.map((r) => [r[2], r[3], r[4], r[5]])).toEqual([
    ['"m/temp"', '"m/temp"', '""', '20'],
    ['"m/temp"', '"m/temp"', '""', '21.5'],
    ['"m/temp"', '"m/temp"', '""', '30'],
  ]);
  for (const r of rows) {
    expect(new Date(r[0]).getTime()).toBe(Number(r[1]));
  }
  const robotCsv = path.join(tempDir(), 'robot.csv');
  await mockDialogs(app, { saveFile: robotCsv });
  await p2.getByRole('button', { name: 'CSV' }).click();
  await expect(toast(page).filter({ hasText: `Saved ${robotCsv}` })).toBeVisible();
  const robotRows = readFileSync(robotCsv, 'utf8').split('\n').slice(1).map((l) => l.split(',').slice(2).join(','));
  expect(robotRows).toEqual([
    '"m/robot › $.battery.charge","m/robot","$.battery.charge",80',
    '"m/robot › $.battery.charge","m/robot","$.battery.charge",75',
    '"m/robot › $.battery.volt","m/robot","$.battery.volt",12.1',
    '"m/robot › $.battery.volt","m/robot","$.battery.volt",12',
  ]);

  // Plot definitions persist.
  await waitForLayout(userData, `p${broker.port}`, (d) => {
    const plots = d.tabs?.[0]?.plots || [];
    return plots.length === 2 && plots[0].title === 'Climate' && plots[0].windowSec === 60 && plots[0].series.length === 1;
  });
  expect(first.errors).toEqual([]);
  await env.closeApp(first);

  const second = await env.launch({ userData });
  const page2 = second.page;
  await reconnected(page2); // its tab comes back
  await expect(page2.locator('#plot-count')).toHaveText('2');
  await plotsTab(page2).click();
  const climate2 = card(page2, 'Climate');
  await expect(climate2.locator('.legend-label')).toHaveText(['m/temp']);
  await expect(climate2.locator('select')).toHaveValue('60');
  await expect(chip(climate2, 'm/temp').locator('.legend-value')).toHaveText('20'); // retained value
  const p2b = card(page2, 'm/robot › $.battery.charge');
  await expect(p2b.locator('.legend-label')).toHaveText(['m/robot › $.battery.charge', 'm/robot › $.battery.volt']);
  await expect(chip(p2b, '$.battery.charge').locator('.legend-value')).toHaveText('80');
  expect(second.errors).toEqual([]);
});
