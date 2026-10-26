// No menu bar on Linux and Windows: the application menu stays set (its
// accelerators fire Quit, zoom, full screen and dev tools) but is never
// shown, and its Help items live at the bottom of Settings. macOS keeps its
// system menu bar, so these tests do not apply there.

import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
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
  // A pop-out belongs to a connection: the active tab's.
  await page.evaluate(() => window.api.openPopout({ connId: window.__mqttscope.shell.active.connId, topic: 'menu/t', title: 'menu/t', history: [] }));
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

// Electron gives the quit role no accelerator on Windows (Alt+F4 closes the window).
const QUIT = process.platform === 'win32' ? null : expect.stringMatching(/^(CommandOrControl|CmdOrCtrl|Ctrl)\+Q$/);

test('the shortcuts that only exist as menu accelerators are in the (hidden) menu', async ({ env }) => {
  const broker = await env.broker();
  const { app } = await env.connected(broker);
  expect(await accelerators(app)).toEqual({
    quit: QUIT,
    zoomIn: expect.stringMatching(/\+Plus$/),
    zoomOut: expect.stringMatching(/\+-$/),
    resetZoom: expect.stringMatching(/\+0$/),
    fullscreen: 'Shift+F11',
    devTools: expect.stringMatching(/\+I$/),
  });
});

// Native accelerators fire for the window that has focus. The fixtures show
// windows without focusing them, so focus it first.
const focusWindow = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.show();
    w.focus();
  });
const win = (app, fn, arg) => app.evaluate(({ BrowserWindow }, [f, a]) => new Function('w', 'a', `return (${f})(w, a)`)(BrowserWindow.getAllWindows()[0], a), [fn.toString(), arg]);
const zoomLevel = (app) => win(app, (w) => w.webContents.getZoomLevel());

async function expectAcceleratorsWork(app) {
  await focusWindow(app);
  await press(app, 'Plus', ['control']);
  await expect.poll(() => zoomLevel(app)).toBeGreaterThan(0);
  await press(app, '0', ['control']);
  await expect.poll(() => zoomLevel(app)).toBe(0);
  await press(app, '-', ['control']);
  await expect.poll(() => zoomLevel(app)).toBeLessThan(0);
  await press(app, '0', ['control']);
  await expect.poll(() => zoomLevel(app)).toBe(0);
  expect(await barVisible(app)).toEqual([false]);
}

test('zoom in, out and reset keys work with the bar hidden', async ({ env }) => {
  const broker = await env.broker();
  const { app } = await env.connected(broker);
  await expectAcceleratorsWork(app);
});

test('developer tools and full screen keys work with the bar hidden', async ({ env }) => {
  const broker = await env.broker();
  const { app } = await env.connected(broker);
  await focusWindow(app);
  await press(app, 'I', ['control', 'shift']);
  await expect.poll(() => win(app, (w) => w.webContents.isDevToolsOpened())).toBe(true);
  // Press again once the dev tools have loaded: a toggle while they still load is lost.
  await expect.poll(() => win(app, (w) => w.webContents.devToolsWebContents?.isLoading() === false)).toBe(true);
  await press(app, 'I', ['control', 'shift']);
  await expect.poll(() => win(app, (w) => w.webContents.isDevToolsOpened())).toBe(false);
  // Headless windows never really go full screen: watch the request instead.
  await win(app, (w) => {
    globalThis.__fullScreen = [];
    w.setFullScreen = (on) => globalThis.__fullScreen.push(on);
  });
  await press(app, 'F11', ['shift']);
  await expect.poll(() => app.evaluate(() => globalThis.__fullScreen)).toEqual([true]);
});

test('the quit key asks the app to quit', async ({ env }) => {
  test.skip(process.platform === 'win32', 'no quit accelerator on Windows: Alt+F4 closes the window');
  const broker = await env.broker();
  const { app } = await env.connected(broker);
  await app.evaluate(({ app: electronApp }) => {
    globalThis.__quitAsked = 0;
    electronApp.once('before-quit', (e) => {
      e.preventDefault(); // the test app keeps running
      globalThis.__quitAsked++;
    });
  });
  await focusWindow(app);
  await press(app, 'Q', ['control']);
  await expect.poll(() => app.evaluate(() => globalThis.__quitAsked)).toBe(1);
});

test('rebinding a shortcut keeps the bar hidden and the menu accelerators working', async ({ env }) => {
  const broker = await env.broker();
  const { app, page } = await env.connected(broker);
  await page.locator('#btn-settings').click();
  const dlg = page.locator('.modal.settings');
  await dlg.getByRole('button', { name: 'Keyboard', exact: true }).click();
  const row = dlg.locator('.keys-row[data-action="hold"]');
  await row.locator('.key-combo').click();
  await page.keyboard.press('h');
  await expect(row.locator('.key-combo')).toHaveText('H');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(dlg).toHaveCount(0);
  // The menu was rebuilt with the new key (and so was every window's menu).
  await expect
    .poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label === 'View').submenu.items.find((i) => i.label.startsWith('Hold')).accelerator))
    .toBe('H');
  expect(await barVisible(app)).toEqual([false]);
  await expectAcceleratorsWork(app);
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
  await expect(toast(page, 'error')).toHaveCount(0);

  // Check for updates answers with a toast above the dialog; this development build does not check.
  await footer.getByRole('button', { name: 'Check for updates' }).click();
  await expect(toast(page, 'info').filter({ hasText: 'Update checks are off in development builds' })).toBeVisible();
  await expect(dlg).toBeVisible(); // stays open, with its edits
});

