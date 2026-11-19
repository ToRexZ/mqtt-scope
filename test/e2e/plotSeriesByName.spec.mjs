// Series picked from arrays of named entries (ROS diagnostics: status[].name,
// values[].key) follow the entry by its name: the label shows the names, the
// points come from that entry wherever it sits in each message, the same entry
// is one series, and the CSV and the saved layout carry the by-name path.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { test, expect, makeUserData, profile, connect, waitForTopic, selectTopic, viewerBody, viewerTab, menu, mockDialogs, tempDir, toast, waitForLayout } from './fixtures.mjs';

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
