// The update check as the main process wires it (when it may contact
// anything, the state every main window gets, Help → Check for Updates…, the
// release page and the settings switch), then the top-bar button and panel
// that show it, and the Installing dialog of Restart to update. A local
// release server stands in for GitHub (MQTTSCOPE_UPDATE_URL); nothing here
// touches the network.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, makeUserData, toast, clipboard, waitForFile } from './fixtures.mjs';

const { pacmanCommand } = createRequire(import.meta.url)('../../main/updateCheck.js');

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

// The AppImage's menu entry (main/desktopIntegration.js) is for packaged
// builds only: these tests never write into a home folder. (No system data
// dirs, so an installed MQTT Scope cannot be why nothing is written.) The
// data folder itself may appear: without a ~/.pki, Chromium keeps its NSS
// database in $XDG_DATA_HOME/pki/nssdb (as on a fresh CI runner).
test('unpackaged run reported as an AppImage adds no menu entry', async ({ env }) => {
  const server = await env.releaseServer(release(VERSION));
  const userData = makeUserData();
  const dataHome = path.join(userData, 'share');
  const appImage = { APPIMAGE: '/nowhere/MQTT-Scope.AppImage', XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: path.join(userData, 'none') };
  const { page } = await env.launch({ userData, env: overrides(server, { MQTTSCOPE_UPDATE_KIND: 'appimage', ...appImage }) });
  expect((await updateState(page)).kind).toBe('appimage');
  const found = existsSync(dataHome) ? readdirSync(dataHome, { recursive: true }).map((f) => f.split(path.sep).join('/')) : [];
  const ours = found.filter((f) => /^(applications|icons)(\/|$)/.test(f));
  expect(ours, `share/ holds: ${found.join(', ') || 'nothing'}`).toEqual([]);
});

