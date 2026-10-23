// Moving a tab, with its connection, to another window (main.js moveTab) and
// to a new window of its own (the tab menu's Move to new window), here driven
// through main's test hook, globalThis.__mqttscopeMoveTab; and dragging a tab
// between windows or out of every window, which makes the same moves. A real
// drag between OS windows cannot be scripted: the drag tests drive what the
// windows report (window.api.tabDragStart, tabDrop, tabDragEnd), or dispatch
// the drag events a window would get.

import path from 'node:path';
import { test, expect, makeUserData, profile, openTabTo, activeTabName, selectTopic, popupFrom, historyItems, menu, menuLabels, toast, waitForFile, waitForLayout, until } from './fixtures.mjs';
import { sleep } from '../helpers/broker.mjs';

const tabIds = (page) => page.evaluate(() => window.__mqttscope.shell.tabs.map((t) => t.connId));
const activeId = (page) => page.evaluate(() => window.__mqttscope.shell.active?.connId ?? null);
const windowIdOf = (page) => page.evaluate(() => window.__mqttscope.shell.windowId);
const activateTab = (page, id) => page.evaluate((i) => window.__mqttscope.shell.activate(i), id);
const tabEl = (page, id) => page.locator(`.conn-tab[data-id="${id}"]`);
const moveTab = (app, connId, windowId, index) => app.evaluate((_electron, [c, w, i]) => globalThis.__mqttscopeMoveTab(c, w, i), [connId, windowId, index]);
const ownerOf = (app, connId) => app.evaluate((_electron, id) => globalThis.__mqttscopeConnections.get(id)?.ownerId ?? null, connId);
const mainWindowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().endsWith('/index.html')).length);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const boundsOf = (app, id) => app.evaluate(({ BrowserWindow }, i) => BrowserWindow.getAllWindows().find((w) => w.webContents.id === i)?.getNormalBounds() ?? null, id);
const countOf = (page, id, topic) => page.evaluate(([i, t]) => window.__mqttscope.shell.tabs.find((x) => x.connId === i)?.tree.find(t)?.messageCount ?? 0, [id, topic]);

// What a window reports of a drag (window.api), as its strip does for a real one.
const dragStart = (page, connId) => page.evaluate((id) => window.api.tabDragStart(id), connId);
const dragEnd = (page, overSource) => page.evaluate((over) => window.api.tabDragEnd({ overSource: over }), overSource);
const dropAt = (page, index) => page.evaluate((i) => window.api.tabDrop({ index: i }), index);

