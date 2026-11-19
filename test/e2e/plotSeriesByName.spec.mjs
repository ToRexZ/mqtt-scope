// Series picked from arrays of named entries (ROS diagnostics: status[].name,
// values[].key) follow the entry by its name: the label shows the names, the
// points come from that entry wherever it sits in each message, the same entry
// is one series, and the CSV and the saved layout carry the by-name path.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { test, expect, makeUserData, profile, connect, waitForTopic, selectTopic, viewerBody, viewerTab, historyItems, menu, mockDialogs, tempDir, toast, waitForLayout } from './fixtures.mjs';

// Node A and node B publish to one topic; BRAKE/FRONT moves, MOTOR has a TEMP too.
const A = { status: [{ name: 'BRAKE/FRONT', level: 0, values: [{ key: 'MODE', value: '3' }, { key: 'TEMP', value: '21.5' }] }] };
const B = {
  status: [
    { name: 'MOTOR', level: 1, values: [{ key: 'TEMP', value: '60' }] },
    { name: 'BRAKE/FRONT', level: 2, values: [{ key: 'TEMP', value: '22.5' }, { key: 'MODE', value: '4' }] },
  ],
};
const sel = (field, equals) => ({ field, equals });
const BRAKE_LEVEL = ['status', sel('name', 'BRAKE/FRONT'), 'level'];
const MOTOR_LEVEL = ['status', sel('name', 'MOTOR'), 'level'];
const BRAKE_TEMP = ['status', sel('name', 'BRAKE/FRONT'), 'values', sel('key', 'TEMP'), 'value'];
const BRAKE_TEMP_PATH = '$.status[?(@.name=="BRAKE/FRONT")].values[?(@.key=="TEMP")].value';

const plotsTab = (page) => page.locator('.right-tabs .tab[data-tab="plots"]');
const inspectorTab = (page) => page.locator('.right-tabs .tab[data-tab="inspector"]');
const labels = (page) => page.locator('.plot-card .legend-label');
const line = (page, jsonPath) => viewerBody(page).locator(`.jt-line[title="${jsonPath}"]`);
const points = (page, segs) => page.evaluate((s) => window.__mqttscope.plots.points('diag', s).map((p) => p.v), segs);
const picker = (page) => page.locator('.modal.picker');

test('series from named array entries follow the name', async ({ env }) => {
  const broker = await env.broker();
  const userData = makeUserData({ profiles: [profile(broker.port)] });
  const { app, page, errors } = await env.launch({ userData });
  await connect(page);
  await broker.publish('diag', JSON.stringify(A));
  await waitForTopic(page, 'diag');
  await selectTopic(page, 'diag');
  await viewerTab(page, 'tree').click();

  // Tree → Add to new plot on BRAKE/FRONT's level (status[0] in message A).
  await line(page, '$.status[0].level').click({ button: 'right' });
  await menu(page, 'Add to new plot');
  await plotsTab(page).click();
  await expect(labels(page)).toHaveText(['diag › BRAKE/FRONT › level']);
  await expect(page.locator('.plot-card .legend-label').first()).toHaveAttribute('title', /diag › \$\.status\[\?\(@\.name=="BRAKE\/FRONT"\)\]\.level/);
  expect(await page.evaluate(() => window.__mqttscope.plots.plots[0].series[0].segs)).toEqual(BRAKE_LEVEL);

  // Node B: BRAKE/FRONT is now status[1]; the series follows it (never MOTOR's 1).
  await broker.publish('diag', JSON.stringify(B));
  await expect.poll(() => points(page, BRAKE_LEVEL)).toEqual([0, 2]);

  // The same entry from message B is the same series; MOTOR is a new one.
  await inspectorTab(page).click();
  await line(page, '$.status[1]').locator('.jt-caret').click(); // new in B, so collapsed
  await expect(line(page, '$.status[1].level')).toBeVisible();
  await line(page, '$.status[1].level').click({ button: 'right' });
  await expect(page.locator('.ctx-menu .ctx-item.disabled')).toHaveText(['Add to plot “diag › BRAKE/FRONT › level”']);
  await page.keyboard.press('Escape');
  await line(page, '$.status[0].level').click({ button: 'right' });
  await menu(page, 'Add to plot “diag › BRAKE/FRONT › level”');
  await plotsTab(page).click();
  await expect(labels(page)).toHaveText(['diag › BRAKE/FRONT › level', 'diag › MOTOR › level']);
  expect(await points(page, MOTOR_LEVEL)).toEqual([1]);

  // Picker: BRAKE/FRONT's TEMP in message B (status[1].values[0]) follows the key too.
  await page.getByRole('button', { name: '+ New plot' }).click();
  await picker(page).locator('.picker-topic', { hasText: 'diag' }).click();
  await picker(page).locator('.picker-field[title="$.status[1].values[0].value"]').click();
  await expect(picker(page).locator('.picker-sel-source')).toHaveText(['diag › BRAKE/FRONT › TEMP']);
  await picker(page).locator('.picker-add').click();
  await expect(labels(page)).toHaveText(['diag › BRAKE/FRONT › level', 'diag › MOTOR › level', 'diag › BRAKE/FRONT › TEMP']);
  await broker.publish('diag', JSON.stringify(A));
  await expect.poll(() => points(page, BRAKE_TEMP)).toEqual([21.5, 22.5, 21.5]);

  // Chart this field (inspector): named the same way, over the kept history.
  await inspectorTab(page).click();
  await expect(line(page, '$.status[0].values')).toBeVisible();
  await expect(line(page, '$.status[1].level')).toHaveCount(0); // message A on screen
  await line(page, '$.status[0].level').click({ button: 'right' });
  await menu(page, 'Chart this field (kept history)');
  await expect(viewerBody(page).locator('.chart-title')).toHaveText('BRAKE/FRONT › level · 3 points in kept history');
  await viewerTab(page, 'tree').click();

  // CSV: the full by-name path.
  await plotsTab(page).click();
  const csvFile = path.join(tempDir(), 'temp.csv');
  await mockDialogs(app, { saveFile: csvFile });
  await page.locator('.plot-card').nth(1).getByRole('button', { name: 'CSV' }).click();
  await menu(page, 'All collected points…');
  await expect(toast(page).filter({ hasText: `Saved ${csvFile}` })).toBeVisible();
  const rows = readFileSync(csvFile, 'utf8').split('\n').slice(1);
  const q = (v) => `"${v.replace(/"/g, '""')}"`;
  expect(rows.map((r) => r.split(',').slice(2).join(','))).toEqual(['21.5', '22.5', '21.5'].map((v) => `${q('diag › BRAKE/FRONT › TEMP')},"diag",${q(BRAKE_TEMP_PATH)},${v}`));

  // Saved by name, and the same after a restart.
  await waitForLayout(userData, `p${broker.port}`, (d) => JSON.stringify(d.tabs[0].plots.flatMap((p) => p.series.map((s) => s.segs))) === JSON.stringify([BRAKE_LEVEL, MOTOR_LEVEL, BRAKE_TEMP]));
  expect(errors).toEqual([]);
  await env.closeApp({ app });
  const again = await env.launch({ userData });
  await plotsTab(again.page).click();
  await expect(labels(again.page)).toHaveText(['diag › BRAKE/FRONT › level', 'diag › MOTOR › level', 'diag › BRAKE/FRONT › TEMP']);
});

