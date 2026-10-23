// Several connections per window, each in its own tab (ConnectionTab). Tabs
// are opened, switched and closed through the test hook's shell here; the
// tab strip itself is tested in tabs.spec.mjs.

import { test, expect, profile, waitForTopic, selectTopic } from './fixtures.mjs';

const tabCount = (page) => page.evaluate(() => window.__mqttscope.shell.tabs.length);
const activate = (page, index) => page.evaluate((i) => window.__mqttscope.shell.activate(window.__mqttscope.shell.tabs[i].connId), index);
const box = (page, selector) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().toJSON(), selector);

// Opens a tab (it becomes the active one) and, with a port, connects it.
async function openTab(page, port) {
  await page.evaluate(async (p) => {
    const tab = await window.__mqttscope.shell.openTab();
    if (p) await tab.connect(p);
  }, port ? profile(port) : null);
  if (port) await page.waitForFunction(() => window.__mqttscope.shell.active.status.state === 'connected');
}

async function dragBy(page, selector, dx, dy) {
  const r = await box(page, selector);
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}

test('a hidden tab keeps receiving and recording, and skips drawing', async ({ env }) => {
  const a = await env.broker();
  const b = await env.broker();
  const { page, errors } = await env.connected(a);
  await openTab(page, b.port);
  expect(await tabCount(page)).toBe(2);
  await page.evaluate(() => window.__mqttscope.shell.tabs[1].plots.addSeries(null, 'b/value', null, { quiet: true }));
  await activate(page, 0);

  for (let i = 0; i < 100; i++) await b.publish('b/value', String(i));
  const hidden = () =>
    page.evaluate(() => {
      const tab = window.__mqttscope.shell.tabs[1];
      return {
        count: tab.tree.find('b/value')?.messageCount ?? 0,
        points: tab.plots.points('b/value', null).length,
        attached: document.contains(tab.root),
        stats: tab.root.querySelector('#stat-msgs').textContent,
      };
    });
  await expect.poll(async () => (await hidden()).count).toBe(100);
  const h = await hidden();
  expect(h.points).toBeGreaterThanOrEqual(100);
  expect(h.attached).toBe(false);
  expect(h.stats).toBe('0 messages'); // not drawn while hidden
  // The active tab (broker A) got none of it.
  expect(await page.evaluate(() => window.__mqttscope.tree.find('b/value'))).toBeNull();
  await expect(page.locator('#stat-msgs')).toHaveText('0 messages');

  await activate(page, 1);
  await expect(page.locator('#stat-msgs')).toContainText('100');
  expect(await page.locator('#tree-scroll .tree-row:not([hidden]) .name').allTextContents()).toContain('b');
  expect(errors).toEqual([]);
});

