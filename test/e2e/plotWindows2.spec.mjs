// Two main windows share the saved plots: each keeps its own tab on screen,
// and an edit in one does not disturb what the other is doing.

import path from 'node:path';
import { test, expect, makeUserData, profile, connect, waitForTopic, waitForFile } from './fixtures.mjs';

test('each window keeps its own tab; edits reach the other window without moving it or leaving full screen', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('robot/state', JSON.stringify({ battery: 80, speed: 1 }), { retain: true });
  const userData = makeUserData({ profiles: [profile(broker.port)] });
  const { app, page: a } = await env.launch({ userData });
  await connect(a);
  await waitForTopic(a, 'robot/state');
  await a.evaluate(() => window.__mqttscope.plots.addSeries(null, 'robot/state', ['battery'], { alias: 'Battery' }));
  await a.locator('.right-tabs .tab[data-tab="plots"]').click();
  await a.locator('.tab-add').click();
  await a.locator('.modal.prompt .input').fill('Second');
  await a.keyboard.press('Enter');
  await a.locator('.plot-tab', { hasText: 'Plots' }).click();
  await waitForFile(path.join(userData, 'plotTabs.json'), (b) => JSON.parse(b).tabs.length === 2);

  // A second window on the same data.
  const opened = app.waitForEvent('window');
  await a.evaluate(() => window.api.newWindow());
  const b = await opened;
  await b.setViewportSize({ width: 1600, height: 1000 });
  await b.waitForFunction(() => !!window.__mqttscope);
  await b.locator('.conn-dialog .modal-close').click();
  await b.locator('.right-tabs .tab[data-tab="plots"]').click();
  await expect(b.locator('.plot-tab-name')).toHaveText(['Plots', 'Second']);

  // A shows its plot full screen; B switches tab and adds a plot there.
  await a.locator('.plot-card .fullscreen-btn').click();
  await expect(a.locator('.plots')).toHaveClass(/solo/);
  await b.locator('.plot-tab', { hasText: 'Second' }).click();
  await b.evaluate(() => window.__mqttscope.plots.addSeries(null, 'robot/state', ['speed'], { alias: 'Speed' }));
  await expect(b.locator('.plot-card .plot-title')).toHaveText(['Speed']);

  // A sees the new plot in its tab strip, but stays on its tab, full screen.
  await expect(a.locator('.plot-tab', { hasText: 'Second' }).locator('.count')).toHaveText('1');
  await expect(a.locator('.plot-tab.active')).toContainText('Plots');
  await expect(a.locator('.plots')).toHaveClass(/solo/);
  await expect(a.locator('.plot-card .plot-title')).toHaveText(['Battery']);

  // Editing in one window, then the other, many times: each sees the other's
  // plots, and their saves are never taken for an older version's change.
  const total = (w) => w.evaluate(() => window.__mqttscope.plots.model.allPlots().length);
  let n = 2;
  for (const name of ['One', 'Two', 'Three']) {
    for (const [w, field] of [
      [b, 'speed'],
      [a, 'battery'],
    ]) {
      await w.evaluate(([f, alias]) => window.__mqttscope.plots.addSeries(null, 'robot/state', [f], { alias }), [field, `${name} ${field}`]);
      n++;
      await expect.poll(() => total(a)).toBe(n);
      await expect.poll(() => total(b)).toBe(n);
    }
  }
  for (const w of [a, b]) await expect(w.locator('.plot-tab-name')).toHaveText(['Plots', 'Second']);
});
