// The update check as the main process wires it: when it may contact
// anything, the state every main window gets, Help → Check for Updates…, the
// release page and the settings switch. A local release server stands in for
// GitHub (MQTTSCOPE_UPDATE_URL); nothing here touches the network.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, makeUserData } from './fixtures.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const release = (version, body = `Notes for ${version}`) => ({ tag_name: `v${version}`, body });
const overrides = (server, extra = {}) => ({ MQTTSCOPE_UPDATE_URL: server.url, ...extra });

const updateState = (page) => page.evaluate(() => window.api.updateState());
const waitForStatus = (page, status) => expect.poll(async () => (await updateState(page)).status).toBe(status);
// One automatic check, through the test handle main sets with MQTTSCOPE_UPDATE_URL.
const tick = (app) => app.evaluate(() => globalThis.__mqttscopeUpdater.tick());

// Records the update:state broadcasts and update:checked results a window gets.
async function recordUpdates(page) {
  await page.evaluate(() => {
    window.__updateStates = [];
    window.__updateChecks = [];
    window.api.onUpdateState((s) => window.__updateStates.push(s));
    window.api.onUpdateChecked((r) => window.__updateChecks.push(r));
  });
}
const broadcasts = (page) => page.evaluate(() => window.__updateStates);
const checkResults = (page) => page.evaluate(() => window.__updateChecks);

// Records every net.fetch call main makes from now on. `block` fails them
// instead, so a test that expects none cannot reach the internet if it is wrong.
async function recordFetches(app, { block = false } = {}) {
  await app.evaluate(({ net }, blocked) => {
    const real = net.fetch;
    globalThis.__fetches = [];
    net.fetch = (url, init) => {
      globalThis.__fetches.push(String(url));
      return blocked ? Promise.reject(new Error('blocked by the test')) : real.call(net, url, init);
    };
  }, block);
  return () => app.evaluate(() => globalThis.__fetches.slice());
}

async function clickMenu(app, menuLabel, itemLabel) {
  await app.evaluate(
    ({ Menu }, [m, i]) =>
      Menu.getApplicationMenu()
        .items.find((x) => x.label === m)
        .submenu.items.find((x) => x.label === i)
        .click(),
    [menuLabel, itemLabel],
  );
}
const checkForUpdates = (app) => clickMenu(app, 'Help', 'Check for Updates…');

async function newWindow(app) {
  const opened = app.waitForEvent('window');
  await clickMenu(app, 'File', 'New Window');
  const page = await opened;
  await page.waitForFunction(() => !!window.__mqttscope);
  return page;
}

// Unpackaged runs (npm start, these tests) never check without the URL override.
async function expectNoContact(env, extraEnv) {
  const { app, page, errors } = await env.launch({ env: extraEnv });
  const fetches = await recordFetches(app, { block: true });
  await recordUpdates(page);
  expect(await updateState(page)).toMatchObject({ status: 'none', kind: 'dev', current: VERSION, latest: null });
  expect(await app.evaluate(() => typeof globalThis.__mqttscopeUpdater)).toBe('undefined');

  // The menu check says so instead of asking; re-enabling the setting asks nothing.
  await checkForUpdates(app);
  await expect.poll(() => checkResults(page)).toEqual([{ result: 'disabled' }]);
  await page.evaluate(() => window.api.storeSet('settings', { checkForUpdates: false }));
  await page.evaluate(() => window.api.storeSet('settings', { checkForUpdates: true }));
  expect(await fetches()).toEqual([]);
  expect(await broadcasts(page)).toEqual([]);
  expect(errors).toEqual([]);
}

test('unpackaged run without override never contacts anything', async ({ env }) => {
  await expectNoContact(env, {});
});

test('unpackaged run with only MQTTSCOPE_UPDATE_KIND set never contacts anything either', async ({ env }) => {
  await expectNoContact(env, { MQTTSCOPE_UPDATE_KIND: 'appimage' });
});