test('Settings footer: failing to open the data folder or the log file is a toast', async ({ env }) => {
  const broker = await env.broker();
  const { app, page, userData } = await env.connected(broker);
  await app.evaluate(({ shell }) => {
    shell.openPath = async () => 'No application is associated with this folder';
    shell.showItemInFolder = () => {
      throw new Error('file manager crashed');
    };
  });
  await page.locator('#btn-settings').click();
  const footer = page.locator('.modal.settings .settings-footer');

  await footer.getByRole('button', { name: 'Open data folder' }).click();
  await expect(toast(page, 'error').filter({ hasText: "Couldn't open the data folder: No application is associated with this folder" })).toBeVisible();

  await footer.getByRole('button', { name: 'Show log file' }).click();
  await expect(toast(page, 'error').filter({ hasText: "Couldn't open the log file: file manager crashed" })).toBeVisible();

  // No log file (yet): say so, do not open anything.
  rmSync(path.join(userData, 'logs', 'main.log'), { force: true });
  await app.evaluate(({ shell }) => {
    globalThis.__opened = 0;
    shell.showItemInFolder = () => globalThis.__opened++;
  });
  await footer.getByRole('button', { name: 'Show log file' }).click();
  await expect(toast(page, 'error').filter({ hasText: "Couldn't open the log file: there is no log file yet" })).toBeVisible();
  expect(await app.evaluate(() => globalThis.__opened)).toBe(0);
});

test('Check for updates is busy while it runs, so a double click asks once', async ({ env }) => {
  const server = await env.releaseServer({ tag_name: `v${VERSION}`, body: '' });
  const { app, page } = await env.launch({ env: { MQTTSCOPE_UPDATE_URL: server.url } });
  await expect.poll(() => server.requests()).toBe(1); // the startup check
  // Hold the answer to see the busy state.
  await app.evaluate(() => {
    const u = globalThis.__mqttscopeUpdater;
    const check = u.check.bind(u);
    globalThis.__checks = 0;
    u.check = async (...args) => {
      globalThis.__checks++;
      await new Promise((resolve) => (globalThis.__release = resolve));
      return check(...args);
    };
  });
  await page.locator('#btn-settings').click();
  const button = page.locator('.modal.settings .settings-footer').getByRole('button', { name: /^Check/ });
  await button.dblclick();
  await expect(button).toHaveText('Checking…');
  await expect(button).toBeDisabled();
  expect(await app.evaluate(() => globalThis.__checks)).toBe(1);
  await app.evaluate(() => globalThis.__release());
  await expect(button).toHaveText('Check for updates');
  await expect(button).toBeEnabled();
  await expect(toast(page, 'info').filter({ hasText: "You're on the latest version" })).toBeVisible();
  expect(server.requests()).toBe(2);

  // A failed call restores the button too.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('app:checkForUpdates');
    ipcMain.handle('app:checkForUpdates', () => {
      throw new Error('boom');
    });
  });
  await button.click();
  await expect(toast(page, 'error').filter({ hasText: "Couldn't check for updates:" })).toBeVisible();
  await expect(button).toHaveText('Check for updates');
  await expect(button).toBeEnabled();
});

test('Settings fits the smallest window on both tabs and lists the fixed shortcuts', async ({ env }) => {
  const broker = await env.broker();
  const { page } = await env.connected(broker);
  await page.setViewportSize({ width: 900, height: 600 });
  await page.locator('#btn-settings').click();
  const dlg = page.locator('.modal.settings');
  const inside = async () => {
    const r = await dlg.evaluate((d) => {
      const b = d.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: innerWidth, h: innerHeight };
    });
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.bottom).toBeLessThanOrEqual(r.h);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(r.w);
    // Footer and buttons stay in view whatever the page above holds.
    for (const name of ['Save', 'Check for updates']) await expect(dlg.getByRole('button', { name })).toBeInViewport({ ratio: 1 });
  };
  await inside();
  await dlg.getByRole('button', { name: 'Keyboard', exact: true }).click();
  await inside();

  // Fixed shortcuts: read-only rows, marked as not rebindable, no key-recording button.
  const fixed = dlg.locator('.keys-fixed .keys-row');
  const quit = process.platform === 'win32' ? 'Alt+F4' : 'Ctrl+Q';
  await expect(fixed.locator('.keys-label')).toHaveText(['Zoom in', 'Zoom out', 'Reset zoom', 'Full screen', 'Developer tools', 'Quit']);
  await expect(fixed.locator('.keys-fixed-combo')).toHaveText(['Ctrl+Plus', 'Ctrl+Minus', 'Ctrl+0', 'Shift+F11', 'Ctrl+Shift+I', quit]);
  await expect(dlg.locator('.keys-fixed')).toContainText('not rebindable');
  await expect(dlg.locator('.keys-fixed button')).toHaveCount(0);
  // The rebindable rows are unchanged.
  await expect(dlg.locator('.keys-table .keys-row[data-action]').first()).toHaveAttribute('data-action', 'connections');
  // The last fixed row can be scrolled to.
  await fixed.last().scrollIntoViewIfNeeded();
  await expect(fixed.last()).toBeInViewport();
});