// Dispatches a drag event of `type` at the page's tab `id`, the pointer at
// `fx` of its width; resolves with whether the page took it (cancelled it).
const dragEvent = (page, type, id, fx = 0.5) =>
  page.evaluate(
    ([t, i, f]) => {
      const item = document.querySelector(`.conn-tab[data-id="${i}"]`);
      const r = item.getBoundingClientRect();
      const ev = new DragEvent(t, { bubbles: true, cancelable: true, clientX: r.left + r.width * f, clientY: r.top + r.height / 2, dataTransfer: new DataTransfer() });
      item.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    [type, id, fx],
  );

// Whether the page's strip takes a drag whose data it cannot read (a tab of
// another window, which main reports).
const takesDrag = (page) =>
  page.evaluate(() => {
    const item = document.querySelector('.topbar .conn-tab');
    const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
    item.dispatchEvent(ev);
    item.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
    return ev.defaultPrevented;
  });

// Starts dragging the page's tab `id` as the browser does: dragstart on it,
// then the pointer enters the window there. The tab is kept as
// window.__dragged, for the events after. Resolves with the drag's data.
const startDragging = (page, id) =>
  page.evaluate((i) => {
    const item = document.querySelector(`.conn-tab[data-id="${i}"]`);
    window.__dragged = item;
    const dataTransfer = new DataTransfer();
    item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    item.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
    return Object.fromEntries(dataTransfer.types.map((type) => [type, dataTransfer.getData(type)]));
  }, id);

// Drag events of `types`, one after the other, at the tab being dragged.
const atDragged = (page, ...types) =>
  page.evaluate((list) => {
    for (const t of list) window.__dragged.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  }, types);

// The numbered messages of topic `seq` a tab holds: its count, its history
// and its plot of them, in whichever window has the tab.
const seqOf = (page, id) =>
  page.evaluate((i) => {
    const tab = window.__mqttscope.shell.tabs.find((t) => t.connId === i);
    const node = tab?.tree.find('seq');
    const value = (m) => Number(new TextDecoder().decode(m.payload));
    return { count: node?.messageCount ?? 0, history: node ? node.history.map(value) : [], points: tab ? tab.plots.points('seq', null).map((p) => p.v) : [] };
  }, id);

// Brokers A, B and C with a profile each (ids a, b, c); every message is kept
// in the history. The headless display is 1×1 px unless told otherwise.
async function launchThree(env, settings = {}) {
  const brokers = [await env.broker(), await env.broker(), await env.broker()];
  const profiles = brokers.map((b, i) => profile(b.port, { id: 'abc'[i], name: `Broker ${'ABC'[i]}` }));
  const userData = makeUserData({ profiles, settings: { historyLimit: 1000, ...settings } });
  const ctx = await env.launch({ userData, args: ['--ozone-override-screen-size=2560,1440'] });
  return { brokers, ...ctx };
}

// Picks a profile in the active tab's connection dialog and connects it.
async function connectTo(page, name) {
  const dlg = page.locator('.conn-dialog');
  await dlg.locator('.conn-item').filter({ has: page.locator('.conn-name').getByText(name, { exact: true }) }).click();
  await dlg.locator('.connect-btn').click();
  await page.waitForFunction(() => window.__mqttscope.status?.state === 'connected', null, { timeout: 10000 });
}

// A second main window (File → New Window), with its own errors.
async function openWindow(app, page) {
  const next = app.waitForEvent('window');
  await page.evaluate(() => window.api.newWindow());
  const w = await next;
  const errors = [];
  w.on('pageerror', (e) => errors.push(String(e)));
  w.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await w.setViewportSize({ width: 1600, height: 1000 });
  await w.waitForFunction(() => !!window.__mqttscope);
  await w.waitForSelector('.conn-dialog');
  return { page: w, errors };
}

// Window 1 with tabs A and B (B shown), window 2 with tab C.
async function twoWindows(app, w1) {
  await connectTo(w1, 'Broker A');
  const idA = await activeId(w1);
  const idB = await openTabTo(w1, 'Broker B');
  const w2 = await openWindow(app, w1);
  await connectTo(w2.page, 'Broker C');
  const idC = await activeId(w2.page);
  return { idA, idB, idC, w2 };
}

// Publishes seq messages `from`..`to` at a steady pace (about 1 ms each), in
// the background; sent() tells how many are out.
function publishSeq(broker, from, to) {
  let sent = 0;
  const done = (async () => {
    for (let i = from; i <= to; i++) {
      await broker.publish('seq', String(i));
      sent++;
      if (i % 5 === 0) await sleep(10);
    }
  })();
  return { done, sent: () => sent };
}

// Whether the broker saw the app's client connect or go.
function watchClients(broker) {
  const seen = [];
  broker.aedes.on('client', () => seen.push('connect'));
  broker.aedes.on('clientDisconnect', () => seen.push('disconnect'));
  return seen;
}

test('a tab moves with its connection; messages published during the move all arrive in order', async ({ env }) => {
  const {
    brokers: [a],
    app,
    page: w1,
    userData,
    errors,
  } = await launchThree(env);
  const { idA, idB, idC, w2 } = await twoWindows(app, w1);
  const w2Id = await windowIdOf(w2.page);
  expect(w2Id).toEqual(expect.any(Number));
  expect(await windowIdOf(w1)).not.toBe(w2Id);
  await activateTab(w1, idA);

  // Earlier messages, the topic selected, a plot of it and a publisher draft.
  const pub = publishSeq(a, 1, 20);
  await pub.done;
  await expect.poll(async () => (await seqOf(w1, idA)).count).toBe(20);
  await selectTopic(w1, 'seq');
  await w1.evaluate(() => window.__mqttscope.plots.addSeries(null, 'seq', null, { alias: 'Sequence' }));
  await w1.locator('#publisher-host .topic-input').fill('cmd/go');
  await w1.locator('#publisher-host .payload-editor').fill('draft payload');
  await w1.locator('#publisher-host select').nth(1).selectOption('text');

  const seen = watchClients(a);
  // Window 2 takes a while to build the tab, so the move spans several
  // batches; main counts what it held for the tab.
  await w2.page.evaluate(() => {
    const Tab = window.__mqttscope.shell.tabs[0].constructor;
    const fromState = Tab.fromState;
    Tab.fromState = (opts, state) => {
      const end = Date.now() + 300;
      while (Date.now() < end);
      return fromState.call(Tab, opts, state);
    };
  });
  await app.evaluate(() => {
    const registry = globalThis.__mqttscopeConnections;
    const release = registry.release.bind(registry);
    globalThis.__held = [];
    registry.release = (id) => {
      globalThis.__held.push(registry.get(id)?.held?.length ?? 0);
      return release(id);
    };
  });

  // 500 more; the tab moves to the first place of window 2 once 100 are out,
  // with a plot change not saved yet.
  const during = publishSeq(a, 21, 520);
  await until(() => during.sent() >= 100);
  await w1.evaluate(() => {
    const { plots } = window.__mqttscope;
    plots.model.updatePlot(plots.plots[0].id, { title: 'Renamed' });
  });
  expect(await moveTab(app, idA, w2Id, 0)).toBe(true);
  expect(during.sent(), 'the move ended while messages were still coming').toBeLessThan(500);
  await during.done;
  expect((await app.evaluate(() => globalThis.__held))[0]).toBeGreaterThan(0);

  // All of them reach the moved tab, once each and in order.
  await expect.poll(async () => (await seqOf(w2.page, idA)).count).toBe(520);
  const moved = await seqOf(w2.page, idA);
  expect(moved.history).toEqual(range(1, 520));
  expect(moved.points).toEqual(range(1, 520));
  // The same client all along.
  expect(seen).toEqual([]);
  expect(a.aedes.connectedClients).toBe(1);

  // Window 2 shows it in first place; window 1 shows tab B.
  expect(await tabIds(w2.page)).toEqual([idA, idC]);
  await expect(activeTabName(w2.page)).toHaveText('Broker A');
  await expect(w2.page).toHaveTitle('MQTT Scope — Broker A');
  expect(await tabIds(w1)).toEqual([idB]);
  await expect(activeTabName(w1)).toHaveText('Broker B');

  // Its selection, plot and draft came along; the plot change was saved.
  await expect(w2.page.locator('#viewer-host .viewer-topic')).toHaveText('seq');
  expect(
    await w2.page.evaluate(() => {
      const tab = window.__mqttscope.shell.active;
      return [tab.selected?.path, tab.publisher.topic.value, tab.publisher.payload.value, tab.publisher.format.value, tab.plots.plots[0].title];
    }),
  ).toEqual(['seq', 'cmd/go', 'draft payload', 'text', 'Renamed']);
  await waitForLayout(userData, 'a', (d) => d.tabs[0].plots[0].title === 'Renamed');

  // The connection belongs to window 2 now: it publishes from there, and
  // window 1 can no longer reach it.
  expect(await ownerOf(app, idA)).toBe(w2Id);
  const listener = await env.client(a.port);
  await listener.subscribe('cmd/go');
  expect(await w2.page.evaluate(() => window.__mqttscope.publisher.publish())).toBe(true);
  expect((await listener.waitFor((m) => m.topic === 'cmd/go')).payload.toString()).toBe('draft payload');
  await expect(w1.evaluate((id) => window.api.status(id), idA)).rejects.toThrow('Unknown connection');
  await expect(w1.evaluate(([id, w]) => window.api.moveTab(id, w, 0), [idA, w2Id])).rejects.toThrow('Unknown connection');
  expect(errors).toEqual([]);
  expect(w2.errors).toEqual([]);
});

test("a moved tab's pop-outs keep receiving and close with it in its new window", async ({ env }) => {
  const {
    brokers: [a, b],
    app,
    page: w1,
    errors,
  } = await launchThree(env);
  await a.publish('po/a', 'a1', { retain: true });
  await b.publish('po/b', 'b1', { retain: true });
  const { idA, idB, idC, w2 } = await twoWindows(app, w1);
  const w2Id = await windowIdOf(w2.page);
  const popOut = (page) => popupFrom(app, () => page.locator('#viewer-host').getByRole('button', { name: '⤢ Pop out' }).click());

  // An inspector pop-out of each tab, and a plot window of A's.
  await selectTopic(w1, 'po/b');
  const { popup: popB, errors: popBErrors } = await popOut(w1);
  await activateTab(w1, idA);
  await selectTopic(w1, 'po/a');
  const { popup: popA, errors: popAErrors } = await popOut(w1);
  await w1.evaluate(() => window.__mqttscope.plots.addSeries(null, 'po/v', null, { alias: 'Value' }));
  await w1.locator('.right-tabs .tab[data-tab="plots"]').click();
  const plotOpened = app.waitForEvent('window');
  await w1.locator('.plot-card .popout-btn').click();
  const plotWin = await plotOpened;
  await plotWin.waitForFunction(() => !!window.__plotWindow);

  // Both tabs go to window 2; window 1, left without tabs, closes. The
  // pop-outs stay.
  const w1Closed = w1.waitForEvent('close');
  expect(await moveTab(app, idA, w2Id, 1)).toBe(true);
  expect(await moveTab(app, idB, w2Id, 2)).toBe(true);
  await w1Closed;
  expect(await tabIds(w2.page)).toEqual([idC, idA, idB]);
  expect(await mainWindowCount(app)).toBe(1);
  for (const p of [popA, popB, plotWin]) expect(p.isClosed()).toBe(false);

  // They keep receiving their own connection's messages.
  await a.publish('po/a', 'a2');
  await b.publish('po/b', 'b2');
  await a.publish('po/v', '5');
  await expect(historyItems(popA).locator('.history-preview')).toHaveText(['a2', 'a1']);
  await expect(historyItems(popB).locator('.history-preview')).toHaveText(['b2', 'b1']);
  await expect.poll(() => plotWin.evaluate(() => window.__plotWindow.data.points('po/v', null).map((p) => p.v))).toEqual([5]);

  // Closing tab A in window 2 closes its pop-outs, not B's.
  const aClosed = Promise.all([popA.waitForEvent('close'), plotWin.waitForEvent('close')]);
  await w2.page.evaluate((id) => window.__mqttscope.shell.closeTab(id, { confirmed: true }), idA);
  await aClosed;
  expect(popB.isClosed()).toBe(false);
  expect(errors).toEqual([]);
  expect(w2.errors).toEqual([]);
  expect(popAErrors).toEqual([]);
  expect(popBErrors).toEqual([]);

  // Closing window 2 closes B's.
  const bClosed = popB.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find((w) => w.webContents.id === id).close(), w2Id);
  await bClosed;
});

