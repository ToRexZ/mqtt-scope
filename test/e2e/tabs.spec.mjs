// The tab strip: one tab per connection with its status dot, switching with a
// click, closing with ×, the window title, and Disconnect / Reconnect in the
// tab's toolbar.

import { test, expect, makeUserData, profile, connect, selectTopic, waitForTopic, viewerBody, mockDialogs, dialogCalls, toast, openTabTo, activeTabName } from './fixtures.mjs';

const tabEl = (page, id) => page.locator(`.conn-tab[data-id="${id}"]`);
// A tab's plot series and the values it recorded, also while the tab is hidden.
const addSeries = (page, id, topic) =>
  page.evaluate(([i, t]) => window.__mqttscope.shell.tabs.find((x) => x.connId === i).plots.addSeries(null, t, null, { quiet: true }), [id, topic]);
const plotValues = (page, id, topic) =>
  page.evaluate(([i, t]) => window.__mqttscope.shell.tabs.find((x) => x.connId === i).plots.points(t, null).map((p) => p.v), [id, topic]);

// Brokers A and B with a profile each; tab A connected from the dialog at
// launch, tab B opened with + (it is the active one).
async function twoTabs(env) {
  const a = await env.broker();
  const b = await env.broker();
  const userData = makeUserData({ profiles: [profile(a.port, { id: 'a', name: 'Broker A' }), profile(b.port, { id: 'b', name: 'Broker B' })] });
  const ctx = await env.launch({ userData });
  await connect(ctx.page);
  const idA = await ctx.page.evaluate(() => window.__mqttscope.shell.active.connId);
  const idB = await openTabTo(ctx.page, 'Broker B');
  return { a, b, idA, idB, ...ctx };
}

test('two tabs on two brokers with the same topic stay separate', async ({ env }) => {
  const { a, b, idA, idB, page, errors } = await twoTabs(env);
  await expect(page.locator('.conn-tab .conn-tab-name')).toHaveText(['Broker A', 'Broker B']);
  await expect(activeTabName(page)).toHaveText('Broker B');
  await expect(tabEl(page, idB)).toHaveAttribute('aria-selected', 'true');
  await expect(tabEl(page, idA)).toHaveAttribute('aria-selected', 'false');

  for (const id of [idA, idB]) await addSeries(page, id, 'same/topic');
  await a.publish('same/topic', '11');
  await b.publish('same/topic', '22');

  await tabEl(page, idA).click();
  await expect(activeTabName(page)).toHaveText('Broker A');
  await selectTopic(page, 'same/topic');
  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText('same/topic');
  await expect(viewerBody(page)).toContainText('11');
  await expect(viewerBody(page)).not.toContainText('22');

  await tabEl(page, idB).click();
  await expect(activeTabName(page)).toHaveText('Broker B');
  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText('No topic selected'); // each tab has its own selection
  await selectTopic(page, 'same/topic');
  await expect(viewerBody(page)).toContainText('22');
  await expect(viewerBody(page)).not.toContainText('11');

  // Each tab's plot of same/topic holds only its own broker's values.
  await expect.poll(() => plotValues(page, idA, 'same/topic')).toEqual([11]);
  await expect.poll(() => plotValues(page, idB, 'same/topic')).toEqual([22]);
  expect(errors).toEqual([]);
});

test("the dot shows each connection's state, also for a background tab", async ({ env }) => {
  const { b, idA, idB, page, errors } = await twoTabs(env);
  await expect(tabEl(page, idA)).toHaveAttribute('data-state', 'connected');
  await expect(tabEl(page, idB)).toHaveAttribute('data-state', 'connected');
  await tabEl(page, idA).click();
  await expect(activeTabName(page)).toHaveText('Broker A');

  // Broker B goes down while its tab is in the background.
  await b.stop();
  await expect(tabEl(page, idB)).toHaveAttribute('data-state', /^(connecting|error)$/);
  await expect(tabEl(page, idA)).toHaveAttribute('data-state', 'connected');
  const dot = (id) => tabEl(page, id).locator('.dot').evaluate((d) => getComputedStyle(d).backgroundColor);
  expect(await dot(idB)).not.toBe(await dot(idA));
  // Its errors toast only once the tab is shown (at its next retry).
  await expect(tabEl(page, idB)).toHaveAttribute('data-state', 'error');
  await expect(toast(page, 'error')).toHaveCount(0);
  await tabEl(page, idB).click();
  await expect(toast(page, 'error')).toContainText('ECONNREFUSED');
  await tabEl(page, idA).click();
  await b.start();
  await expect(tabEl(page, idB)).toHaveAttribute('data-state', 'connected', { timeout: 15_000 });
  expect(await dot(idB)).toBe(await dot(idA));
  // A tab that never connected has no dot.
  await page.locator('.tab-new').click();
  await page.locator('.conn-dialog .modal-close').click();
  await expect(page.locator('.conn-tab.active')).toHaveAttribute('data-state', 'new');
  await expect(page.locator('.conn-tab.active .dot')).toBeHidden();
  await expect(activeTabName(page)).toHaveText('New connection');
  expect(errors).toEqual([]);
});