test('switching tabs keeps selection, expansion, scroll position and the inspector', async ({ env }) => {
  const a = await env.broker();
  for (let i = 0; i < 150; i++) await a.publish(`many/t${String(i).padStart(3, '0')}`, String(i), { retain: true });
  const big = JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`key${i}`, i])));
  await a.publish('deep/doc', big, { retain: true });
  const { page, errors } = await env.connected(a);
  await waitForTopic(page, 'deep/doc');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.topicCount)).toBe(151);

  await selectTopic(page, 'deep/doc');
  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText('deep/doc');
  await page.evaluate(() => window.__mqttscope.viewer.toggleLive()); // hold the message
  await page.evaluate(() => window.__mqttscope.tree.setExpandedRecursive(window.__mqttscope.tree.find('many'), true));
  await page.evaluate(() => window.__mqttscope.treeView.refresh());
  await page.evaluate(() => {
    document.querySelector('#tree-scroll').scrollTop = 1200;
    document.querySelector('#viewer-host .viewer-body').scrollTop = 900;
  });
  const before = await page.evaluate(() => ({
    tree: document.querySelector('#tree-scroll').scrollTop,
    viewer: document.querySelector('#viewer-host .viewer-body').scrollTop,
  }));
  expect(before.tree).toBe(1200);
  expect(before.viewer).toBe(900);

  await openTab(page);
  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText('No topic selected');
  await expect(page.locator('#status-selected')).toHaveText('');
  await activate(page, 0);

  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText('deep/doc');
  await expect(page.locator('#viewer-host .viewer .live')).toHaveText('❚❚ Held');
  await expect(page.locator('#status-selected')).toHaveText('deep/doc');
  const after = await page.evaluate(() => {
    const { tree, treeView } = window.__mqttscope;
    return {
      tree: document.querySelector('#tree-scroll').scrollTop,
      viewer: document.querySelector('#viewer-host .viewer-body').scrollTop,
      selected: treeView.selected?.path,
      expanded: tree.find('many').expanded,
    };
  });
  expect(after).toEqual({ ...before, selected: 'deep/doc', expanded: true });
  // The rows at that scroll position are drawn (not the top of the tree).
  await expect(page.locator('#tree-scroll .tree-row:not([hidden]) .name').filter({ hasText: 't060' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a closed tab stops its timers and observers', async ({ env }) => {
  const { app, page, errors } = await env.launch();
  // Count document and window listeners and observers the tabs add and remove.
  await page.evaluate(() => {
    const net = (window.__net = { listeners: {}, observers: 0, intervals: new Set() });
    for (const target of [document, window]) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      const key = (type) => `${target === document ? 'document' : 'window'}:${type}`;
      target.addEventListener = (type, ...rest) => {
        net.listeners[key(type)] = (net.listeners[key(type)] || 0) + 1;
        return add(type, ...rest);
      };
      target.removeEventListener = (type, ...rest) => {
        net.listeners[key(type)] = (net.listeners[key(type)] || 0) - 1;
        return remove(type, ...rest);
      };
    }
    const RO = window.ResizeObserver;
    window.ResizeObserver = class extends RO {
      constructor(cb) {
        super(cb);
        net.observers++;
      }
      disconnect() {
        if (!this.done) net.observers--;
        this.done = true;
        super.disconnect();
      }
    };
    const setI = window.setInterval;
    const clearI = window.clearInterval;
    window.setInterval = (...args) => {
      const id = setI(...args);
      net.intervals.add(id);
      return id;
    };
    window.clearInterval = (id) => {
      net.intervals.delete(id);
      clearI(id);
    };
  });

  const closed = await page.evaluate(async () => {
    const { shell } = window.__mqttscope;
    const out = [];
    for (let i = 0; i < 20; i++) {
      const tab = await shell.openTab();
      tab.handlers.tabPlots(); // the Plots tab draws on a timer while shown
      await shell.closeTab(tab.connId);
      out.push({ redrawTimer: tab.plots.redrawTimer, resizeObserver: tab.treeView.resizeObserver, attached: document.contains(tab.root) });
    }
    return out;
  });
  expect(closed).toHaveLength(20);
  for (const t of closed) expect(t).toEqual({ redrawTimer: null, resizeObserver: null, attached: false });
  expect(await tabCount(page)).toBe(1);
  const net = await page.evaluate(() => ({
    listeners: Object.fromEntries(Object.entries(window.__net.listeners).filter(([, n]) => n !== 0)),
    observers: window.__net.observers,
    intervals: window.__net.intervals.size,
  }));
  expect(net).toEqual({ listeners: {}, observers: 0, intervals: 0 });
  expect(await app.evaluate(() => globalThis.__mqttscopeConnections.size)).toBe(1);
  expect(errors).toEqual([]);
});

