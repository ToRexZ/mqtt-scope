// Inspector Tree with ROS-diagnostics-style messages: numbers written as text
// can be charted and plotted from the right-click menu, and a search hit
// inside a list entry shows the whole entry (a key with its value).

import { test, expect, makeUserData, profile, connect, waitForTopic, selectTopic, viewerBody, viewerTab, menu, menuLabels } from './fixtures.mjs';

const diag = (t) => ({
  status: [
    {
      name: 'BRAKE',
      level: 1,
      values: [
        { key: 'MODE', value: '3' },
        { key: 'TEMP', value: t },
        { key: 'STATE', value: 'OK' },
        { key: 'EXP', value: ' -3e1 ' },
      ],
    },
  ],
});
const line = (page, jsonPath) => viewerBody(page).locator(`.jt-line[title="${jsonPath}"]`);
const plotsTab = (page) => page.locator('.right-tabs .tab[data-tab="plots"]');

async function open(env, ...messages) {
  const broker = await env.broker();
  const ctx = await env.launch({ userData: makeUserData({ profiles: [profile(broker.port)] }) });
  await connect(ctx.page);
  for (const m of messages) await broker.publish('diag', JSON.stringify(m));
  await waitForTopic(ctx.page, 'diag');
  await expect.poll(() => ctx.page.evaluate(() => window.__mqttscope.tree.find('diag').history.length)).toBe(messages.length);
  await selectTopic(ctx.page, 'diag');
  await viewerTab(ctx.page, 'tree').click();
  return { broker, ...ctx };
}

test('numbers written as text can be charted and plotted from the Tree', async ({ env }) => {
  const { page, errors } = await open(env, diag('21.5'), diag('22.5'));

  // "22.5" (TEMP): chart and plot items, nothing disabled.
  await line(page, '$.status[0].values[1].value').click({ button: 'right' });
  expect(await menuLabels(page)).toEqual(['Copy value', 'Copy path', 'Chart this field (kept history)', 'Choose values to plot…', 'Add to new plot']);
  await expect(page.locator('.ctx-menu .ctx-item.disabled')).toHaveCount(0);
  await menu(page, 'Chart this field (kept history)');
  await expect(viewerBody(page).locator('.chart-title')).toHaveText('BRAKE › TEMP · 2 points in kept history');
  await viewerTab(page, 'tree').click();

  await line(page, '$.status[0].values[1].value').click({ button: 'right' });
  await menu(page, 'Add to new plot');
  await plotsTab(page).click();
  await expect(page.locator('.plot-card .legend-label')).toHaveText(['diag › BRAKE › TEMP']);
  expect(await page.evaluate(() => window.__mqttscope.plots.points('diag', ['status', { field: 'name', equals: 'BRAKE' }, 'values', { field: 'key', equals: 'TEMP' }, 'value']).map((p) => p.v))).toEqual([21.5, 22.5]);

  // " -3e1 " is a number too; "OK" is not: chart disabled, no plot items.
  await page.locator('.right-tabs .tab[data-tab="inspector"]').click();
  await line(page, '$.status[0].values[3].value').click({ button: 'right' });
  await expect(page.locator('.ctx-menu .ctx-item.disabled')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await line(page, '$.status[0].values[2].value').click({ button: 'right' });
  expect(await menuLabels(page)).toEqual(['Copy value', 'Copy path', 'Chart this field (kept history)']);
  await expect(page.locator('.ctx-menu .ctx-item.disabled')).toHaveText(['Chart this field (kept history)']);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
