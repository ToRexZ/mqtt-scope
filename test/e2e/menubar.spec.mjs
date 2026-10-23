// No menu bar on Linux and Windows: the application menu stays set (its
// accelerators fire Quit, zoom, full screen and dev tools) but is never
// shown, and its Help items live at the bottom of Settings. macOS keeps its
// system menu bar, so these tests do not apply there.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { test, expect, toast } from './fixtures.mjs';

test.skip(process.platform === 'darwin', 'macOS keeps its system menu bar');

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

// A key as the renderer's host sees it, from outside the page (the way the
// native accelerators get it).
const press = (app, keyCode, modifiers = []) =>
  app.evaluate(
    ({ BrowserWindow }, [k, m]) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
      wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
    },
    [keyCode, modifiers],
  );
const barVisible = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isMenuBarVisible()));

test('no menu bar, also after Alt, F10 and Alt+F; popped-out windows too', async ({ env }) => {
  const broker = await env.broker();
  const { app, page } = await env.connected(broker);
  expect(await barVisible(app)).toEqual([false]);
  for (const [key, mods] of [['Alt', []], ['F', ['alt']], ['F10', []], ['Alt', ['shift']]]) {
    await press(app, key, mods);
    expect(await barVisible(app)).toEqual([false]);
  }
  // The window's menu is still set, so its accelerators have something to fire.
  expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.label))).toContain('View');

  const popped = app.waitForEvent('window');
  await page.evaluate(() => window.api.openPopout('menu/t', []));
  await popped;
  await expect.poll(async () => (await barVisible(app)).length).toBe(2);
  for (const bar of await barVisible(app)) expect(bar).toBe(false);
});

// What the menu fires, by role. A hidden menu still owns these accelerators.
const accelerators = (app) =>
  app.evaluate(({ Menu }) => {
    const flat = (items) => items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu.items) : [])]);
    const items = flat(Menu.getApplicationMenu().items);
    const acc = (role) => items.find((i) => i.role?.toLowerCase() === role)?.accelerator ?? null;
    return { quit: acc('quit'), zoomIn: acc('zoomin'), zoomOut: acc('zoomout'), resetZoom: acc('resetzoom'), fullscreen: acc('togglefullscreen'), devTools: acc('toggledevtools') };
  });

test('the shortcuts that only exist as menu accelerators are still in the (hidden) menu', async ({ env }) => {
  const broker = await env.broker();
  const { app } = await env.connected(broker);
  expect(await accelerators(app)).toEqual({
    quit: expect.stringMatching(/^(CommandOrControl|CmdOrCtrl|Ctrl)\+Q$/),
    zoomIn: expect.stringMatching(/\+Plus$/),
    zoomOut: expect.stringMatching(/\+-$/),
    resetZoom: expect.stringMatching(/\+0$/),
    fullscreen: 'Shift+F11',
    devTools: expect.stringMatching(/\+I$/),
  });
});

// Native accelerators need a real window (headless Chromium has no native
// key handling). MQTTSCOPE_E2E_HEADED=1 npx playwright test menubar
test('headed: zoom, dev tools and full screen keys work with the bar hidden', async ({ env }) => {
  test.skip(!process.env.MQTTSCOPE_E2E_HEADED, 'needs a visible window');
  const broker = await env.broker();
  const { app } = await env.connected(broker);
  const wc = (fn, arg) => app.evaluate(({ BrowserWindow }, [f, a]) => new Function('w', 'a', `return (${f})(w, a)`)(BrowserWindow.getAllWindows()[0], a), [fn.toString(), arg]);
  await new Promise((r) => setTimeout(r, 1500));
  await press(app, 'Plus', ['control']);
  await expect.poll(() => wc((w) => w.webContents.getZoomLevel())).toBeGreaterThan(0);
  await press(app, '0', ['control']);
  await expect.poll(() => wc((w) => w.webContents.getZoomLevel())).toBe(0);
  await press(app, 'Plus', ['control', 'shift']);
  await press(app, '-', ['control']);
  await expect.poll(() => wc((w) => w.webContents.getZoomLevel())).toBe(0);
  await press(app, 'I', ['control', 'shift']);
  await expect.poll(() => wc((w) => w.webContents.isDevToolsOpened())).toBe(true);
  await press(app, 'F11', ['shift']);
  await expect.poll(() => wc((w) => w.isFullScreen())).toBe(true);
  for (const key of ['Alt', 'F10']) {
    await press(app, key);
    expect(await barVisible(app)).toEqual([false]);
  }
});

test('Settings footer: Check for updates, Show log file and Open data folder', async ({ env }) => {
  const broker = await env.broker();
  const { app, page, userData } = await env.connected(broker);
  await app.evaluate(({ shell }) => {
    globalThis.__shell = [];
    shell.openPath = async (p) => {
      globalThis.__shell.push(['openPath', p]);
      return '';
    };
    shell.showItemInFolder = (p) => void globalThis.__shell.push(['showItemInFolder', p]);
  });
  const calls = () => app.evaluate(() => globalThis.__shell);

  await page.locator('#btn-settings').click();
  const dlg = page.locator('.modal.settings');
  const footer = dlg.locator('.settings-footer');
  await expect(footer.locator('.settings-version')).toHaveText(`MQTT Scope ${VERSION}`);
  await expect(footer.locator('button')).toHaveText(['Check for updates', 'Show log file', 'Open data folder']);

  await footer.getByRole('button', { name: 'Open data folder' }).click();
  await expect.poll(calls).toEqual([['openPath', userData]]);
  await footer.getByRole('button', { name: 'Show log file' }).click();
  await expect.poll(async () => (await calls()).at(-1)).toEqual(['showItemInFolder', path.join(userData, 'logs', 'main.log')]);

  // Check for updates answers with a toast above the dialog; this development build does not check.
  await footer.getByRole('button', { name: 'Check for updates' }).click();
  await expect(toast(page, 'info').filter({ hasText: 'Update checks are off in development builds' })).toBeVisible();
  await expect(dlg).toBeVisible(); // stays open, with its edits
});
