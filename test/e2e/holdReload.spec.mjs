// Space holds the inspector's message (freezes the plots on the Plots tab);
// Ctrl+R clears received messages and restarts the plot timelines.

import { test, expect, selectTopic, waitForTopic, until } from './fixtures.mjs';

const shown = (page) => page.evaluate(() => new TextDecoder().decode(window.__mqttscope.viewer.current().payload));

test('Space holds and releases the inspector message and freezes the plots; spaces still type', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('hall/temp', '21', { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'hall/temp');
  await selectTopic(page, 'hall/temp');
  await page.locator('#tree-scroll').focus();

  await page.keyboard.press('Space');
  await expect(page.locator('.viewer .btn.live')).toHaveText(/Held/);
  await broker.publish('hall/temp', '22');
  await until(() => page.evaluate(() => window.__mqttscope.tree.find('hall/temp').history.length === 2), { message: 'second message' });
  expect(await shown(page)).toBe('21');
  await page.keyboard.press('Space');
  await expect(page.locator('.viewer .btn.live')).toHaveText(/Live/);
  expect(await shown(page)).toBe('22');

  // In a text field Space types a space.
  await page.locator('#tree-filter').click();
  await page.keyboard.type('hall temp');
  await expect(page.locator('#tree-filter')).toHaveValue('hall temp');
  await expect(page.locator('.viewer .btn.live')).toHaveText(/Live/);
  await page.locator('#tree-filter').fill('');

  // On the Plots tab Space freezes and resumes the time axis.
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'hall/temp', null, { quiet: true }));
  // Right after clicking the Plots tab (it keeps focus), Space is still the shortcut.
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  const freeze = page.locator('.plots-toolbar .btn', { hasText: /^(Freeze|Resume)$/ });
  await page.keyboard.press('Space');
  await expect(freeze).toHaveText('Resume');
  await page.keyboard.press('Space');
  await expect(freeze).toHaveText('Freeze');
  // A focused button does not also "click" on Space (that would toggle twice).
  await freeze.click();
  await expect(freeze).toHaveText('Resume');
  await page.keyboard.press('Space');
  await expect(freeze).toHaveText('Freeze');
  expect(errors).toEqual([]);
});

test('Ctrl+R clears received messages and restarts the plots, staying connected', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('hall/temp', '21', { retain: true });
  await broker.publish('a/b', 'x', { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'a/b');
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'hall/temp', null));
  await broker.publish('hall/temp', '22');
  const points = () => page.evaluate(() => window.__mqttscope.plots.points('hall/temp', null).length);
  await until(async () => (await points()) === 2, { message: 'two points' });
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Freeze' }).click();

  await page.locator('.plots-hint').click();
  await page.evaluate(() => (window.__notReloaded = true));
  await page.keyboard.press('Control+r');
  await expect(page.locator('.toast').filter({ hasText: 'Cleared received messages and restarted the plots' })).toBeVisible();
  expect(await page.evaluate(() => [window.__mqttscope.tree.topicCount, window.__mqttscope.tree.messageCount])).toEqual([0, 0]);
  expect(await points()).toBe(0);
  await expect(page.locator('.plots-toolbar .btn', { hasText: /^Freeze$/ })).toBeVisible();
  expect(await page.evaluate(() => window.__mqttscope.status.state)).toBe('connected');
  // The page itself was not reloaded: plots and the open tab are still there.
  expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
  await expect(page.locator('.plot-card')).toHaveCount(1);
  await expect(page.locator('#plots-host')).toBeVisible();

  // New messages start the timeline again.
  await broker.publish('hall/temp', '23');
  await waitForTopic(page, 'hall/temp');
  await until(async () => (await points()) === 1, { message: 'new point' });
  expect(errors).toEqual([]);
});

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test('Hold and Reload are in the View menu with their keys, and can be rebound', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('hall/temp', '21', { retain: true });
  const { app, page, errors } = await env.connected(broker);
  await waitForTopic(page, 'hall/temp');
  await selectTopic(page, 'hall/temp');
  const menuItem = (label) =>
    app.evaluate(({ Menu }, l) => {
      const item = Menu.getApplicationMenu().items.find((i) => i.label === 'View').submenu.items.find((i) => i.label === l);
      return item && { accelerator: item.accelerator };
    }, label);
  await expect.poll(() => menuItem('Hold / Follow (Freeze Plots)')).toEqual({ accelerator: 'Space' });
  await expect.poll(() => menuItem('Reload: Clear Messages and Restart Plots')).toEqual({ accelerator: 'CmdOrCtrl+R' });

  // The menu item works like the key.
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label === 'View').submenu.items.find((i) => i.label === 'Hold / Follow (Freeze Plots)').click());
  await expect(page.locator('.viewer .btn.live')).toHaveText(/Held/);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label === 'View').submenu.items.find((i) => i.label === 'Hold / Follow (Freeze Plots)').click());
  await expect(page.locator('.viewer .btn.live')).toHaveText(/Live/);

  // Rebind Hold to H.
  await page.locator('#btn-settings').click();
  const dlg = page.locator('.modal.settings');
  await dlg.getByRole('button', { name: 'Keyboard', exact: true }).click();
  const row = dlg.locator('.keys-row[data-action="hold"]');
  await row.locator('.key-combo').click();
  await page.keyboard.press('h');
  await expect(row.locator('.key-combo')).toHaveText('H');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.locator('#tree-scroll').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.viewer .btn.live')).toHaveText(/Live/);
  await page.keyboard.press('h');
  await expect(page.locator('.viewer .btn.live')).toHaveText(/Held/);
  await expect.poll(() => menuItem('Hold / Follow (Freeze Plots)')).toEqual({ accelerator: 'H' });
  expect(errors).toEqual([]);
});

