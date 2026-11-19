// Plot zoom and pan with the mouse: the wheel zooms the timeline around the
// pointer, the sideways wheel (or Shift+wheel) and a left drag pan it, a right
// drag draws a zoom box; every plot of the tab follows. Wheel events are sent
// to the canvas: headless Chromium doesn't deliver real cancelable ones.

import { test, expect, makeUserData, profile, connect, waitForTopic, until } from './fixtures.mjs';

const plotsTab = (page) => page.locator('.right-tabs .tab[data-tab="plots"]');
const cards = (page) => page.locator('.plot-card');
const chartsNow = (page) => page.evaluate(() => [...window.__mqttscope.plots.charts.values()].map((c) => ({ range: c.range, axis: c.axis, geom: c.geom && { ...c.geom, y: c.geom.y && { ...c.geom.y } } })));
// The charts once each is drawn (a zoom can redraw the plot cards).
async function charts(page) {
  await expect.poll(async () => (await chartsNow(page)).every((c) => c.geom)).toBe(true);
  return chartsNow(page);
}
const width = (r) => r.t1 - r.t0;
const close = (a, b, tol) => Math.abs(a - b) <= tol;

async function setup(env) {
  const broker = await env.broker();
  await broker.publish('hall/temp', '20', { retain: true });
  await broker.publish('robot/state', JSON.stringify({ battery: 80 }), { retain: true });
  const userData = makeUserData({ profiles: [profile(broker.port)] });
  const ctx = await env.launch({ userData });
  await ctx.page.setViewportSize({ width: 1600, height: 1000 });
  await connect(ctx.page);
  await waitForTopic(ctx.page, 'hall/temp');
  await ctx.page.evaluate(() => {
    const { plots } = window.__mqttscope;
    plots.addSeries(null, 'hall/temp', null, { quiet: true });
    plots.addSeries(null, 'robot/state', ['battery'], { alias: 'Battery', quiet: true });
    for (const p of plots.plots) plots.model.updatePlot(p.id, { windowSec: 0 }); // All: the data fills the plot
    plots.renderAll();
  });
  await plotsTab(ctx.page).click();
  for (let i = 0; i < 30; i++) {
    await broker.publish('hall/temp', String(20 + (i % 5)));
    await broker.publish('robot/state', JSON.stringify({ battery: 80 - i }));
    await new Promise((r) => setTimeout(r, 50));
  }
  await until(() => ctx.page.evaluate(() => window.__mqttscope.plots.points('hall/temp', null).length >= 31), { message: 'points' });
  return { broker, userData, ...ctx };
}

// A wheel event over the plotting area of plot `i`, at fraction `fx` across
// (drawn: false — the plot may be empty there; its last layout is used).
async function wheel(page, i, fx, init, { drawn = true } = {}) {
  const canvas = cards(page).nth(i).locator('canvas');
  const c = await canvas.boundingBox();
  const g = drawn ? (await charts(page))[i].geom : await page.evaluate((n) => ({ ...[...window.__mqttscope.plots.charts.values()][n].lastGeom }), i);
  const clientX = c.x + g.left + (g.right - g.left) * fx;
  const clientY = c.y + (g.top + g.bottom) / 2;
  await canvas.dispatchEvent('wheel', { clientX, clientY, deltaX: 0, deltaY: 0, ...init });
}