test('override: startup check finds a newer release and every window gets it', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9', 'Fixed things'));
  const { app, page, userData, errors } = await env.launch({ env: overrides(server) });
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

  // The log says how this build updates, and each version once when found.
  const logged = readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  expect(logged.match(/ INFO update .*/g)).toEqual([' INFO update install kind: manual', ' INFO update 9.9.9 is available', ' INFO update 9.9.10 is available']);
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

test('self-updating build: download, confirm while connected or reconnecting, restart installs (fake engine)', async ({ env }) => {
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

  // A broker that went away while the app keeps reconnecting counts too.
  await broker.close();
  await page.waitForFunction(() => ['offline', 'reconnecting', 'error'].includes(window.__mqttscope.status.state));
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
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  };
  const second = await newWindow(app);
  watch(second);
  await recordUpdates(second);
  const logged = () => readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  // Main broadcasts in window creation order (webContents id order). The
  // first window goes away right before a change is broadcast: it is skipped,
  // not sent to, and the second still hears it.
  await app.evaluate(({ BrowserWindow }) => {
    const [first] = BrowserWindow.getAllWindows().sort((a, b) => a.webContents.id - b.webContents.id);
    first.destroy();
    globalThis.__mqttscopeUpdater.skip();
  });
  await expect.poll(async () => (await broadcasts(second)).map((s) => s.status)).toEqual(['none']);
  expect(logged()).not.toMatch(/could not send the update state/);

  // A window that cannot take the message (a destroyed one throws "Object has
  // been destroyed") does not keep the windows after it from hearing it.
  const third = await newWindow(app);
  watch(third);
  await recordUpdates(third);
  await app.evaluate(({ BrowserWindow }) => {
    const [first] = BrowserWindow.getAllWindows().sort((a, b) => a.webContents.id - b.webContents.id);
    globalThis.__realSend = first.webContents.send;
    first.webContents.send = () => {
      throw new Error('Object has been destroyed');
    };
  });
  try {
    server.setRelease(release('9.9.10'));
    await tick(app);
    await expect.poll(async () => (await broadcasts(third)).map((s) => s.latest?.version)).toEqual(['9.9.10']);
  } finally {
    // Its flush request on close must reach it, or closing the app throws.
    await app.evaluate(({ BrowserWindow }) => {
      const [first] = BrowserWindow.getAllWindows().sort((a, b) => a.webContents.id - b.webContents.id);
      first.webContents.send = globalThis.__realSend;
    });
  }
  expect(logged()).toMatch(/ WARN update could not send the update state: Object has been destroyed/);
  expect(logged()).not.toMatch(/ ERROR update/);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------ top-bar button and panel

const SELF_UPDATING = { MQTTSCOPE_UPDATE_KIND: 'appimage', MQTTSCOPE_UPDATE_FAKE: '1' };
const releasePage = (version) => `https://github.com/ToRexZ/mqtt-scope/releases/tag/v${version}`;

const updateButton = (page) => page.locator('#btn-update');
const panel = (page) => page.locator('#update-panel');
const panelButton = (page, name) => panel(page).getByRole('button', { name, exact: true });
// Every button the panel shows: the actions, then the footer links.
const panelButtons = (page) => panel(page).getByRole('button');
const notes = (page) => panel(page).locator('.update-notes');

// A window without a connection starts with the (modal) connection dialog.
async function closeConnectionDialog(page) {
  await page.locator('.conn-dialog .modal-close').click();
  await expect(page.locator('.modal-overlay')).toHaveCount(0);
}

async function openPanel(page) {
  await updateButton(page).click();
  await expect(panel(page)).toBeVisible();
}

// The fake engine's gate (main/updateEngine.js): a download started while
// held stops at 50 % until released.
const holdDownloads = (app) =>
  app.evaluate(() => {
    globalThis.__updateDownloadHold = new Promise((resolve) => (globalThis.__releaseDownloads = resolve));
  });
const releaseDownloads = (app) =>
  app.evaluate(() => {
    delete globalThis.__updateDownloadHold;
    globalThis.__releaseDownloads();
  });
const installed = (app) => app.evaluate(() => globalThis.__updateInstalled === true);

const installingDialog = (page, version = '9.9.9') => page.getByRole('dialog', { name: `Installing MQTT Scope ${version}`, exact: true });

// Records every time the Installing dialog opens or closes.
async function recordInstalling(page) {
  await page.evaluate(() => {
    window.__installingLog = [];
    let shown = false;
    new MutationObserver(() => {
      const now = !!document.querySelector('.installing-overlay');
      if (now === shown) return;
      shown = now;
      window.__installingLog.push(now ? 'shown' : 'hidden');
    }).observe(document.body, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => window.__installingLog.slice());
}

// The Installing dialog's bar: its running CSS animations and three samples
// of what they animate, 200 ms apart.
const installingBar = (page) =>
  page.evaluate(async () => {
    const fill = document.querySelector('.installing-overlay .installing-bar-fill');
    const samples = [];
    for (let i = 0; i < 3; i++) {
      if (i) await new Promise((resolve) => setTimeout(resolve, 200));
      const { transform, opacity } = getComputedStyle(fill);
      samples.push({ transform, opacity });
    }
    const animations = fill.getAnimations().map((a) => ({ name: a.animationName, playState: a.playState }));
    return { animations, transforms: [...new Set(samples.map((x) => x.transform))], opacities: [...new Set(samples.map((x) => x.opacity))] };
  });

// Replaces shell.openExternal; returns a reader of the URLs it was asked to open.
async function stubOpenExternal(app) {
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (url) => void globalThis.__opened.push(url);
  });
  return () => app.evaluate(() => globalThis.__opened.slice());
}

// Records every text the button shows ('(hidden)' while hidden), so
// short-lived states are not missed.
async function recordButton(page) {
  await page.evaluate(() => {
    const b = document.querySelector('#btn-update');
    const now = () => (b.hidden ? '(hidden)' : b.textContent);
    window.__buttonLog = [now()];
    new MutationObserver(() => now() !== window.__buttonLog.at(-1) && window.__buttonLog.push(now())).observe(b, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    });
  });
  return () => page.evaluate(() => window.__buttonLog.slice());
}

test('notice: button, panel, Later keeps it, Skip hides it until a newer release', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9', 'Fixed things'));
  const { app, page, errors } = await env.launch({ env: overrides(server) });
  await closeConnectionDialog(page);
  const button = updateButton(page);

  // A quiet button beside Settings; the arrow is decoration, not part of its name.
  await expect(button).toHaveText('↑ Update 9.9.9');
  await expect(page.getByRole('button', { name: 'Update 9.9.9', exact: true })).toBeVisible();
  const box = async (sel) => page.locator(sel).boundingBox();
  // (Clear and the other connection buttons are in the tab's toolbar, below.)
  const [pill, update, settings] = [await box('#btn-connections'), await button.boundingBox(), await box('#btn-settings')];
  expect(pill.x + pill.width).toBeLessThanOrEqual(update.x);
  expect(update.x + update.width).toBeLessThanOrEqual(settings.x);
  expect(update.y).toBe(settings.y);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toHaveAttribute('aria-controls', 'update-panel');
  await expect(panel(page)).toBeHidden();

  // The panel: versions, notes and this build's actions, without blocking the window.
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'MQTT Scope 9.9.9' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'false');
  await expect(page.locator('.modal-overlay')).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog).toContainText(`You have ${VERSION}`);
  await expect(notes(page)).toHaveText('Fixed things');
  await expect(panelButtons(page)).toHaveText(['Download', 'Later', 'Skip this version']);
  await expect(button).toBeFocused(); // clicking does not move focus into the panel

  // Later closes it; the notice stays.
  await panelButton(page, 'Later').click();
  await expect(panel(page)).toBeHidden();
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();

  // So does a click anywhere else, which keeps its own focus.
  await button.click();
  await expect(panel(page)).toBeVisible();
  await page.locator('#tree-filter').click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#tree-filter')).toBeFocused();
  // The button toggles it as well.
  await button.click();
  await expect(panel(page)).toBeVisible();
  await button.click();
  await expect(panel(page)).toBeHidden();

  // Skip this version (asked over IPC, like any user) hides it ...
  await openPanel(page);
  await panelButton(page, 'Skip this version').click();
  await expect(button).toBeHidden();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#btn-settings')).toBeFocused(); // focus is not dropped with the button
  expect((await updateState(page)).status).toBe('none');

  // ... and automatic checks finding the same release keep it hidden.
  const asked = server.requests();
  await tick(app);
  expect(server.requests()).toBe(asked + 1);
  expect((await updateState(page)).status).toBe('none');
  await expect(button).toBeHidden();

  // A newer release shows it again, quietly: no panel, and the user keeps typing where they were.
  await page.locator('#tree-filter').fill('robot');
  server.setRelease(release('9.9.10', 'More fixes'));
  await tick(app);
  await expect(button).toHaveText('↑ Update 9.9.10');
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#tree-filter')).toBeFocused();

  // Help → Check for Updates… opens the panel in the window that asked.
  await checkForUpdates(app);
  await expect(page.getByRole('dialog', { name: 'MQTT Scope 9.9.10' })).toBeVisible();
  await expect(panel(page)).toBeFocused();
  await expect(notes(page)).toHaveText('More fixes');
  expect(errors).toEqual([]);
});

