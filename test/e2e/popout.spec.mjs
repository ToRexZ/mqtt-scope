// Pop-out inspector windows.

import { test, expect, rowByPath, waitForTopic, menu, popupFrom, selectTopic } from './fixtures.mjs';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
// Clicks File → Close Tab as macOS does with `title`'s window in front
// (Electron passes the focused window to the item).
const menuCloseTab = (app, title) =>
  app.evaluate(({ BrowserWindow, Menu }, t) => {
    const item = Menu.getApplicationMenu()
      .items.find((i) => i.label === 'File')
      .submenu.items.find((i) => i.label === 'Close Tab');
    item.click(undefined, BrowserWindow.getAllWindows().find((w) => w.getTitle() === t));
  }, title);

test('pop-out window shows one topic, follows it live and closes with the main window', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('po/a', 'first', { retain: true });
  await broker.publish('po/b', 'other', { retain: true });
  const { app, page, errors } = await env.connected(broker);
  await waitForTopic(page, 'po/b');
  await (await rowByPath(page, 'po/a')).click();
  await page.locator('#viewer-host .viewer-toolbar .tab[data-mode="raw"]').click();
  await broker.publish('po/a', 'second');
  await expect(page.locator('#viewer-host .history-item')).toHaveCount(2);

  const { popup, errors: popupErrors } = await popupFrom(app, () => page.locator('#viewer-host').getByRole('button', { name: '⤢ Pop out' }).click());
  await expect(popup.locator('.viewer-topic')).toHaveText('po/a');
  await expect(popup).toHaveTitle(`Test broker ${broker.port} — po/a`);
  // It starts with the history collected so far.
  await expect(popup.locator('.history-item .history-preview')).toHaveText(['second', 'first']);
  // A standalone viewer: no pop-out / maximize of its own.
  await expect(popup.getByRole('button', { name: '⤢ Pop out' })).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Maximize' })).toHaveCount(0);
  await popup.locator('.viewer-toolbar .tab[data-mode="raw"]').click();
  await expect(popup.locator('.viewer-body .src')).toHaveText('second');

  // Live updates for its topic only.
  await broker.publish('po/a', 'third');
  await expect(popup.locator('.viewer-body .src')).toHaveText('third');
  await expect(popup.locator('.history-item')).toHaveCount(3);
  await broker.publish('po/b', 'not for the pop-out');
  await broker.publish('po/a/child', 'not for the pop-out either');
  await waitForTopic(page, 'po/a/child');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('po/b').messageCount)).toBe(2);
  await broker.publish('po/a', 'fourth');
  await expect(popup.locator('.viewer-body .src')).toHaveText('fourth');
  await expect(popup.locator('.history-item .history-preview')).toHaveText(['fourth', 'third', 'second', 'first']);
  // Main window keeps working independently.
  await expect(page.locator('#viewer-host .viewer-body .src')).toHaveText('fourth');

  // A second pop-out from the tree's context menu.
  const { popup: popupB, errors: popupBErrors } = await popupFrom(app, async () => {
    await (await rowByPath(page, 'po/b')).click({ button: 'right' });
    await menu(page, 'Open in new window');
  });
  await expect(popupB.locator('.viewer-topic')).toHaveText('po/b');
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(3);
  expect(errors).toEqual([]);
  expect(popupErrors).toEqual([]);
  expect(popupBErrors).toEqual([]);

  // Closing the main window closes the pop-outs (and the app).
  const closed = Promise.all([popup.waitForEvent('close'), popupB.waitForEvent('close'), app.waitForEvent('close')]);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith('/index.html'))
      .close();
  });
  await closed;
});

test('the Close tab key (Ctrl+W) and File → Close Tab close a pop-out in front, not a tab', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('po/a', 'first', { retain: true });
  const { app, page, errors } = await env.connected(broker);
  await selectTopic(page, 'po/a');
  const popOut = () => popupFrom(app, () => page.locator('#viewer-host').getByRole('button', { name: '⤢ Pop out' }).click());
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const tabStates = () => page.evaluate(() => window.__mqttscope.shell.tabs.map((t) => t.status.state));
  const title = `Test broker ${broker.port} — po/a`;

  const { popup, errors: popupErrors } = await popOut();
  await expect(popup.locator('.viewer-topic')).toHaveText('po/a');
  let closed = popup.waitForEvent('close');
  await popup.locator('.viewer-topic').click();
  await popup.keyboard.press(`${MOD}+w`).catch(() => {}); // the window is gone before the key comes up
  await closed;
  expect(await windowCount()).toBe(1);
  expect(await tabStates()).toEqual(['connected']);

  // macOS: the menu bar belongs to the pop-out in front.
  const { popup: second } = await popOut();
  await expect(second).toHaveTitle(title);
  closed = second.waitForEvent('close');
  await menuCloseTab(app, title);
  await closed;
  expect(await windowCount()).toBe(1);
  expect(await tabStates()).toEqual(['connected']);
  // With the main window in front it closes the tab (a New connection tab takes its place).
  await menuCloseTab(app, `MQTT Scope — Test broker ${broker.port}`);
  await expect.poll(() => page.evaluate(() => window.__mqttscope.shell.tabs.map((t) => t.mode))).toEqual(['picker']);
  expect(errors).toEqual([]);
  expect(popupErrors).toEqual([]);
});