test('Follow by position for changing names; picker ticks, settings and prompt follow names', async ({ env }) => {
  const broker = await env.broker();
  const { page, errors } = await env.launch({ userData: makeUserData({ profiles: [profile(broker.port)] }) });
  await connect(page);

  // Event ids change every message: by name the series gets one point;
  // "Follow by position" in its settings switches it to the entry's place.
  await broker.publish('events', JSON.stringify({ events: [{ name: 'evt-1', v: 1 }] }));
  await waitForTopic(page, 'events');
  await broker.publish('events', JSON.stringify({ events: [{ name: 'evt-2', v: 2 }] }));
  await selectTopic(page, 'events');
  await viewerTab(page, 'tree').click();
  await expect(viewerBody(page).locator('.jt-line[title="$.events[0].name"]')).toContainText('evt-2');
  await line(page, '$.events[0].v').click({ button: 'right' });
  await menu(page, 'Add to new plot');
  await plotsTab(page).click();
  await expect(labels(page)).toHaveText(['events › evt-2 › v']);
  const evPoints = (segs) => page.evaluate((s) => window.__mqttscope.plots.points('events', s).map((p) => p.v), segs);
  expect(await evPoints(['events', sel('name', 'evt-2'), 'v'])).toEqual([2]);
  await page.locator('.plot-card').getByRole('button', { name: 'Plot settings' }).click();
  await page.locator('.plot-settings .ps-series-summary').first().click();
  await page.locator('.plot-settings .ps-source').click(); // the path text doesn't press the button
  await expect(labels(page)).toHaveText(['events › evt-2 › v']);
  await page.locator('.plot-settings').getByRole('button', { name: 'Follow by position' }).click();
  await expect(labels(page)).toHaveText(['events › $.events[0].v']);
  await expect(page.locator('.plot-settings .ps-source')).toHaveText('events › $.events[0].v');
  await expect(page.locator('.plot-settings').getByRole('button', { name: 'Follow by position' })).toHaveCount(0);
  await expect.poll(() => evPoints(['events', 0, 'v'])).toEqual([1, 2]);
  await broker.publish('events', JSON.stringify({ events: [{ name: 'evt-3', v: 3 }] }));
  await expect.poll(() => evPoints(['events', 0, 'v'])).toEqual([1, 2, 3]);
  await page.locator('.plot-card').getByRole('button', { name: 'Remove plot' }).click();
  await expect(page.locator('.plot-card')).toHaveCount(0);

  // Diagnostics: BRAKE/FRONT level by name, from the Tree.
  await broker.publish('diag', JSON.stringify(A));
  await waitForTopic(page, 'diag');
  await broker.publish('diag', JSON.stringify(B));
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('diag').history.length)).toBe(2);
  await inspectorTab(page).click();
  await selectTopic(page, 'diag');
  await expect(line(page, '$.status[1]')).toBeVisible();
  if ((await line(page, '$.status[1]').locator('.jt-caret').textContent()) === '▸') await line(page, '$.status[1]').locator('.jt-caret').click();
  await line(page, '$.status[1].level').click({ button: 'right' });
  await menu(page, 'Add to new plot');
  const brake = page.locator('.plot-card').filter({ has: page.locator('.plot-title', { hasText: 'diag › BRAKE/FRONT › level' }) });

  // Chart this field → "Add to plots": the plot that has it is greyed out.
  await line(page, '$.status[1].level').click({ button: 'right' });
  await menu(page, 'Chart this field (kept history)');
  await viewerBody(page).getByRole('button', { name: 'Add to plots' }).click();
  await expect(page.locator('.ctx-menu .ctx-item.disabled')).toHaveText(['Add to plot “diag › BRAKE/FRONT › level”']);
  await page.keyboard.press('Escape');
  await viewerTab(page, 'tree').click();

  // Settings and the alias prompt name the series the way the legend does.
  await plotsTab(page).click();
  await brake.getByRole('button', { name: 'Plot settings' }).click();
  await expect(page.locator('.plot-settings input[name="series-alias"]').first()).toHaveAttribute('placeholder', 'diag › BRAKE/FRONT › level');
  await brake.locator('.legend-label').dblclick();
  await expect(page.locator('.modal.prompt')).toContainText('(leave empty for “diag › BRAKE/FRONT › level”)');
  await page.keyboard.press('Escape');

  // Picker on that plot: the same entry counts as already there.
  await brake.getByRole('button', { name: '+ Series' }).click();
  await picker(page).locator('.picker-topic', { hasText: 'diag' }).click();
  await picker(page).locator('.picker-field[title="$.status[1].level"]').click();
  await expect(picker(page)).toContainText('1 already in this plot (skipped)');
  await picker(page).locator('.picker-field[title="$.status[1].level"]').click(); // untick
  // Ticked by name in message B. In a newer message that names two entries
  // BRAKE/FRONT, the first one's TEMP (the one the series reads) shows ticked.
  await picker(page).locator('.picker-field[title="$.status[1].values[0].value"]').click();
  await expect(picker(page).locator('.picker-sel-source')).toHaveText(['diag › BRAKE/FRONT › TEMP']);
  const twice = { status: [{ name: 'BRAKE/FRONT', level: 5, values: [{ key: 'TEMP', value: '30' }] }, { name: 'BRAKE/FRONT', level: 6, values: [{ key: 'TEMP', value: '31' }] }] };
  await broker.publish('diag', JSON.stringify(twice));
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('diag').history.length)).toBe(3);
  await picker(page).locator('.picker-topic', { hasText: 'diag' }).click(); // redraw the fields
  const first = picker(page).locator('.picker-field[title="$.status[0].values[0].value"] input');
  await expect(first).toBeChecked();
  await expect(picker(page).locator('.picker-field[title="$.status[1].values[0].value"] input')).not.toBeChecked();
  await first.click(); // unticking it there removes it
  await expect(picker(page).locator('.picker-sel-source')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A true/false field picked from an older message (held in the inspector)
  // becomes a state lane, though the latest message lacks that entry.
  await broker.publish('flags', JSON.stringify({ status: [{ name: 'X', ok: true }] }));
  await waitForTopic(page, 'flags');
  await broker.publish('flags', JSON.stringify({ status: [{ name: 'Y', ok: 1 }] }));
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('flags').history.length)).toBe(2);
  await inspectorTab(page).click();
  await selectTopic(page, 'flags');
  await viewerTab(page, 'tree').click();
  await historyItems(page).nth(1).click(); // the older message: X
  await expect(viewerBody(page).locator('.jt-line[title="$.status[0].name"]')).toContainText('"X"');
  await line(page, '$.status[0].ok').click({ button: 'right' });
  await menu(page, 'Add to new plot');
  expect(await page.evaluate(() => window.__mqttscope.plots.plots.at(-1).series[0])).toMatchObject({ segs: ['status', sel('name', 'X'), 'ok'], display: 'state' });
  expect(errors).toEqual([]);
});

test('a series saved by position (before 0.5) still loads and plots', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('diag', JSON.stringify(B), { retain: true });
  const series = { id: 's1', topic: 'diag', segs: ['status', 0, 'level'], slot: 0 };
  const plotTabs = { version: 2, tabs: [{ id: 'g', name: 'Old', plots: [{ id: 'p1', title: 'Old', windowSec: 300, series: [series] }] }], activeTabId: 'g' };
  const { page, errors } = await env.launch({ userData: makeUserData({ profiles: [profile(broker.port)], plotTabs }) });
  await connect(page);
  await waitForTopic(page, 'diag');
  await plotsTab(page).click();
  await expect(labels(page)).toHaveText(['diag › $.status[0].level']);
  await expect.poll(() => page.evaluate(() => window.__mqttscope.plots.points('diag', ['status', 0, 'level']).map((p) => p.v))).toEqual([1]);
  expect(errors).toEqual([]);
});
