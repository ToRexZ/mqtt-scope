// Plot tabs fill the available space and can be resized; a plot can go full
// screen; dragging zooms; State transitions plots; icons; older saved layouts
// open as tabs.

import path from 'node:path';
import { test, expect, makeUserData, profile, connect, waitForTopic, waitForFile, readJson, until } from './fixtures.mjs';

const plotsTab = (page) => page.locator('.right-tabs .tab[data-tab="plots"]');
const cards = (page) => page.locator('.plot-card');
const charts = (page) => page.evaluate(() => [...window.__mqttscope.plots.charts.values()].map((c) => ({ range: c.range, axis: c.axis, geom: c.geom && { ...c.geom } })));

async function setup(env, { height = 1000, scale = 1 } = {}) {
  const broker = await env.broker();
  await broker.publish('robot/state', JSON.stringify({ battery: 81, speed: 1.2, driving: true, docked: false }), { retain: true });
  await broker.publish('hall/temp', '21', { retain: true });
  const userData = makeUserData({ profiles: [profile(broker.port)] });
  const ctx = await env.launch({ userData });
  await ctx.page.setViewportSize({ width: 1600, height });
  if (scale !== 1) {
    const cdp = await ctx.page.context().newCDPSession(ctx.page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height, deviceScaleFactor: scale, mobile: false });
  }
  await connect(ctx.page);
  await waitForTopic(ctx.page, 'hall/temp');
  await ctx.page.evaluate(() => {
    const { plots } = window.__mqttscope;
    const id = plots.addSeries(null, 'robot/state', ['battery'], { alias: 'Battery', quiet: true });
    plots.addSeries(id, 'robot/state', ['driving'], { alias: 'Driving', quiet: true });
    plots.addSeries(null, 'hall/temp', null, { quiet: true });
    plots.renderAll();
    plots.persist();
  });
  await plotsTab(ctx.page).click();
  return { broker, userData, ...ctx };
}

const box = (locator) => locator.boundingBox();

const layoutOf = (page) => page.evaluate(() => window.__mqttscope.plots.tab.layout);
const titlesInOrder = (page) => page.locator('.plot-card .plot-title').allTextContents();

// Drags the gap `handle` by (dx, dy).
async function dragBy(page, handle, dx, dy) {
  const h = await box(handle);
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + dx, h.y + h.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
}

async function arrange(page, label) {
  await page.locator('.arrange-btn').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: label }).click();
}

test('plots fill the tab; the gaps between them resize them; Arrange; the area scrolls only below the minimum sizes', async ({ env }) => {
  const { page, userData, errors } = await setup(env, { height: 1400 });
  const grid = page.locator('.plots-grid');
  await expect(cards(page)).toHaveCount(2);

  // Two plots: stacked, together filling the area (8 px padding, 6 px gap).
  const g = await box(grid);
  const [a, b] = [await box(cards(page).nth(0)), await box(cards(page).nth(1))];
  expect(Math.abs(a.y - (g.y + 8))).toBeLessThan(3);
  expect(Math.abs(b.y + b.height - (g.y + g.height - 8))).toBeLessThan(3);
  expect(Math.abs(a.width - (g.width - 16))).toBeLessThan(3);
  // The plot with a state lane gets a little more height.
  expect(Math.abs(a.height / b.height - 254 / 220)).toBeLessThan(0.03);

  // Dragging the gap resizes both; the sizes are saved.
  const gap = page.locator('.mosaic-handle.col');
  await expect(gap).toHaveCount(1);
  await dragBy(page, gap, 0, 100);
  const [a2, b2] = [await box(cards(page).nth(0)), await box(cards(page).nth(1))];
  expect(Math.abs(a2.height - a.height - 100)).toBeLessThan(4);
  expect(Math.abs(b.height - b2.height - 100)).toBeLessThan(4);
  await waitForFile(path.join(userData, 'plotTabs.json'), (buf) => {
    const l = JSON.parse(buf).tabs[0].layout;
    return l?.dir === 'col' && l.sizes[0] / l.sizes[1] > 1.5;
  });
  // A plot cannot be made smaller than its minimum.
  await dragBy(page, gap, 0, 2000);
  const min = Number.parseFloat(await cards(page).nth(1).evaluate((el) => el.style.minHeight));
  expect(Math.abs((await box(cards(page).nth(1))).height - min)).toBeLessThan(3);
  // Double-click makes them equal.
  await gap.dblclick();
  await expect.poll(async () => Math.abs((await box(cards(page).nth(0))).height - (await box(cards(page).nth(1))).height)).toBeLessThan(1);

  // Arrange two per row: side by side with a gap between them.
  await arrange(page, '2 per row');
  const [c1, c2] = [await box(cards(page).nth(0)), await box(cards(page).nth(1))];
  expect(Math.abs(c1.y - c2.y)).toBeLessThan(2);
  expect(c2.x).toBeGreaterThan(c1.x + c1.width);
  await dragBy(page, page.locator('.mosaic-handle.row'), -40, 0);
  expect(Math.abs((await box(cards(page).nth(0))).width - (c1.width - 40))).toBeLessThan(4);
  await dragBy(page, page.locator('.mosaic-handle.row'), -2000, 0);
  expect(Math.abs((await box(cards(page).nth(0))).width - 220)).toBeLessThan(3);
  await waitForFile(path.join(userData, 'plotTabs.json'), (buf) => JSON.parse(buf).tabs[0].layout?.dir === 'row');

  // A small window: plots keep their minimum size and the area scrolls.
  await arrange(page, 'Stack: one per row');
  await page.setViewportSize({ width: 1200, height: 700 });
  await expect.poll(() => grid.evaluate((el) => el.scrollHeight > el.clientHeight + 10)).toBe(true);
  for (const i of [0, 1]) {
    const minH = Number.parseFloat(await cards(page).nth(i).evaluate((el) => el.style.minHeight));
    expect((await box(cards(page).nth(i))).height).toBeGreaterThanOrEqual(minH - 1);
  }
  expect(errors).toEqual([]);
});