test('Ctrl+R while paused also drops the queued messages; zoom and freeze are reset', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('hall/temp', '21', { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'hall/temp');
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'hall/temp', null));
  for (let i = 0; i < 6; i++) {
    await broker.publish('hall/temp', String(22 + i));
    await new Promise((r) => setTimeout(r, 40));
  }
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  // Zoom in and freeze.
  const canvas = page.locator('.plot-card canvas');
  const c = await canvas.boundingBox();
  await page.mouse.move(c.x + c.width * 0.3, c.y + 30);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width * 0.8, c.y + 30, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.zoom-reset')).toBeVisible();
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Freeze' }).click();
  // Pause and let messages queue up.
  await page.locator('#btn-pause').click();
  await broker.publish('hall/temp', '30');
  await broker.publish('hall/temp', '31');
  await expect(page.locator('#stat-rate')).toHaveText(/paused · 2 queued/);

  await page.locator('.plots-hint').click();
  await page.keyboard.press(`${MOD}+r`);
  await expect(page.locator('#stat-rate')).toHaveText(/paused · 0 queued/);
  await expect(page.locator('.zoom-reset')).toBeHidden();
  await expect(page.locator('.plots-toolbar .btn', { hasText: /^Freeze$/ })).toBeVisible();
  expect(await page.evaluate(() => window.__mqttscope.plots.points('hall/temp', null).length)).toBe(0);
  // Still paused: resuming brings nothing old back.
  await page.locator('#btn-pause').click();
  expect(await page.evaluate(() => window.__mqttscope.tree.messageCount)).toBe(0);
  expect(errors).toEqual([]);
});

test('Space presses a button reached with the keyboard; after a mouse click it is still the shortcut', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('hall/temp', '21', { retain: true });
  const { app, page, errors } = await env.connected(broker);
  await waitForTopic(page, 'hall/temp');
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'hall/temp', null));
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  const frozen = page.locator('.plots-toolbar .btn', { hasText: /^Resume$/ });

  // Tab to the Arrange button: Space presses it (opens its menu) and does not freeze.
  await page.locator('.plots-toolbar').getByRole('button', { name: '+ New plot' }).focus();
  await page.keyboard.press('Tab');
  // (The hidden test window has no system focus, so check the active element directly.)
  expect(await page.locator('.arrange-btn').evaluate((b) => b === document.activeElement)).toBe(true);
  await page.keyboard.press('Space');
  await expect(page.locator('.ctx-menu')).toBeVisible();
  await expect(frozen).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Click the Arrange button with the mouse (it keeps focus), close its menu: Space freezes.
  await page.locator('.arrange-btn').click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Space');
  await expect(frozen).toBeVisible();
  await page.keyboard.press('Space');
  await expect(frozen).toHaveCount(0);

  // Same after clicking the pop-out button: Space freezes, no second window opens.
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const opened = app.waitForEvent('window');
  await page.locator('.plot-card .popout-btn').click();
  await opened;
  const before = await windows();
  await page.keyboard.press('Space');
  await expect(frozen).toBeVisible();
  await page.waitForTimeout(300); // a second window would have opened by now
  expect(await windows()).toBe(before);
  expect(errors).toEqual([]);
});

test('freezing a plot showing everything ("All") holds its time axis and its legend', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('hall/temp', '21', { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'hall/temp');
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'hall/temp', null));
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  await page.locator('.plot-card .window-select').selectOption('0');
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Freeze' }).click();
  const range = () => page.evaluate(() => [...window.__mqttscope.plots.charts.values()][0].range);
  const frozen = await range();
  expect(frozen).not.toBeNull();
  await new Promise((r) => setTimeout(r, 50));
  await broker.publish('hall/temp', '99');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.plots.points('hall/temp', null).length)).toBe(2);
  await page.mouse.move(5, 5);
  await page.evaluate(() => window.__mqttscope.plots.redraw());
  expect(await range()).toEqual(frozen);
  await expect(page.locator('.plot-card .legend-value')).toHaveText('21');
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Resume' }).click();
  await expect(page.locator('.plot-card .legend-value')).toHaveText('99');
  expect(errors).toEqual([]);
});