test('self-updating: download progress, confirm while connected, restart installs', async ({ env }) => {
  const broker = await env.broker();
  const server = await env.releaseServer(release('9.9.9'));
  const { app, page, errors } = await env.connected(broker, { env: overrides(server, SELF_UPDATING) });
  const button = updateButton(page);
  await expect(button).toHaveText('↑ Update 9.9.9');
  const shown = await recordButton(page);

  await openPanel(page);
  await expect(panelButtons(page)).toHaveText(['Download update', 'Later', 'Skip this version', 'Open release page']);

  // Downloading: progress on the button and in the panel; nothing to skip now.
  await holdDownloads(app);
  await panelButton(page, 'Download update').click();
  await expect(button).toHaveText('Downloading 50%');
  await expect(panelButtons(page)).toHaveText(['Downloading… 50%', 'Later', 'Open release page']);
  await expect(panelButton(page, 'Downloading… 50%')).toBeDisabled();
  await expect(panel(page)).toBeFocused(); // the pressed button went away; focus stays in the panel
  await releaseDownloads(app);
  await expect(button).toHaveText('Restart to update');
  expect(await shown()).toEqual(['↑ Update 9.9.9', 'Downloading 0%', 'Downloading 50%', 'Downloading 100%', 'Restart to update']);
  await expect(panelButtons(page)).toHaveText(['Restart to update', 'Later', 'Open release page']);

  // Connected to a broker: the panel asks first, with Cancel focused.
  await panelButton(page, 'Restart to update').click();
  await expect(panel(page)).toContainText('Restarting disconnects 1 broker.');
  await expect(panelButtons(page)).toHaveText(['Restart', 'Cancel', 'Open release page']);
  await expect(panelButton(page, 'Cancel')).toBeFocused();
  expect(await installed(app)).toBe(false);

  // Cancel goes back to the ready view.
  await panelButton(page, 'Cancel').click();
  await expect(panelButtons(page)).toHaveText(['Restart to update', 'Later', 'Open release page']);
  await expect(panel(page)).not.toContainText('Restarting disconnects');
  await expect(panelButton(page, 'Restart to update')).toBeFocused();
  expect(await installed(app)).toBe(false);

  await panelButton(page, 'Restart to update').click();
  await expect(installingDialog(page)).toHaveCount(0); // not while it asks
  await panelButton(page, 'Restart').click();
  await expect(installingDialog(page)).toBeVisible();
  await expect.poll(() => installed(app)).toBe(true);
  expect(errors).toEqual([]);
});

