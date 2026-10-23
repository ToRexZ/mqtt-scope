// Several broker connections in one window, by connection id: MQTT calls,
// events and pop-outs stay with their connection, and closing a connection,
// or reloading its window, ends it. The UI still shows one connection per
// window, so the second one is driven through window.api.

import { test, expect, profile, connect, selectTopic, waitForTopic, popupFrom, closedPort, activeTabName } from './fixtures.mjs';

const registry = (app, method, ...args) => app.evaluate((_electron, [m, a]) => globalThis.__mqttscopeConnections[m](...a), [method, args]);
const registrySize = (app) => app.evaluate(() => globalThis.__mqttscopeConnections.size);

// Opens a second connection in the window, records what reaches the window
// for it, and connects it to the broker on `port`.
async function openSecond(page, port) {
  return page.evaluate(async (p) => {
    const id = await window.api.openConnection();
    const seen = ((window.__seen ||= {})[id] = { payloads: [], states: [] });
    window.api.onMessages((batch) => batch.connId === id && seen.payloads.push(...batch.messages.map((m) => new TextDecoder().decode(m.payload))));
    window.api.onStatus(({ connId, status }) => connId === id && seen.states.push(status.state));
    const res = await window.api.connect(id, p);
    return { id, res };
  }, profile(port));
}
const seen = (page, id) => page.evaluate((i) => window.__seen[i], id);
const payloadsOf = async (page, id) => (await seen(page, id)).payloads;

const popOutSelected = (page) => page.locator('#viewer-host').getByRole('button', { name: '⤢ Pop out' }).click();
const historyPreviews = (popup) => popup.locator('.history-item .history-preview');

async function twoBrokers(env) {
  const a = await env.broker();
  const b = await env.broker();
  await a.publish('same/topic', 'a', { retain: true });
  await b.publish('same/topic', 'b', { retain: true });
  return { a, b };
}

test('one window, two connections: each gets only its own broker', async ({ env }) => {
  const { a, b } = await twoBrokers(env);
  const { page, errors } = await env.connected(a);
  await waitForTopic(page, 'same/topic');
  const { id, res } = await openSecond(page, b.port);
  expect(res).toEqual({ ok: true, url: `mqtt://127.0.0.1:${b.port}` });
  await expect.poll(() => payloadsOf(page, id)).toEqual(['b']);

  await a.publish('same/topic', 'a2');
  await b.publish('same/topic', 'b2');
  await expect.poll(() => payloadsOf(page, id)).toEqual(['b', 'b2']);
  // The window's own connection (its tree) only has broker A's messages.
  const history = () => page.evaluate(() => window.__mqttscope.tree.find('same/topic').history.map((m) => new TextDecoder().decode(m.payload)));
  await expect.poll(history).toEqual(['a', 'a2']);
  expect(await page.evaluate(() => new TextDecoder().decode(window.__mqttscope.tree.find('same/topic').message.payload))).toBe('a2');
  await expect(activeTabName(page)).toHaveText(`Test broker ${a.port}`);
  expect(errors).toEqual([]);
});

test("a pop-out only receives its own connection's messages", async ({ env }) => {
  const { a, b } = await twoBrokers(env);
  const { app, page, errors } = await env.connected(a);
  await waitForTopic(page, 'same/topic');
  const { id } = await openSecond(page, b.port);
  await expect.poll(() => payloadsOf(page, id)).toEqual(['b']);

  await selectTopic(page, 'same/topic');
  const { popup, errors: popupErrors } = await popupFrom(app, () => popOutSelected(page));
  await expect(popup).toHaveTitle(`Test broker ${a.port} — same/topic`);
  await expect(historyPreviews(popup)).toHaveText(['a']);

  // B's message reaches the window (for the second connection), not the pop-out.
  await b.publish('same/topic', 'b2');
  await expect.poll(() => payloadsOf(page, id)).toEqual(['b', 'b2']);
  await a.publish('same/topic', 'a2');
  await expect(historyPreviews(popup)).toHaveText(['a2', 'a']);
  expect(errors).toEqual([]);
  expect(popupErrors).toEqual([]);
});

