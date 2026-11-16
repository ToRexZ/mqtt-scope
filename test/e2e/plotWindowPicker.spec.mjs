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

  // Enter on a focused Cancel button cancels (it does not apply the fields).
  await header.selectOption('custom');
  await hours.fill('3');
  await picker.getByRole('button', { name: 'Cancel' }).focus();
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(header).toHaveValue('300');

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

test('the picker gives focus back, keeps a zoom, and closes with its view', async ({ env }) => {
  const { app, page, errors } = await setup(env);
  const header = page.locator('.plot-card').first().locator('.window-select');
  const settings = panel(page).locator('select[name="plot-window"]');
  const picker = page.locator('.window-picker');
  const minutes = picker.locator('input[name="window-minutes"]');
  const reset = page.locator('.plot-card .reset-view');
  const open = async () => {
    await header.selectOption('custom');
    await expect(picker).toBeVisible();
  };

  // Esc closes only the picker: the zoom stays (a second Esc resets it), and
  // focus goes back to the time-window menu.
  await page.evaluate(() => {
    const { plots } = window.__mqttscope;
    plots.zoom(plots.plots[0], { t0: Date.now() - 60_000, t1: Date.now() });
  });
  await expect(reset).toBeVisible();
  await open();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(header).toBeFocused();
  await expect(reset).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reset).toBeHidden();

  // Apply gives focus back too.
  await open();
  await picker.locator('input[name="window-hours"]').fill('2');
  await minutes.fill('0');
  await picker.getByRole('button', { name: 'Apply' }).click();
  await expect(header).toHaveValue('7200');
  await expect(header).toBeFocused();

  // Picking a preset drops the custom entry, in the header and in the settings panel.
  await header.selectOption('900');
  const presets = ['1 min', '5 min', '15 min', '1 h', 'All', 'Custom…'];
  await expect(header.locator('option')).toHaveText(presets);
  await expect(settings.locator('option')).toHaveText(presets);

  // Sideways scrolling over a field leaves it alone; scrolling up steps it.
  await open();
  await minutes.hover();
  await page.mouse.wheel(40, 0);
  await expect(minutes).toHaveValue('15');
  await page.mouse.wheel(0, -40);
  await expect(minutes).toHaveValue('16');

  // It closes (cancelled) when the window loses focus…
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(picker).toHaveCount(0);
  // …when focus is tabbed out of it (back into the page)…
  await open();
  await expect(picker.locator('input[name="window-hours"]')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(picker).toHaveCount(0);
  // …when the plots are drawn again (e.g. another window saved them)…
  await open();
  await page.evaluate(() => window.__mqttscope.plots.renderAll());
  await expect(picker).toHaveCount(0);
  // …when full screen starts or ends…
  await open();
  await page.evaluate(() => document.dispatchEvent(new Event('fullscreenchange')));
  await expect(picker).toHaveCount(0);
  // …and when the menu bar switches to the Inspector.
  await open();
  await app.evaluate(({ Menu }) => {
    const find = (items) => {
      for (const i of items) {
        if (i.label === 'Inspector') return i;
        const sub = i.submenu && find(i.submenu.items);
        if (sub) return sub;
      }
      return null;
    };
    find(Menu.getApplicationMenu().items).click();
  });
  await expect(page.locator('#plots-host')).toBeHidden();
  await expect(picker).toHaveCount(0);
  expect(await page.evaluate(() => window.__mqttscope.plots.plots[0].windowSec)).toBe(900);
  expect(errors).toEqual([]);
});
