// Keyboard shortcuts (rebindable in Settings → Keyboard), Enter to connect,
// and the "expand a topic when clicked" setting.

import path from 'node:path';
import { test, expect, makeUserData, profile, connect, rowByPath, waitForTopic, waitForFile, readJson } from './fixtures.mjs';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test('connection list: Enter connects to the selected connection, arrows move the selection', async ({ env }) => {
  const a = await env.broker();
  const b = await env.broker();
  const userData = makeUserData({ profiles: [profile(a.port, { id: 'a', name: 'Broker A' }), profile(b.port, { id: 'b', name: 'Broker B' })] });
  const { page, errors } = await env.launch({ userData });
  await expect(page.locator('.conn-item.active')).toHaveText(/Broker A/);
  await expect(page.locator('.conn-item.active')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.conn-item.active')).toHaveText(/Broker B/);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__mqttscope.status.state === 'connected');
  await expect(page.locator('#conn-label')).toHaveText('Broker B');
  await expect(page.locator('.conn-dialog')).toHaveCount(0);
  // Enter in a text field connects too; in the subscription list it adds a line.
  await page.keyboard.press(`${MOD}+K`);
  await page.locator('.conn-form textarea[name="subscriptions"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.conn-dialog')).toHaveCount(1);
  await page.locator('.conn-form input[name="host"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__mqttscope.status.state === 'connected');
  await expect(page.locator('.conn-dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('shortcuts can be rebound in Settings → Keyboard; conflicts block saving; the menu shows them', async ({ env }) => {
  const broker = await env.broker();
  const userData = makeUserData({ profiles: [profile(broker.port)] });
  const { app, page, errors } = await env.launch({ userData });
  await connect(page);

  // Defaults work.
  await page.keyboard.press(`${MOD}+2`);
  await expect(page.locator('.right-tabs .tab[data-tab="plots"]')).toHaveClass(/active/);
  await page.keyboard.press(`${MOD}+1`);
  await expect(page.locator('.right-tabs .tab[data-tab="inspector"]')).toHaveClass(/active/);
  await page.keyboard.press(`${MOD}+K`);
  await expect(page.locator('.conn-dialog')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // Rebind "Open connections" to Mod+J.
  await page.locator('#btn-settings').click();
  const dlg = page.locator('.modal.settings');
  await dlg.getByRole('button', { name: 'Keyboard', exact: true }).click();
  const row = dlg.locator('.keys-row[data-action="connections"]');
  await row.locator('.key-combo').click();
  await expect(row.locator('.key-combo')).toHaveText('Press keys…');
  await page.keyboard.press(`${MOD}+J`);
  await expect(row.locator('.key-combo')).toHaveText(process.platform === 'darwin' ? '⌘J' : 'Ctrl+J');

  // Giving Settings the same shortcut is flagged and blocks saving.
  const settingsRow = dlg.locator('.keys-row[data-action="settings"]');
  await settingsRow.locator('.key-combo').click();
  await page.keyboard.press(`${MOD}+J`);
  await expect(dlg.locator('.keys-row.conflict')).toHaveCount(2);
  await expect(dlg.getByRole('button', { name: 'Save' })).toBeDisabled();
  await settingsRow.getByRole('button', { name: '↺' }).click();
  await expect(dlg.locator('.keys-row.conflict')).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(dlg).toHaveCount(0);

  // The new key works, the old one no longer does.
  await page.keyboard.press(`${MOD}+K`);
  await expect(page.locator('.conn-dialog')).toHaveCount(0);
  await page.keyboard.press(`${MOD}+J`);
  await expect(page.locator('.conn-dialog')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // Saved, and shown in the application menu.
  await waitForFile(path.join(userData, 'settings.json'), (b) => JSON.parse(b).keys?.connections === 'Mod+J');
  await expect
    .poll(() =>
      app.evaluate(({ Menu }) => {
        const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File');
        return file.submenu.items.find((i) => i.label === 'Connections…').accelerator;
      }),
    )
    .toBe('CmdOrCtrl+J');
  expect(readJson(path.join(userData, 'settings.json')).keys).toEqual({ connections: 'Mod+J' });

  // Reset all restores the defaults.
  await page.locator('#btn-settings').click();
  await dlg.getByRole('button', { name: 'Keyboard', exact: true }).click();
  await dlg.getByRole('button', { name: 'Reset all to defaults' }).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.keyboard.press(`${MOD}+K`);
  await expect(page.locator('.conn-dialog')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('plain-key shortcuts do not fire while typing; Ctrl+F searches the message inside the inspector', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('a/b', '{"x":1}', { retain: true });
  const userData = makeUserData({ profiles: [profile(broker.port)], settings: { keys: { pause: 'P' } } });
  const { page, errors } = await env.launch({ userData });
  await connect(page);
  await waitForTopic(page, 'a/b');
  // "P" alone pauses, but not while typing in the filter box.
  await page.locator('#tree-filter').fill('');
  await page.locator('#tree-filter').press('P');
  await expect(page.locator('#btn-pause')).toHaveText('Pause');
  await expect(page.locator('#tree-filter')).toHaveValue('P');
  await page.locator('#tree-filter').fill('');
  await page.locator('#tree-scroll').focus();
  await page.keyboard.press('P');
  await expect(page.locator('#btn-pause')).toHaveText('Resume');
  await page.keyboard.press('P');
  // Mod+F: filter topics from the tree, search the message from the inspector.
  await page.keyboard.press(`${MOD}+F`);
  await expect(page.locator('#tree-filter')).toBeFocused();
  await (await rowByPath(page, 'a/b')).click();
  await page.locator('#viewer-host .viewer-body').click();
  await page.keyboard.press(`${MOD}+F`);
  await expect(page.locator('#viewer-host .search')).toBeFocused();
  expect(errors).toEqual([]);
});

test('clicking a topic expands it one level; keyboard navigation does not; the setting turns it off', async ({ env }) => {
  const broker = await env.broker();
  for (const t of ['robot/a/x', 'robot/a/y', 'robot/b/x', 'robot/c']) await broker.publish(t, '1', { retain: true });
  const userData = makeUserData({ profiles: [profile(broker.port)] });
  const { page, errors } = await env.launch({ userData });
  await connect(page);
  await waitForTopic(page, 'robot/c');
  const expanded = (t) => page.evaluate((t) => window.__mqttscope.tree.find(t).expanded, t);

  await page.locator('#tree-scroll .tree-row', { hasText: 'robot' }).first().click();
  await expect.poll(() => expanded('robot')).toBe(true);
  expect(await expanded('robot/a')).toBe(false); // only one level
  // Keyboard: moving onto "a" selects it without expanding.
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.treeView.selected?.path)).toBe('robot/a');
  expect(await expanded('robot/a')).toBe(false);

  // Turn the setting off.
  await page.locator('#btn-settings').click();
  await page.locator('.modal.settings input[name="autoExpand"]').uncheck();
  await page.locator('.modal.settings').getByRole('button', { name: 'Save' }).click();
  await (await rowByPath(page, 'robot/b')).click();
  expect(await expanded('robot/b')).toBe(false);
  await waitForFile(path.join(userData, 'settings.json'), (b) => JSON.parse(b).autoExpand === false);
  expect(errors).toEqual([]);
});