test("moving a window's last tab closes that window", async ({ env }) => {
  const {
    brokers: [a],
    app,
    page: w1,
    userData,
    errors,
  } = await launchThree(env, { restoreTabs: false });
  await connectTo(w1, 'Broker A');
  const idA = await activeId(w1);
  const w2 = await openWindow(app, w1);
  await connectTo(w2.page, 'Broker C');
  const idC = await activeId(w2.page);
  const w2Id = await windowIdOf(w2.page);
  await app.evaluate(({ dialog }) => {
    globalThis.__asked = [];
    dialog.showMessageBox = async (...args) => {
      globalThis.__asked.push(args.find((x) => x && typeof x === 'object' && 'message' in x)?.message);
      return { response: 0 };
    };
  });

  const closed = w1.waitForEvent('close');
  expect(await moveTab(app, idA, w2Id, 1)).toBe(true);
  await closed;
  expect(await mainWindowCount(app)).toBe(1);
  expect(await app.evaluate(() => globalThis.__asked)).toEqual([]);
  expect(await tabIds(w2.page)).toEqual([idC, idA]);
  await expect(activeTabName(w2.page)).toHaveText('Broker A');

  // The closed window is forgotten: the next launch has one window, with both tabs.
  await waitForFile(path.join(userData, 'windowState.json'), (buf) => {
    const { windows } = JSON.parse(buf);
    return windows.length === 1 && windows[0].tabs.map((t) => t.profileId).join() === 'c,a';
  });
  await a.publish('still/here', '1');
  await expect.poll(() => w2.page.evaluate((id) => window.__mqttscope.shell.tabs.find((t) => t.connId === id).tree.find('still/here')?.messageCount ?? 0, idA)).toBe(1);
  expect(a.aedes.connectedClients).toBe(1);
  expect(errors).toEqual([]);
  expect(w2.errors).toEqual([]);
});