test('closing the last tab leaves a fresh one', async ({ env }) => {
  const a = await env.broker();
  const { app, page, errors } = await env.connected(a);
  const first = await page.evaluate(() => window.__mqttscope.shell.active.connId);
  await page.evaluate((id) => window.__mqttscope.shell.closeTab(id), first);
  await expect.poll(() => a.aedes.connectedClients).toBe(0);
  expect(await tabCount(page)).toBe(1);
  const next = await page.evaluate(() => ({ id: window.__mqttscope.shell.active.connId, label: window.__mqttscope.shell.active.label }));
  expect(next.id).not.toBe(first);
  expect(next.label).toBe('New connection');
  await expect(page.locator('.conn-dialog')).toBeVisible();
  expect(await app.evaluate(() => globalThis.__mqttscopeConnections.size)).toBe(1);
  expect(errors).toEqual([]);
});

test('connecting a tab to a profile open in another tab leaves the tab as it was', async ({ env }) => {
  const a = await env.broker();
  await a.publish('a/topic', '1', { retain: true });
  const { page, errors } = await env.connected(a);
  await waitForTopic(page, 'a/topic');
  await openTab(page);
  const res = await page.evaluate((p) => window.__mqttscope.shell.active.connect(p), profile(a.port));
  expect(res.duplicate).toBeTruthy();
  await expect(page.locator('.toast.error')).toHaveText(`“Test broker ${a.port}” is already open`);
  const tab = await page.evaluate(() => ({ profile: window.__mqttscope.shell.active.profile, state: window.__mqttscope.status.state }));
  expect(tab).toEqual({ profile: null, state: 'disconnected' });
  // The first tab keeps its tree.
  await activate(page, 0);
  expect(await page.evaluate(() => window.__mqttscope.tree.find('a/topic')?.messageCount)).toBe(1);
  expect(errors).toEqual([]);
});

test('panel sizes are shared by all tabs', async ({ env }) => {
  const { page, errors } = await env.launch();
  await page.locator('.conn-dialog .modal-close').click();
  const treeWidth = async () => (await box(page, '.tree-pane')).width;
  const pubHeight = async () => (await box(page, '#publisher-host')).height;

  const start = await treeWidth();
  await dragBy(page, '#split-main', 120, 0);
  const wide = await treeWidth();
  expect(wide).toBeCloseTo(start + 120, 0);
  await dragBy(page, '#split-right', 0, -60);
  const tall = await pubHeight();

  await openTab(page);
  expect(await treeWidth()).toBe(wide);
  expect(await pubHeight()).toBe(tall);

  // A drag in one tab starts from the size another tab left.
  await dragBy(page, '#split-main', -50, 0);
  // So is the inspector's view mode.
  await page.locator('#viewer-host .viewer-toolbar .tab[data-mode="raw"]').click();
  await activate(page, 0);
  expect(await treeWidth()).toBeCloseTo(wide - 50, 0);
  await dragBy(page, '#split-main', 10, 0);
  expect(await treeWidth()).toBeCloseTo(wide - 40, 0);
  expect(await page.evaluate(() => window.__mqttscope.viewer.mode)).toBe('raw');
  expect(errors).toEqual([]);
});

test('each tab has its own publisher topic list', async ({ env }) => {
  const a = await env.broker();
  await a.publish('only/in/a', '1', { retain: true });
  const { page, errors } = await env.connected(a);
  await waitForTopic(page, 'only/in/a');
  await openTab(page);
  const ids = await page.evaluate(() => window.__mqttscope.shell.tabs.map((t) => t.publisher.topicList.id));
  expect(new Set(ids).size).toBe(2);
  expect(errors).toEqual([]);
});

test('a plot popped out of a tab without a profile is titled by the plot alone', async ({ env }) => {
  const { app, page, errors } = await env.launch();
  await page.locator('.conn-dialog .modal-close').click();
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'hall/temp', null, { alias: 'Temperature' }));
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  const opened = app.waitForEvent('window');
  await page.locator('.plot-card .popout-btn').click();
  const win = await opened;
  await expect(win).toHaveTitle('Temperature');
  expect(errors).toEqual([]);
});