test('on a HiDPI screen (2×) plots keep their size and can be resized', async ({ env }) => {
  const { page, errors } = await setup(env, { height: 1300, scale: 2 });
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
  const heights = async () => [await box(cards(page).nth(0)), await box(cards(page).nth(1))].map((b) => Math.round(b.height));
  const first = await heights();
  // Charts redraw every half second; the layout must not creep.
  await page.waitForTimeout(1600);
  expect(await heights()).toEqual(first);
  const g = await box(page.locator('.plots-grid'));
  expect(first[0] + first[1] + 6 + 16).toBeLessThanOrEqual(Math.round(g.height) + 2);
  await dragBy(page, page.locator('.mosaic-handle.col'), 0, -80);
  const after = await heights();
  expect(Math.abs(first[0] - after[0] - 80)).toBeLessThan(4);
  expect(Math.abs(after[1] - first[1] - 80)).toBeLessThan(4);
  await page.waitForTimeout(1200); // several redraws later, still the same size
  expect(await heights()).toEqual(after);
  expect(errors).toEqual([]);
});

test('drag a plot by its title onto another plot: an edge splits, the middle swaps, a tab moves it; Esc cancels', async ({ env }) => {
  const { page, userData, errors } = await setup(env, { height: 1300 });
  await page.evaluate(() => {
    const { plots } = window.__mqttscope;
    plots.addSeries(null, 'robot/state', ['speed'], { alias: 'Speed', quiet: true });
    plots.plots[2].title = 'Speed';
    plots.renderAll();
  });
  await expect.poll(() => titlesInOrder(page)).toEqual(['Battery', 'hall/temp', 'Speed']);
  const drag = async (from, to, fx, fy, { drop = true } = {}) => {
    const t = await box(cards(page).filter({ has: page.locator('.plot-title', { hasText: new RegExp(`^${from}$`) }) }).locator('.plot-title'));
    const target = await box(cards(page).filter({ has: page.locator('.plot-title', { hasText: new RegExp(`^${to}$`) }) }));
    await page.mouse.move(t.x + 10, t.y + t.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width * fx, target.y + target.height * fy, { steps: 8 });
    await expect(page.locator('.drop-marker')).toBeVisible();
    await expect(page.locator('.drag-ghost')).toHaveText(from);
    if (drop) await page.mouse.up();
  };

  // Onto the right edge of Battery: Speed goes beside it.
  await drag('Speed', 'Battery', 0.95, 0.5);
  await expect(page.locator('.drop-marker')).toHaveCount(0);
  const battery = await box(cards(page).nth(0));
  const speed = await box(cards(page).nth(1));
  expect(await titlesInOrder(page)).toEqual(['Battery', 'Speed', 'hall/temp']);
  expect(Math.abs(battery.y - speed.y)).toBeLessThan(2);
  expect(speed.x).toBeGreaterThan(battery.x + battery.width);

  // A plot drawn again (here after hiding a series) can still be moved.
  await cards(page).filter({ has: page.locator('.plot-title', { hasText: /^Battery$/ }) }).locator('.swatch-toggle').first().click();
  // Onto the middle of Battery: hall/temp and Battery swap places.
  await drag('hall/temp', 'Battery', 0.5, 0.5);
  expect(await titlesInOrder(page)).toEqual(['hall/temp', 'Speed', 'Battery']);

  // Esc cancels a drag.
  const before = await layoutOf(page);
  await drag('Battery', 'Speed', 0.05, 0.5, { drop: false });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.drop-marker')).toHaveCount(0);
  expect(await layoutOf(page)).toEqual(before);
  await waitForFile(path.join(userData, 'plotTabs.json'), (b) => JSON.stringify(JSON.parse(b).tabs[0].layout) === JSON.stringify(before));

  // Onto another tab: the plot moves there.
  await page.evaluate(() => {
    const { plots } = window.__mqttscope;
    const here = plots.tab.id;
    plots.model.addTab('Other');
    plots.model.switchTab(here);
    plots.renderAll();
  });
  const t = await box(cards(page).filter({ has: page.locator('.plot-title', { hasText: /^Speed$/ }) }).locator('.plot-title'));
  const tab = await box(page.locator('.plot-tab', { hasText: 'Other' }));
  await page.mouse.move(t.x + 10, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2, { steps: 8 });
  await expect(page.locator('.plot-tab.drop-target')).toHaveText(/Other/);
  await page.mouse.up();
  await expect(page.locator('.toast').filter({ hasText: 'Moved “Speed” to “Other”' })).toBeVisible();
  expect(await titlesInOrder(page)).toEqual(['hall/temp', 'Battery']);
  await page.locator('.plot-tab', { hasText: 'Other' }).click();
  expect(await titlesInOrder(page)).toEqual(['Speed']);
  await waitForFile(path.join(userData, 'plotTabs.json'), (b) => JSON.parse(b).tabs.find((x) => x.name === 'Other')?.plots.length === 1);
  expect(errors).toEqual([]);
});