test('wheel zooms around the pointer, sideways wheel and drags pan, right drag box-zooms', async ({ env }) => {
  const { page, broker, errors } = await setup(env);
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Freeze' }).click();
  const reset = page.locator('.plot-card .reset-view');
  const before = (await charts(page))[0].geom;
  const first = await page.evaluate(() => window.__mqttscope.plots.points('hall/temp', null)[0].t);

  // Wheel up over the middle: narrower, the middle time stays in the middle, both plots follow.
  const mid = before.t0 + (before.t1 - before.t0) * 0.5;
  await wheel(page, 0, 0.5, { deltaY: -200 });
  await expect(reset.first()).toBeVisible();
  let [a, b] = await charts(page);
  expect(close(width(a.range), (before.t1 - before.t0) * Math.exp(-0.4), 5)).toBe(true);
  expect(close((mid - a.range.t0) / width(a.range), 0.5, 0.01)).toBe(true);
  expect(b.range).toEqual(a.range);

  // Wheel down a lot: back out to the data collected, no further.
  await wheel(page, 0, 0.5, { deltaY: 5000 });
  [a] = await charts(page);
  expect(close(a.range.t0, Math.min(first, before.t0), 1)).toBe(true);
  expect(close(a.range.t1, before.t1, 1)).toBe(true);

  // Zoom in on the left, then pan with the sideways wheel and with Shift+wheel.
  await wheel(page, 0, 0.25, { deltaY: -600 });
  let r = (await charts(page))[0];
  const w = width(r.range);
  const px = r.geom.right - r.geom.left;
  await wheel(page, 0, 0.5, { deltaX: 100 });
  let n = (await charts(page))[0].range;
  expect(close(n.t0 - r.range.t0, (100 / px) * w, 2)).toBe(true);
  expect(close(width(n), w, 1)).toBe(true);
  await wheel(page, 0, 0.5, { deltaY: 100, shiftKey: true });
  const m = (await charts(page))[0].range;
  expect(close(m.t0 - n.t0, (100 / px) * w, 2)).toBe(true);
  // …and no further than the first point / the freeze.
  await wheel(page, 0, 0.5, { deltaX: -1e7 });
  n = (await charts(page))[0].range;
  expect(close(n.t0, Math.min(first, before.t0), 1)).toBe(true);
  expect(close(width(n), w, 1)).toBe(true);
  await wheel(page, 0, 0.5, { deltaX: 1e7 });
  n = (await charts(page))[0].range;
  expect(close(n.t1, before.t1, 1)).toBe(true);

  // Left drag pans: dragging right shows earlier times.
  r = (await charts(page))[0];
  const canvas = cards(page).first().locator('canvas');
  const c = await canvas.boundingBox();
  const y = c.y + (r.geom.top + r.geom.bottom) / 2;
  const x = c.x + (r.geom.left + r.geom.right) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y, { steps: 6 });
  await page.mouse.up();
  n = (await charts(page))[0].range;
  expect(close(r.range.t0 - n.t0, (120 / px) * width(r.range), 3)).toBe(true);
  expect(close(width(n), width(r.range), 1)).toBe(true);
  await expect(page.locator('.chart-sel')).toHaveCount(0);

  // Right drag: a zoom box, and no menu.
  r = (await charts(page))[0];
  await page.mouse.move(c.x + r.geom.left + px * 0.2, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(c.x + r.geom.left + px * 0.6, y, { steps: 6 });
  await expect(page.locator('.chart-sel')).toBeVisible();
  await page.mouse.up({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  n = (await charts(page))[0].range;
  expect(close(width(n), width(r.range) * 0.4, width(r.range) * 0.02)).toBe(true);

  // Wheel over the legend zooms nothing (and the plots area may scroll).
  r = (await charts(page))[0];
  await cards(page).first().locator('.plot-legend').dispatchEvent('wheel', { deltaY: -200 });
  expect((await charts(page))[0].range).toEqual(r.range);
  // Over the plot the page doesn't scroll; right and middle buttons open no
  // menu and start no autoscroll there.
  const prevented = await page.evaluate(() => {
    const cv = document.querySelector('.plot-card canvas');
    const rect = cv.getBoundingClientRect();
    const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true };
    const fire = (e) => (cv.dispatchEvent(e), e.defaultPrevented);
    const legend = document.querySelector('.plot-card .plot-legend');
    const legendWheel = new WheelEvent('wheel', { ...at, deltaY: 50 });
    legend.dispatchEvent(legendWheel);
    return {
      wheel: fire(new WheelEvent('wheel', { ...at, deltaY: 50 })),
      legendWheel: legendWheel.defaultPrevented,
      menu: fire(new MouseEvent('contextmenu', { ...at, button: 2 })),
      middle: fire(new MouseEvent('mousedown', { ...at, button: 1 })),
    };
  });
  expect(prevented).toEqual({ wheel: true, legendWheel: false, menu: true, middle: true });
  await page.mouse.up({ button: 'middle' }).catch(() => {});

  // Zoomed in between two points (nothing drawn there), the wheel still works.
  const g0 = (await charts(page))[0].geom;
  const pts = await page.evaluate(() => window.__mqttscope.plots.points('hall/temp', null).map((p) => p.t));
  const k = pts.findIndex((t, i) => i > 0 && t > g0.t0 && pts[i + 1] < g0.t1 && pts[i + 1] - t > 30);
  const between = (pts[k] + pts[k + 1]) / 2;
  await wheel(page, 0, (between - g0.t0) / (g0.t1 - g0.t0), { deltaY: -50000 });
  const tiny = (await chartsNow(page))[0].range;
  expect(width(tiny)).toBe(10);
  expect(await page.evaluate(() => [...window.__mqttscope.plots.charts.values()][0].geom)).toBeNull(); // nothing to draw
  await wheel(page, 0, 0.5, { deltaY: 1500 }, { drawn: false });
  expect(width((await chartsNow(page))[0].range)).toBeGreaterThan(100);

  // Double-click: back to the whole window.
  await canvas.dblclick();
  await expect(page.locator('.plot-card .reset-view:visible')).toHaveCount(0);
  expect(errors).toEqual([]);
  void broker;
});

test('a left drag in a value zoom pans the values too', async ({ env }) => {
  const { page, errors } = await setup(env);
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Freeze' }).click();
  const canvas = cards(page).first().locator('canvas');
  const c = await canvas.boundingBox();
  const g = (await charts(page))[0].geom;
  // Right-drag a box over part of the value area.
  await page.mouse.move(c.x + g.left + (g.right - g.left) * 0.2, c.y + g.y.top + (g.y.bottom - g.y.top) * 0.2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(c.x + g.left + (g.right - g.left) * 0.8, c.y + g.y.top + (g.y.bottom - g.y.top) * 0.7, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  const zoomed = (await charts(page))[0];
  expect(zoomed.axis.yMin).not.toBeNull();
  const span = zoomed.axis.yMax - zoomed.axis.yMin;
  // Drag down by a quarter of the value area: the values move up by a quarter.
  const z = zoomed.geom;
  const x = c.x + (z.left + z.right) / 2;
  const y0 = c.y + (z.y.top + z.y.bottom) / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  await page.mouse.move(x, y0 + (z.y.bottom - z.y.top) / 4, { steps: 5 });
  await page.mouse.up();
  const moved = (await charts(page))[0].axis;
  expect(close(moved.yMin - zoomed.axis.yMin, span / 4, span * 0.03)).toBe(true);
  expect(close(moved.yMax - moved.yMin, span, span * 0.001)).toBe(true);
  // A plot without a value zoom keeps automatic values when panned.
  const other = (await charts(page))[1];
  expect(other.axis.yMin).toBeNull();
  expect(errors).toEqual([]);
});

test('live plots: the first wheel fixes the range; the pop-out zooms and pans on its own', async ({ env }) => {
  const { app, page, broker, errors } = await setup(env);
  await wheel(page, 0, 0.5, { deltaY: -300 });
  const fixed = (await charts(page))[0].range;
  await broker.publish('hall/temp', '30');
  await new Promise((r) => setTimeout(r, 1200)); // more than a redraw
  expect((await charts(page))[0].range).toEqual(fixed);
  await cards(page).first().locator('.plot-title').click(); // keys go to the plots, not a text field
  await page.keyboard.press('Escape');
  await expect(page.locator('.plot-card .reset-view:visible')).toHaveCount(0);

  const opened = app.waitForEvent('window');
  await cards(page).first().locator('.popout-btn').click();
  const win = await opened;
  await win.setViewportSize({ width: 1100, height: 650 });
  await win.waitForFunction(() => !!window.__plotWindow?.chart.geom);
  const wcanvas = win.locator('canvas');
  const wc = await wcanvas.boundingBox();
  const wg = await win.evaluate(() => ({ ...window.__plotWindow.chart.geom }));
  await wcanvas.dispatchEvent('wheel', { clientX: wc.x + (wg.left + wg.right) / 2, clientY: wc.y + (wg.top + wg.bottom) / 2, deltaY: -300 });
  const wr = await win.evaluate(() => window.__plotWindow.chart.range);
  expect(width(wr)).toBeLessThan((wg.t1 - wg.t0) * 0.6);
  await expect(win.locator('.reset-view')).toBeVisible();
  // Its zoom stays its own.
  expect(await page.evaluate(() => window.__mqttscope.plots.zoomByTab.size)).toBe(0);
  // Right drag box-zooms there too; a left drag pans.
  const g2 = await win.evaluate(() => ({ ...window.__plotWindow.chart.geom }));
  const yy = wc.y + (g2.top + g2.bottom) / 2;
  await win.mouse.move(wc.x + g2.left + (g2.right - g2.left) * 0.25, yy);
  await win.mouse.down({ button: 'right' });
  await win.mouse.move(wc.x + g2.left + (g2.right - g2.left) * 0.75, yy, { steps: 5 });
  await win.mouse.up({ button: 'right' });
  const boxed = await win.evaluate(() => window.__plotWindow.chart.range);
  // A value zoom there stays through a wheel step (time only).
  await win.evaluate(() => window.__plotWindow.chart.opts.onZoom({ ...window.__plotWindow.chart.range, yMin: 21, yMax: 23 }));
  await wcanvas.dispatchEvent('wheel', { clientX: wc.x + (g2.left + g2.right) / 2, clientY: wc.y + (g2.top + g2.bottom) / 2, deltaY: 50 });
  expect(await win.evaluate(() => [window.__plotWindow.chart.axis.yMin, window.__plotWindow.chart.axis.yMax])).toEqual([21, 23]);
  expect(close(width(boxed), (g2.t1 - g2.t0) * 0.5, (g2.t1 - g2.t0) * 0.02)).toBe(true);
  const g3 = await win.evaluate(() => ({ ...window.__plotWindow.chart.geom }));
  const prePan = await win.evaluate(() => window.__plotWindow.chart.range);
  await win.mouse.move(wc.x + (g3.left + g3.right) / 2, yy);
  await win.mouse.down();
  await win.mouse.move(wc.x + (g3.left + g3.right) / 2 + 80, yy, { steps: 5 });
  await win.mouse.up();
  const panned = await win.evaluate(() => window.__plotWindow.chart.range);
  expect(panned.t0).toBeLessThan(prePan.t0);
  expect(close(width(panned), width(prePan), 1)).toBe(true);
  expect(errors).toEqual([]);
});

// Drags across plot `i` (time only) with `button`; returns the range before.
async function dragAcross(page, i, button, from = 0.3, to = 0.6) {
  const r = (await charts(page))[i];
  const c = await cards(page).nth(i).locator('canvas').boundingBox();
  const y = c.y + (r.geom.top + r.geom.bottom) / 2;
  const px = r.geom.right - r.geom.left;
  await page.mouse.move(c.x + r.geom.left + px * from, y);
  await page.mouse.down({ button });
  await page.mouse.move(c.x + r.geom.left + px * to, y, { steps: 6 });
  const boxed = await page.locator('.chart-sel').isVisible();
  await page.mouse.up({ button });
  return { before: r.range, after: (await charts(page))[i].range, boxed };
}

test('Settings → Keyboard → Plot mouse: swap the drags; equal is refused; kept after a restart and in a pop-out', async ({ env }) => {
  const { app, page, userData, broker, errors } = await setup(env);
  const dlg = page.locator('.modal.settings');
  const pan = dlg.locator('select[name="mouse-pan"]');
  const box = dlg.locator('select[name="mouse-box"]');
  const save = dlg.getByRole('button', { name: 'Save' });
  await page.locator('#btn-settings').click();
  await dlg.locator('.tab[data-tab="keyboard"]').click();
  await expect(dlg.locator('.keys-mouse')).toContainText('Plot mouse');
  await expect(dlg.locator('.keys-mouse')).toContainText('wheel');
  await expect(pan).toHaveValue('left');
  await expect(box).toHaveValue('right');
  expect(await pan.locator('option').allTextContents()).toEqual(['Left drag', 'Right drag', 'Middle drag', 'Shift + left drag', 'Ctrl/Cmd + left drag']);

  // The same drag for both: said, and Save is off.
  await pan.selectOption('right');
  await expect(dlg.locator('.keys-mouse .field-hint.bad')).toHaveText('Pan and Box zoom use the same drag. Change one of them to save.');
  await expect(save).toBeDisabled();
  await box.selectOption('left');
  await expect(dlg.locator('.keys-mouse .field-hint.bad')).toHaveText('');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dlg).toHaveCount(0);

  // Now a right drag pans and a left drag box-zooms.
  await page.locator('.plots-toolbar').getByRole('button', { name: 'Freeze' }).click();
  await page.evaluate(() => {
    const { plots } = window.__mqttscope;
    const ts = plots.points('hall/temp', null).map((p) => p.t);
    const [a, b] = [ts[0], ts[ts.length - 1]];
    plots.zoom(plots.plots[0], { t0: a + (b - a) * 0.4, t1: a + (b - a) * 0.8 }); // inside the data, room on both sides
  });
  let d = await dragAcross(page, 0, 'right');
  expect(d.boxed).toBe(false);
  expect(d.after.t0).toBeLessThan(d.before.t0);
  expect(close(width(d.after), width(d.before), 1)).toBe(true);
  d = await dragAcross(page, 0, 'left');
  expect(d.boxed).toBe(true);
  expect(close(width(d.after), width(d.before) * 0.3, width(d.before) * 0.02)).toBe(true);
  await expect(page.locator('.ctx-menu')).toHaveCount(0);

  // Reset all restores the defaults in the form.
  await page.locator('#btn-settings').click();
  await dlg.locator('.tab[data-tab="keyboard"]').click();
  await expect(pan).toHaveValue('right');
  await dlg.getByRole('button', { name: 'Reset all to defaults' }).click();
  await expect(pan).toHaveValue('left');
  await expect(box).toHaveValue('right');
  await page.keyboard.press('Escape'); // not saved

  // Kept after a restart, and a pop-out opened then uses them.
  await env.closeApp({ app });
  const again = await env.launch({ userData });
  await again.page.setViewportSize({ width: 1600, height: 1000 });
  await plotsTab(again.page).click();
  for (let i = 0; i < 20; i++) {
    await broker.publish('hall/temp', String(20 + (i % 4)));
    await new Promise((r) => setTimeout(r, 40));
  }
  await until(() => again.page.evaluate(() => window.__mqttscope.plots.points('hall/temp', null).length >= 20), { message: 'points after the restart' });
  const opened = again.app.waitForEvent('window');
  await cards(again.page).first().locator('.popout-btn').click();
  const win = await opened;
  await win.setViewportSize({ width: 1100, height: 650 });
  await win.waitForFunction(() => !!window.__plotWindow?.chart.geom);
  await win.evaluate(() => {
    const ts = window.__plotWindow.data.points('hall/temp', null).map((p) => p.t);
    const [a, b] = [ts[0], ts[ts.length - 1]];
    window.__plotWindow.chart.opts.onZoom({ t0: a + (b - a) * 0.4, t1: a + (b - a) * 0.8 });
  });
  const wc = await win.locator('canvas').boundingBox();
  const g = await win.evaluate(() => ({ ...window.__plotWindow.chart.geom }));
  const y = wc.y + (g.top + g.bottom) / 2;
  const before = await win.evaluate(() => window.__plotWindow.chart.range);
  await win.mouse.move(wc.x + g.left + (g.right - g.left) * 0.3, y);
  await win.mouse.down({ button: 'right' });
  await win.mouse.move(wc.x + g.left + (g.right - g.left) * 0.6, y, { steps: 5 });
  await expect(win.locator('.chart-sel')).toHaveCount(0);
  await win.mouse.up({ button: 'right' });
  const after = await win.evaluate(() => window.__plotWindow.chart.range);
  expect(after.t0).toBeLessThan(before.t0);
  expect(close(width(after), width(before), 1)).toBe(true);
  expect(errors).toEqual([]);
});