// Records every time the panel is shown or hidden.
async function recordPanel(page) {
  await page.evaluate(() => {
    const p = document.querySelector('#update-panel');
    window.__panelLog = [];
    new MutationObserver(() => window.__panelLog.push(p.hidden ? 'hidden' : 'shown')).observe(p, { attributes: true, attributeFilter: ['hidden'] });
  });
  return () => page.evaluate(() => window.__panelLog.slice());
}

test('Restart to update on the top bar restarts at once when nothing is connected', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9'));
  const { app, page, errors } = await env.launch({ env: overrides(server, SELF_UPDATING) });
  await closeConnectionDialog(page);
  const button = updateButton(page);
  await expect(button).toHaveAttribute('aria-haspopup', 'dialog'); // opens the panel while offered
  await page.evaluate(() => window.api.updateDownload());
  await expect(button).toHaveText('Restart to update');
  // Now it is an action, not a popup; it still names the panel a confirm would open in.
  await expect(button).not.toHaveAttribute('aria-haspopup');
  await expect(button).toHaveAttribute('aria-controls', 'update-panel');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  const panelShown = await recordPanel(page);
  const installingShown = await recordInstalling(page);

  // A failed install closes the Installing dialog and shows on the button (the
  // error broadcast), still without the panel; focus is back on the button.
  await app.evaluate(() => (globalThis.__updateInstallError = 'mv: cannot move'));
  await button.click();
  await expect(button).toHaveText('Update failed');
  await expect(installingDialog(page)).toHaveCount(0);
  expect(await installingShown()).toEqual(['shown', 'hidden']);
  await expect(button).toBeFocused();
  expect(await installed(app)).toBe(false);
  expect(await panelShown()).toEqual([]);

  // Retry from the panel, then the top-bar button installs at once.
  await app.evaluate(() => delete globalThis.__updateInstallError);
  await openPanel(page);
  await panelButton(page, 'Retry').click();
  await expect(button).toHaveText('Restart to update');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  const before = (await panelShown()).length;
  await button.click();
  await expect(installingDialog(page)).toBeVisible();
  await expect.poll(() => installed(app)).toBe(true);
  expect((await panelShown()).slice(before)).toEqual([]);
  await expect(panel(page)).toBeHidden();
  expect(errors).toEqual([]);
});

test('Restart to update on the top bar asks in the panel while a broker is connected', async ({ env }) => {
  const broker = await env.broker();
  const server = await env.releaseServer(release('9.9.9'));
  const { app, page, errors } = await env.connected(broker, { env: overrides(server, SELF_UPDATING) });
  const button = updateButton(page);
  await page.evaluate(() => window.api.updateDownload());
  await expect(button).toHaveText('Restart to update');
  await expect(panel(page)).toBeHidden();

  // The click asks main, which wants a confirm: the panel opens on it, Cancel focused.
  await button.click();
  await expect(panel(page)).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page).locator('.update-message')).toHaveText('Restarting disconnects 1 broker.');
  await expect(panelButtons(page)).toHaveText(['Restart', 'Cancel', 'Open release page']);
  await expect(panelButton(page, 'Cancel')).toBeFocused();
  // A screen reader hears what is being confirmed along with the button.
  await expect(panelButton(page, 'Cancel')).toHaveAccessibleDescription('Restarting disconnects 1 broker.');
  await expect(panelButton(page, 'Restart')).toHaveAccessibleDescription('Restarting disconnects 1 broker.');
  await expect(installingDialog(page)).toHaveCount(0);
  expect(await installed(app)).toBe(false);

  // Cancel goes back to the ready view; nothing is described by a message any more.
  await panelButton(page, 'Cancel').click();
  await expect(panelButtons(page)).toHaveText(['Restart to update', 'Later', 'Open release page']);
  await expect(panelButton(page, 'Restart to update')).toBeFocused();
  await expect(panelButton(page, 'Restart to update')).toHaveAccessibleDescription('');
  expect(await installed(app)).toBe(false);

  // Closed again, the top-bar button asks again; Restart in the confirm installs.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await button.click();
  await expect(panelButton(page, 'Cancel')).toBeFocused();
  await expect(installingDialog(page)).toHaveCount(0);
  await panelButton(page, 'Restart').click();
  await expect(installingDialog(page)).toBeVisible();
  await expect.poll(() => installed(app)).toBe(true);
  expect(errors).toEqual([]);
});

