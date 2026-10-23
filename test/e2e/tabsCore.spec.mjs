// Several connections per window, each in its own tab (ConnectionTab). Tabs
// are opened, switched and closed through the test hook's shell here; the
// tab strip itself is tested in tabs.spec.mjs.

import { test, expect, makeUserData, profile, connect, waitForTopic, selectTopic } from './fixtures.mjs';

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

  const b = await env.broker();
  await openTab(page, b.port);
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

test('connecting a tab to a profile open in another tab shows that tab and closes the picker', async ({ env }) => {
  const a = await env.broker();
  await a.publish('a/topic', '1', { retain: true });
  const { page, errors } = await env.connected(a);
  await waitForTopic(page, 'a/topic');
  const first = await page.evaluate(() => window.__mqttscope.shell.active.connId);
  await openTab(page);
  const res = await page.evaluate((p) => window.__mqttscope.shell.active.connect(p), profile(a.port));
  expect(res.duplicate).toBeTruthy();
  expect(await page.evaluate(() => window.__mqttscope.shell.tabs.length)).toBe(1);
  expect(await page.evaluate(() => window.__mqttscope.shell.active.connId)).toBe(first);
  expect(await page.evaluate(() => window.__mqttscope.tree.find('a/topic')?.messageCount)).toBe(1);
  expect(errors).toEqual([]);
});