test('Move to new window opens a window with just that tab', async ({ env }) => {
  const {
    brokers: [a],
    app,
    page: w1,
    errors,
  } = await launchThree(env);
  await connectTo(w1, 'Broker A');
  const idA = await activeId(w1);
  await a.publish('hello', 'there');
  await expect.poll(() => w1.evaluate(() => window.__mqttscope.tree.find('hello')?.messageCount ?? 0)).toBe(1);
  const idB = await openTabTo(w1, 'Broker B');
  const w1Id = await windowIdOf(w1);
  const bounds = { x: 100, y: 80, width: 1300, height: 850 };
  await app.evaluate(({ BrowserWindow }, [id, b]) => BrowserWindow.getAllWindows().find((w) => w.webContents.id === id).setBounds(b), [w1Id, bounds]);
  const seen = watchClients(a);

  await tabEl(w1, idA).click({ button: 'right' });
  expect(await menuLabels(w1)).toContain('Move to new window');
  expect(await w1.locator('.ctx-menu .ctx-item.disabled').allTextContents()).not.toContain('Move to new window');
  const opened = app.waitForEvent('window');
  await menu(w1, 'Move to new window');
  const w3 = await opened;
  const w3Errors = [];
  w3.on('pageerror', (e) => w3Errors.push(String(e)));
  await w3.waitForFunction(() => window.__mqttscope?.shell.tabs.length === 1);
  expect(await tabIds(w3)).toEqual([idA]);
  await expect(activeTabName(w3)).toHaveText('Broker A');
  expect(await w3.evaluate(() => [window.__mqttscope.status.state, window.__mqttscope.tree.find('hello')?.messageCount])).toEqual(['connected', 1]);
  expect(await tabIds(w1)).toEqual([idB]);
  expect(await mainWindowCount(app)).toBe(2);
  // Cascaded from window 1, at its size.
  const w3Id = await windowIdOf(w3);
  expect(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find((w) => w.webContents.id === id).getNormalBounds(), w3Id)).toEqual({
    ...bounds,
    x: bounds.x + 30,
    y: bounds.y + 30,
  });

  // The connection carries on there.
  await a.publish('hello', 'again');
  await expect.poll(() => w3.evaluate(() => window.__mqttscope.tree.find('hello').messageCount)).toBe(2);
  expect(seen).toEqual([]);
  expect(await ownerOf(app, idA)).toBe(w3Id);

  // A window's only tab has nowhere new to go.
  for (const [page, id] of [
    [w1, idB],
    [w3, idA],
  ]) {
    await tabEl(page, id).click({ button: 'right' });
    expect(await page.locator('.ctx-menu .ctx-item.disabled').allTextContents()).toContain('Move to new window');
    await page.keyboard.press('Escape');
  }
  expect(errors).toEqual([]);
  expect(w3Errors).toEqual([]);
});