test('a plot opens live in its own window', async ({ env }) => {
  const { app, page, broker, errors } = await setup(env);
  const opened = app.waitForEvent('window');
  await cards(page).nth(1).locator('.popout-btn').click();
  const win = await opened;
  // Headless windows open at their minimum size; a desktop window is 1100×650.
  await win.setViewportSize({ width: 1100, height: 650 });
  await win.waitForFunction(() => !!window.__plotWindow);
  await expect(win.locator('.plot-title')).toHaveText('hall/temp');
  const count = () => win.evaluate(() => window.__plotWindow.data.points('hall/temp', null).length);
  const before = await count();
  expect(before).toBeGreaterThan(0);
  await broker.publish('hall/temp', '30');
  await expect.poll(count).toBe(before + 1);
  // Only the plot's own topics are sent to it.
  await broker.publish('robot/state', JSON.stringify({ battery: 1, driving: false }));
  await page.waitForTimeout(300); // a message that should not arrive: give it time to
  expect(await count()).toBe(before + 1);
  // It has its own controls.
  await win.locator('.kind-toggle .seg-btn[data-kind="states"]').click();
  await expect.poll(() => win.evaluate(() => window.__plotWindow.chart.axis.kind)).toBe('states');
  // The plot is still in the tab.
  await expect(cards(page)).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('the settings panel hides, comes back and can be resized', async ({ env }) => {
  const { page, errors } = await setup(env);
  const panel = page.locator('.plot-settings');
  await expect(panel).toBeVisible();
  await panel.locator('.ps-hide').click();
  await expect(panel).toBeHidden();
  await expect(page.locator('.ps-rail')).toBeVisible();
  await page.locator('.ps-rail button').click();
  await expect(panel).toBeVisible();
  const w = (await box(panel)).width;
  await dragBy(page, page.locator('.ps-splitter'), 120, 0);
  expect(Math.abs((await box(panel)).width - (w + 120))).toBeLessThan(3);
  // The plots use the space that is left.
  const card = await box(cards(page).first());
  expect(card.x).toBeGreaterThan((await box(panel)).x + (await box(panel)).width);
  expect(errors).toEqual([]);
});

test('narrow plots move some header buttons into a menu', async ({ env }) => {
  const { page, errors } = await setup(env);
  const card = cards(page).first();
  await expect(card.getByRole('button', { name: '+ Series' })).toBeVisible();
  await expect(card.locator('.plot-more')).toBeHidden();
  await arrange(page, '2 per row');
  await expect(card.getByRole('button', { name: '+ Series' })).toBeHidden();
  await expect(card.locator('.plot-more')).toBeVisible();
  await card.locator('.plot-more').click();
  await expect(page.locator('.ctx-menu .ctx-item')).toHaveText(['Add series…', 'Export CSV…', 'Open in its own window', 'Show as state transitions']);
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Show as state transitions' }).click();
  await expect(cards(page).first()).toHaveClass(/kind-states/);
  expect(errors).toEqual([]);
});

test('a plot can be shown full screen, stays so while you work with it, and comes back', async ({ env }) => {
  const { page, errors } = await setup(env);
  const panel = page.locator('.plots');
  const fullBtn = (i = 0) => cards(page).nth(i).locator('.fullscreen-btn');
  await expect(fullBtn()).toHaveAttribute('title', 'Show this plot full screen');
  await fullBtn().click();
  // Real full screen, or (where the system refuses it) covering the window.
  const covering = () => page.evaluate(() => document.fullscreenElement === document.querySelector('.plots') || document.querySelector('.plots').classList.contains('fill-window'));
  await expect.poll(covering).toBe(true);
  await expect(panel).toHaveClass(/solo/);
  await expect(cards(page)).toHaveCount(1);
  await expect(page.locator('.plots-toolbar')).toBeHidden();
  await expect.poll(async () => (await box(cards(page).first())).width).toBeGreaterThan(1550);
  await expect(fullBtn()).toHaveAttribute('title', 'Exit full screen (Esc)');

  // Working with the plot keeps it full screen.
  await cards(page).first().locator('.legend-chip').first().locator('.swatch-toggle').click();
  await expect(cards(page).first().locator('.legend-chip').first()).toHaveClass(/off/);
  await cards(page).first().locator('.kind-toggle .seg-btn[data-kind="states"]').click();
  await expect(cards(page).first()).toHaveClass(/kind-states/);
  await expect(panel).toHaveClass(/solo/);
  expect(await covering()).toBe(true);
  await expect(cards(page)).toHaveCount(1);
  // Prompts and menus appear on top of it.
  await cards(page).first().locator('.plot-title').dblclick();
  await expect(page.locator('.modal.prompt')).toBeVisible();
  const onTop = (sel) =>
    page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return !!document.elementFromPoint(r.x + r.width / 2, r.y + 8)?.closest(s);
    }, sel);
  expect(await onTop('.modal.prompt')).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal.prompt')).toHaveCount(0);
  await expect(panel).toHaveClass(/solo/);

  // Esc leaves full screen; the other plot is back.
  await page.keyboard.press('Escape');
  await expect(panel).not.toHaveClass(/solo/);
  await expect(panel).not.toHaveClass(/fill-window/);
  await expect(cards(page)).toHaveCount(2);
  await expect(page.locator('.plots-toolbar')).toBeVisible();
  // The button toggles too, for any plot.
  await fullBtn(1).click();
  await expect(panel).toHaveClass(/solo/);
  await expect(cards(page).first().locator('.plot-title')).toHaveText('hall/temp');
  await fullBtn(0).click();
  await expect(panel).not.toHaveClass(/solo/);
  // Removing the plot shown full screen leaves full screen, with each plot once.
  await fullBtn(1).click();
  await cards(page).first().locator('button[title="Remove plot"]').click();
  await expect(panel).not.toHaveClass(/solo/);
  await expect(page.locator('.mosaic-root')).toHaveCount(1);
  await expect(cards(page)).toHaveCount(1);
  expect(await page.evaluate(() => window.__mqttscope.plots.charts.size)).toBe(1);
  expect(await covering()).toBe(false);
  expect(errors).toEqual([]);
});