test('closing a tab with recorded plot data asks first', async ({ env }) => {
  const { app, b, idA, idB, page, errors } = await twoTabs(env);
  await addSeries(page, idB, 'b/value');
  await b.publish('b/value', '1');
  await expect.poll(() => plotValues(page, idB, 'b/value')).toEqual([1]);

  await mockDialogs(app, { confirm: false });
  await tabEl(page, idB).locator('.conn-tab-close').click();
  await expect
    .poll(() => dialogCalls(app))
    .toEqual([
      {
        kind: 'confirm',
        message: 'Close “Broker B”?',
        detail: 'Its plots hold recorded data, which is lost when the tab closes. The plots themselves are kept.',
      },
    ]);
  // Kept, with its connection and data.
  await expect(page.locator('.conn-tab')).toHaveCount(2);
  await expect(activeTabName(page)).toHaveText('Broker B');
  expect(await plotValues(page, idB, 'b/value')).toEqual([1]);
  expect(b.aedes.connectedClients).toBe(1);

  await mockDialogs(app, { confirm: true });
  await tabEl(page, idB).locator('.conn-tab-close').click();
  await expect(tabEl(page, idB)).toHaveCount(0);
  await expect.poll(() => b.aedes.connectedClients).toBe(0);
  await expect(activeTabName(page)).toHaveText('Broker A');
  expect(await app.evaluate(() => globalThis.__mqttscopeConnections.size)).toBe(1);
  expect(await page.evaluate(() => window.__mqttscope.shell.tabs.map((t) => t.connId))).toEqual([idA]);
  expect(errors).toEqual([]);
});

test('closing the last tab leaves a fresh tab', async ({ env }) => {
  const a = await env.broker();
  const { app, page, errors } = await env.connected(a);
  const first = await page.evaluate(() => window.__mqttscope.shell.active.connId);
  await mockDialogs(app, { confirm: false });
  // No plot data: closes without asking.
  await tabEl(page, first).locator('.conn-tab-close').click();
  await expect(tabEl(page, first)).toHaveCount(0);
  await expect.poll(() => a.aedes.connectedClients).toBe(0);
  await expect(page.locator('.conn-tab')).toHaveCount(1);
  await expect(activeTabName(page)).toHaveText('New connection');
  await expect(page.locator('.conn-tab.active')).toHaveAttribute('data-state', 'new');
  await expect(page.locator('.conn-dialog')).toBeVisible();
  await expect(page).toHaveTitle('MQTT Scope — New connection');
  expect(await dialogCalls(app)).toEqual([]);
  expect(await app.evaluate(() => globalThis.__mqttscopeConnections.size)).toBe(1);
  expect(errors).toEqual([]);
});

test('the window title follows the active tab', async ({ env }) => {
  const { idA, page, errors } = await twoTabs(env);
  await expect(page).toHaveTitle('MQTT Scope — Broker B');
  await tabEl(page, idA).click();
  await expect(page).toHaveTitle('MQTT Scope — Broker A');
  await page.locator('.tab-new').click();
  await expect(page.locator('.conn-dialog')).toBeVisible();
  await expect(page).toHaveTitle('MQTT Scope — New connection');
  await expect(page.locator('.conn-tab .conn-tab-name')).toHaveText(['Broker A', 'Broker B', 'New connection']);
  expect(errors).toEqual([]);
});

