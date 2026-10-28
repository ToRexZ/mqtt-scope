// A plot popped out into its own window: live data, its own controls
// (Space freezes, dragging zooms, Esc and double-click reset), and it closes
// with its main window.

import { test, expect, makeUserData, profile, connect, waitForTopic, until } from './fixtures.mjs';

async function openPlotWindow(env) {
  const broker = await env.broker();
  for (let i = 0; i < 12; i++) {
    await broker.publish('hall/temp', String(20 + (i % 4)), { retain: i === 11 });
    await new Promise((r) => setTimeout(r, 40));
  }
  const ctx = await env.launch({ userData: makeUserData({ profiles: [profile(broker.port)] }) });
  await connect(ctx.page);
  await waitForTopic(ctx.page, 'hall/temp');
  for (let i = 0; i < 12; i++) {
    await broker.publish('hall/temp', String(20 + (i % 4)));
    await new Promise((r) => setTimeout(r, 40));
  }
  await until(() => ctx.page.evaluate(() => window.__mqttscope.tree.find('hall/temp').history.length >= 13), { message: 'history' });
  await ctx.page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'hall/temp', null, { alias: 'Temperature' }));
  await ctx.page.locator('.right-tabs .tab[data-tab="plots"]').click();
  const opened = ctx.app.waitForEvent('window');
  await ctx.page.locator('.plot-card .popout-btn').click();
  const win = await opened;
  // Headless windows open at their minimum size; a desktop window is 1100×650.
  await win.setViewportSize({ width: 1100, height: 650 });
  await win.waitForFunction(() => !!window.__plotWindow);
  return { broker, win, ...ctx };
}

test('it starts with the points collected so far and shows the latest value', async ({ env }) => {
  const { broker, win, page, errors } = await openPlotWindow(env);
  const inMain = await page.evaluate(() => window.__mqttscope.plots.points('hall/temp', null).length);
  expect(await win.evaluate(() => window.__plotWindow.data.points('hall/temp', null).length)).toBe(inMain);
  await expect(win.locator('.legend-label')).toHaveText('Temperature');
  await expect(win.locator('.legend-value')).toHaveText('23');
  await expect(win).toHaveTitle(`Test broker ${broker.port} — Temperature`);
  expect(errors).toEqual([]);
});

test('Space freezes and resumes; dragging zooms; Esc and double-click go back to live', async ({ env }) => {
  const { win, errors } = await openPlotWindow(env);
  const freeze = win.locator('.freeze-btn');
  await win.locator('.plot-title').click();
  await win.keyboard.press('Space');
  await expect(freeze).toHaveText('Resume');
  await win.keyboard.press('Space');
  await expect(freeze).toHaveText('Freeze');

  const canvas = win.locator('canvas');
  const zoomIn = async () => {
    const c = await canvas.boundingBox();
    const g = await win.evaluate(() => window.__plotWindow.chart.geom);
    await win.mouse.move(c.x + g.left + (g.right - g.left) * 0.25, c.y + g.y.top + 10);
    await win.mouse.down();
    await win.mouse.move(c.x + g.left + (g.right - g.left) * 0.75, c.y + g.y.bottom - 10, { steps: 6 });
    await win.mouse.up();
    return g;
  };
  const before = await zoomIn();
  await expect(win.locator('.reset-view')).toBeVisible();
  const range = await win.evaluate(() => window.__plotWindow.chart.range);
  expect(range.t1 - range.t0).toBeLessThan((before.t1 - before.t0) * 0.6);
  expect(await win.evaluate(() => window.__plotWindow.chart.axis.yMin)).toBeGreaterThan(before.y.min);
  await win.keyboard.press('Escape');
  await expect(win.locator('.reset-view')).toBeHidden();
  expect(await win.evaluate(() => window.__plotWindow.chart.axis.yMin)).toBeNull();

  await zoomIn();
  await canvas.dblclick();
  await expect(win.locator('.reset-view')).toBeHidden();
  expect(errors).toEqual([]);
});

test('its Lines/States and time window only change this window', async ({ env }) => {
  const { win, page, errors } = await openPlotWindow(env);
  await win.locator('.kind-toggle .seg-btn[data-kind="states"]').click();
  await expect(win.locator('.plot-card')).toHaveClass(/kind-states/);
  await expect(win.locator('.plot-legend')).toBeHidden();
  await win.locator('.window-select').selectOption('60');
  expect(await win.evaluate(() => [window.__plotWindow.plot.kind, window.__plotWindow.plot.windowSec])).toEqual(['states', 60]);
  expect(await page.evaluate(() => [window.__mqttscope.plots.plots[0].kind, window.__mqttscope.plots.plots[0].windowSec])).toEqual(['timeseries', 300]);
  expect(errors).toEqual([]);
});

test('it closes with its main window', async ({ env }) => {
  const { app, win } = await openPlotWindow(env);
  const closed = win.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html')).close());
  await closed;
});

test('the Close tab key (Ctrl+W) closes the plot window, not a tab', async ({ env }) => {
  const { app, win, page, errors } = await openPlotWindow(env);
  const closed = win.waitForEvent('close');
  await win.locator('.plot-title').click();
  await win.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+w`).catch(() => {}); // gone before the key comes up
  await closed;
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(await page.evaluate(() => window.__mqttscope.shell.tabs.map((t) => t.status.state))).toEqual(['connected']);
  expect(errors).toEqual([]);
});

test('Reload (Ctrl+R) in the main window starts the pop-out over too', async ({ env }) => {
  const { win, page, broker } = await openPlotWindow(env);
  const count = () => win.evaluate(() => window.__plotWindow.data.points('hall/temp', null).length);
  expect(await count()).toBeGreaterThan(0);
  await page.locator('.plots-hint').click();
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+r`);
  await expect.poll(count).toBe(0);
  await broker.publish('hall/temp', '40');
  await expect.poll(count).toBe(1);
});

test('its Hold key follows the user’s key bindings', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('hall/temp', '21', { retain: true });
  const userData = makeUserData({ profiles: [profile(broker.port)], settings: { keys: { hold: 'H' } } });
  const { app, page } = await env.launch({ userData });
  await connect(page);
  await waitForTopic(page, 'hall/temp');
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'hall/temp', null));
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  const opened = app.waitForEvent('window');
  await page.locator('.plot-card .popout-btn').click();
  const win = await opened;
  await win.setViewportSize({ width: 1100, height: 650 });
  await win.waitForFunction(() => !!window.__plotWindow);
  await win.locator('.plot-title').click();
  await win.keyboard.press('Space');
  await expect(win.locator('.freeze-btn')).toHaveText('Freeze');
  await win.keyboard.press('h');
  await expect(win.locator('.freeze-btn')).toHaveText('Resume');
});