test('override: startup check finds a newer release and every window gets it', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9', 'Fixed things'));
  const { app, page, errors } = await env.launch({ env: overrides(server) });
  await waitForStatus(page, 'available');
  const state = await updateState(page);
  expect(state).toEqual({
    status: 'available',
    current: VERSION,
    kind: 'manual',
    latest: { version: '9.9.9', notes: 'Fixed things' },
    progress: null,
    error: null,
    pacmanCommand: null,
  });
  expect(server.requests()).toBe(1);

  // A window opened later starts from the same state ...
  const page2 = await newWindow(app);
  expect(await updateState(page2)).toEqual(state);

  // ... and every window hears about the next change.
  await recordUpdates(page);
  await recordUpdates(page2);
  server.setRelease(release('9.9.10'));
  await tick(app);
  for (const p of [page, page2]) {
    await expect.poll(async () => (await broadcasts(p)).map((s) => s.latest?.version)).toEqual(['9.9.10']);
  }
  expect(server.requests()).toBe(2);
  expect(errors).toEqual([]);
});

test('Help → Check for Updates reports latest and offline', async ({ env }) => {
  const server = await env.releaseServer(release(VERSION));
  const { app, page, errors } = await env.launch({ env: overrides(server) });
  await expect.poll(() => server.requests()).toBe(1); // the startup check
  await recordUpdates(page);

  const help = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label === 'Help').submenu.items.map((i) => i.label));
  expect(help.indexOf('Check for Updates…')).toBe(help.indexOf('Keyboard Shortcuts…') + 1);

  await checkForUpdates(app);
  await expect.poll(() => checkResults(page)).toEqual([{ result: 'latest' }]);

  server.setRelease(null); // the server answers 503
  await checkForUpdates(app);
  await expect.poll(async () => (await checkResults(page)).at(-1)).toEqual({ result: 'error', error: 'HTTP 503' });

  await server.close(); // nothing listens any more
  await checkForUpdates(app);
  await expect.poll(async () => (await checkResults(page)).length).toBe(3);
  expect((await checkResults(page)).at(-1)).toEqual({ result: 'error', error: expect.stringMatching(/\S/) });

  // Failed checks change nothing.
  expect(await broadcasts(page)).toEqual([]);
  expect((await updateState(page)).status).toBe('none');
  expect(errors).toEqual([]);
});

test('openRelease opens the page main builds', async ({ env }) => {
  const server = await env.releaseServer(release(VERSION));
  const { app, page } = await env.launch({ env: overrides(server) });
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (url) => void globalThis.__opened.push(url);
  });
  const opened = () => app.evaluate(() => globalThis.__opened.slice());
  await expect.poll(() => server.requests()).toBe(1);

  // Nothing to open while there is no newer release.
  await page.evaluate(() => window.api.updateOpenRelease());
  expect(await opened()).toEqual([]);

  server.setRelease(release('9.9.9'));
  await tick(app);
  await waitForStatus(page, 'available');
  await page.evaluate(() => window.api.updateOpenRelease());
  expect(await opened()).toEqual(['https://github.com/ToRexZ/mqtt-scope/releases/tag/v9.9.9']);
});

test('turning the setting back on checks at once; other settings changes do not', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9'));
  const userData = makeUserData({ settings: { checkForUpdates: false } });
  const { app, page } = await env.launch({ userData, env: overrides(server) });
  const fetches = await recordFetches(app);
  const setSettings = (s) => page.evaluate((v) => window.api.storeSet('settings', v), s);

  // Off: neither the startup check nor a later automatic one asks.
  await tick(app);
  expect(server.requests()).toBe(0);
  expect((await updateState(page)).status).toBe('none');

  await setSettings({ checkForUpdates: true });
  await waitForStatus(page, 'available');
  expect(server.requests()).toBe(1);

  // Saving settings that leave it on asks nothing (the check starts while
  // main handles the save, so the fetch count is final once it returns).
  await setSettings({ checkForUpdates: true, historyLimit: 50 });
  expect(await fetches()).toHaveLength(1);

  // Turning it off keeps the notice already shown.
  await setSettings({ checkForUpdates: false });
  expect(await fetches()).toHaveLength(1);
  expect((await updateState(page)).status).toBe('available');
});

