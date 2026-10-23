// Plot picker ("+ New plot", "+ Series", "Choose values to plot…") and
// series aliases in the legend, tooltip, CSV and persistence.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { test, expect, makeUserData, profile, connect, rowByPath, waitForTopic, menu, mockDialogs, tempDir, waitForFile } from './fixtures.mjs';

const picker = (page) => page.locator('.modal.picker');
const topicRows = (page) => picker(page).locator('.picker-topic');
const field = (page, key) =>
  picker(page).locator('.picker-field').filter({ has: page.locator('.picker-key', { hasText: new RegExp(`^${key}$`) }) });
const legendLabels = (page) => page.locator('.plot-card .legend-label');

test('picker: scrollable topic list, message structure, multi-select with aliases, legend aliases persist', async ({ env }) => {
  const broker = await env.broker();
  // Enough topics that the list has to scroll.
  for (let i = 0; i < 120; i++) await broker.publish(`fleet/robot-${String(i).padStart(3, '0')}/temp`, String(20 + i), { retain: true });
  const state = {
    batteryState: { batteryCharge: 81.5, batteryVoltage: 47.1, charging: false },
    agvPosition: { x: 1.25, y: 2.5, mapId: 'hall-1' },
    nodeStates: Array.from({ length: 30 }, (_, i) => ({ nodeId: `N${i}`, sequenceId: i })),
    serialNumber: 'AGV-1',
  };
  await broker.publish('agv/1/state', JSON.stringify(state), { retain: true });
  await broker.publish('notes/text', 'just text', { retain: true });
  const userData = makeUserData({ profiles: [profile(broker.port)] });
  const { app, page, errors } = await env.launch({ userData });
  await connect(page);
  await waitForTopic(page, 'agv/1/state');
  await waitForTopic(page, 'fleet/robot-119/temp');

  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  await page.getByRole('button', { name: '+ New plot' }).click();
  await expect(picker(page)).toBeVisible();

  // Topic list: lists every topic with numbers (text-only topics hidden by default) and scrolls.
  await expect(topicRows(page)).toHaveCount(121);
  await expect(picker(page).locator('.picker-foot').first()).toHaveText('121 of 122 topics');
  const list = picker(page).locator('.picker-topics');
  const scrollable = await list.evaluate((e) => e.scrollHeight > e.clientHeight + 100);
  expect(scrollable).toBe(true);
  await list.evaluate((e) => (e.scrollTop = e.scrollHeight));
  await expect.poll(() => list.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  await expect(topicRows(page).last()).toBeInViewport();
  await picker(page).locator('label:has-text("With numbers") input').uncheck();
  await expect(topicRows(page)).toHaveCount(122);
  await picker(page).locator('label:has-text("With numbers") input').check();

  // Filtering (substring and MQTT wildcard).
  await page.locator('.picker-topic-search').fill('agv/1');
  await expect(topicRows(page)).toHaveCount(1);
  await page.locator('.picker-topic-search').fill('fleet/+/temp');
  await expect(topicRows(page)).toHaveCount(120);
  await page.locator('.picker-topic-search').fill('agv');
  await expect(topicRows(page)).toHaveCount(1);
  await topicRows(page).first().click();

  // Field list shows the message structure; only numbers are selectable.
  await expect(picker(page).locator('.picker-col-title', { hasText: 'Fields of agv/1/state' })).toBeVisible();
  await expect(field(page, 'batteryState')).toHaveClass(/container/);
  await expect(field(page, 'batteryCharge').locator('input[type="checkbox"]')).toBeEnabled();
  await expect(field(page, 'serialNumber')).toHaveCount(0); // numbers only by default
  await picker(page).locator('label:has-text("Numbers only") input').uncheck();
  await expect(field(page, 'serialNumber').locator('input[type="checkbox"]')).toBeDisabled();
  await picker(page).locator('label:has-text("Numbers only") input').check();
  // Long arrays start collapsed and expand on click.
  await expect(field(page, 'nodeStates')).toContainText('[ 30 ]');
  await expect(field(page, 'sequenceId')).toHaveCount(0);
  await field(page, 'nodeStates').click();
  await expect(field(page, 'sequenceId')).toHaveCount(30);
  await field(page, 'nodeStates').click();
  // The field filter finds values inside collapsed arrays.
  await page.locator('.picker-field-search').fill('voltage');
  await expect(picker(page).locator('.picker-field:not(.container)')).toHaveCount(1);
  await page.locator('.picker-field-search').fill('');

  await field(page, 'batteryCharge').click();
  await field(page, 'batteryVoltage').locator('input').check();
  await expect(picker(page).locator('.picker-sel')).toHaveCount(2);
  await expect(topicRows(page).first().locator('.picker-count')).toHaveText('2');
  // Unticking removes from the selection; ticking again restores.
  await field(page, 'batteryVoltage').click();
  await expect(picker(page).locator('.picker-sel')).toHaveCount(1);
  await field(page, 'batteryVoltage').click();

  // Pick a value from a second topic too.
  await page.locator('.picker-topic-search').fill('robot-007');
  await expect(topicRows(page)).toHaveText([/fleet\/robot-007\/temp/]);
  await topicRows(page).first().click();
  await field(page, '\\(payload\\)').click();
  await expect(picker(page).locator('.picker-sel')).toHaveCount(3);

  await picker(page).locator('.picker-alias').nth(0).fill('Battery %');
  await picker(page).locator('.picker-alias').nth(2).fill('Robot 7 temp');
  await expect(picker(page).locator('.picker-add')).toHaveText('Add 3 series');
  await picker(page).locator('.picker-add').click();
  await expect(picker(page)).toHaveCount(0);

  // One plot with three series; aliases in the legend, source in the tooltip.
  await expect(page.locator('.plot-card')).toHaveCount(1);
  await expect(page.locator('.plot-card .plot-title')).toHaveText('Battery %');
  await expect(legendLabels(page)).toHaveText(['Battery %', 'agv/1/state › $.batteryState.batteryVoltage', 'Robot 7 temp']);
  await expect(legendLabels(page).first()).toHaveAttribute('title', /agv\/1\/state › \$\.batteryState\.batteryCharge/);
  await expect(page.locator('.plot-card .legend-value').first()).toHaveText('81.5');

  // Rename via double-click; Enter confirms; empty alias falls back to the source.
  await legendLabels(page).nth(1).dblclick();
  await page.locator('.modal.prompt .input').fill('Voltage');
  await page.keyboard.press('Enter');
  await expect(legendLabels(page).nth(1)).toHaveText('Voltage');
  await legendLabels(page).nth(2).dblclick();
  await page.locator('.modal.prompt .input').fill('');
  await page.keyboard.press('Enter');
  await expect(legendLabels(page).nth(2)).toHaveText('fleet/robot-007/temp');

  // Tooltip uses the alias.
  await page.locator('.plot-card canvas').hover({ position: { x: 300, y: 100 } });
  await expect(page.locator('.chart-tip')).toContainText('Battery %');

  // CSV carries alias, topic and path.
  const dir = tempDir();
  const csvFile = path.join(dir, 'plot.csv');
  await mockDialogs(app, { saveFile: csvFile });
  await page.locator('.plot-card').getByRole('button', { name: 'CSV' }).click();
  await waitForFile(csvFile);
  const csv = readFileSync(csvFile, 'utf8').split('\n');
  expect(csv[0]).toBe('time_iso,epoch_ms,series,topic,path,value');
  expect(csv.some((l) => l.includes('"Battery %","agv/1/state","$.batteryState.batteryCharge",81.5'))).toBe(true);
  expect(csv.some((l) => l.includes('"Voltage","agv/1/state","$.batteryState.batteryVoltage",47.1'))).toBe(true);

  // "+ Series" targets that plot; already-plotted values are skipped and capacity is enforced.
  await page.locator('.plot-card').getByRole('button', { name: '+ Series' }).click();
  await expect(picker(page).locator('.picker-head select')).toHaveValue(/.+/);
  await page.locator('.picker-topic-search').fill('agv/1');
  await expect(topicRows(page)).toHaveCount(1);
  await topicRows(page).first().click();
  await field(page, 'batteryCharge').click();
  await expect(picker(page).locator('.picker-note')).toHaveText('1 already in this plot (skipped)');
  await field(page, 'batteryCharge').click();
  await page.locator('.picker-topic-search').fill('fleet/');
  await expect(topicRows(page)).toHaveCount(120);
  for (const name of ['fleet/robot-000/temp', 'fleet/robot-001/temp', 'fleet/robot-002/temp', 'fleet/robot-003/temp', 'fleet/robot-004/temp', 'fleet/robot-005/temp']) {
    await topicRows(page).filter({ hasText: name }).click();
    await field(page, '\\(payload\\)').click();
  }
  await expect(picker(page).locator('.picker-note')).toContainText('room for 5 more series');
  await expect(picker(page).locator('.picker-add')).toBeDisabled();
  await picker(page).locator('.picker-sel .chip-x').last().click();
  await expect(picker(page).locator('.picker-add')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await expect(legendLabels(page)).toHaveCount(3);

  // Aliases persist across restarts.
  await env.closeApp({ app });
  const again = await env.launch({ userData });
  await connect(again.page); // the plots show in a connected tab
  await again.page.locator('.right-tabs .tab[data-tab="plots"]').click();
  await expect(legendLabels(again.page)).toHaveText(['Battery %', 'Voltage', 'fleet/robot-007/temp']);
  expect(errors).toEqual([]);
  expect(again.errors).toEqual([]);
});

test('picker from the tree: "Choose values to plot…" opens on that topic', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('robot/state', JSON.stringify({ speed: 1.2, pos: { x: 3, y: 4 } }), { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'robot/state');
  await (await rowByPath(page, 'robot/state')).click({ button: 'right' });
  await menu(page, 'Choose values to plot…');
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator('.picker-topic.active')).toContainText('robot/state');
  await field(page, 'x').click();
  await field(page, 'y').click();
  await picker(page).locator('.picker-add').click();
  // Adding switches to the Plots tab and shows the new plot.
  await expect(page.locator('.right-tabs .tab[data-tab="plots"]')).toHaveClass(/active/);
  await expect(legendLabels(page)).toHaveText(['robot/state › $.pos.x', 'robot/state › $.pos.y']);
  await broker.publish('robot/state', JSON.stringify({ speed: 1.2, pos: { x: 5, y: 6 } }));
  await expect(page.locator('.plot-card .legend-value').first()).toHaveText('5');
  expect(errors).toEqual([]);
});