test('Disconnect keeps the tab and its data; Reconnect resumes', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('keep/me', '1', { retain: true });
  const { page, errors } = await env.connected(broker);
  const id = await page.evaluate(() => window.__mqttscope.shell.active.connId);
  const url = `mqtt://127.0.0.1:${broker.port}`;
  await waitForTopic(page, 'keep/me');
  await addSeries(page, id, 'n/value');
  await broker.publish('n/value', '5');
  await expect.poll(() => plotValues(page, id, 'n/value')).toEqual([5]);
  const button = page.locator('#btn-disconnect');
  await expect(button).toHaveText('Disconnect');

  await button.click();
  await expect(page.locator('#status-text')).toHaveText(`Disconnected — ${url}`);
  await expect.poll(() => broker.aedes.connectedClients).toBe(0);
  await expect(button).toHaveText('Reconnect');
  await expect(button).toBeVisible();
  await expect(tabEl(page, id)).toHaveAttribute('data-state', 'disconnected');
  await expect(page.locator('.conn-tab')).toHaveCount(1);
  await expect(activeTabName(page)).toHaveText(`Test broker ${broker.port}`);
  expect(await page.evaluate(() => window.__mqttscope.tree.find('keep/me')?.messageCount)).toBe(1);
  expect(await plotValues(page, id, 'n/value')).toEqual([5]);

  await button.click();
  await expect(page.locator('#status-text')).toHaveText(`Connected — ${url}`);
  await expect(tabEl(page, id)).toHaveAttribute('data-state', 'connected');
  await expect(button).toHaveText('Disconnect');
  await broker.publish('n/value', '6');
  await expect.poll(() => plotValues(page, id, 'n/value')).toEqual([5, 6]);
  expect(await page.evaluate(() => window.__mqttscope.tree.find('keep/me')?.messageCount)).toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => window.__mqttscope.shell.tabs.length)).toBe(1);
  expect(errors).toEqual([]);
});

test('a tab opened for a profile open in another tab stays a New connection', async ({ env }) => {
  const a = await env.broker();
  const { page, errors } = await env.connected(a);
  await page.evaluate(async (p) => {
    await window.__mqttscope.shell.openTab({ profile: p, connect: true });
  }, profile(a.port));
  await expect(toast(page, 'error')).toHaveText(`“Test broker ${a.port}” is already open`);
  await expect(page.locator('.conn-tab .conn-tab-name')).toHaveText([`Test broker ${a.port}`, 'New connection']);
  await expect(page).toHaveTitle('MQTT Scope — New connection');
  expect(await page.evaluate(() => window.__mqttscope.shell.active.profile)).toBeNull();
  expect(errors).toEqual([]);
});

test('saved messages: a save in one tab shows in the others; switching back keeps the list as it was', async ({ env }) => {
  const { page, errors } = await env.launch();
  await page.locator('.conn-dialog .modal-close').click();
  await page.locator('.tab-new').click();
  await page.locator('.conn-dialog .modal-close').click();
  const [first, second] = await page.evaluate(() => window.__mqttscope.shell.tabs.map((t) => t.connId));
  const list = page.locator('#publisher-host .lib-list');
  // The second tab saves enough messages for its list to scroll.
  await page.evaluate(() => {
    const pub = window.__mqttscope.publisher;
    pub.saved = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, name: `msg ${i}`, topic: `t/${i}`, payload: String(i), format: 'text', qos: 0, retain: false }));
    pub.persist();
    pub.renderList();
  });
  const send = page.locator('#publisher-host .lib-item .send').first();
  await send.focus();
  await list.evaluate((l) => (l.scrollTop = 300));
  // After a reload of a list has had its round trip to the store.
  const settled = () => page.evaluate(() => window.api.storeGet('savedMessages'));

  await tabEl(page, first).click();
  await expect(page.locator('#publisher-host .lib-item')).toHaveCount(60);
  await tabEl(page, second).click();
  await settled();
  // Nothing changed meanwhile: the list is not rebuilt, so its focus stays.
  await expect(page.locator('#publisher-host .lib-item')).toHaveCount(60);
  await expect(send).toBeFocused();
  expect(await list.evaluate((l) => l.scrollTop)).toBe(300);
  expect(errors).toEqual([]);
});
