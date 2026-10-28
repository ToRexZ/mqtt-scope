// Reopening tabs on launch (Settings → General → Reopen tabs on launch, on by
// default): windows come back with their tabs, bounds and active tab; and the
// question when a window with several connections closes while it is off.

import path from 'node:path';
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, makeUserData, profile, connect, openTabTo, activeTabName, waitForFile, waitForLayout, readJson, toast } from './fixtures.mjs';

const tabNames = (page) => page.locator('.conn-tab .conn-tab-name');
const tabEl = (page, name) => page.locator('.conn-tab').filter({ has: page.locator('.conn-tab-name').getByText(name, { exact: true }) });
// Each tab's mode and connection state, in strip order.
const tabStates = (page) => page.evaluate(() => window.__mqttscope.shell.tabs.map((t) => `${t.label}: ${t.mode} ${t.status.state}`));
const openProfiles = (app) => app.evaluate(() => globalThis.__mqttscopeConnections.openProfileIds().sort());
const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const stateFile = (userData) => path.join(userData, 'windowState.json');
const writeState = (userData, windows) => writeFileSync(stateFile(userData), JSON.stringify({ version: 1, windows }));
const saved = (profileId, connected = true) => ({ profileId, connected });

// The headless display is 1×1 px unless told otherwise, and windows opened on
// it shrink to fit (then grow to their minimum size).
const launch = (env, userData) => env.launch({ userData, args: ['--ozone-override-screen-size=2560,1440'] });
const FULL_SCREEN_PROBE = fileURLToPath(new URL('../helpers/fullScreenProbe.cjs', import.meta.url));

// Brokers A, B and C with a profile each (ids a, b, c).
async function threeBrokers(env, settings) {
  const brokers = [await env.broker(), await env.broker(), await env.broker()];
  const profiles = brokers.map((b, i) => profile(b.port, { id: 'abc'[i], name: `Broker ${'ABC'[i]}` }));
  return { brokers, userData: makeUserData({ profiles, settings }) };
}

// File → New Window: a window with a New connection tab.
async function openWindow(app) {
  const next = app.waitForEvent('window');
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File');
    file.submenu.items.find((i) => i.label === 'New Window').click();
  });
  const page = await next;
  await page.waitForFunction(() => !!window.__mqttscope);
  await page.waitForSelector('.conn-dialog');
  return page;
}

// Every main window of a launch, once each has its tabs.
async function mainWindows(app, count) {
  await expect.poll(() => app.windows().length).toBe(count);
  const pages = app.windows();
  for (const p of pages) await p.waitForFunction(() => !!window.__mqttscope);
  return pages;
}

// Picks a profile in the active tab's connection dialog and connects it.
async function connectTo(page, name) {
  const dlg = page.locator('.conn-dialog');
  await dlg.locator('.conn-item').filter({ has: page.locator('.conn-name').getByText(name, { exact: true }) }).click();
  await dlg.locator('.connect-btn').click();
  await page.waitForFunction(() => window.__mqttscope.status.state === 'connected', null, { timeout: 10000 });
}

// The main window whose active tab is `name` (its title follows that tab).
const boundsOf = (app, name) => app.evaluate(({ BrowserWindow }, n) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === `MQTT Scope — ${n}`).getNormalBounds(), name);
const setBounds = (app, name, bounds) =>
  app.evaluate(({ BrowserWindow }, [n, b]) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === `MQTT Scope — ${n}`).setBounds(b), [name, bounds]);
const closeWindow = (app, name) => app.evaluate(({ BrowserWindow }, n) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === `MQTT Scope — ${n}`).close(), name);

// Answers every native message box with the button at `response` and
// records what it asked.
async function answerDialogs(app, response) {
  await app.evaluate(({ dialog }, r) => {
    const asked = (globalThis.__asked ||= []);
    dialog.showMessageBox = async (...args) => {
      const { message, buttons } = args.find((a) => a && typeof a === 'object' && 'message' in a);
      asked.push({ message, buttons });
      return { response: r };
    };
  }, response);
}
const asked = (app) => app.evaluate(() => globalThis.__asked || []);