test('dragging zooms: time for every plot, values for the plot dragged in; double-click, Esc and Reset go back', async ({ env }) => {
  const { page, broker, errors } = await setup(env);
  for (let i = 0; i < 16; i++) {
    await broker.publish('hall/temp', String(20 + (i % 5)));
    await new Promise((r) => setTimeout(r, 60));
  }
  const temp = cards(page).nth(1);
  const canvas = temp.locator('canvas');
  await until(() => page.evaluate(() => window.__mqttscope.plots.points('hall/temp', null).length >= 17), { message: 'points' });
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Freeze' }).click();

  const drag = async () => {
    const c = await box(canvas);
    const g = (await charts(page))[1].geom;
    const x0 = c.x + g.left + (g.right - g.left) * 0.3;
    const x1 = c.x + g.left + (g.right - g.left) * 0.7;
    const y0 = c.y + g.y.top + (g.y.bottom - g.y.top) * 0.2;
    const y1 = c.y + g.y.top + (g.y.bottom - g.y.top) * 0.6;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 6 });
    await expect(page.locator('.chart-sel')).toBeVisible();
    await page.mouse.up();
    return g;
  };
  const resetOn = (i) => cards(page).nth(i).locator('.reset-view');
  await expect(resetOn(0)).toBeHidden();
  await expect(resetOn(1)).toBeHidden();
  const before = await drag();
  await expect(page.locator('.zoom-reset')).toBeVisible();
  // Every plot of the tab shows "Reset view" (the time zoom applies to all).
  await expect(resetOn(0)).toBeVisible();
  await expect(resetOn(1)).toBeVisible();
  await expect(resetOn(1)).toHaveText('Reset view');
  const after = await charts(page);
  // Both plots show the same, narrower time range.
  expect(after[0].range).toEqual(after[1].range);
  const width = (r) => r.t1 - r.t0;
  expect(width(after[1].range)).toBeLessThan((before.t1 - before.t0) * 0.5);
  expect(Math.abs(width(after[1].range) - (before.t1 - before.t0) * 0.4)).toBeLessThan((before.t1 - before.t0) * 0.02);
  // Values zoom only in the plot dragged in.
  expect(after[1].axis.yMax).toBeLessThan(before.y.max);
  expect(after[1].axis.yMin).toBeGreaterThan(before.y.min);
  expect(after[0].axis.yMin).toBeNull();

  await canvas.dblclick();
  await expect(page.locator('.zoom-reset')).toBeHidden();
  expect((await charts(page))[1].axis.yMin).toBeNull();

  await drag();
  await expect(page.locator('.zoom-reset')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.zoom-reset')).toBeHidden();

  await drag();
  await page.locator('.zoom-reset').click();
  await expect(page.locator('.zoom-reset')).toBeHidden();

  // "Reset view" on a plot goes back to the live view for the whole tab.
  await drag();
  await resetOn(0).click();
  await expect(page.locator('.zoom-reset')).toBeHidden();
  await expect(resetOn(0)).toBeHidden();
  await expect(resetOn(1)).toBeHidden();
  expect((await charts(page))[1].axis.yMin).toBeNull();
  // A click without dragging does not zoom.
  const c = await box(canvas);
  await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
  await expect(page.locator('.zoom-reset')).toBeHidden();
  expect(errors).toEqual([]);
});

