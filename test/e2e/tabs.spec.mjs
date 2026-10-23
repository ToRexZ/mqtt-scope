// The tab strip: one tab per connection with its status dot, switching with a
// click, closing with ×, the window title, and Disconnect / Reconnect in the
// tab's toolbar.

import { test, expect, makeUserData, profile, connect, selectTopic, waitForTopic, viewerBody, mockDialogs, dialogCalls, toast, openTabTo, activeTabName, menu, menuLabels } from './fixtures.mjs';

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
  const { idA: first, idB: second, page, errors } = await twoTabs(env);
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

// Twelve tabs with long names, each opened for its own profile (no connection
// needed: a tab with a profile shows its name).
async function manyTabs(env, count = 12) {
  const profiles = Array.from({ length: count }, (_, i) => profile(1883, { id: `long${i}`, name: `Production cluster number ${i + 1} east` }));
  const ctx = await env.launch({ userData: makeUserData({ profiles }) });
  await ctx.page.evaluate(async (ps) => {
    for (const p of ps) await window.__mqttscope.shell.openTab({ profile: p });
  }, profiles);
  await expect(ctx.page.locator('.conn-tab')).toHaveCount(count + 1);
  return { profiles, ...ctx };
}

test('twelve tabs: icon-only brand, the strip scrolls, + stays in view', async ({ env }) => {
  const { page, errors } = await manyTabs(env);
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(page.locator('.brand')).toHaveClass(/icon-only/);
  await expect(page.locator('.brand-text')).toBeHidden();
  await expect(page.locator('.conn-tabs')).toHaveClass(/scrolling/);
  const widths = await page.locator('.conn-tab').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  for (const w of widths) expect(Math.round(w)).toBeGreaterThanOrEqual(100);
  // The strip stays on one row and + is inside the window, right after the strip.
  const box = await page.locator('.tab-new').boundingBox();
  const strip = await page.locator('.conn-tabs').boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(1000);
  expect(box.x).toBeGreaterThanOrEqual(strip.x + strip.width - 1);
  expect(box.y).toBeLessThan(60);
  expect(await page.locator('.conn-tab').last().evaluate((e) => e.getBoundingClientRect().top)).toBeLessThan(60);
  await page.locator('.tab-new').click();
  await expect(page.locator('.conn-tab')).toHaveCount(14);
  expect(errors).toEqual([]);
});

test('the strip never wraps in the narrow stacked layout', async ({ env }) => {
  const { page, errors } = await manyTabs(env, 6);
  await page.setViewportSize({ width: 700, height: 600 });
  await expect(page.locator('.conn-tabs')).toHaveClass(/scrolling/);
  const tops = await page.locator('.brand, .conn-tab, .tab-new, #btn-settings').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(12);
  expect(errors).toEqual([]);
});

test('a cut-off name scrolls, and only ellipsizes with reduced motion', async ({ env }) => {
  const { page, errors } = await manyTabs(env);
  await page.setViewportSize({ width: 1000, height: 700 });
  const name = page.locator('.conn-tab').nth(1).locator('.conn-tab-name');
  const label = name.locator('.conn-tab-label');
  await expect(name).toHaveClass(/scrolling/);
  expect(await label.evaluate((e) => getComputedStyle(e).animationName)).not.toBe('none');
  const vars = await name.evaluate((e) => ({ shift: parseFloat(e.style.getPropertyValue('--shift')), dur: parseFloat(e.style.getPropertyValue('--dur')) }));
  expect(vars.shift).toBeGreaterThan(0);
  expect(vars.dur).toBeCloseTo(3 + (2 * vars.shift) / 30, 1); // 30 px/s, 1.5 s at each end

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await label.evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
  expect(await name.evaluate((e) => getComputedStyle(e).textOverflow)).toBe('ellipsis');
  expect(errors).toEqual([]);
});

test('a name that fits does not scroll; the tooltip is the full name', async ({ env }) => {
  const { page, errors } = await manyTabs(env);
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(page.locator('.conn-tab').nth(1)).toHaveAttribute('title', 'Production cluster number 1 east');
  await expect(page.locator('.conn-tab').last()).toHaveAttribute('title', 'Production cluster number 12 east');
  // Widening the window until everything fits stops the scrolling.
  await page.setViewportSize({ width: 5000, height: 700 });
  await expect(page.locator('.conn-tab .conn-tab-name.scrolling')).toHaveCount(0);
  await expect(page.locator('.conn-tabs')).not.toHaveClass(/scrolling/);
  await expect(page.locator('.brand')).not.toHaveClass(/icon-only/);
  expect(errors).toEqual([]);
});

