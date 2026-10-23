// Connection manager: several saved profiles, protocol-dependent fields,
// duplicate/delete, auto-save and persistence across restarts; the dialog as
// the content of a New connection tab.

import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { test, expect, makeUserData, profile, connect, closedPort, mockDialogs, dialogCalls, waitForFile, waitForTopic, selectTopic, row, toast, activeTabName, openTabTo, recordDialogStatus } from './fixtures.mjs';

const PASSWORD = 's3cret-Pa55word';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const tabEl = (page, id) => page.locator(`.conn-tab[data-id="${id}"]`);
const activeId = (page) => page.evaluate(() => window.__mqttscope.shell.active.connId);
const mode = (page) => page.evaluate(() => window.__mqttscope.shell.active.mode);

test('connection manager: create, protocol defaults, duplicate, delete and persistence', async ({ env }) => {
  const userData = makeUserData();
  const profilesFile = path.join(userData, 'profiles.json');
  const first = await env.launch({ userData });
  const { app, page } = first;

  // The dialog opens on start with the built-in default profile.
  const dlg = page.locator('.conn-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.conn-item .conn-name')).toHaveText(['Local broker']);
  const field = (name) => dlg.locator(`.conn-form [name="${name}"]`);

  // + New adds and selects a blank profile.
  await dlg.getByRole('button', { name: '+ New' }).click();
  await expect(dlg.locator('.conn-item')).toHaveCount(2);
  await expect(dlg.locator('.conn-item.active .conn-name')).toHaveText('New connection');
  await expect(field('name')).toHaveValue('New connection');

  await field('name').fill('Alpha');
  await field('host').fill('alpha.example.com');
  await expect(dlg.locator('.conn-item.active .conn-name')).toHaveText('Alpha');
  await expect(dlg.locator('.conn-item.active .conn-url')).toHaveText('mqtt://alpha.example.com:1883');

  // Protocol switch: default ports follow the protocol, ws path / TLS only where relevant.
  const proto = field('protocol');
  const port = field('port');
  const wsPath = field('wsPath');
  const tls = dlg.locator('fieldset.tls');
  await expect(port).toHaveValue('1883');
  await expect(wsPath).toBeHidden();
  await expect(tls).toBeHidden();

  await proto.selectOption('mqtts');
  await expect(port).toHaveValue('8883');
  await expect(wsPath).toBeHidden();
  await expect(tls).toBeVisible();
  await expect(dlg.locator('.conn-item.active .conn-url')).toHaveText('mqtts://alpha.example.com:8883');

  await proto.selectOption('ws');
  await expect(port).toHaveValue('9001');
  await expect(wsPath).toBeVisible();
  await expect(tls).toBeHidden();

  await proto.selectOption('wss');
  await expect(wsPath).toBeVisible();
  await expect(tls).toBeVisible();

  await proto.selectOption('mqtt');
  await expect(port).toHaveValue('1883');
  await expect(wsPath).toBeHidden();
  await expect(tls).toBeHidden();

  // A custom port is never replaced by a protocol switch.
  await port.fill('18830');
  await proto.selectOption('mqtts');
  await expect(port).toHaveValue('18830');
  await proto.selectOption('ws');
  await expect(port).toHaveValue('18830');
  await proto.selectOption('mqtt');
  await expect(port).toHaveValue('18830');
  await expect(dlg.locator('.conn-item.active .conn-url')).toHaveText('mqtt://alpha.example.com:18830');

  // The rest of the form.
  await field('mqttVersion').selectOption('5');
  await field('username').fill('alice');
  await field('password').fill(PASSWORD);
  await expect(field('password')).toHaveAttribute('type', 'password');
  await dlg.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(field('password')).toHaveAttribute('type', 'text');
  await field('clientId').fill('wb-alpha');
  await field('keepalive').fill('30');
  await field('subscriptions').fill('sensors/# 1\nalerts/+');
  await field('clean').uncheck();

  // Duplicate copies every field into a new, selected profile.
  await dlg.getByRole('button', { name: 'Duplicate' }).click();
  await expect(dlg.locator('.conn-item .conn-name')).toHaveText(['Local broker', 'Alpha', 'Alpha (copy)']);
  await expect(dlg.locator('.conn-item.active .conn-name')).toHaveText('Alpha (copy)');
  await expect(field('host')).toHaveValue('alpha.example.com');
  await expect(field('port')).toHaveValue('18830');
  await expect(field('username')).toHaveValue('alice');
  await field('name').fill('Beta');
  await field('host').fill('beta.example.com');
  await expect(dlg.locator('.conn-item .conn-name')).toHaveText(['Local broker', 'Alpha', 'Beta']);

  // Selecting another profile shows its own values.
  await dlg.locator('.conn-item', { hasText: 'Alpha' }).click();
  await expect(field('host')).toHaveValue('alpha.example.com');
  await dlg.locator('.conn-item', { hasText: 'Beta' }).click();
  await expect(field('host')).toHaveValue('beta.example.com');

  // Delete, cancelled: nothing changes.
  await mockDialogs(app, { confirm: false });
  await dlg.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => dialogCalls(app)).toEqual([expect.objectContaining({ kind: 'confirm', message: 'Delete connection “Beta”?' })]);
  await expect(dlg.locator('.conn-item .conn-name')).toHaveText(['Local broker', 'Alpha', 'Beta']);
  await expect(dlg.locator('.conn-item.active .conn-name')).toHaveText('Beta');

  // Delete, confirmed.
  await mockDialogs(app, { confirm: true });
  await dlg.getByRole('button', { name: 'Delete' }).click();
  await expect(dlg.locator('.conn-item .conn-name')).toHaveText(['Local broker', 'Alpha']);

  // Edits are saved automatically.
  const saved = JSON.parse(
    await waitForFile(profilesFile, (buf) => {
      const list = JSON.parse(buf);
      return list.length === 2 && list[1].name === 'Alpha' && list[1].clean === false && list[1].keepalive === 30;
    }),
  );
  expect(saved.map((p) => p.name)).toEqual(['Local broker', 'Alpha']);
  expect(saved[1]).toMatchObject({
    protocol: 'mqtt',
    host: 'alpha.example.com',
    port: 18830,
    mqttVersion: 5,
    username: 'alice',
    clientId: 'wb-alpha',
    keepalive: 30,
    clean: false,
    subscriptions: [
      { topic: 'sensors/#', qos: 1 },
      { topic: 'alerts/+', qos: 0 },
    ],
  });

  // Password at rest: encrypted when the OS offers it, otherwise plaintext (documented).
  const raw = readFileSync(profilesFile, 'utf8');
  const encryption = await app.evaluate(({ safeStorage }) => ({
    available: safeStorage.isEncryptionAvailable(),
    backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os',
  }));
  if (encryption.available) {
    expect(raw).not.toContain(PASSWORD);
    expect(saved[1].passwordEnc).toBeTruthy();
    expect(saved[1].password).toBeUndefined();
  } else {
    test.info().annotations.push({
      type: 'note',
      description: `safeStorage unavailable (backend ${encryption.backend}): passwords are stored in plaintext in profiles.json (mode 0600)`,
    });
    expect(saved[1].password).toBe(PASSWORD);
  }
  expect(first.errors).toEqual([]);
  await env.closeApp(first);

  // Relaunch with the same data directory: everything is back.
  const second = await env.launch({ userData });
  const dlg2 = second.page.locator('.conn-dialog');
  await expect(dlg2.locator('.conn-item .conn-name')).toHaveText(['Local broker', 'Alpha']);
  await expect(dlg2.locator('.conn-item .conn-url')).toHaveText(['mqtt://localhost:1883', 'mqtt://alpha.example.com:18830']);
  await dlg2.locator('.conn-item', { hasText: 'Alpha' }).click();
  const f2 = (name) => dlg2.locator(`.conn-form [name="${name}"]`);
  await expect(f2('name')).toHaveValue('Alpha');
  await expect(f2('protocol')).toHaveValue('mqtt');
  await expect(f2('host')).toHaveValue('alpha.example.com');
  await expect(f2('port')).toHaveValue('18830');
  await expect(f2('mqttVersion')).toHaveValue('5');
  await expect(f2('username')).toHaveValue('alice');
  await expect(f2('password')).toHaveValue(PASSWORD);
  await expect(f2('clientId')).toHaveValue('wb-alpha');
  await expect(f2('keepalive')).toHaveValue('30');
  await expect(f2('subscriptions')).toHaveValue('sensors/# 1\nalerts/+');
  await expect(f2('clean')).not.toBeChecked();
  await expect(dlg2.locator('fieldset.tls')).toBeHidden();
  expect(second.errors).toEqual([]);
});

