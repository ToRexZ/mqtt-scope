// Regression tests for the issues found in the production review.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  test,
  expect,
  makeUserData,
  profile,
  connect,
  rowByPath,
  waitForTopic,
  viewerTab,
  viewerButton,
  viewerBody,
  historyItems,
  mockDialogs,
  activeTabName,
  tempDir,
  waitForFile,
  readJson,
} from './fixtures.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('history: clicking an entry holds exactly that message even after the history shifted', async ({ env }) => {
  const broker = await env.broker();
  const { page, errors } = await env.connected(broker, {
    userData: makeUserData({ profiles: [profile(broker.port)], settings: { historyLimit: 10, historyMB: 64 } }),
  });
  for (let i = 1; i <= 12; i++) await broker.publish('fast/counter', JSON.stringify({ n: i }));
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('fast/counter')?.messageCount)).toBe(12);
  await page.evaluate(() => {
    const { tree, treeView } = window.__mqttscope;
    treeView.select(tree.find('fast/counter'));
  });
  await expect(historyItems(page)).toHaveCount(10);
  // New messages arrive (dropping the oldest) after the list was drawn but
  // before the click lands: the click must still hold the row's message.
  const result = await page.evaluate(() => {
    const { tree } = window.__mqttscope;
    const item = document.querySelectorAll('#viewer-host .history-item')[4];
    const clicked = item.querySelector('.history-preview').textContent;
    for (let i = 0; i < 3; i++) tree.addMessage({ topic: 'fast/counter', payload: new TextEncoder().encode(`{"n":${100 + i}}`), qos: 0, retain: false, ts: Date.now() });
    item.click();
    return { clicked, held: new TextDecoder().decode(window.__mqttscope.viewer.current().payload) };
  });
  expect(result.held).toBe(result.clicked);
  await expect(page.locator('#viewer-host .btn.live')).toHaveText('❚❚ Held');
  expect(errors).toEqual([]);
});

test('history list holds still while the pointer is over it', async ({ env }) => {
  const broker = await env.broker();
  const { page, errors } = await env.connected(broker);
  await broker.publish('busy/t', '0');
  await waitForTopic(page, 'busy/t');
  await page.evaluate(() => window.__mqttscope.treeView.select(window.__mqttscope.tree.find('busy/t')));
  await page.locator('#viewer-host .history-list').hover();
  const before = await historyItems(page).allTextContents();
  for (let i = 1; i <= 5; i++) await broker.publish('busy/t', String(i));
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('busy/t').messageCount)).toBe(6);
  await sleep(300);
  expect(await historyItems(page).allTextContents()).toEqual(before);
  await expect(page.locator('#viewer-host .history-head')).toHaveText('History (6) · paused while pointing');
  await page.mouse.move(5, 5);
  await expect(historyItems(page)).toHaveCount(6);
  expect(errors).toEqual([]);
});

test('tree "values" filter searches the whole payload, not only its beginning', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('agv/state', JSON.stringify({ pad: 'x'.repeat(20000), errors: [{ errorType: 'laserScannerWarning' }] }), { retain: true });
  await broker.publish('agv/other', JSON.stringify({ fine: true }), { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'agv/other');
  await page.locator('#filter-values').check();
  await page.locator('#tree-filter').fill('laserscanner');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.treeView.rows.map((r) => r.node.path))).toEqual(['agv', 'agv/state']);
  expect(errors).toEqual([]);
});