test('a move that fails gives the tab back to its window, with what arrived meanwhile', async ({ env }) => {
  const {
    brokers: [a],
    app,
    page: w1,
    errors,
  } = await launchThree(env);
  const { idA, idB, idC, w2 } = await twoWindows(app, w1);
  const w1Id = await windowIdOf(w1);
  const w2Id = await windowIdOf(w2.page);
  await publishSeq(a, 1, 10).done;
  await expect.poll(async () => (await seqOf(w1, idA)).count).toBe(10);
  const seen = watchClients(a);

  // Window 2 cannot build the tab, after a while.
  await w2.page.evaluate(() => {
    const Tab = window.__mqttscope.shell.tabs[0].constructor;
    Tab.fromState = () => {
      const end = Date.now() + 300;
      while (Date.now() < end);
      throw new Error('Cannot build it');
    };
  });
  const during = publishSeq(a, 11, 300);
  await until(() => during.sent() >= 50);
  expect(await moveTab(app, idA, w2Id, 0)).toBe(false);
  await during.done;

  // Back in its place in window 1, not shown (it was not), with every message.
  expect(await tabIds(w1)).toEqual([idA, idB]);
  expect(await activeId(w1)).toBe(idB);
  await expect.poll(async () => (await seqOf(w1, idA)).count).toBe(300);
  expect((await seqOf(w1, idA)).history).toEqual(range(1, 300));
  expect(await ownerOf(app, idA)).toBe(w1Id);
  expect(seen).toEqual([]);
  expect(await w1.evaluate((id) => window.api.status(id).then((s) => s.state), idA)).toBe('connected');
  // Window 2 is as it was.
  expect(await tabIds(w2.page)).toEqual([idC]);
  expect(await mainWindowCount(app)).toBe(2);
  expect(errors).toEqual([]);
  expect(w2.errors).toEqual([]);
});