test('connection dialog: + opens it in a new tab, Escape closes that tab, profiles persist via Connect', async ({ env }) => {
  const broker = await env.broker();
  const userData = makeUserData();
  const { page, errors } = await env.launch({ userData });
  const dlg = page.locator('.conn-dialog');
  await expect(dlg).toBeVisible();

  // Point the default profile at the test broker and connect from the dialog.
  await dlg.locator('[name="host"]').fill('127.0.0.1');
  await dlg.locator('[name="port"]').fill(String(broker.port));
  await dlg.locator('[name="subscriptions"]').fill('#');
  await dlg.locator('.connect-btn').click();
  await expect(dlg).toHaveCount(0); // gives way to the session once connected
  await expect(page.locator('#status-text')).toHaveText(`Connected — mqtt://127.0.0.1:${broker.port}`);
  await expect(activeTabName(page)).toHaveText('Local broker');
  await expect(page.locator('#btn-disconnect')).toBeVisible();

  // Open again with + (in a new tab); Escape closes that tab.
  await page.locator('.tab-new').click();
  await expect(dlg).toBeVisible();
  await expect(page.locator('.conn-tab .conn-tab-name')).toHaveText(['Local broker', 'New connection']);
  await dlg.locator('[name="name"]').press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.conn-tab .conn-tab-name')).toHaveText(['Local broker']);
  await expect(page.locator('#status-text')).toHaveText(`Connected — mqtt://127.0.0.1:${broker.port}`);

  // Connect flushed the edits to disk.
  const saved = JSON.parse(await waitForFile(path.join(userData, 'profiles.json'), (b) => JSON.parse(b)[0].port === broker.port));
  expect(saved[0]).toMatchObject({ host: '127.0.0.1', port: broker.port, subscriptions: [{ topic: '#', qos: 0 }] });
  expect(errors).toEqual([]);
});