test('tabs come back after a relaunch, a disconnected one stays disconnected', async ({ env }) => {
  const { userData } = await threeBrokers(env);
  const first = await launch(env, userData);
  let { app, page } = first;
  await connect(page); // Broker A
  const idB = await openTabTo(page, 'Broker B');
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'b/temp', null, { alias: 'B temp', quiet: true }));
  await waitForLayout(userData, 'b', (d) => d.tabs[0].plots.length === 1);
  await page.locator('#btn-disconnect').click(); // the user disconnects B
  await expect(page.locator('#btn-disconnect')).toHaveText('Reconnect');
  await openTabTo(page, 'Broker C');
  await page.click('.tab-new'); // a New connection tab is not reopened
  await expect(tabNames(page)).toHaveText(['Broker A', 'Broker B', 'Broker C', 'New connection']);
  await page.locator(`.conn-tab[data-id="${idB}"]`).click();
  await expect(activeTabName(page)).toHaveText('Broker B');
  const bounds = { x: 40, y: 30, width: 1300, height: 900 };
  await setBounds(app, 'Broker B', bounds);
  // Saved soon after each change, not only on quit.
  await waitForFile(stateFile(userData), (b) => {
    const [w] = JSON.parse(b).windows;
    return w.active === 1 && w.tabs.length === 3 && w.bounds.width === bounds.width;
  });
  expect(readJson(stateFile(userData))).toEqual({ version: 1, windows: [{ bounds, tabs: [saved('a'), saved('b', false), saved('c')], active: 1 }] });
  expect(first.errors).toEqual([]);
  await env.closeApp(first);

  const second = await launch(env, userData);
  ({ app, page } = second);
  await expect(tabNames(page)).toHaveText(['Broker A', 'Broker B', 'Broker C']);
  await expect(activeTabName(page)).toHaveText('Broker B');
  expect(await boundsOf(app, 'Broker B')).toEqual(bounds);
  await expect.poll(() => tabStates(page)).toEqual(['Broker A: session connected', 'Broker B: session disconnected', 'Broker C: session connected']);
  // B shows its session, its plots and Reconnect; it has not connected.
  await expect(page.locator('.conn-dialog')).toHaveCount(0);
  await expect(page.locator('#btn-disconnect')).toHaveText('Reconnect');
  await expect(page.locator('#status-text')).toHaveText('Disconnected');
  await expect(tabEl(page, 'Broker B')).toHaveAttribute('data-state', 'disconnected');
  await expect(page.locator('#plot-count')).toHaveText('1');
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  await expect(page.locator('.plot-card .legend-label')).toHaveText(['B temp']);

  // B's profile is open all the same: it cannot be deleted, and opening it
  // again shows its tab.
  expect(await openProfiles(app)).toEqual(['a', 'b', 'c']);
  await tabEl(page, 'Broker A').click();
  await page.click('.tab-new');
  const dlg = page.locator('.conn-dialog');
  await dlg.locator('.conn-item').filter({ has: page.locator('.conn-name').getByText('Broker B', { exact: true }) }).click();
  await expect(dlg.getByRole('button', { name: 'Delete' })).toBeDisabled();
  await expect(dlg.getByRole('button', { name: 'Delete' })).toHaveAttribute('title', 'Close its tab first');
  await dlg.locator('.connect-btn').click();
  await expect(tabNames(page)).toHaveText(['Broker A', 'Broker B', 'Broker C']);
  await expect(activeTabName(page)).toHaveText('Broker B');

  await page.locator('#btn-disconnect').click(); // Reconnect
  await expect.poll(() => tabStates(page)).toEqual(['Broker A: session connected', 'Broker B: session connected', 'Broker C: session connected']);
  await expect(page.locator('.plot-card .legend-label')).toHaveText(['B temp']);
  expect(second.errors).toEqual([]);
});