test('re-measuring a running name animation keeps --shift and the scrolling class', async ({ env }) => {
  const { page, errors } = await manyTabs(env);
  await page.setViewportSize({ width: 1000, height: 700 });
  const name = page.locator('.conn-tab').nth(1).locator('.conn-tab-name');
  await expect(name).toHaveClass(/scrolling/);
  const read = () => name.evaluate((e) => ({ shift: e.style.getPropertyValue('--shift'), dur: e.style.getPropertyValue('--dur'), scrolling: e.classList.contains('scrolling') }));
  // Resize observers have run once a frame has been painted after the resize.
  const settled = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await settled();
  const before = await read();
  // Move the label by a transform that widens the scrollable overflow (the
  // animation only moves it left, which scrollWidth ignores), then re-measure.
  await name.locator('.conn-tab-label').evaluate((e) => {
    e.getAnimations().forEach((a) => a.cancel());
    e.style.transform = 'translateX(40px)';
  });
  await page.setViewportSize({ width: 1001, height: 700 });
  await page.setViewportSize({ width: 1000, height: 700 });
  await settled();
  expect(await read()).toEqual(before);
  expect(errors).toEqual([]);
});

test('no tab overlaps +, whatever the width', async ({ env }) => {
  const { page, errors } = await manyTabs(env, 8);
  for (let w = 1400; w >= 760; w -= 23) {
    await page.setViewportSize({ width: w, height: 700 });
    await page.waitForTimeout(50);
    const r = await page.evaluate(() => {
      const tabs = document.querySelectorAll('.conn-tab');
      const plus = document.querySelector('.tab-new').getBoundingClientRect();
      const strip = document.querySelector('.conn-tabs');
      const head = document.querySelector('.topbar').getBoundingClientRect();
      return { last: tabs[tabs.length - 1].getBoundingClientRect().right, stripRight: strip.getBoundingClientRect().right, plusLeft: plus.left, plusRight: plus.right, headRight: head.right, scrolled: strip.classList.contains('scrolling') };
    });
    expect(r.plusRight, `width ${w}`).toBeLessThanOrEqual(r.headRight);
    expect(r.stripRight, `width ${w}`).toBeLessThanOrEqual(r.plusLeft + 0.5);
    if (!r.scrolled) expect(r.last, `width ${w}`).toBeLessThanOrEqual(r.plusLeft + 0.5);
  }
  expect(errors).toEqual([]);
});

const tabIds = (page) => page.evaluate(() => window.__mqttscope.shell.tabs.map((t) => t.connId));
const newTab = (page) => page.evaluate(() => window.__mqttscope.shell.openTab().then((t) => t.connId));