test('edits made right before the window is closed are not lost (connections, plots)', async ({ env }) => {
  const broker = await env.broker();
  const userData = makeUserData({
    profiles: [profile(broker.port)],
    plots: { plots: [{ id: 'p1', title: 'Seeded', windowSec: 300, series: [{ id: 's1', topic: 'a/b', segs: null, slot: 0 }] }] },
  });
  const { app, page, errors } = await env.launch({ userData });
  await connect(page); // the plots show in a connected tab
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  await page.locator('.plot-card select').selectOption('60');
  await page.locator('.tab-new').click();
  await page.locator('.conn-dialog [name="name"]').fill('Renamed just before closing');
  expect(errors).toEqual([]);

  // The user closes the window straight away (as with the window's close button).
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;

  const file = path.join(userData, 'profiles.json');
  const profiles = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  expect.soft(profiles[0]?.name, 'connection renamed just before closing').toBe('Renamed just before closing');
  const layouts = JSON.parse(readFileSync(path.join(userData, 'profileLayouts.json'), 'utf8'));
  // Seeded in the older format: saved as the profile's tabs.
  expect.soft(layouts.byProfile?.[`p${broker.port}`]?.tabs?.[0]?.plots[0]?.windowSec, 'plot time window changed just before closing').toBe(60);
});