// The app cannot report the install's progress: it has to quit for the
// install to replace it. Until then, every main window says what is happening.
test('Restart to update: every window shows the Installing dialog, its bar moving, then the install starts', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9'));
  const { app, page, errors } = await env.launch({ env: overrides(server, { MQTTSCOPE_UPDATE_KIND: 'nsis', MQTTSCOPE_UPDATE_FAKE: '1' }) });
  await closeConnectionDialog(page);
  const second = await newWindow(app);
  await closeConnectionDialog(second);
  await second.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.api.updateDownload());
  for (const p of [page, second]) await expect(updateButton(p)).toHaveText('Restart to update');
  await expect(installingDialog(page)).toHaveCount(0);

  await updateButton(page).click();
  for (const p of [page, second]) {
    const dialog = installingDialog(p);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAccessibleDescription('MQTT Scope closes now. The installer shows its progress, then MQTT Scope opens again.');
    await expect(dialog.getByRole('progressbar', { name: 'Installing MQTT Scope 9.9.9' })).toBeVisible();
    await expect(dialog.getByRole('button')).toHaveCount(0); // it cannot be stopped
    await expect(dialog).toBeFocused();
    await expect(updateButton(p)).toHaveText('Installing…');
  }
  // The bar moves: a sliding segment, or with reduced motion a pulse in place.
  const sliding = await installingBar(page);
  expect(sliding.animations).toEqual([{ name: 'installing-slide', playState: 'running' }]);
  expect(sliding.transforms.length).toBeGreaterThan(1);
  const pulsing = await installingBar(second);
  expect(pulsing.animations).toEqual([{ name: 'installing-pulse', playState: 'running' }]);
  expect(pulsing.opacities.length).toBeGreaterThan(1);
  expect(pulsing.transforms).toEqual(['none']);

  await expect.poll(() => installed(app)).toBe(true);
  // The real app now quits; this one stays, and so does the dialog, also in a
  // window opened now (without its connection dialog). Keys stay in it.
  const third = await newWindow(app);
  await expect(installingDialog(third)).toBeVisible();
  await expect(installingDialog(third)).toBeFocused();
  await expect(third.locator('.conn-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  for (const p of [page, second]) await expect(installingDialog(p)).toBeVisible();
  await expect(installingDialog(page)).toBeFocused();

  // Nothing opens over it or takes its focus: neither Connections… (the menu
  // action allowed over other dialogs) nor Help → Check for Updates….
  await clickMenu(app, 'File', 'Connections…');
  await checkForUpdates(app);
  await expect.poll(() => server.requests()).toBe(2);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await expect(page.locator('.conn-dialog')).toHaveCount(0);
  await expect(panel(page)).toBeHidden();
  await expect(toast(page)).toHaveCount(0);
  await expect(installingDialog(page)).toBeFocused();
  expect(errors).toEqual([]);
});

// The main process can be busy while the dialog shows (it was blocked for
// seconds starting the Windows installer, before that moved to a worker): the
// bar is a compositor animation and keeps moving regardless.
test('the Installing dialog keeps moving while the main process is busy', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9'));
  const { app, page, errors } = await env.launch({ env: overrides(server, SELF_UPDATING) });
  await closeConnectionDialog(page);
  await page.evaluate(() => window.api.updateDownload());
  await expect(updateButton(page)).toHaveText('Restart to update');
  await updateButton(page).click();
  await expect(installingDialog(page)).toBeVisible();
  await page.evaluate(() => {
    const fill = document.querySelector('.installing-overlay .installing-bar-fill');
    window.__frames = [];
    const frame = () => {
      window.__frames.push({ at: Date.now(), transform: getComputedStyle(fill).transform });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const busy = await app.evaluate(() => {
    const start = Date.now();
    while (Date.now() - start < 1500); // the main process does nothing else meanwhile
    return { start, end: Date.now() };
  });
  const frames = await page.evaluate(() => window.__frames);
  const during = frames.filter((f) => f.at > busy.start + 100 && f.at < busy.end - 100);
  expect(during.length, `frames while main was busy (of ${frames.length})`).toBeGreaterThan(10);
  expect(new Set(during.map((f) => f.transform)).size).toBeGreaterThan(5);
  expect(errors).toEqual([]);
});

// The Windows installer starts the new version with --updated; by then the
// user may have clicked elsewhere, and Windows would open it behind. Unlike
// the other tests, the window is shown when it is created, as in a real start
// (not MQTTSCOPE_HIDDEN; still headless). A probe preloaded into the main
// process records the toggle, which is over before a test could look, and
// withholds 'ready-to-show' from shown windows, as some machines do.
const ALWAYS_ON_TOP_PROBE = fileURLToPath(new URL('../helpers/alwaysOnTopProbe.cjs', import.meta.url));
const shown = (args = []) => ({ env: { MQTTSCOPE_HIDDEN: '' }, args, preload: [ALWAYS_ON_TOP_PROBE] });
const allLoaded = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.webContents.isLoading()));