test('with the setting off the app starts with one New connection tab', async ({ env }) => {
  const { userData } = await threeBrokers(env);
  const first = await launch(env, userData);
  const { page } = first;
  await connect(page);
  await openTabTo(page, 'Broker B');
  await page.locator('#btn-settings').click();
  const box = page.locator('.modal.settings label.check').filter({ hasText: 'Reopen tabs on launch' }).locator('input[name="restoreTabs"]');
  await expect(box).toBeChecked();
  await box.uncheck();
  await page.locator('.modal.settings').getByRole('button', { name: 'Save' }).click();
  await waitForFile(path.join(userData, 'settings.json'), (b) => JSON.parse(b).restoreTabs === false);
  expect((await page.evaluate(() => window.__mqttscope.settings)).restoreTabs).toBe(false);
  await env.closeApp(first);

  const { app, page: page2, errors } = await launch(env, userData);
  await expect(tabNames(page2)).toHaveText(['New connection']);
  await expect(page2.locator('.conn-dialog')).toBeVisible();
  expect(await windowCount(app)).toBe(1);
  expect(await openProfiles(app)).toEqual([]);
  // The dialog shows the setting as saved.
  await page2.locator('#btn-settings').click();
  await expect(page2.locator('.modal.settings input[name="restoreTabs"]')).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('a window closed while another stays open does not come back', async ({ env }) => {
  const { userData } = await threeBrokers(env);
  const first = await launch(env, userData);
  let { app } = first;
  await connect(first.page); // Broker A
  const other = await openWindow(app);
  await connectTo(other, 'Broker B');
  await openTabTo(other, 'Broker C');
  const boundsA = { x: 20, y: 30, width: 1100, height: 750 };
  const boundsC = { x: 200, y: 100, width: 1000, height: 700 };
  await setBounds(app, 'Broker A', boundsA);
  await setBounds(app, 'Broker C', boundsC);
  await waitForFile(stateFile(userData), (b) => JSON.parse(b).windows.length === 2 && JSON.parse(b).windows[1].bounds?.x === boundsC.x);
  await env.closeApp(first);

  // Both windows come back, each with its tabs and bounds.
  ({ app } = await launch(env, userData));
  const pages = await mainWindows(app, 2);
  const names = await Promise.all(pages.map((p) => tabNames(p).allTextContents()));
  expect([...names].sort()).toEqual([['Broker A'], ['Broker B', 'Broker C']]);
  expect(await boundsOf(app, 'Broker A')).toEqual(boundsA);
  expect(await boundsOf(app, 'Broker C')).toEqual(boundsC);
  await expect(activeTabName(pages[names.findIndex((n) => n.length === 2)])).toHaveText('Broker C');

  // Closing it (restore is on: it closes without asking) forgets it.
  await answerDialogs(app, 1);
  await expect.poll(() => openProfiles(app)).toEqual(['a', 'b', 'c']);
  await closeWindow(app, 'Broker C');
  await expect.poll(() => windowCount(app)).toBe(1);
  expect(await asked(app)).toEqual([]);
  await waitForFile(stateFile(userData), (b) => JSON.parse(b).windows.length === 1);
  await env.closeApp({ app });

  const last = await launch(env, userData);
  await expect(tabNames(last.page)).toHaveText(['Broker A']);
  expect(await windowCount(last.app)).toBe(1);
  await expect.poll(() => tabStates(last.page)).toEqual(['Broker A: session connected']);
  expect(last.errors).toEqual([]);
});

// The headless platform maximizes but has no full screen: the probe stands
// in for it (see fullScreenProbe.cjs).
test('a maximized or full-screen window comes back so, at its normal bounds', async ({ env }) => {
  const { userData } = await threeBrokers(env);
  const launchProbed = () => env.launch({ userData, args: ['--ozone-override-screen-size=2560,1440'], preload: [FULL_SCREEN_PROBE] });
  const first = await launchProbed();
  let { app } = first;
  await connect(first.page); // Broker A
  const other = await openWindow(app);
  await connectTo(other, 'Broker B');
  const boundsA = { x: 20, y: 30, width: 1100, height: 750 };
  const boundsB = { x: 200, y: 100, width: 1000, height: 700 };
  await setBounds(app, 'Broker A', boundsA);
  await setBounds(app, 'Broker B', boundsB);
  const shape = (n) => app.evaluate(({ BrowserWindow }, t) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === `MQTT Scope — ${t}`);
    return { maximized: w.isMaximized(), fullScreen: w.isFullScreen() };
  }, n);
  await app.evaluate(({ BrowserWindow }) => {
    const byTitle = (t) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === `MQTT Scope — ${t}`);
    byTitle('Broker A').maximize();
    byTitle('Broker B').setFullScreen(true);
  });
  await expect.poll(() => shape('Broker A')).toEqual({ maximized: true, fullScreen: false });
  await expect.poll(() => shape('Broker B')).toEqual({ maximized: false, fullScreen: true });
  await waitForFile(stateFile(userData), (b) => JSON.parse(b).windows.some((w) => w.maximized) && JSON.parse(b).windows.some((w) => w.fullScreen));
  expect(readJson(stateFile(userData)).windows).toEqual([
    { bounds: boundsA, maximized: true, tabs: [saved('a')], active: 0 },
    { bounds: boundsB, fullScreen: true, tabs: [saved('b')], active: 0 },
  ]);
  await env.closeApp(first);

  ({ app } = await launchProbed());
  await mainWindows(app, 2);
  await expect.poll(() => shape('Broker A')).toEqual({ maximized: true, fullScreen: false });
  await expect.poll(() => shape('Broker B')).toEqual({ maximized: false, fullScreen: true });
  expect(await boundsOf(app, 'Broker A')).toEqual(boundsA);
  expect(await boundsOf(app, 'Broker B')).toEqual(boundsB);
});