test('closing a connection closes its pop-outs only', async ({ env }) => {
  const { a, b } = await twoBrokers(env);
  const { app, page, errors } = await env.connected(a);
  await waitForTopic(page, 'same/topic');
  const { id } = await openSecond(page, b.port);
  await expect.poll(() => payloadsOf(page, id)).toEqual(['b']);

  await selectTopic(page, 'same/topic');
  const { popup: popupA } = await popupFrom(app, () => popOutSelected(page));
  const { popup: popupB } = await popupFrom(app, () =>
    page.evaluate((connId) => window.api.openPopout({ connId, topic: 'same/topic', title: 'Second — same/topic', history: [] }), id),
  );
  await expect(popupB).toHaveTitle('Second — same/topic');
  await b.publish('same/topic', 'b2');
  await expect(historyPreviews(popupB)).toHaveText(['b2']);

  const closed = popupB.waitForEvent('close');
  await page.evaluate((connId) => window.api.closeConnection(connId), id);
  await closed;
  await expect.poll(() => b.aedes.connectedClients).toBe(0);
  expect(await registrySize(app)).toBe(1);
  // The first connection and its pop-out carry on.
  expect(popupA.isClosed()).toBe(false);
  await a.publish('same/topic', 'a2');
  await expect(historyPreviews(popupA)).toHaveText(['a2', 'a']);
  // The closed connection is gone for good.
  await expect(page.evaluate((connId) => window.api.status(connId), id)).rejects.toThrow('Unknown connection');
  expect(errors).toEqual([]);
});

test('closing a connection mid-connect leaves no session', async ({ env }) => {
  const a = await env.broker();
  const { app, page, errors } = await env.connected(a);
  const { id, res } = await openSecond(page, await closedPort());
  expect(res.ok).toBe(true);
  expect(await registry(app, 'activeCount')).toBe(2);

  await page.evaluate((connId) => window.api.closeConnection(connId), id);
  expect(await registrySize(app)).toBe(1);
  expect(await registry(app, 'activeCount')).toBe(1);
  // Nothing reaches the window for it afterwards, not even after mqtt.js's
  // retry delay (3 s).
  const states = (await seen(page, id)).states;
  await page.waitForTimeout(3500);
  expect((await seen(page, id)).states).toEqual(states);
  expect(await page.evaluate(() => window.__mqttscope.status.state)).toBe('connected');
  expect(errors).toEqual([]);
});

test('reloading a window closes its connections', async ({ env }) => {
  const { a, b } = await twoBrokers(env);
  const { app, page, errors } = await env.connected(a);
  const { id } = await openSecond(page, b.port);
  await expect.poll(() => payloadsOf(page, id)).toEqual(['b']);
  expect(a.aedes.connectedClients).toBe(1);
  expect(b.aedes.connectedClients).toBe(1);

  await page.reload();
  await page.waitForFunction(() => !!window.__mqttscope);
  await expect.poll(() => a.aedes.connectedClients).toBe(0);
  await expect.poll(() => b.aedes.connectedClients).toBe(0);
  // Only the reloaded page's own (not yet connected) connection is left.
  expect(await registrySize(app)).toBe(1);
  expect(await registry(app, 'activeCount')).toBe(0);
  await expect(page.evaluate((connId) => window.api.status(connId), id)).rejects.toThrow('Unknown connection');

  await connect(page);
  await expect.poll(() => a.aedes.connectedClients).toBe(1);
  expect(await registrySize(app)).toBe(1);
  await waitForTopic(page, 'same/topic');
  expect(errors).toEqual([]);
});

// The window blocks every navigation of its own (a link, a file dropped on
// it); such an attempt still starts loading, but the page stays and so must
// its connections.
test('a blocked navigation keeps the connections', async ({ env }) => {
  const a = await env.broker();
  const { app, page, errors } = await env.connected(a);
  await page.evaluate(() => {
    location.href = 'https://example.com/';
  });
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = 'file:///';
    document.body.append(link);
    link.click();
    link.remove();
  });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  expect(page.url()).toMatch(/\/renderer\/index\.html$/);
  expect(await registrySize(app)).toBe(1);
  expect(a.aedes.connectedClients).toBe(1);
  await a.publish('still/here', '1');
  await waitForTopic(page, 'still/here');
  expect(errors).toEqual([]);
});

test('the update restart counts connections of every tab', async ({ env }) => {
  const { a, b } = await twoBrokers(env);
  const server = await env.releaseServer({ tag_name: 'v9.9.9', body: 'Notes for 9.9.9' });
  const { app, page, errors } = await env.connected(a, {
    env: { MQTTSCOPE_UPDATE_URL: server.url, MQTTSCOPE_UPDATE_KIND: 'appimage', MQTTSCOPE_UPDATE_FAKE: '1' },
  });
  const { id } = await openSecond(page, b.port);
  await expect.poll(async () => (await seen(page, id)).states).toContain('connected');
  expect(await registry(app, 'activeCount')).toBe(2);

  await expect.poll(async () => (await page.evaluate(() => window.api.updateState())).status).toBe('available');
  await page.evaluate(() => window.api.updateDownload());
  expect(await page.evaluate(() => window.api.updateRestart(false))).toEqual({ confirm: 2 });
  expect(await app.evaluate(() => globalThis.__updateInstalled === true)).toBe(false);
  expect(errors).toEqual([]);
});