test('started after an update (--updated), the first window comes to the front, once', async ({ env }) => {
  const line = / INFO update started after an update: bringing the window to the front$/gm;
  const logged = (userData) => readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8').match(line)?.length ?? 0;
  const { app, userData, errors } = await env.launch(shown(['--updated']));
  const toggles = () => app.evaluate(() => globalThis.__alwaysOnTop);
  const [first] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.id));
  await expect.poll(() => logged(userData)).toBe(1);
  // Above the others for a moment, shown, then back to a normal window.
  await expect.poll(toggles).toEqual([
    { id: first, set: true, visible: true },
    { id: first, set: false, visible: true },
  ]);

  // Later windows are left alone: a new one, and one a second launch opens.
  await newWindow(app);
  await app.evaluate(({ app: a }) => void a.emit('second-instance', {}, ['MQTT Scope', '--updated'], process.cwd(), {}));
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(3);
  await expect.poll(() => allLoaded(app)).toBe(true);
  expect(await toggles()).toHaveLength(2);
  expect(logged(userData)).toBe(1);
  expect(errors).toEqual([]);

  // A start without --updated leaves its window alone.
  const plain = await env.launch(shown());
  await newWindow(plain.app);
  await expect.poll(() => allLoaded(plain.app)).toBe(true);
  expect(await plain.app.evaluate(() => globalThis.__alwaysOnTop)).toEqual([]);
  expect(logged(plain.userData)).toBe(0);
});

test('AppImage: the Installing dialog says the app restarts', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9'));
  const { page, errors } = await env.launch({ env: overrides(server, SELF_UPDATING) });
  await closeConnectionDialog(page);
  await page.evaluate(() => window.api.updateDownload());
  await expect(updateButton(page)).toHaveText('Restart to update');
  await updateButton(page).click();
  await expect(installingDialog(page)).toHaveAccessibleDescription('MQTT Scope restarts in a moment.');
  expect(errors).toEqual([]);
});

test('a failed install from the panel closes the Installing dialog; the panel shows the error and Retry', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9'));
  const { app, page, errors } = await env.launch({ env: overrides(server, SELF_UPDATING) });
  await closeConnectionDialog(page);
  // Opened while offered: once downloaded, the top-bar button restarts instead.
  await openPanel(page);
  await panelButton(page, 'Download update').click();
  await expect(updateButton(page)).toHaveText('Restart to update');
  const installingShown = await recordInstalling(page);
  await app.evaluate(() => (globalThis.__updateInstallError = 'mv: cannot move'));

  await panelButton(page, 'Restart to update').click();
  await expect(updateButton(page)).toHaveText('Update failed');
  await expect(installingDialog(page)).toHaveCount(0);
  expect(await installingShown()).toEqual(['shown', 'hidden']);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.update-message')).toHaveText('mv: cannot move');
  await expect(panelButtons(page)).toHaveText(['Retry', 'Later', 'Skip this version', 'Open release page']);
  await expect(panel(page)).toBeFocused();
  expect(await installed(app)).toBe(false);
  expect(errors).toEqual([]);
});

test('manual build opens the release page; pacman build shows the command', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9'));

  // Builds that cannot update themselves: Download opens that version's release page.
  const manual = await env.launch({ env: overrides(server) });
  const openedManual = await stubOpenExternal(manual.app);
  await closeConnectionDialog(manual.page);
  await openPanel(manual.page);
  await expect(panelButtons(manual.page)).toHaveText(['Download', 'Later', 'Skip this version']);
  await panelButton(manual.page, 'Download').click();
  await expect.poll(openedManual).toEqual([releasePage('9.9.9')]);
  expect(manual.errors).toEqual([]);
  await env.closeApp(manual);

  // pacman: the command that builds this exact version, to copy.
  const { app, page, errors } = await env.launch({ env: overrides(server, { MQTTSCOPE_UPDATE_KIND: 'pacman' }) });
  const opened = await stubOpenExternal(app);
  await closeConnectionDialog(page);
  await expect(updateButton(page)).toHaveText('↑ Update 9.9.9');
  await openPanel(page);
  await expect(panel(page)).toContainText('Installed by the package manager. Update with:');
  await expect(panel(page).locator('code')).toHaveText(pacmanCommand('9.9.9'));
  await expect(panelButtons(page)).toHaveText(['Copy command', 'Later', 'Skip this version', 'Open release page']);
  await app.evaluate(({ clipboard: c }) => c.writeText(''));
  await panelButton(page, 'Copy command').click();
  await expect.poll(() => clipboard(app)).toBe(pacmanCommand('9.9.9'));
  await expect(toast(page).filter({ hasText: 'Command copied' })).toBeVisible();
  await panelButton(page, 'Open release page').click();
  await expect.poll(opened).toEqual([releasePage('9.9.9')]);
  expect(errors).toEqual([]);
});