test('integers beyond 2^53 are shown and re-published exactly', async ({ env }) => {
  const broker = await env.broker();
  const exact = '{"id":18446744073709551615,"ts":1700000000123456789}';
  await broker.publish('robot/ids', exact, { retain: true });
  const { app, page, errors } = await env.connected(broker);
  await waitForTopic(page, 'robot/ids');
  const watcher = await env.client(broker.port);
  await watcher.subscribe('out/#');
  await (await rowByPath(page, 'robot/ids')).click();
  await viewerTab(page, 'tree').click();
  await expect(viewerBody(page).locator('.warn-note')).toContainText('integers larger than 2^53');
  await viewerTab(page, 'text').click();
  await expect(viewerBody(page).locator('.warn-note')).toContainText('Shown as received');
  await expect(viewerBody(page).locator('.src')).toHaveText(exact);
  await viewerTab(page, 'raw').click();
  await expect(viewerBody(page).locator('.src')).toHaveText(exact);
  // Edit & publish keeps the exact text; Format refuses to round it.
  await viewerButton(page, 'Edit & publish').click();
  const editor = page.locator('#publisher-host .payload-editor');
  await expect(editor).toHaveValue(exact);
  await page.locator('#publisher-host').getByRole('button', { name: 'Format', exact: true }).click();
  await expect(editor).toHaveValue(exact);
  await page.locator('#publisher-host .topic-input').fill('out/ids');
  await page.locator('#publisher-host').getByRole('button', { name: 'Publish', exact: true }).click();
  const got = await watcher.waitFor((m) => m.topic === 'out/ids');
  expect(got.payload.toString()).toBe(exact);
  void app;
  expect(errors).toEqual([]);
});

test('windows: each has its own broker connection; saved data syncs between them', async ({ env }) => {
  const brokerA = await env.broker();
  const brokerB = await env.broker();
  await brokerA.publish('only/on/a', '1', { retain: true });
  await brokerB.publish('only/on/b', '2', { retain: true });
  const userData = makeUserData({
    profiles: [profile(brokerA.port, { id: 'a', name: 'Broker A' }), profile(brokerB.port, { id: 'b', name: 'Broker B' })],
  });
  const { app, page, errors } = await env.launch({ userData });
  await connect(page);
  await waitForTopic(page, 'only/on/a');

  // File → New Window.
  const second = app.waitForEvent('window');
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File');
    file.submenu.items.find((i) => i.label === 'New Window').click();
  });
  const page2 = await second;
  await page2.waitForFunction(() => !!window.__mqttscope);
  await page2.waitForSelector('.conn-dialog');
  await page2.locator('.conn-item', { hasText: 'Broker B' }).click();
  await page2.click('.connect-btn');
  await page2.waitForFunction(() => window.__mqttscope.status.state === 'connected');
  await page2.waitForFunction(() => !!window.__mqttscope.tree.find('only/on/b'));

  // Separate connections: each window sees only its own broker.
  await brokerA.publish('only/on/a', '1b');
  await brokerB.publish('only/on/b', '2b');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('only/on/a').messageCount)).toBe(2);
  expect(await page.evaluate(() => window.__mqttscope.tree.find('only/on/b'))).toBeNull();
  expect(await page2.evaluate(() => window.__mqttscope.tree.find('only/on/a'))).toBeNull();
  await expect(activeTabName(page)).toHaveText('Broker A');
  await expect(activeTabName(page2)).toHaveText('Broker B');

  // A message saved in one window appears in the other.
  await page.locator('#publisher-host .topic-input').fill('shared/topic');
  await page.locator('#publisher-host .payload-editor').fill('{"x":1}');
  await page.locator('#publisher-host').getByRole('button', { name: 'Save…' }).click();
  await page.locator('.modal.prompt .input').fill('Shared one');
  await page.keyboard.press('Enter');
  await expect(page2.locator('#publisher-host .lib-name')).toHaveText(['Shared one']);

  // Closing the second window leaves the first connected.
  await page2.close();
  await brokerA.publish('only/on/a', '1c');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('only/on/a').messageCount)).toBe(3);
  expect(errors).toEqual([]);
});