// As restoreTabs does at launch, for a profile that another tab has open by
// then (another window was quicker): the reopened tab goes, or, as its
// window's only tab, becomes a New connection tab for that profile.
test('a reopened tab whose profile is open already does not stay behind', async ({ env }) => {
  const { userData } = await threeBrokers(env);
  const { app, page, errors } = await launch(env, userData);
  await connectTo(page, 'Broker A');
  const idA = await page.evaluate(() => window.__mqttscope.shell.active.connId);
  await openTabTo(page, 'Broker B');
  const reopen = (p, profileId, how, { only = false } = {}) =>
    p.evaluate(
      async ([id, h, alone]) => {
        const shell = window.__mqttscope.shell;
        const stored = window.__mqttscope.connections.profiles.find((x) => x.id === id);
        const others = shell.tabs.map((t) => t.connId);
        const tab = await shell.openTab({ profile: stored, restored: true, activate: alone });
        if (alone) for (const other of others) await shell.closeTab(other);
        await (h === 'connect' ? tab.connect(stored) : tab.bind());
      },
      [profileId, how, only],
    );
  for (const how of ['connect', 'bind']) {
    await reopen(page, 'a', how);
    expect(await tabStates(page)).toEqual(['Broker A: session connected', 'Broker B: session connected']);
    await expect(activeTabName(page)).toHaveText('Broker A');
    expect(await page.evaluate(() => window.__mqttscope.shell.active.connId)).toBe(idA);
  }
  // It is not one to reopen.
  expect(await page.evaluate(() => window.__mqttscope.shell.reopenClosed())).toBeNull();

  const other = await openWindow(app);
  await reopen(other, 'b', 'connect', { only: true });
  expect(await tabStates(other)).toEqual(['Broker B: picker disconnected']);
  await expect(other.locator('.conn-dialog')).toBeVisible();
  await expect(other.locator('.conn-dialog .conn-item.active .conn-name')).toHaveText('Broker B');
  expect(await openProfiles(app)).toEqual(['a', 'b']);
  // Its dialog connects another profile in it.
  await connectTo(other, 'Broker C');
  expect(await tabStates(other)).toEqual(['Broker C: session connected']);
  expect(errors).toEqual([]);
});

// Two profiles with one client ID on one broker, each reopened in a window
// of its own: one connects; the other says why not and offers its profile in
// the connection dialog.
test('of two reopened tabs with one client ID on a broker, one connects', async ({ env }) => {
  const broker = await env.broker();
  const profiles = ['a', 'b'].map((id) => profile(broker.port, { id, name: `Robot ${id.toUpperCase()}`, clientId: 'robot-1' }));
  const userData = makeUserData({ profiles });
  writeState(userData, [
    { bounds: null, tabs: [saved('a')], active: 0 },
    { bounds: null, tabs: [saved('b')], active: 0 },
  ]);
  const { app } = await launch(env, userData);
  const pages = await mainWindows(app, 2);
  const states = async () => (await Promise.all(pages.map((p) => tabStates(p)))).flat().sort();
  await expect.poll(async () => (await states()).filter((s) => s.endsWith('session connected')).length).toBe(1);
  const all = await states();
  const winner = all.find((s) => s.endsWith('session connected')).split(':')[0];
  const loser = winner === 'Robot A' ? 'Robot B' : 'Robot A';
  expect(all).toEqual([`${loser}: picker disconnected`, `${winner}: session connected`].sort());
  const page = pages[(await Promise.all(pages.map((p) => p.evaluate(() => window.__mqttscope.shell.active.mode)))).indexOf('picker')];
  await expect(toast(page, 'error')).toHaveText([`Client ID “robot-1” is already used by “${winner}” on this broker`]);
  await expect(page.locator('.conn-dialog .conn-item.active .conn-name')).toHaveText(loser);
  expect(broker.aedes.connectedClients).toBe(1);
});