test('panel sizes are shared by all tabs', async ({ env }) => {
  const a = await env.broker();
  const b = await env.broker();
  const { page, errors } = await env.connected(a);
  const treeWidth = async () => (await box(page, '.tree-pane')).width;
  const pubHeight = async () => (await box(page, '#publisher-host')).height;

  const start = await treeWidth();
  await dragBy(page, '#split-main', 120, 0);
  const wide = await treeWidth();
  expect(wide).toBeCloseTo(start + 120, 0);
  await dragBy(page, '#split-right', 0, -60);
  const tall = await pubHeight();

  await openTab(page, b.port);
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

// What a tab shows and holds, read from the active tab and the document.
const tabState = (page) =>
  page.evaluate(() => {
    const tab = window.__mqttscope.shell.active;
    const { tree, viewer, plots, publisher } = tab;
    const text = (m) => new TextDecoder().decode(m.payload);
    const nodes = [];
    const walk = (node) => {
      for (const n of node.children.values()) {
        const history = n.history.map((m) => [m.ts, text(m), m.payload instanceof Uint8Array, m.qos, m.retain]);
        nodes.push([n.path, n.messageCount, n.subtreeMessages, n.subtreeTopics, n.lastUpdate, n.selfUpdate, n.retained, n.expanded, history]);
        walk(n);
      }
    };
    walk(tree.root);
    const $ = (s) => document.querySelector(s);
    return {
      tab: [tab.connId, tab.label, tab.mode, tab.status.state, tab.everConnected, tab.rightPanel, !$('#plots-host').hidden],
      counts: [tree.topicCount, tree.messageCount],
      nodes,
      rows: tab.treeView.rows.map((r) => r.node.path),
      selected: [tab.selected?.path, tab.treeView.selected?.path, $('#status-selected').textContent],
      filter: [$('#tree-filter').value, $('#filter-values').checked, !!tab.treeView.filter],
      viewer: {
        source: viewer.source?.path,
        held: viewer.pinned && [viewer.pinned.ts, text(viewer.pinned), viewer.pinned === viewer.source.history[0]],
        query: [viewer.query, viewer.search.value],
        expanded: [...viewer.expandedByTopic].map(([t, s]) => [t, [...s].sort()]),
        chart: [...viewer.plotByTopic],
      },
      publisher: [publisher.topic.value, publisher.payload.value, publisher.format.value, publisher.qos.value, publisher.retain.checked, publisher.follow],
      plots: {
        doc: JSON.stringify(plots.model.toDoc()),
        points: plots.points('robot/value', null),
        zoom: [[...plots.zoomByTab], [...plots.yZoom]],
        frozenAt: plots.frozenAt,
        selected: plots.selectedId,
        drawn: [document.querySelectorAll('#plots-host .plot-card').length, $('#plots-host .zoom-reset').hidden, $('#plots-host .plots-toolbar').textContent],
      },
      pause: [tab.paused, $('#btn-pause').textContent, tab.pauseQueue.map(text), tab.droppedTotal],
    };
  });

test("a tab's state survives export and import", async ({ env }) => {
  const a = await env.broker();
  await a.publish('robot/state', JSON.stringify({ battery: 80, pose: { x: 1, y: 2 } }), { retain: true });
  await a.publish('robot/arm/joint1', '1', { retain: true });
  await a.publish('robot/arm/joint2', '2', { retain: true });
  const { app, page, errors } = await env.connected(a);
  await waitForTopic(page, 'robot/arm/joint2');
  await a.publish('robot/state', JSON.stringify({ battery: 79, pose: { x: 1, y: 3 } }));
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('robot/state').messageCount)).toBe(2);

  // A second tab, so the tab's place in the strip counts.
  await openTab(page);
  await activate(page, 0);
  const id = await page.evaluate(() => window.__mqttscope.shell.active.connId);

  // Expanded nodes, the selection and the inspector: held on the older
  // message, its JSON collapsed, searched, a field charted.
  await page.evaluate(() => {
    const { tree, treeView } = window.__mqttscope;
    tree.find('robot/arm').expanded = true; // a branch with no message of its own
    treeView.refresh();
  });
  await selectTopic(page, 'robot/state');
  await page.evaluate(() => {
    const { viewer } = window.__mqttscope;
    viewer.pinned = viewer.source.history[0];
    viewer.render(true);
    viewer.expandAll(false);
    viewer.plotByTopic.set('robot/state', { segs: ['battery'], label: 'battery' });
  });
  await page.locator('#viewer-host .viewer .search').fill('pose');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.viewer.query)).toBe('pose');

  // The filter and a publisher draft.
  await page.locator('#tree-filter').fill('robot');
  await page.locator('#filter-values').check();
  await expect.poll(() => page.evaluate(() => !!window.__mqttscope.treeView.filter)).toBe(true);
  await page.locator('#publisher-host .topic-input').fill('cmd/go');
  await page.locator('#publisher-host .payload-editor').fill('go now');
  await page.locator('#publisher-host select').nth(0).selectOption('2');
  await page.locator('#publisher-host select').nth(1).selectOption('text');
  await page.locator('#publisher-host .pub-row .check input').check();

  // A plot with points, zoomed and frozen, on screen.
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'robot/value', null));
  for (let i = 1; i <= 5; i++) await a.publish('robot/value', String(i));
  await expect.poll(() => page.evaluate(() => window.__mqttscope.plots.points('robot/value', null).length)).toBe(5);
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  await page.evaluate(() => {
    const { plots } = window.__mqttscope;
    const pts = plots.points('robot/value', null);
    plots.zoom(plots.plots[0], { t0: pts[0].t - 1, t1: pts[4].t + 1, yMin: 0, yMax: 10 });
    plots.toggleFreeze();
  });

  // Paused with a queue.
  await page.locator('#btn-pause').click();
  for (let i = 6; i <= 8; i++) await a.publish('robot/value', String(i));
  await expect.poll(() => page.evaluate(() => window.__mqttscope.shell.active.pauseQueue.length)).toBe(3);
  await page.evaluate(() => (window.__mqttscope.shell.active.droppedTotal = 7));

  const before = await tabState(page);
  expect(before.viewer.held).toEqual([expect.any(Number), expect.stringContaining('80'), true]);
  expect(before.plots.zoom[1]).toHaveLength(1);
  const order = await page.evaluate(() => window.__mqttscope.shell.tabs.map((t) => t.connId));

  await page.evaluate((i) => {
    window.__old = window.__mqttscope.shell.active;
    window.__mqttscope.shell.reimport(i);
  }, id);
  expect(await page.evaluate(() => window.__mqttscope.shell.active !== window.__old && !document.contains(window.__old.root))).toBe(true);
  expect(await page.evaluate(() => window.__mqttscope.shell.tabs.map((t) => t.connId))).toEqual(order);
  expect(await tabState(page)).toEqual(before);
  await expect(page.locator('#stat-rate')).toHaveText('paused · 3 queued');
  await expect(page.locator('#status-dropped')).toHaveText('7 messages dropped (too fast)');
  await expect(page.locator('#status-text')).toContainText('Connected');
  await expect(page.locator('#plots-host .plot-card')).toHaveCount(1);

  // The same connection: what was queued and what arrives now reach the new tab.
  await page.locator('#btn-pause').click();
  await a.publish('robot/value', '9');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.plots.points('robot/value', null).map((p) => p.v))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(await page.evaluate(() => window.__mqttscope.tree.find('robot/value').messageCount)).toBe(9);
  expect(a.aedes.connectedClients).toBe(1);
  expect(await app.evaluate(() => globalThis.__mqttscopeConnections.size)).toBe(2);

  // Plot changes are still saved for the profile: one not saved yet when the
  // tab is rebuilt, and one made after.
  const savedTitle = () => page.evaluate(async () => (await window.api.layoutGet(window.__mqttscope.shell.active.profile.id)).doc.tabs[0].plots[0].title);
  await page.evaluate((i) => {
    const { plots, shell } = window.__mqttscope;
    plots.model.updatePlot(plots.plots[0].id, { title: 'Unsaved' });
    shell.reimport(i);
  }, id);
  await expect.poll(savedTitle).toBe('Unsaved');
  await page.evaluate(() => window.__mqttscope.plots.model.updatePlot(window.__mqttscope.plots.plots[0].id, { title: 'Later' }));
  await expect.poll(savedTitle).toBe('Later');

  // An inactive tab stays where it was, inactive.
  const other = order.find((t) => t !== id);
  await page.evaluate((i) => window.__mqttscope.shell.reimport(i), other);
  expect(await page.evaluate(() => window.__mqttscope.shell.tabs.map((t) => t.connId))).toEqual(order);
  expect(await page.evaluate(() => window.__mqttscope.shell.active.connId)).toBe(id);
  await activate(page, 1);
  await expect(page.locator('.conn-dialog')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a held message no longer in the history stays held through export and import', async ({ env }) => {
  const a = await env.broker();
  const userData = makeUserData({ profiles: [profile(a.port)], settings: { historyLimit: 3 } });
  const { page, errors } = await env.connected(a, { userData });
  const held = () => page.evaluate(() => (window.__mqttscope.viewer.pinned ? new TextDecoder().decode(window.__mqttscope.viewer.pinned.payload) : null));
  await a.publish('h', 'one');
  await a.publish('h', 'two');
  await selectTopic(page, 'h');
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('h').messageCount)).toBe(2);
  await page.evaluate(() => {
    const { viewer } = window.__mqttscope;
    viewer.pinned = viewer.source.history[0];
    viewer.render(true);
  });
  for (const p of ['three', 'four', 'five']) await a.publish('h', p);
  await expect.poll(() => page.evaluate(() => window.__mqttscope.tree.find('h').history.length)).toBe(3);
  expect(await page.evaluate(() => window.__mqttscope.tree.find('h').history.includes(window.__mqttscope.viewer.pinned))).toBe(false);
  expect(await held()).toBe('one');

  await page.evaluate(() => window.__mqttscope.shell.reimport(window.__mqttscope.shell.active.connId));
  expect(await held()).toBe('one');
  await expect(page.locator('#viewer-host .btn.live')).toHaveText('❚❚ Held');
  expect(errors).toEqual([]);
});

test('a plot popped out of a tab whose profile has no name is titled by the plot alone', async ({ env }) => {
  const a = await env.broker();
  const { app, page, errors } = await env.connected(a, { connectNow: false });
  await page.locator('.conn-dialog [name="name"]').fill(''); // connected unnamed
  await connect(page);
  await page.evaluate(() => window.__mqttscope.plots.addSeries(null, 'hall/temp', null, { alias: 'Temperature' }));
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  const opened = app.waitForEvent('window');
  await page.locator('.plot-card .popout-btn').click();
  const win = await opened;
  await expect(win).toHaveTitle('Temperature');
  expect(errors).toEqual([]);
});