test('the tab menu lists its actions and closes others and to the right', async ({ env }) => {
  const { idA, idB, page, errors } = await twoTabs(env);
  const idC = await newTab(page);
  await tabEl(page, idB).click({ button: 'right' });
  expect(await menuLabels(page)).toEqual(['Close', 'Close other tabs', 'Close tabs to the right', 'Move to new window', 'Disconnect']);
  const disabled = () => page.locator('.ctx-menu .ctx-item.disabled').allTextContents();
  expect(await disabled()).toEqual(['Move to new window']);
  await menu(page, 'Close tabs to the right');
  await expect(tabEl(page, idC)).toHaveCount(0);
  expect(await tabIds(page)).toEqual([idA, idB]);

  // Reconnect once the user disconnected.
  await tabEl(page, idB).click({ button: 'right' });
  await menu(page, 'Disconnect');
  await expect(tabEl(page, idB)).toHaveAttribute('data-state', 'disconnected');
  await tabEl(page, idB).click({ button: 'right' });
  expect(await menuLabels(page)).toContain('Reconnect');
  await menu(page, 'Reconnect');
  await expect(tabEl(page, idB)).toHaveAttribute('data-state', 'connected');

  // Nothing to the right of the last tab.
  await tabEl(page, idB).click({ button: 'right' });
  expect(await disabled()).toEqual(['Close tabs to the right', 'Move to new window']);
  await page.keyboard.press('Escape');

  await tabEl(page, idB).click({ button: 'right' });
  await menu(page, 'Close other tabs');
  await expect(tabEl(page, idA)).toHaveCount(0);
  expect(await tabIds(page)).toEqual([idB]);
  await tabEl(page, idB).click({ button: 'right' });
  expect(await disabled()).toEqual(['Close other tabs', 'Close tabs to the right', 'Move to new window']);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('closing several tabs asks once when plots hold data', async ({ env }) => {
  const { app, b, idA, idB, page, errors } = await twoTabs(env);
  const idC = await newTab(page);
  await addSeries(page, idB, 'b/value');
  await b.publish('b/value', '1');
  await expect.poll(() => plotValues(page, idB, 'b/value')).toEqual([1]);
  await mockDialogs(app, { confirm: false });
  await tabEl(page, idA).click({ button: 'right' });
  await menu(page, 'Close other tabs');
  await expect.poll(() => dialogCalls(app)).toHaveLength(1);
  expect((await dialogCalls(app))[0].message).toBe('Close 2 tabs?');
  expect(await tabIds(page)).toEqual([idA, idB, idC]);
  await mockDialogs(app, { confirm: true });
  await tabEl(page, idA).click({ button: 'right' });
  await menu(page, 'Close other tabs');
  await expect.poll(() => tabIds(page)).toEqual([idA]);
  expect(errors).toEqual([]);
});

test('middle-click closes a tab', async ({ env }) => {
  const { idA, idB, page, errors } = await twoTabs(env);
  await tabEl(page, idA).click({ button: 'middle' });
  await expect(tabEl(page, idA)).toHaveCount(0);
  expect(await tabIds(page)).toEqual([idB]);
  expect(errors).toEqual([]);
});

test('dragging a tab reorders the strip', async ({ env }) => {
  const { idA, idB, page, errors } = await twoTabs(env);
  const idC = await newTab(page);
  await tabEl(page, idC).dragTo(tabEl(page, idA), { targetPosition: { x: 5, y: 10 } });
  await expect.poll(() => tabIds(page)).toEqual([idC, idA, idB]);
  await expect(page.locator('.conn-tab')).toHaveCount(3);
  await expect(page.locator('.conn-tab.drop-before, .conn-tab.drop-after')).toHaveCount(0);
  await tabEl(page, idC).dragTo(tabEl(page, idB), { targetPosition: { x: 5, y: 10 } });
  await expect.poll(() => tabIds(page)).toEqual([idA, idC, idB]);
  // The right half of the last tab: after it.
  const box = await tabEl(page, idB).boundingBox();
  await tabEl(page, idA).dragTo(tabEl(page, idB), { targetPosition: { x: box.width - 5, y: 10 } });
  await expect.poll(() => tabIds(page)).toEqual([idC, idB, idA]);
  expect(errors).toEqual([]);
});

test('reopen brings the last closed tab back, connected and empty', async ({ env }) => {
  const { app, idA, idB, b, page, errors } = await twoTabs(env);
  await addSeries(page, idB, 'b/value');
  await b.publish('b/value', '1');
  await expect.poll(() => plotValues(page, idB, 'b/value')).toEqual([1]);
  await mockDialogs(app, { confirm: true });
  await page.evaluate(() => window.__mqttscope.shell.closeTab(window.__mqttscope.shell.tabs[1].connId));
  await expect(tabEl(page, idB)).toHaveCount(0);
  await page.evaluate(() => window.__mqttscope.shell.reopenClosed());
  await expect(page.locator('.conn-tab')).toHaveCount(2);
  await expect(activeTabName(page)).toHaveText('Broker B');
  await expect(page.locator('.conn-tab.active')).toHaveAttribute('data-state', 'connected');
  expect(await page.evaluate(() => window.__mqttscope.tree.find('b/value'))).toBeFalsy();
  expect(await tabIds(page)).toContain(idA);
  // Nothing left to reopen: no new tab.
  await page.evaluate(() => window.__mqttscope.shell.reopenClosed());
  await expect(page.locator('.conn-tab')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('a double-click on + opens one tab', async ({ env }) => {
  const { page, errors } = await twoTabs(env);
  await page.locator('.tab-new').dblclick();
  await expect(page.locator('.conn-dialog')).toBeVisible();
  await expect(page.locator('.conn-tab')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('the strip is a tablist with roving tabindex and arrow keys', async ({ env }) => {
  const { idA, idB, page, errors } = await twoTabs(env);
  await expect(page.locator('.conn-tabs')).toHaveAttribute('role', 'tablist');
  await expect(tabEl(page, idB)).toHaveAttribute('tabindex', '0');
  await expect(tabEl(page, idA)).toHaveAttribute('tabindex', '-1');
  await expect(tabEl(page, idA)).toHaveAccessibleName('Broker A');
  await tabEl(page, idB).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(activeTabName(page)).toHaveText('Broker A');
  await expect(tabEl(page, idA)).toBeFocused();
  await page.keyboard.press('End');
  await expect(tabEl(page, idB)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tabEl(page, idA)).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(tabEl(page, idA)).toHaveCount(0);
  expect(await tabIds(page)).toEqual([idB]);
  expect(errors).toEqual([]);
});

test('keyboard focus stays in the strip: after a click, and after Delete closes a tab', async ({ env }) => {
  const { idA, idB, page, errors } = await twoTabs(env);
  await tabEl(page, idB).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tabEl(page, idA)).toBeFocused();
  await tabEl(page, idB).click(); // the focus was on a tab: it stays on the clicked one
  await expect(tabEl(page, idB)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tabEl(page, idA)).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(tabEl(page, idA)).toHaveCount(0);
  await expect(tabEl(page, idB)).toBeFocused();
  expect(errors).toEqual([]);
});

test('the File menu has New Tab, Close Tab and Reopen Closed Tab with their shortcuts', async ({ env }) => {
  const { app, errors } = await twoTabs(env);
  const items = await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File');
    return file.submenu.items.filter((i) => /Tab$/.test(i.label)).map((i) => [i.label, i.accelerator]);
  });
  expect(items).toEqual([
    ['New Tab', 'CmdOrCtrl+T'],
    ['Close Tab', 'CmdOrCtrl+W'],
    ['Reopen Closed Tab', 'CmdOrCtrl+Shift+T'],
  ]);
  expect(errors).toEqual([]);
});