test("a tab dropped on another window's strip goes there, at the drop position", async ({ env }) => {
  const {
    brokers: [a],
    app,
    page: w1,
    errors,
  } = await launchThree(env);
  const { idA, idB, idC, w2 } = await twoWindows(app, w1);
  const w2Id = await windowIdOf(w2.page);
  await a.publish('hello', 'there');
  await expect.poll(() => countOf(w1, idA, 'hello')).toBe(1);
  const seen = watchClients(a);

  // Window 2 takes a tab drag only while main reports one.
  expect(await takesDrag(w2.page)).toBe(false);
  await dragStart(w1, idA);
  await expect.poll(() => takesDrag(w2.page)).toBe(true);
  // Dropped after tab C: it goes there, shown, with its connection.
  expect(await dropAt(w2.page, 1)).toBe(true);
  expect(await tabIds(w2.page)).toEqual([idC, idA]);
  await expect(activeTabName(w2.page)).toHaveText('Broker A');
  expect(await countOf(w2.page, idA, 'hello')).toBe(1);
  expect(await ownerOf(app, idA)).toBe(w2Id);
  expect(await tabIds(w1)).toEqual([idB]);
  expect(seen).toEqual([]);
  // Window 1 then reports the end of the drag: it was dropped, so that is all.
  expect(await dragEnd(w1, false)).toBe(null);
  expect(await mainWindowCount(app)).toBe(2);
  await expect.poll(() => takesDrag(w2.page)).toBe(false);
  // A drop with no drag going on takes nothing.
  expect(await dropAt(w2.page, 0)).toBe(null);

  // The end may come first: main waits a moment for the drop. Window 1, left
  // without tabs, closes.
  await dragStart(w1, idB);
  const w1Closed = w1.waitForEvent('close');
  await w1.evaluate(() => {
    window.api.tabDragEnd({ overSource: false });
  });
  await sleep(50);
  expect(await dropAt(w2.page, 0)).toBe(true);
  await w1Closed;
  expect(await tabIds(w2.page)).toEqual([idB, idC, idA]);
  await sleep(500); // longer than main waits for a drop
  expect(await mainWindowCount(app)).toBe(1);
  expect(errors).toEqual([]);
  expect(w2.errors).toEqual([]);
});

test('a tab let go outside every window opens a window of its own; over its own window nothing happens', async ({ env }) => {
  const {
    brokers: [a],
    app,
    page: w1,
    errors,
  } = await launchThree(env);
  await connectTo(w1, 'Broker A');
  const idA = await activeId(w1);
  const idB = await openTabTo(w1, 'Broker B');
  const w1Id = await windowIdOf(w1);
  const bounds = { x: 100, y: 80, width: 1300, height: 850 };
  await app.evaluate(({ BrowserWindow }, [id, b]) => BrowserWindow.getAllWindows().find((w) => w.webContents.id === id).setBounds(b), [w1Id, bounds]);
  await app.evaluate(({ screen }) => {
    screen.getCursorScreenPoint = () => ({ x: 900, y: 500 });
  });
  const seen = watchClients(a);

  // Let go over its own window (or Esc there): nothing.
  await dragStart(w1, idA);
  expect(await dragEnd(w1, true)).toBe(null);
  expect(await mainWindowCount(app)).toBe(1);
  expect(await tabIds(w1)).toEqual([idA, idB]);

  // Outside every window: a window with just that tab, under the pointer,
  // the size of the one it came from.
  await dragStart(w1, idA);
  const opened = app.waitForEvent('window');
  expect(await dragEnd(w1, false)).toBe(true);
  const w3 = await opened;
  await w3.waitForFunction(() => window.__mqttscope?.shell.tabs.length === 1);
  expect(await tabIds(w3)).toEqual([idA]);
  expect(await w3.evaluate(() => window.__mqttscope.status.state)).toBe('connected');
  expect(await tabIds(w1)).toEqual([idB]);
  const w3Id = await windowIdOf(w3);
  expect(await ownerOf(app, idA)).toBe(w3Id);
  expect(await boundsOf(app, w3Id)).toEqual({ x: 900 - 60, y: 500 - 15, width: bounds.width, height: bounds.height });
  expect(seen).toEqual([]);

  // Only the window a drag started in can end it.
  await dragStart(w1, idB);
  expect(await dragEnd(w3, false)).toBe(null);
  expect(await dragEnd(w1, true)).toBe(null);
  expect(await mainWindowCount(app)).toBe(2);
  expect(errors).toEqual([]);
});