test('release notes are shown as text', async ({ env }) => {
  const body = '<img src=x onerror=alert(1)>\n- item';
  const server = await env.releaseServer(release('9.9.9', body));
  const { app, page, errors } = await env.launch({ env: overrides(server) });
  await closeConnectionDialog(page);
  await openPanel(page);
  expect(await notes(page).evaluate((n) => n.textContent)).toBe(body);
  await expect(panel(page).locator('img')).toHaveCount(0);
  expect(await notes(page).evaluate((n) => n.children.length)).toBe(0);
  // Line breaks are kept.
  expect(await notes(page).evaluate((n) => n.innerText)).toBe(body);

  // A release without notes says so.
  server.setRelease(release('9.9.10', ''));
  await tick(app);
  await expect(page.getByRole('dialog', { name: 'MQTT Scope 9.9.10' })).toBeVisible();
  await expect(notes(page)).toHaveText('No release notes.');
  expect(errors).toEqual([]);
});

test('a new window shows the current update state', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9'));
  const { app, page, errors } = await env.launch({ env: overrides(server, SELF_UPDATING) });
  await expect(updateButton(page)).toHaveText('↑ Update 9.9.9');

  // Opened after the update was found.
  const second = await newWindow(app);
  await expect(updateButton(second)).toHaveText('↑ Update 9.9.9');

  // A download started in one window shows in all of them, and in one opened mid-download.
  await holdDownloads(app);
  await closeConnectionDialog(second);
  await openPanel(second);
  await panelButton(second, 'Download update').click();
  for (const p of [page, second]) await expect(updateButton(p)).toHaveText('Downloading 50%');
  const third = await newWindow(app);
  await expect(updateButton(third)).toHaveText('Downloading 50%');
  // Only the window it was opened in shows the panel.
  await expect(panel(page)).toBeHidden();
  await expect(panel(third)).toBeHidden();

  await releaseDownloads(app);
  for (const p of [page, second, third]) await expect(updateButton(p)).toHaveText('Restart to update');
  expect(errors).toEqual([]);
});

test('turning the setting off stops automatic checks; Help still checks', async ({ env }) => {
  const server = await env.releaseServer(release(VERSION));
  const { app, page, userData, errors } = await env.launch({ env: overrides(server) });
  await expect.poll(() => server.requests()).toBe(1); // the startup check
  await closeConnectionDialog(page);

  await page.locator('#btn-settings').click();
  const dialog = page.locator('.modal.settings');
  const box = dialog.locator('input[name="checkForUpdates"]');
  await expect(box).toBeChecked();
  await expect(dialog.locator('label.check', { has: page.locator('input[name="checkForUpdates"]') })).toHaveText(
    'Check for updates (asks GitHub at startup and every 6 hours)',
  );
  await box.uncheck();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await waitForFile(path.join(userData, 'settings.json'), (b) => JSON.parse(b).checkForUpdates === false);
  expect((await page.evaluate(() => window.__mqttscope.settings)).checkForUpdates).toBe(false);

  // An automatic check asks nothing now.
  await tick(app);
  expect(server.requests()).toBe(1);

  // Help → Check for Updates… still asks, and says so.
  await checkForUpdates(app);
  await expect(toast(page).filter({ hasText: `You're on the latest version (${VERSION})` })).toBeVisible();
  expect(server.requests()).toBe(2);

  // The dialog shows the saved choice; saving other settings keeps it.
  await page.locator('#btn-settings').click();
  await expect(box).not.toBeChecked();
  await dialog.locator('[name="historyLimit"]').fill('50');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await waitForFile(path.join(userData, 'settings.json'), (b) => JSON.parse(b).historyLimit === 50);
  expect(JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8')).checkForUpdates).toBe(false);
  await tick(app);
  expect(server.requests()).toBe(2);
  expect(errors).toEqual([]);
});

test('a failed download shows its error in the panel, and Retry can succeed', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9'));
  const { app, page, errors } = await env.launch({ env: overrides(server, SELF_UPDATING) });
  await closeConnectionDialog(page);
  await app.evaluate(() => (globalThis.__updateDownloadError = 'net::ERR_CONNECTION_RESET'));
  await openPanel(page);
  await panelButton(page, 'Download update').click();

  await expect(updateButton(page)).toHaveText('Update failed');
  await expect(panel(page).locator('.update-message')).toHaveText('net::ERR_CONNECTION_RESET');
  await expect(panelButtons(page)).toHaveText(['Retry', 'Later', 'Skip this version', 'Open release page']);
  await expect(toast(page)).toHaveCount(0); // in the panel, not a toast

  await app.evaluate(() => delete globalThis.__updateDownloadError);
  await panelButton(page, 'Retry').click();
  await expect(updateButton(page)).toHaveText('Restart to update');
  await expect(panel(page).locator('.update-message')).toBeHidden();
  await expect(panelButtons(page)).toHaveText(['Restart to update', 'Later', 'Open release page']);
  expect(errors).toEqual([]);
});