test('self-updating build: download, confirm while connected, restart installs (fake engine)', async ({ env }) => {
  const broker = await env.broker();
  const server = await env.releaseServer(release('9.9.9'));
  const { app, page } = await env.connected(broker, { env: overrides(server, { MQTTSCOPE_UPDATE_KIND: 'appimage', MQTTSCOPE_UPDATE_FAKE: '1' }) });
  await waitForStatus(page, 'available');
  expect((await updateState(page)).kind).toBe('appimage');
  await recordUpdates(page);

  await page.evaluate(() => window.api.updateDownload());
  expect((await broadcasts(page)).map((s) => (s.status === 'downloading' ? s.progress : s.status))).toEqual([0, 50, 100, 'ready']);

  const installed = () => app.evaluate(() => globalThis.__updateInstalled === true);
  expect(await page.evaluate(() => window.api.updateRestart(false))).toEqual({ confirm: 1 });
  expect(await installed()).toBe(false);
  expect(await page.evaluate(() => window.api.updateRestart(true))).toEqual({ ok: true });
  expect(await installed()).toBe(true);
});

// The new version starts while this one still closes its windows (each waits
// up to 1.5 s for its flush). It must get the single-instance lock, and this
// one must not open a window for it on the way out.
test('Restart to update hands the single-instance lock to the new version; a failed install keeps it', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9'));
  const userData = makeUserData();
  const updateEnv = overrides(server, { MQTTSCOPE_UPDATE_KIND: 'appimage', MQTTSCOPE_UPDATE_FAKE: '1' });
  const { app, page } = await env.launch({ userData, env: updateEnv });
  await waitForStatus(page, 'available');
  await page.evaluate(() => window.api.updateDownload());
  const hasLock = () => app.evaluate(({ app: a }) => a.hasSingleInstanceLock());
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  // What launching the app again does while this instance holds the lock.
  const launchedAgain = () => app.evaluate(({ app: a }) => void a.emit('second-instance', {}, [], process.cwd(), {}));

  // The install fails: the lock stays, and launching again still opens a window.
  await app.evaluate(() => (globalThis.__updateInstallError = 'mv: cannot move'));
  expect(await page.evaluate(() => window.api.updateRestart(true))).toEqual({ ok: false });
  expect(await updateState(page)).toMatchObject({ status: 'error', error: 'mv: cannot move' });
  expect(await hasLock()).toBe(true);
  await launchedAgain();
  expect(await windowCount()).toBe(2);

  // Retry; this time the install starts and this instance is on its way out.
  await app.evaluate(() => delete globalThis.__updateInstallError);
  await page.evaluate(() => window.api.updateDownload());
  expect(await page.evaluate(() => window.api.updateRestart(true))).toEqual({ ok: true });
  expect(await app.evaluate(() => globalThis.__updateInstalled)).toBe(true);
  expect(await hasLock()).toBe(false);
  await launchedAgain();
  expect(await windowCount()).toBe(2);

  // The relaunched app (same data folder) starts and takes the lock. (Its page
  // waits a few seconds for this instance's browser storage, which a real old
  // version frees by quitting; this one stays up.)
  const next = await env.launch({ userData });
  expect(await next.app.evaluate(({ app: a }) => a.hasSingleInstanceLock())).toBe(true);
});

test('a broadcast to a closed window does not break the others', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9'));
  const userData = makeUserData();
  const { app, page, errors } = await env.launch({ userData, env: overrides(server) });
  await waitForStatus(page, 'available');
  await newWindow(app);
  await recordUpdates(page);
  // The second window goes away right before a change is broadcast. (Main
  // broadcasts in window creation order, which is webContents id order.)
  await app.evaluate(({ BrowserWindow }) => {
    const [, second] = BrowserWindow.getAllWindows().sort((a, b) => a.webContents.id - b.webContents.id);
    second.destroy();
    globalThis.__mqttscopeUpdater.skip();
  });
  await expect.poll(async () => (await broadcasts(page)).map((s) => s.status)).toEqual(['none']);

  // A window that cannot take the message (a destroyed one throws "Object has
  // been destroyed") does not keep the windows after it from hearing it.
  const third = await newWindow(app);
  await recordUpdates(third);
  await app.evaluate(({ BrowserWindow }) => {
    const [first] = BrowserWindow.getAllWindows().sort((a, b) => a.webContents.id - b.webContents.id);
    first.webContents.send = () => {
      throw new Error('Object has been destroyed');
    };
  });
  server.setRelease(release('9.9.10'));
  await tick(app);
  await expect.poll(async () => (await broadcasts(third)).map((s) => s.latest?.version)).toEqual(['9.9.10']);
  const logged = readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  expect(logged).toMatch(/ WARN update could not send the update state: Object has been destroyed/);
  expect(logged).not.toMatch(/ ERROR update/);
  expect(errors).toEqual([]);
});
