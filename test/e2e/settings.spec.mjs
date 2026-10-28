// Settings dialog (history limit) and keyboard handling of modal dialogs.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { test, expect, makeUserData, profile, connect, reconnected, rowByPath, waitForTopic, waitForFile, historyItems } from './fixtures.mjs';

const settingsDialog = (page) => page.locator('.modal.settings');

async function publishMany(broker, topic, from, to) {
  for (let i = from; i <= to; i++) await broker.publish(topic, `msg-${i}`);
}

test('settings: messages kept per topic limits history and persists', async ({ env }) => {
  const broker = await env.broker();
  const userData = makeUserData({ profiles: [profile(broker.port)] });
  const first = await env.launch({ userData });
  const { page } = first;
  await connect(page);

  await page.locator('#btn-settings').click();
  const dlg = settingsDialog(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('[name="historyLimit"]')).toHaveValue('100');
  await expect(dlg.locator('[name="historyMB"]')).toHaveValue('64');
  await expect(dlg.locator('[name="historyLimit"]')).toBeFocused();

  // Out-of-range values are refused by the form's validation.
  await dlg.locator('[name="historyLimit"]').fill('999999');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(dlg).toBeVisible();
  expect(await dlg.locator('[name="historyLimit"]').evaluate((i) => i.validity.rangeOverflow)).toBe(true);
  expect((await page.evaluate(() => window.__mqttscope.settings)).historyLimit).toBe(100);

  await dlg.locator('[name="historyLimit"]').fill('5');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(dlg).toHaveCount(0);
  expect(await page.evaluate(() => window.__mqttscope.settings)).toEqual({ historyLimit: 5, historyMB: 64, autoExpand: true, checkForUpdates: true, restoreTabs: true, keys: {} });

  // Cancel discards changes.
  await page.locator('#btn-settings').click();
  await dlg.locator('[name="historyLimit"]').fill('7');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toHaveCount(0);
  expect((await page.evaluate(() => window.__mqttscope.settings)).historyLimit).toBe(5);

  // History never exceeds 5.
  await broker.publish('set/t', 'msg-0');
  await waitForTopic(page, 'set/t');
  await (await rowByPath(page, 'set/t')).click();
  await page.locator('#viewer-host .viewer-toolbar .tab[data-mode="raw"]').click();
  await publishMany(broker, 'set/t', 1, 9);
  await expect(page.locator('#viewer-host .viewer-meta')).toContainText('10 received');
  await expect(historyItems(page)).toHaveCount(5);
  await expect(page.locator('#viewer-host .history-head')).toHaveText('History (5)');
  await expect(historyItems(page).locator('.history-preview')).toHaveText(['msg-9', 'msg-8', 'msg-7', 'msg-6', 'msg-5']);
  await expect(page.locator('#viewer-host .viewer-meta')).toContainText('#5 of 5 kept');
  await publishMany(broker, 'set/t', 10, 12);
  await expect(page.locator('#viewer-host .viewer-meta')).toContainText('13 received');
  await expect(historyItems(page)).toHaveCount(5);
  await expect(historyItems(page).first().locator('.history-preview')).toHaveText('msg-12');

  await waitForFile(path.join(userData, 'settings.json'), (b) => JSON.parse(b).historyLimit === 5);
  expect(first.errors).toEqual([]);
  await env.closeApp(first);

  // After a restart the limit still applies.
  const second = await env.launch({ userData });
  const page2 = second.page;
  await reconnected(page2); // its tab comes back
  await page2.locator('#btn-settings').click();
  await expect(settingsDialog(page2).locator('[name="historyLimit"]')).toHaveValue('5');
  await settingsDialog(page2).getByRole('button', { name: 'Cancel' }).click();
  await broker.publish('set/u', 'msg-0');
  await waitForTopic(page2, 'set/u');
  await (await rowByPath(page2, 'set/u')).click();
  await publishMany(broker, 'set/u', 1, 7);
  await expect(page2.locator('#viewer-host .viewer-meta')).toContainText('8 received');
  await expect(historyItems(page2)).toHaveCount(5);
  expect(second.errors).toEqual([]);
});

test('modal dialogs: Enter confirms, Escape cancels (settings and text prompts)', async ({ env }) => {
  const broker = await env.broker();
  const { page, errors } = await env.connected(broker);

  // Escape cancels.
  await page.locator('#btn-settings').click();
  const dlg = settingsDialog(page);
  await dlg.locator('[name="historyLimit"]').fill('42');
  await dlg.locator('[name="historyLimit"]').press('Escape');
  await expect(dlg).toHaveCount(0);
  expect((await page.evaluate(() => window.__mqttscope.settings)).historyLimit).toBe(100);

  // Enter in a field submits the form, like the Save button.
  await page.locator('#btn-settings').click();
  await dlg.locator('[name="historyLimit"]').fill('7');
  await dlg.locator('[name="historyLimit"]').press('Enter');
  await expect(dlg).toHaveCount(0);
  // Soft: a failure here is a reported bug; the rest still runs.
  await expect.soft.poll(() => page.evaluate(() => window.__mqttscope.settings.historyLimit), { message: 'Enter saves the settings', timeout: 2000 }).toBe(7);

  // Same for the text prompt used by Save…, Rename, plots.
  const pub = page.locator('#publisher-host .publisher');
  await pub.locator('.topic-input').fill('kbd/topic');
  await pub.locator('.pub-row').nth(1).locator('select').selectOption('text');
  await pub.locator('.payload-editor').fill('x');
  await pub.getByRole('button', { name: 'Save…' }).click();
  const prompt = page.locator('.modal.prompt');
  await prompt.locator('input').fill('Saved with Enter');
  await prompt.locator('input').press('Enter');
  await expect(prompt).toHaveCount(0);
  await expect.soft(pub.locator('.lib-item .lib-name'), 'Enter confirms the prompt').toHaveText(['Saved with Enter'], { timeout: 2000 });

  await pub.getByRole('button', { name: 'Save…' }).click();
  await prompt.locator('input').fill('Never saved');
  await prompt.locator('input').press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(pub.locator('.lib-item .lib-name', { hasText: 'Never saved' })).toHaveCount(0);
  // The global Escape (restore maximized inspector) does not fire through a modal.
  await expect(page.locator('#layout')).not.toHaveClass(/max-viewer/);
  expect(errors).toEqual([]);
});

test('settings: footer shows the running app version', async ({ env }) => {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const broker = await env.broker();
  const { page } = await env.connected(broker);
  await page.locator('#btn-settings').click();
  const footer = settingsDialog(page).locator('.settings-version');
  await expect(footer).toHaveText(`MQTT Scope ${version}`);
  // Visible on every tab, below the tab content.
  await settingsDialog(page).locator('.tab[data-tab="keyboard"]').click();
  await expect(footer).toBeVisible();
});
