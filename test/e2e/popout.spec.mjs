// Pop-out inspector windows.

import { test, expect, rowByPath, waitForTopic, menu, popupFrom } from './fixtures.mjs';

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
