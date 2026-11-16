// Custom plot time window: the Custom… entry of the time-window menu opens an
// hours + minutes picker (plot header and settings panel); cancelling keeps
// the old window; the chosen window is labelled and saved.

import path from 'node:path';
import { test, expect, makeUserData, profile, connect, waitForTopic, waitForFile } from './fixtures.mjs';

const plotsTab = (page) => page.locator('.right-tabs .tab[data-tab="plots"]');
const panel = (page) => page.locator('.plot-settings');

async function setup(env, userData) {
  const broker = await env.broker();
  await broker.publish('hall/temp', '21', { retain: true });
  userData ||= makeUserData({ profiles: [profile(broker.port)] });
  const ctx = await env.launch({ userData });
  await connect(ctx.page);
  await waitForTopic(ctx.page, 'hall/temp');
  await ctx.page.evaluate(() => {
    const { plots } = window.__mqttscope;
    plots.addSeries(null, 'hall/temp', null, { alias: 'Temp', quiet: true });
    plots.selectedId = plots.plots[0].id;
    plots.renderAll();
    plots.persist();
  });
  await plotsTab(ctx.page).click();
  return { broker, userData, ...ctx };
}

test('custom time window: picker in header and settings, cancel, persistence', async ({ env }) => {
  const { app, page, userData, errors } = await setup(env);
  const header = page.locator('.plot-card').first().locator('.window-select');
  const settings = panel(page).locator('select[name="plot-window"]');
  const picker = page.locator('.window-picker');
  const hours = picker.locator('input[name="window-hours"]');
  const minutes = picker.locator('input[name="window-minutes"]');

  // Custom… opens the picker filled with the current window (5 min).
  await header.selectOption('custom');
  await expect(picker).toBeVisible();
  await expect(hours).toHaveValue('0');
  await expect(minutes).toHaveValue('5');
  await expect(header).toHaveValue('300');

  // Space and letters typed in the picker do nothing else: no freeze, no text.
  await hours.press('Space');
  await hours.press('e');
  await expect(page.locator('.plots-toolbar').getByRole('button', { name: 'Freeze' })).toBeVisible();
  await expect(hours).toHaveValue('0');

  // Esc cancels: the picker closes and the window stays 5 min.
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(header).toHaveValue('300');
  expect(await page.evaluate(() => window.__mqttscope.plots.plots[0].windowSec)).toBe(300);

  // 0 h 0 min cannot be applied; 1 h 30 min can (Enter applies).
  await header.selectOption('custom');
  await hours.fill('0');
  await minutes.fill('0');
  await expect(picker.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await hours.fill('1');
  await minutes.fill('30');
  await expect(picker.getByRole('button', { name: 'Apply' })).toBeEnabled();
  await minutes.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(header).toHaveValue('5400');
  await expect(header.locator('option:checked')).toHaveText('1 h 30 min');
  await expect(settings.locator('option:checked')).toHaveText('1 h 30 min');

  // The settings panel has its own Custom…: 2 h.
  await settings.selectOption('custom');
  await expect(hours).toHaveValue('1');
  await expect(minutes).toHaveValue('30');
  await hours.fill('2');
  await minutes.fill('0');
  await picker.getByRole('button', { name: 'Apply' }).click();
  await expect(header).toHaveValue('7200');
  await expect(header.locator('option:checked')).toHaveText('2 h');

  // A click outside cancels too.
  await header.selectOption('custom');
  await expect(picker).toBeVisible();
  await page.locator('.plot-card canvas').first().click({ position: { x: 20, y: 20 } });
  await expect(picker).toHaveCount(0);
  await expect(header).toHaveValue('7200');

  // Saved, and still "2 h" after a restart.
  await waitForFile(path.join(userData, 'plotTabs.json'), (b) => JSON.parse(b).tabs[0].plots[0].windowSec === 7200);
  expect(errors).toEqual([]);
  await env.closeApp({ app });
  const again = await env.launch({ userData });
  await again.page.locator('.conn-dialog .modal-close').click();
  await plotsTab(again.page).click();
  await expect(again.page.locator('.plot-card .window-select option:checked')).toHaveText('2 h');
});