test('the strip reports a drag of its tab and takes a drop of one from another window', async ({ env }) => {
  const { app, page: w1, errors } = await launchThree(env);
  const { idA, idB, idC, w2 } = await twoWindows(app, w1);

  // Tab A's drag carries its id in a type of its own, not as text.
  expect(await startDragging(w1, idA)).toEqual({ 'application/x-mqttscope-tab': idA });
  await atDragged(w1, 'dragleave'); // out of window 1
  // Window 2's strip takes it, marks where it would go, and it goes there.
  await expect.poll(() => dragEvent(w2.page, 'dragover', idC, 0.75)).toBe(true);
  await expect(tabEl(w2.page, idC)).toHaveClass(/drop-after/);
  await dragEvent(w2.page, 'drop', idC, 0.75);
  await expect.poll(() => tabIds(w2.page)).toEqual([idC, idA]);
  await expect(w2.page.locator('.conn-tab.drop-before, .conn-tab.drop-after')).toHaveCount(0);
  expect(await tabIds(w1)).toEqual([idB]);
  // The drag ends in window 1, at the tab that has left it: nothing more.
  await sleep(300);
  await atDragged(w1, 'dragend');
  await sleep(500); // longer than main waits for a drop
  expect(await mainWindowCount(app)).toBe(2);
  expect(await takesDrag(w2.page)).toBe(false);

  // Esc, or letting go where nothing takes it, over window 1: the pointer
  // leaves its last element just before the drag ends. Nothing happens.
  await startDragging(w1, idB);
  await atDragged(w1, 'dragleave', 'dragend');
  await sleep(500);
  expect(await mainWindowCount(app)).toBe(2);
  expect(await tabIds(w1)).toEqual([idB]);

  // Across window 1, over an element re-rendered meanwhile (it gets its leave
  // once out of the document), out of the window and let go a while later
  // where no window takes it: a window of its own. Window 1, left without
  // tabs, closes.
  await startDragging(w1, idB);
  await w1.evaluate(() => {
    const at = (el, type, relatedTarget) => el.dispatchEvent(new DragEvent(type, { bubbles: true, relatedTarget }));
    const tab = window.__dragged;
    const host = document.querySelector('#tab-host');
    const row = host.appendChild(document.createElement('div'));
    at(row, 'dragenter', tab);
    at(tab, 'dragleave', row);
    row.remove();
    at(host, 'dragenter', row);
    at(row, 'dragleave', host);
    at(host, 'dragleave', null);
  });
  await sleep(300);
  const opened = app.waitForEvent('window');
  const w1Closed = w1.waitForEvent('close');
  await atDragged(w1, 'dragend');
  const w3 = await opened;
  await w3.waitForFunction(() => window.__mqttscope?.shell.tabs.length === 1);
  expect(await tabIds(w3)).toEqual([idB]);
  await w1Closed;
  expect(await mainWindowCount(app)).toBe(2);
  expect(errors).toEqual([]);
  expect(w2.errors).toEqual([]);
});

test('a pop-out cannot reach its connection while the tab is between windows', async ({ env }) => {
  const {
    brokers: [a],
    app,
    page: w1,
  } = await launchThree(env);
  await a.publish('po/a', 'a1', { retain: true });
  const { idA, w2 } = await twoWindows(app, w1);
  const w2Id = await windowIdOf(w2.page);
  await activateTab(w1, idA);
  await selectTopic(w1, 'po/a');
  const { popup } = await popupFrom(app, () => w1.locator('#viewer-host').getByRole('button', { name: '⤢ Pop out' }).click());
  const status = () => popup.evaluate((id) => window.api.status(id).then((s) => s.state), idA);
  expect(await status()).toBe('connected');

  // Window 2 takes a while to build the tab; meanwhile it belongs to no window.
  await w2.page.evaluate(() => {
    const Tab = window.__mqttscope.shell.tabs[0].constructor;
    const fromState = Tab.fromState;
    Tab.fromState = (opts, state) => {
      const end = Date.now() + 2000;
      while (Date.now() < end);
      return fromState.call(Tab, opts, state);
    };
  });
  await app.evaluate((_electron, [c, w]) => {
    globalThis.__moving = globalThis.__mqttscopeMoveTab(c, w, 0);
  }, [idA, w2Id]);
  await expect.poll(() => ownerOf(app, idA), { intervals: [20] }).toBe(null);
  await expect(status()).rejects.toThrow('Unknown connection');
  expect(await app.evaluate(() => globalThis.__moving)).toBe(true);
  expect(await status()).toBe('connected');
});