test('State transitions plot: every series is a labelled lane, no legend or y axis; saved', async ({ env }) => {
  const { page, userData, errors, broker } = await setup(env);
  const card = cards(page).first();
  const panel = page.locator('.plot-settings');
  await card.locator('.plot-head').click();
  await card.locator('.kind-toggle .seg-btn[data-kind="states"]').click();
  await expect(card).toHaveClass(/kind-states/);
  await expect(card.locator('.plot-legend')).toBeHidden();
  await expect(card.locator('.kind-toggle .seg-btn[data-kind="states"]')).toHaveClass(/on/);
  // Both series (a number and a boolean) are lanes with their full labels.
  await expect.poll(async () => (await charts(page))[0].geom?.laneLabels).toEqual([
    { label: 'Battery', value: '81' },
    { label: 'Driving', value: 'true' },
  ]);
  expect((await charts(page))[0].axis.kind).toBe('states');
  expect((await charts(page))[0].geom.y).toBeNull();
  // Settings: plot type follows; y axis, legend and per-series style do not apply.
  await expect(panel.locator('select[name="plot-kind"]')).toHaveValue('states');
  await expect(panel.locator('details.ps-section', { hasText: 'Y axis' })).toBeHidden();
  await expect(panel.locator('details.ps-section', { hasText: 'Legend' })).toBeHidden();
  await panel.locator('.ps-series-item').first().locator('summary').click();
  await expect(panel.locator('.ps-series-item').first().locator('select[name="series-display"]')).toBeHidden();
  // The lane label shows the value at the latest point.
  await broker.publish('robot/state', JSON.stringify({ battery: 80, speed: 1, driving: false, docked: false }));
  await expect.poll(async () => (await charts(page))[0].geom?.laneLabels.map((l) => l.value)).toEqual(['80', 'false']);
  await waitForFile(path.join(userData, 'plotTabs.json'), (b) => JSON.parse(b).tabs[0].plots[0].kind === 'states');

  // Long labels are not cut short when there is room.
  const long = 'robot/state › $.docked (rear docking contact, left side)';
  await page.evaluate((alias) => {
    const { plots } = window.__mqttscope;
    plots.addSeries(plots.plots[0].id, 'robot/state', ['docked'], { alias, quiet: true });
    plots.renderAll();
  }, long);
  await expect.poll(async () => (await charts(page))[0].geom?.laneLabels.at(-1)).toEqual({ label: long, value: 'false' });

  // Back to lines via the settings panel.
  await panel.locator('select[name="plot-kind"]').selectOption('timeseries');
  await expect(cards(page).first()).not.toHaveClass(/kind-states/);
  await expect(cards(page).first().locator('.plot-legend')).toBeVisible();
  expect((await charts(page))[0].geom.y).not.toBeNull();
  expect(errors).toEqual([]);
});