test('the connection dialog lives in its tab; other tabs stay usable', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('a/first', '1', { retain: true });
  const { app, page, errors } = await env.launch({ userData: makeUserData({ profiles: [profile(broker.port)] }) });
  const dlg = page.locator('.conn-dialog');
  // A window starts with one New connection tab whose content is the dialog,
  // not a modal over the window.
  await expect(page.locator('.conn-tab')).toHaveCount(1);
  await expect(page.locator('#tab-host .conn-dialog')).toBeVisible();
  await expect(page.locator('.modal-overlay')).toHaveCount(0);
  await connect(page);
  await waitForTopic(page, 'a/first');
  const first = await activeId(page);

  // + opens another, the same way: the dialog instead of the toolbar, the
  // layout and the status bar.
  await page.locator('.tab-new').click();
  await expect(page.locator('.conn-tab')).toHaveCount(2);
  await expect(activeTabName(page)).toHaveText('New connection');
  await expect(page.locator('#tab-host .conn-dialog')).toBeVisible();
  await expect(page.locator('.modal-overlay')).toHaveCount(0);
  await expect(page.locator('#tab-host .tab-toolbar')).toHaveCount(0);
  await expect(page.locator('#layout')).toHaveCount(0);
  await expect(page.locator('#status-text')).toHaveCount(0);
  const second = await activeId(page);

  // The connected tab keeps recording meanwhile and stays usable.
  await broker.publish('a/later', '2');
  await tabEl(page, first).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#status-text')).toHaveText(`Connected — mqtt://127.0.0.1:${broker.port}`);
  await waitForTopic(page, 'a/later');
  await selectTopic(page, 'a/later');
  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText('a/later');
  await tabEl(page, second).click();
  await expect(page.locator('#tab-host .conn-dialog')).toBeVisible();

  // Subscriptions (shortcut or menu) says to connect first.
  await page.keyboard.press(`${MOD}+Shift+S`);
  await expect(toast(page, 'error')).toHaveText('Connect first to change subscriptions');
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .items.find((m) => m.label === 'File')
      .submenu.items.find((i) => i.label === 'Subscriptions…')
      .click(),
  );
  await expect(toast(page, 'error')).toHaveText(['Connect first to change subscriptions', 'Connect first to change subscriptions']);

  // Mod+K in a New connection tab focuses its dialog instead of opening
  // another tab; Mod+T opens one, and so does Mod+K from a connected tab.
  await page.locator('#btn-settings').focus();
  await page.keyboard.press(`${MOD}+K`);
  await expect(dlg.locator('.conn-item.active')).toBeFocused();
  await expect(page.locator('.conn-tab')).toHaveCount(2);
  await page.keyboard.press(`${MOD}+T`);
  await expect(page.locator('.conn-tab')).toHaveCount(3);
  await expect(page.locator('#tab-host .conn-dialog')).toBeVisible();
  await tabEl(page, first).click();
  await expect(dlg).toHaveCount(0);
  await page.keyboard.press(`${MOD}+K`);
  await expect(page.locator('.conn-tab')).toHaveCount(4);
  await expect(activeTabName(page)).toHaveText('New connection');
  await expect(page.locator('#tab-host .conn-dialog')).toBeVisible();
  expect(errors).toEqual([]);
});