test('restore skips deleted profiles and survives a corrupt state file', async ({ env }) => {
  const broker = await env.broker();
  const userData = makeUserData({ profiles: [profile(broker.port, { id: 'a', name: 'Broker A' })] });
  writeState(userData, [
    // Last placed on a display that is gone (the one there is: 2560×1440).
    { bounds: { x: 4000, y: 10, width: 1200, height: 800 }, tabs: [saved('gone'), saved('a'), saved('also-gone', false)], active: 0 },
    { bounds: null, tabs: [saved('gone')], active: 0 },
  ]);
  const first = await launch(env, userData);
  await expect(tabNames(first.page)).toHaveText(['Broker A']);
  await expect.poll(() => tabStates(first.page)).toEqual(['Broker A: session connected']);
  expect(await windowCount(first.app)).toBe(1);
  // Its size is kept; the system places it, on the display.
  const bounds = await boundsOf(first.app, 'Broker A');
  expect(bounds).toMatchObject({ width: 1200, height: 800 });
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(2560);
  expect(first.errors).toEqual([]);
  await env.closeApp(first);
  expect(readJson(stateFile(userData)).windows.map((w) => w.tabs)).toEqual([[saved('a')]]);

  writeFileSync(stateFile(userData), '{"version": 1, "windows": [{"tabs": [');
  const second = await launch(env, userData);
  await expect(tabNames(second.page)).toHaveText(['New connection']);
  await expect(second.page.locator('.conn-dialog')).toBeVisible();
  expect(readdirSync(userData).filter((f) => f.startsWith('windowState.json.corrupt-'))).toHaveLength(1);
  // The app works on: the tab connects, and what is open is saved again.
  await connect(second.page);
  await waitForFile(stateFile(userData), (b) => JSON.parse(b).windows[0]?.tabs[0]?.profileId === 'a');
  expect(second.errors).toEqual([]);
});

test('an unreachable broker shows its error in its restored tab', async ({ env }) => {
  const broker = await env.broker();
  const userData = makeUserData({ profiles: [profile(broker.port, { id: 'a', name: 'Broker A' })] });
  writeState(userData, [{ bounds: null, tabs: [saved('a')], active: 0 }]);
  await broker.stop();
  const { page, errors } = await launch(env, userData);
  await expect(tabNames(page)).toHaveText(['Broker A']);
  // The session, not the dialog; the error in its status bar, a red dot,
  // while the client keeps retrying.
  await expect(page.locator('.conn-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.__mqttscope.shell.active.mode)).toBe('session');
  await expect(page.locator('#status-text')).toHaveText(new RegExp(`^Error: connect ECONNREFUSED 127\\.0\\.0\\.1:${broker.port}`));
  await expect(tabEl(page, 'Broker A')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#btn-disconnect')).toHaveText('Disconnect');

  // Disconnect, then Reconnect once the broker is back: the Retry.
  await broker.start();
  await page.locator('#btn-disconnect').click();
  await expect(page.locator('#btn-disconnect')).toHaveText('Reconnect');
  await page.locator('#btn-disconnect').click();
  await expect(page.locator('#status-text')).toHaveText(`Connected — mqtt://127.0.0.1:${broker.port}`);
  await expect(tabEl(page, 'Broker A')).toHaveAttribute('data-state', 'connected');
  expect(errors).toEqual([]);
});

test('closing a window with two connected tabs asks when restore is off', async ({ env }) => {
  const { userData } = await threeBrokers(env, { restoreTabs: false });
  const { app, page, errors } = await launch(env, userData);
  await connectTo(page, 'Broker A');
  await openTabTo(page, 'Broker B');
  const other = await openWindow(app); // so that closing the first does not quit
  const question = { message: 'Close 2 connections?', buttons: ['Close', 'Cancel'] };

  // Cancel keeps the window and its connections; the next attempt asks again.
  await answerDialogs(app, 1);
  await closeWindow(app, 'Broker B');
  await expect.poll(() => asked(app)).toEqual([question]);
  expect(await windowCount(app)).toBe(2);
  await expect.poll(() => tabStates(page)).toEqual(['Broker A: session connected', 'Broker B: session connected']);
  await answerDialogs(app, 0);
  await closeWindow(app, 'Broker B');
  await expect.poll(() => windowCount(app)).toBe(1);
  expect(await asked(app)).toEqual([question, question]);
  expect(await openProfiles(app)).toEqual([]);

  // One connection (the other disconnected): no question.
  await connectTo(other, 'Broker A');
  await openTabTo(other, 'Broker B');
  await other.locator('#btn-disconnect').click();
  await expect(other.locator('#btn-disconnect')).toHaveText('Reconnect');
  const third = await openWindow(app);
  await closeWindow(app, 'Broker B');
  await expect.poll(() => windowCount(app)).toBe(1);
  expect(await asked(app)).toHaveLength(2);

  // Quitting never asks (a question would be cancelled and keep the app).
  await connectTo(third, 'Broker A');
  await openTabTo(third, 'Broker B');
  await answerDialogs(app, 1);
  const exited = new Promise((resolve) => app.process().once('exit', () => resolve('exited')));
  await app.evaluate(({ app: a }) => a.quit()).catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(() => resolve('still running'), 8000));
  expect(await Promise.race([exited, timeout])).toBe('exited');
  expect(errors).toEqual([]);
});