test('icons are monochrome SVG (no colour emoji) in the plots', async ({ env }) => {
  const { page, errors } = await setup(env);
  await cards(page).first().locator('.plot-head').click();
  await expect(cards(page).first().locator('button[title="Plot settings"] svg')).toHaveCount(1);
  await expect(page.locator('.plot-settings .ps-eye svg')).toHaveCount(2);
  const text = await page.locator('.plots').innerText();
  expect(text).not.toMatch(/[👁⚙◌🗑]/u);
  // Hiding a series swaps the eye for the crossed-out eye.
  await page.locator('.plot-settings .ps-eye').first().click();
  await expect(page.locator('.plot-settings .ps-eye').first().locator('.icon-eye-off')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('plots and layouts saved by an older version open as tabs', async ({ env }) => {
  const broker = await env.broker();
  const plot = (title, topic) => ({ id: title, title, windowSec: 300, series: [{ id: `${title}-s`, topic, segs: null, slot: 0 }] });
  const userData = makeUserData({
    profiles: [profile(broker.port)],
    plots: {
      plots: [plot('Working', 'a/b')],
      layouts: [
        { id: 'l1', name: 'Robot view', plots: [plot('Saved robot', 'a/b')] },
        { id: 'l2', name: 'Climate', plots: [plot('Temperatures', 'hall/temp')] },
      ],
      activeLayoutId: 'l1',
    },
  });
  const { page, errors } = await env.launch({ userData });
  await connect(page); // the plots show in a connected tab
  await plotsTab(page).click();
  await expect(page.locator('.plot-tabs .plot-tab .plot-tab-name')).toHaveText(['Robot view', 'Robot view (saved)', 'Climate']);
  await expect(page.locator('.plot-card .plot-title')).toHaveText(['Working']);
  await page.locator('.plot-tabs .plot-tab', { hasText: 'Climate' }).click();
  await expect(page.locator('.plot-card .plot-title')).toHaveText(['Temperatures']);
  // Saving writes the tabs to their own file and the tab on screen in the old format.
  await page.locator('.plot-card .window-select').selectOption('60');
  await waitForFile(path.join(userData, 'plotTabs.json'), (b) => Array.isArray(JSON.parse(b).tabs));
  expect(readJson(path.join(userData, 'plotTabs.json')).tabs.map((t) => t.name)).toEqual(['Robot view', 'Robot view (saved)', 'Climate']);
  await waitForFile(path.join(userData, 'plots.json'), (b) => JSON.parse(b).plots?.[0]?.title === 'Temperatures');
  expect(errors).toEqual([]);
});

test('vertical lines at the timestamps: on by default, turned off per plot in its settings, also in its window', async ({ env }) => {
  const { app, page, userData, errors } = await setup(env);
  const grid = (i) => page.evaluate((n) => [...window.__mqttscope.plots.charts.values()][n].geom?.timeGrid?.length ?? 0, i);
  await expect.poll(() => grid(0)).toBeGreaterThan(0);
  await expect.poll(() => grid(1)).toBeGreaterThan(0);
  // Off for the first plot only.
  await cards(page).first().locator('.plot-head').click();
  const toggle = page.locator('.plot-settings input[name="plot-timeGrid"]');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect.poll(() => grid(0)).toBe(0);
  expect(await grid(1)).toBeGreaterThan(0);
  await waitForFile(path.join(userData, 'plotTabs.json'), (b) => JSON.parse(b).tabs[0].plots[0].timeGrid === false);
  // State lanes get them too (the second plot as state transitions).
  await cards(page).nth(1).locator('.kind-toggle .seg-btn[data-kind="states"]').click();
  await expect.poll(() => grid(1)).toBeGreaterThan(0);
  // A pop-out window follows the plot's setting.
  const opened = app.waitForEvent('window');
  await cards(page).first().locator('.popout-btn').click();
  const win = await opened;
  await win.setViewportSize({ width: 1100, height: 650 });
  await win.waitForFunction(() => !!window.__plotWindow?.chart.geom);
  expect(await win.evaluate(() => window.__plotWindow.chart.geom.timeGrid.length)).toBe(0);
  expect(errors).toEqual([]);
});

test('"Reset view" sits in the same corner over the chart of every zoomed plot, lines or state lanes', async ({ env }) => {
  const { page, errors } = await setup(env, { height: 1200 });
  await cards(page).first().locator('.kind-toggle .seg-btn[data-kind="states"]').click();
  // Zoom by dragging across the State transitions plot.
  const canvas = cards(page).first().locator('canvas');
  const c = await box(canvas);
  await page.mouse.move(c.x + c.width * 0.3, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width * 0.8, c.y + c.height / 2, { steps: 6 });
  await page.mouse.up();
  for (const i of [0, 1]) {
    const button = cards(page).nth(i).locator('.reset-view');
    await expect(button).toBeVisible();
    const b = await box(button);
    const chart = await box(cards(page).nth(i).locator('canvas'));
    // Bottom right of the chart, just above the time axis…
    expect(Math.abs(chart.x + chart.width - (b.x + b.width) - 18)).toBeLessThan(3);
    expect(Math.abs(chart.y + chart.height - (b.y + b.height) - 32)).toBeLessThan(3);
    // …and nothing covers it.
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.reset-view'), [b.x + b.width / 2, b.y + b.height / 2])).toBe(true);
  }
  await cards(page).first().locator('.reset-view').click();
  await expect(page.locator('.plot-card .reset-view:visible')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the timestamp lines show on the state lanes themselves (and go when turned off)', async ({ env }) => {
  const { page, broker, errors } = await setup(env);
  for (let i = 0; i < 6; i++) {
    await broker.publish('robot/state', JSON.stringify({ battery: 80, speed: 1, driving: i % 2 === 0, docked: false }));
    await new Promise((r) => setTimeout(r, 250));
  }
  await cards(page).first().locator('.kind-toggle .seg-btn[data-kind="states"]').click();
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Freeze' }).click();
  // How much a lane's pixels change across each timestamp line (vs 3 px to the side).
  const contrast = () =>
    page.evaluate(() => {
      const chart = [...window.__mqttscope.plots.charts.values()][0];
      const ctx = chart.canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const px = (x, y) => ctx.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data;
      let best = 0;
      for (const bar of chart.geom.laneBars) {
        const y = bar.top + bar.height / 2;
        for (const x of chart.geom.timeGrid) {
          const [a, b] = [px(x, y), px(x + 3, y)];
          best = Math.max(best, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]));
        }
      }
      return { best, ticks: chart.geom.timeGrid.length, lanes: chart.geom.laneBars.length };
    });
  const on = await contrast();
  expect(on.lanes).toBe(2);
  expect(on.ticks).toBeGreaterThan(0);
  expect(on.best).toBeGreaterThan(40);
  await cards(page).first().locator('.plot-head').click();
  await page.locator('.plot-settings input[name="plot-timeGrid"]').uncheck();
  await expect.poll(async () => (await contrast()).ticks).toBe(0);
  expect(errors).toEqual([]);
});