test('subscriptions dialog: subscribe and unsubscribe live, optionally saved to the connection', async ({ env }) => {
  const broker = await env.broker();
  const userData = makeUserData({ profiles: [profile(broker.port, { subscriptions: [{ topic: 'a/#', qos: 0 }] })] });
  const { page, errors } = await env.launch({ userData });
  await connect(page);
  await broker.publish('b/x', 'not yet');
  await sleep(200);
  expect(await page.evaluate(() => window.__mqttscope.tree.find('b/x'))).toBeNull();

  await page.locator('#btn-subscriptions').click();
  const dlg = page.locator('.subs-dialog');
  await expect(dlg.locator('.subs-topic')).toHaveText(['a/#']);
  // Invalid filters are refused with the reason.
  await dlg.locator('.subs-filter').fill('b/#/x');
  await dlg.getByRole('button', { name: 'Subscribe', exact: true }).click();
  await expect(dlg.locator('.field-hint.bad')).toContainText('"#" must be the last level');
  await dlg.locator('.subs-filter').fill('b/#');
  await dlg.locator('select').selectOption('1');
  await dlg.getByRole('button', { name: 'Subscribe', exact: true }).click();
  await expect(dlg.locator('.subs-row')).toHaveCount(2);
  await expect(dlg.locator('.subs-row', { hasText: 'b/#' }).locator('.subs-qos')).toHaveText('QoS 1');
  await broker.publish('b/x', 'now');
  await waitForTopic(page, 'b/x');
  // Unsubscribe a/# — its messages stop arriving.
  await dlg.locator('.subs-row', { hasText: 'a/#' }).getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(dlg.locator('.subs-topic')).toHaveText(['b/#']);
  await broker.publish('a/late', 'x');
  await broker.publish('b/y', 'y');
  await waitForTopic(page, 'b/y');
  expect(await page.evaluate(() => window.__mqttscope.tree.find('a/late'))).toBeNull();
  await dlg.getByRole('button', { name: 'Close' }).click();
  // Saved to the profile.
  await waitForFile(path.join(userData, 'profiles.json'), (b) => JSON.parse(b)[0].subscriptions?.[0]?.topic === 'b/#');
  expect(readJson(path.join(userData, 'profiles.json'))[0].subscriptions).toEqual([{ topic: 'b/#', qos: 1 }]);
  expect(errors).toEqual([]);
});

test('connection dialog explains when passwords cannot be encrypted', async ({ env }) => {
  const { app, page, errors } = await env.launch({ userData: makeUserData({ profiles: [profile(1883)] }) });
  const security = await app.evaluate(({ safeStorage }) => ({
    available: safeStorage.isEncryptionAvailable(),
    backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null,
  }));
  const hint = page.locator('.conn-form .field', { hasText: 'Password' }).locator('.field-hint');
  if (!security.available || security.backend === 'basic_text') {
    await expect(hint).toContainText('No system keyring available');
  } else {
    await expect(hint).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('lowering "messages kept per topic" trims existing history at once', async ({ env }) => {
  const broker = await env.broker();
  const { page, errors } = await env.connected(broker);
  for (let i = 0; i < 12; i++) await broker.publish('h/t', String(i));
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('h/t')?.history.length)).toBe(12);
  await page.locator('#btn-settings').click();
  await page.locator('.settings input[name="historyLimit"]').fill('4');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('h/t').history.length)).toBe(4);
  expect(errors).toEqual([]);
});

test('CSV export neutralises spreadsheet formulas in aliases', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('m/v', '5', { retain: true });
  const { app, page, errors } = await env.connected(broker);
  await waitForTopic(page, 'm/v');
  await page.evaluate(() => {
    const { plots } = window.__mqttscope;
    plots.addSeries(null, 'm/v', null, { alias: '=HYPERLINK("http://x")' });
  });
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  const file = path.join(tempDir(), 'p.csv');
  await mockDialogs(app, { saveFile: file });
  await page.locator('.plot-card').getByRole('button', { name: 'CSV' }).click();
  await waitForFile(file);
  const line = readFileSync(file, 'utf8').split('\n')[1];
  expect(line).toContain(`"'=HYPERLINK(""http://x"")"`);
  expect(errors).toEqual([]);
});