test("Esc closes a New connection tab but not the window's only tab", async ({ env }) => {
  const broker = await env.broker();
  const { app, page, errors } = await env.launch({ userData: makeUserData({ profiles: [profile(broker.port)] }) });
  const dlg = page.locator('.conn-dialog');
  const tabs = page.locator('.conn-tab');
  const connections = () => app.evaluate(() => globalThis.__mqttscopeConnections.size);
  // The window's only tab: no ×, and Esc does nothing, wherever the focus is
  // (it does not swap the tab for a fresh one either).
  const first = await activeId(page);
  await expect(dlg.locator('.conn-item.active')).toBeFocused();
  await expect(dlg.locator('.modal-close')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await dlg.locator('[name="name"]').press('Escape');
  await tabEl(page, first).focus();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeVisible();
  await expect(tabs).toHaveCount(1);
  expect(await activeId(page)).toBe(first);
  expect(await connections()).toBe(1);

  await connect(page);
  await page.keyboard.press('F11'); // maximizes the inspector
  await expect(page.locator('#layout')).toHaveClass(/max-viewer/);

  // Another New connection tab closes with Esc wherever the focus is in the
  // window (the list, a field, beside the dialog, the tab strip) or with ×,
  // without asking.
  await mockDialogs(app, { confirm: false });
  const openOne = async () => {
    await page.locator('.tab-new').click();
    await expect(tabs).toHaveCount(2);
  };
  const closedBack = async () => {
    await expect(tabs).toHaveCount(1);
    expect(await activeId(page)).toBe(first);
  };
  await openOne();
  await expect(dlg.locator('.modal-close')).toBeVisible();
  await expect(dlg.locator('.conn-item.active')).toBeFocused();
  await page.keyboard.press('Escape');
  await closedBack();
  await expect(page.locator('#layout')).toHaveClass(/max-viewer/); // the Esc was the closed tab's
  await page.keyboard.press(`${MOD}+T`);
  await dlg.locator('[name="host"]').press('Escape');
  await closedBack();
  await openOne();
  await page.locator('.tab-picker').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.conn-dialog :focus')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await closedBack();
  await openOne();
  await page.locator('.conn-tab.active').focus();
  await page.keyboard.press('Escape');
  await closedBack();

  // A menu or a dialog open over it takes the Esc instead.
  await openOne();
  await page.locator('.conn-tab.active').click({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toBeVisible();
  await expect(dlg.locator('.conn-item.active')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  await expect(tabs).toHaveCount(2);
  await page.locator('#btn-settings').click();
  await expect(page.locator('.modal.settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal.settings')).toHaveCount(0);
  await expect(tabs).toHaveCount(2);
  await dlg.locator('.modal-close').click();
  await closedBack();
  expect(await dialogCalls(app)).toEqual([]);

  // Closing the connected tab leaves a New connection tab, the only one again.
  await tabEl(page, first).locator('.conn-tab-close').click();
  await expect(activeTabName(page)).toHaveText('New connection');
  const fresh = await activeId(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.modal-close')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dlg).toBeVisible();
  await expect(tabs).toHaveCount(1);
  expect(await activeId(page)).toBe(fresh);
  expect(await connections()).toBe(1);
  expect(errors).toEqual([]);
});

test('a failed connect keeps the dialog with the error; Connect retries', async ({ env }) => {
  const port = await closedPort();
  const up = await env.broker();
  const { app, page, errors } = await env.launch({
    userData: makeUserData({ profiles: [profile(port, { id: 'down', name: 'Down' }), profile(up.port, { id: 'up', name: 'Up' })] }),
  });
  const dlg = page.locator('.conn-dialog');
  const line = dlg.locator('.conn-status-line');
  const log = await recordDialogStatus(page);
  const id = await activeId(page);
  const button = dlg.locator('.connect-btn');
  const pick = (name) => dlg.locator('.conn-item', { hasText: name }).click();

  await expect(button).toHaveText('Connect');
  await button.click();
  await expect(line).toHaveText(/^Error: connect ECONNREFUSED/);
  await expect(line).toHaveClass(/\berror\b/);
  // The tab names its profile and shows the failure on its dot; the dialog
  // stays with Retry, and the error is not repeated in a toast.
  await expect(dlg).toBeVisible();
  await expect(button).toHaveText('Retry');
  await expect(activeTabName(page)).toHaveText('Down');
  await expect(page).toHaveTitle('MQTT Scope — Down');
  await expect(tabEl(page, id)).toHaveAttribute('data-state', /^(connecting|error)$/);
  expect(await mode(page)).toBe('picker');
  await expect(toast(page, 'error')).toHaveCount(0);

  // Retry starts a new attempt (the client's own retries say "Reconnecting").
  const attempts = async () => (await log()).filter((t) => t?.startsWith('Connecting… ')).length;
  const tries = await attempts();
  await button.click();
  await expect.poll(attempts).toBe(tries + 1);
  await expect(line).toHaveText(/^Error: connect ECONNREFUSED/);
  await expect(button).toHaveText('Retry');

  // Leaving the tab and coming back: the dialog shows the error again, still
  // without a toast, also for the errors of later retries. (Another New
  // connection tab offers Connect.)
  await page.locator('.tab-new').click();
  await expect(line).toHaveText('');
  await expect(button).toHaveText('Connect');
  await tabEl(page, id).click();
  await expect(line).toHaveText(/ECONNREFUSED|Reconnecting/);
  await expect(button).toHaveText('Retry');
  const failures = async () => (await log()).filter((t) => t?.startsWith('Error: ')).length;
  const failed = await failures();
  await expect.poll(failures, { timeout: 8000 }).toBeGreaterThan(failed);
  await expect(button).toHaveText('Retry'); // through the client's own retries
  await expect(toast(page, 'error')).toHaveCount(0);

  // Retry is for the tab's profile; another one reads Connect.
  await pick('Up');
  await expect(button).toHaveText('Connect');
  await pick('Down');
  await expect(button).toHaveText('Retry');

  // Another profile from the list connects this same tab instead.
  await pick('Up');
  await button.click();
  await expect(dlg).toHaveCount(0);
  expect(await activeId(page)).toBe(id);
  await expect(activeTabName(page)).toHaveText('Up');
  await expect(page.locator('#status-text')).toHaveText(`Connected — mqtt://127.0.0.1:${up.port}`);
  expect(await app.evaluate(() => globalThis.__mqttscopeConnections.openProfileIds())).toEqual(['up']);
  await expect(toast(page, 'error')).toHaveCount(0);

  // A tab opened to connect a profile (as Reopen does) shows that profile in
  // its dialog next to its error.
  expect(await page.evaluate(() => window.__mqttscope.connections.selectedId)).toBe('up');
  await page.evaluate((p) => window.__mqttscope.shell.openTab({ profile: p, connect: true }), profile(port, { id: 'down', name: 'Down' }));
  await expect(line).toHaveText(/ECONNREFUSED|Reconnecting/);
  await expect(activeTabName(page)).toHaveText('Down');
  await expect(dlg.locator('.conn-item.active .conn-name')).toHaveText('Down');
  await expect(button).toHaveText('Retry');
  await expect(toast(page, 'error')).toHaveCount(0);

  // Reopen brings back the tab that had connected, not one that never did.
  const down = await activeId(page);
  await page.evaluate((i) => window.__mqttscope.shell.closeTab(i), id);
  await expect(tabEl(page, id)).toHaveCount(0);
  expect(await activeId(page)).toBe(down);
  await dlg.locator('.modal-close').click();
  await expect(tabEl(page, down)).toHaveCount(0);
  await page.keyboard.press(`${MOD}+Shift+T`);
  await expect(activeTabName(page)).toHaveText('Up');
  await expect(page.locator('.conn-tab.active')).toHaveAttribute('data-state', 'connected');
  expect(await page.evaluate(() => window.__mqttscope.shell.reopenClosed())).toBeNull();
  await expect(page.locator('.conn-tab .conn-tab-name')).toHaveText(['New connection', 'Up']);
  expect(errors).toEqual([]);
});

test('the tab becomes a session on the first connect', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('s/topic', '1', { retain: true });
  const { page, errors } = await env.launch({ userData: makeUserData({ profiles: [profile(broker.port)] }) });
  const url = `mqtt://127.0.0.1:${broker.port}`;
  const dlg = page.locator('.conn-dialog');
  expect(await mode(page)).toBe('picker');
  await expect(page.locator('#tab-host .tab-toolbar')).toHaveCount(0);

  await dlg.locator('.connect-btn').click();
  await expect(dlg).toHaveCount(0);
  expect(await mode(page)).toBe('session');
  await expect(page.locator('#tab-host .tab-toolbar')).toBeVisible();
  await expect(page.locator('#status-text')).toHaveText(`Connected — ${url}`);
  await waitForTopic(page, 's/topic');
  await expect(row(page, 's')).toBeVisible();

  // For good: a dropped connection, or one the user disconnects, keeps the
  // session and its data, never the dialog.
  await broker.stop();
  await expect(page.locator('.conn-tab.active')).toHaveAttribute('data-state', /^(connecting|error)$/);
  await page.locator('#btn-disconnect').click();
  await expect(page.locator('#btn-disconnect')).toHaveText('Reconnect');
  await expect(page.locator('.conn-tab.active')).toHaveAttribute('data-state', 'disconnected');
  expect(await mode(page)).toBe('session');
  await expect(dlg).toHaveCount(0);
  await expect(row(page, 's')).toBeVisible();
  await broker.start();
  await page.locator('#btn-disconnect').click();
  await expect(page.locator('#status-text')).toHaveText(`Connected — ${url}`);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------- one tab per profile

const twoProfiles = async (env) => {
  const a = await env.broker();
  const b = await env.broker();
  const userData = makeUserData({ profiles: [profile(a.port, { id: 'a', name: 'Broker A' }), profile(b.port, { id: 'b', name: 'Broker B' })] });
  return { a, b, userData };
};
const tabCount = (page) => page.evaluate(() => window.__mqttscope.shell.tabs.length);
const pickProfile = (page, name) => page.locator('.conn-dialog .conn-item').filter({ has: page.locator('.conn-name').getByText(name, { exact: true }) }).click();
const openWindow = async (app) => {
  const next = app.waitForEvent('window');
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File');
    file.submenu.items.find((i) => i.label === 'New Window').click();
  });
  const page = await next;
  await page.waitForFunction(() => !!window.__mqttscope);
  await page.waitForSelector('.conn-dialog');
  return page;
};

test('opening an open profile switches to its tab', async ({ env }) => {
  const { userData } = await twoProfiles(env);
  const { page, errors } = await env.launch({ userData });
  await connect(page);
  const idA = await activeId(page);
  const idB = await openTabTo(page, 'Broker B');
  expect(await activeId(page)).toBe(idB);

  // A picker for the open Broker A is closed; Broker A's tab is shown.
  await page.click('.tab-new');
  await expect.poll(() => tabCount(page)).toBe(3);
  await pickProfile(page, 'Broker A');
  await page.locator('.conn-dialog .connect-btn').click();
  await expect.poll(() => tabCount(page)).toBe(2);
  expect(await activeId(page)).toBe(idA);
  await expect(page.locator('.conn-tab .conn-tab-name')).toHaveText(['Broker A', 'Broker B']);
  await expect(toast(page, 'error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('reopening a closed profile that is open again activates its tab', async ({ env }) => {
  const { userData } = await twoProfiles(env);
  const { page, errors } = await env.launch({ userData });
  await connect(page);
  const idA = await activeId(page);
  const idB = await openTabTo(page, 'Broker B');
  await page.evaluate((id) => window.__mqttscope.shell.closeTab(id), idB);
  const idB2 = await openTabTo(page, 'Broker B');
  await page.evaluate(() => window.__mqttscope.shell.activate(window.__mqttscope.shell.tabs[0].connId));
  expect(await activeId(page)).toBe(idA);
  await page.evaluate(() => window.__mqttscope.shell.reopenClosed());
  expect(await tabCount(page)).toBe(2);
  expect(await activeId(page)).toBe(idB2);
  await expect(toast(page, 'error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a fresh picker preselects a profile that is not open', async ({ env }) => {
  const { userData } = await twoProfiles(env);
  const { page, errors } = await env.launch({ userData });
  await connect(page);
  await page.click('.tab-new');
  await expect(page.locator('.conn-dialog .conn-item.active .conn-name')).toHaveText('Broker B');
  expect(errors).toEqual([]);
});

test('a window\'s only tab, a picker, stays when its profile is open elsewhere', async ({ env }) => {
  const { userData } = await twoProfiles(env);
  const { app, page, errors } = await env.launch({ userData });
  await connect(page);
  const page2 = await openWindow(app);
  await pickProfile(page2, 'Broker A');
  await page2.locator('.conn-dialog .connect-btn').click();
  await expect.poll(() => page2.evaluate(() => window.__mqttscope.shell.tabs.length)).toBe(1);
  expect(await mode(page2)).toBe('picker');
  await expect(page2.locator('.conn-dialog')).toBeVisible();
  expect(errors).toEqual([]);
});

test('opening an open profile in another window brings that window forward', async ({ env }) => {
  const { userData } = await twoProfiles(env);
  const { app, page, errors } = await env.launch({ userData });
  await connect(page);
  const idA = await activeId(page);
  await openTabTo(page, 'Broker B'); // window 1 shows Broker B; Broker A is behind it
  const id1 = await (await app.browserWindow(page)).evaluate((win) => win.webContents.id);
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__focused = [];
    const focus = BrowserWindow.prototype.focus;
    BrowserWindow.prototype.focus = function (...args) {
      globalThis.__focused.push(this.webContents.id);
      return focus.apply(this, args);
    };
  });

  const page2 = await openWindow(app);
  await pickProfile(page2, 'Broker A');
  await page2.locator('.conn-dialog .connect-btn').click();
  await expect.poll(() => activeId(page)).toBe(idA);
  expect(await app.evaluate(() => globalThis.__focused)).toContain(id1);
  expect(errors).toEqual([]);
});

test('an open profile cannot be deleted', async ({ env }) => {
  const { userData } = await twoProfiles(env);
  const { app, page, errors } = await env.launch({ userData });
  await mockDialogs(app, { confirm: true });
  await connect(page);
  const idA = await activeId(page);
  await page.click('.tab-new');
  await expect.poll(() => tabCount(page)).toBe(2);
  const del = page.locator('.conn-dialog').getByRole('button', { name: 'Delete', exact: true });
  await pickProfile(page, 'Broker B');
  await expect(del).toBeEnabled();
  await pickProfile(page, 'Broker A');
  await expect(del).toBeDisabled();
  await expect(del).toHaveAttribute('title', 'Close its tab first');

  // Closing its tab frees it, without redrawing the dialog.
  await page.evaluate((id) => window.__mqttscope.shell.closeTab(id), idA);
  await expect(del).toBeEnabled();
  await expect(del).toHaveAttribute('title', 'Delete this connection');
  expect(errors).toEqual([]);
});

test('editing an open profile asks for a reconnect; renaming renames the tab', async ({ env }) => {
  const { userData } = await twoProfiles(env);
  const { page, errors } = await env.launch({ userData });
  await connect(page);
  const idA = await activeId(page);
  await page.click('.tab-new');
  await expect.poll(() => tabCount(page)).toBe(2);
  const idPicker = await activeId(page);
  await pickProfile(page, 'Broker A');
  const field = (name) => page.locator(`.conn-dialog .conn-form [name="${name}"]`);
  const hint = page.locator('#tab-host .reconnect-hint');

  // A rename needs no reconnect.
  await field('name').fill('Renamed A');
  await tabEl(page, idA).click();
  await expect(activeTabName(page)).toHaveText('Renamed A');
  await expect(page).toHaveTitle('MQTT Scope — Renamed A');
  await expect(hint).toBeHidden();

  // A change to how it connects does.
  await tabEl(page, idPicker).click();
  await field('host').fill('localhost');
  await tabEl(page, idA).click();
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('reconnect to apply');
  // Changing it back takes the hint away again.
  await tabEl(page, idPicker).click();
  await field('host').fill('127.0.0.1');
  await tabEl(page, idA).click();
  await expect(hint).toBeHidden();

  await tabEl(page, idPicker).click();
  await field('host').fill('localhost');
  await tabEl(page, idA).click();
  await expect(hint).toBeVisible();
  await hint.click();
  await expect(page.locator('#status-text')).toContainText('mqtt://localhost:');
  await expect(page.locator('#status-text')).toContainText('Connected');
  await expect(hint).toBeHidden();
  expect(errors).toEqual([]);
});

test('an edit in another window shows the hint', async ({ env }) => {
  const { userData } = await twoProfiles(env);
  const { app, page, errors } = await env.launch({ userData });
  await connect(page);
  const page2 = await openWindow(app);
  await pickProfile(page2, 'Broker A');
  await page2.locator('.conn-dialog [name="username"]').fill('someone');
  await expect(page.locator('#tab-host .reconnect-hint')).toBeVisible();
  expect(errors).toEqual([]);
});