test('a window that reloads while its tab is leaving stays open', async ({ env }) => {
  const { app, page: w1 } = await launchThree(env);
  await connectTo(w1, 'Broker A');
  const idA = await activeId(w1);
  const w2 = await openWindow(app, w1);
  await connectTo(w2.page, 'Broker C');
  const idC = await activeId(w2.page);
  const w1Id = await windowIdOf(w1);
  const w2Id = await windowIdOf(w2.page);

  // Tab A, the window's only one, takes its time to leave; the window
  // reloads meanwhile.
  await w1.evaluate(() => {
    window.__mqttscope.shell.active.settle = () => new Promise(() => {});
  });
  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.id === id)
      .on('close', () => (globalThis.__closing = true));
  }, w1Id);
  await app.evaluate((_electron, [c, w]) => {
    globalThis.__moving = globalThis.__mqttscopeMoveTab(c, w, 0);
  }, [idA, w2Id]);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find((w) => w.webContents.id === id).webContents.reload(), w1Id);
  expect(await app.evaluate(() => globalThis.__moving)).toBe(false);

  // It starts over with a New connection tab; window 2 is as it was.
  await w1.waitForFunction(() => window.__mqttscope?.shell.tabs.length === 1);
  await expect(w1.locator('.conn-dialog')).toBeVisible();
  expect(await app.evaluate(() => globalThis.__closing ?? false), 'the window was not closed').toBe(false);
  expect(await mainWindowCount(app)).toBe(2);
  expect(await tabIds(w2.page)).toEqual([idC]);
});

test('a window that is closing takes no tab; the tab stays where it was', async ({ env }) => {
  const {
    brokers: [a],
    app,
    page: w1,
  } = await launchThree(env);
  const { idA, idB, w2 } = await twoWindows(app, w1);
  const w1Id = await windowIdOf(w1);
  const w2Id = await windowIdOf(w2.page);

  // Window 2 closes, taking a while to save its tab's plots.
  await w2.page.evaluate(() => {
    window.__mqttscope.shell.tabs[0].flush = () => {
      window.__flushing = true;
      return new Promise((resolve) => setTimeout(resolve, 1000));
    };
  });
  const closed = w2.page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find((w) => w.webContents.id === id).close(), w2Id);
  await w2.page.waitForFunction(() => window.__flushing);
  await expect(moveTab(app, idA, w2Id, 0)).rejects.toThrow('Unknown window');
  await closed;

  // Tab A is still in window 1, with its connection.
  expect(await tabIds(w1)).toEqual([idA, idB]);
  expect(await ownerOf(app, idA)).toBe(w1Id);
  await a.publish('still/here', '1');
  await expect.poll(() => countOf(w1, idA, 'still/here')).toBe(1);
});

test('a tab that cannot move says so in its window', async ({ env }) => {
  const { app, page: w1 } = await launchThree(env);
  const { idA, idB, idC, w2 } = await twoWindows(app, w1);

  // Move to new window, with tab A unable to leave: it stays, and says so.
  await w1.evaluate((id) => {
    window.__mqttscope.shell.tabs.find((t) => t.connId === id).settle = () => Promise.reject(new Error('Busy'));
  }, idA);
  await tabEl(w1, idA).click({ button: 'right' });
  await menu(w1, 'Move to new window');
  await expect(toast(w1, 'error')).toHaveText(['Could not move the tab']);
  await expect.poll(() => mainWindowCount(app)).toBe(2);
  expect(await tabIds(w1)).toEqual([idA, idB]);

  // A drop of a tab that went away meanwhile: the window it is dropped on
  // says why.
  await dragStart(w1, idB);
  await w1.evaluate((id) => window.__mqttscope.shell.closeTab(id, { confirmed: true }), idB);
  await expect.poll(() => dragEvent(w2.page, 'dragover', idC)).toBe(true);
  await dragEvent(w2.page, 'drop', idC);
  await expect(toast(w2.page, 'error')).toHaveText(['Could not move the tab: Unknown connection']);
  expect(await tabIds(w2.page)).toEqual([idC]);
});