test('Help → Check for Updates… answers latest, failure and development builds with a toast', async ({ env }) => {
  const server = await env.releaseServer(release(VERSION));
  const { app, page, errors } = await env.launch({ env: overrides(server) });
  await expect.poll(() => server.requests()).toBe(1);

  await checkForUpdates(app);
  await expect(toast(page, 'info').filter({ hasText: `You're on the latest version (${VERSION})` })).toBeVisible();

  server.setRelease(null); // 503
  await checkForUpdates(app);
  await expect(toast(page, 'error').filter({ hasText: "Couldn't check for updates: HTTP 503" })).toBeVisible();
  await expect(updateButton(page)).toBeHidden();
  await expect(panel(page)).toBeHidden();
  expect(errors).toEqual([]);

  const dev = await env.launch({});
  await checkForUpdates(dev.app);
  await expect(toast(dev.page, 'info').filter({ hasText: 'Update checks are off in development builds' })).toBeVisible();
  await expect(updateButton(dev.page)).toBeHidden();
  expect(dev.errors).toEqual([]);
});

test('Escape closes the panel and returns focus to the button', async ({ env }) => {
  const server = await env.releaseServer(release('9.9.9'));
  const { page, errors } = await env.launch({ env: overrides(server) });
  await closeConnectionDialog(page);
  const button = updateButton(page);

  // Keyboard only: Enter opens it, Tab goes into it (it follows the button), Escape closes it.
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(button).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panelButton(page, 'Download')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();

  // Escape on the button itself closes it too.
  await page.keyboard.press('Space');
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(button).toBeFocused();

  // Escape elsewhere closes it without taking focus from where it is.
  await button.click();
  await expect(panel(page)).toBeVisible();
  await page.locator('#tree-filter').focus();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#tree-filter')).toBeFocused();
  expect(errors).toEqual([]);
});

test('in a narrow window the button and panel stay inside the window', async ({ env }) => {
  const long = Array.from({ length: 2000 }, (_, i) => `- change ${i + 1}: ${'detail '.repeat(12)}`).join('\n');
  const server = await env.releaseServer(release('9.9.9', long));
  const { page, errors } = await env.launch({ env: overrides(server, SELF_UPDATING) });
  await page.setViewportSize({ width: 598, height: 1300 });
  await closeConnectionDialog(page);

  await expect(updateButton(page)).toBeInViewport({ ratio: 1 });
  await openPanel(page);
  const inside = async (locator, width, height) => {
    const b = await locator.boundingBox();
    return b.x >= 0 && b.y >= 0 && b.x + b.width <= width && b.y + b.height <= height;
  };
  expect(await inside(panel(page), 598, 1300)).toBe(true);
  for (const b of await panelButtons(page).all()) expect(await inside(b, 598, 1300)).toBe(true);
  // Long notes scroll inside the panel.
  expect(await notes(page).evaluate((n) => n.scrollHeight > n.clientHeight)).toBe(true);

  // Still inside, actions and all, when the window shrinks further while it
  // is open: the notes give up their height first.
  await page.setViewportSize({ width: 420, height: 400 });
  await expect.poll(() => inside(panel(page), 420, 400)).toBe(true);
  for (const b of await panelButtons(page).all()) expect(await inside(b, 420, 400)).toBe(true);
  expect(errors).toEqual([]);
});
