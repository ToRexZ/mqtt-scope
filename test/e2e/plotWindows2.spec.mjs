// Two main windows, each with a tab of its own profile: each shows its
// profile's plots, an edit in one does not disturb what the other is doing,
// and saves from both at once never undo each other.

import { test, expect, makeUserData, profile, connect, waitForTopic, waitForLayout } from './fixtures.mjs';

test('each window keeps its own profile’s plots; edits in one neither move the other nor undo its saves', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('robot/state', JSON.stringify({ battery: 80, speed: 1 }), { retain: true });
  // A profile is open in one tab at a time: the second window connects its own.
  const first = profile(broker.port);
  const userData = makeUserData({ profiles: [first, profile(broker.port, { id: 'second', name: 'Second window' })] });
  const { app, page: a } = await env.launch({ userData });
  await connect(a);
  await waitForTopic(a, 'robot/state');
  await a.evaluate(() => window.__mqttscope.plots.addSeries(null, 'robot/state', ['battery'], { alias: 'Battery' }));
  await a.locator('.right-tabs .tab[data-tab="plots"]').click();
  await a.locator('.tab-add').click();
  await a.locator('.modal.prompt .input').fill('Second');
  await a.keyboard.press('Enter');
  await a.locator('.plot-tab', { hasText: 'Plots' }).click();
  await waitForLayout(userData, first.id, (d) => d.tabs.length === 2);

  // A second window on the other profile: its own plots (none yet).
  const opened = app.waitForEvent('window');
  await a.evaluate(() => window.api.newWindow());
  const b = await opened;
  await b.setViewportSize({ width: 1600, height: 1000 });
  await b.waitForFunction(() => !!window.__mqttscope);
  await b.locator('.conn-dialog .conn-item', { hasText: 'Second window' }).click();
  await connect(b); // the plots show in a connected tab
  await b.locator('.right-tabs .tab[data-tab="plots"]').click();
  await expect(b.locator('.plot-tab-name')).toHaveText(['Plots']);
  await expect(b.locator('.plot-card')).toHaveCount(0);

  // A shows its plot full screen; B adds a plot.
  await a.locator('.plot-card .fullscreen-btn').click();
  await expect(a.locator('.plots')).toHaveClass(/solo/);
  await b.evaluate(() => window.__mqttscope.plots.addSeries(null, 'robot/state', ['speed'], { alias: 'Speed' }));
  await expect(b.locator('.plot-card .plot-title')).toHaveText(['Speed']);
  await waitForLayout(userData, 'second', (d) => d.tabs[0].plots.length === 1);

  // A keeps its plots and stays on its tab, full screen.
  await expect(a.locator('.plot-tab-name')).toHaveText(['Plots', 'Second']);
  await expect(a.locator('.plot-tab.active')).toContainText('Plots');
  await expect(a.locator('.plots')).toHaveClass(/solo/);
  await expect(a.locator('.plot-card .plot-title')).toHaveText(['Battery']);

  // Editing in one window, then the other, many times: each keeps its own
  // plots, and the saved layouts have every change of both.
  const total = (w) => w.evaluate(() => window.__mqttscope.plots.model.allPlots().length);
  const counts = new Map([
    [a, 1],
    [b, 1],
  ]);
  for (const name of ['One', 'Two', 'Three']) {
    for (const [w, field] of [
      [b, 'speed'],
      [a, 'battery'],
    ]) {
      await w.evaluate(([f, alias]) => window.__mqttscope.plots.addSeries(null, 'robot/state', [f], { alias }), [field, `${name} ${field}`]);
      counts.set(w, counts.get(w) + 1);
      for (const x of [a, b]) await expect.poll(() => total(x)).toBe(counts.get(x));
    }
  }
  const saved = (d) => d.tabs.flatMap((t) => t.plots).length;
  await waitForLayout(userData, first.id, (d) => saved(d) === 4);
  await waitForLayout(userData, 'second', (d) => saved(d) === 4);
  for (const [w, names] of [
    [a, ['Plots', 'Second']],
    [b, ['Plots']],
  ]) {
    await expect(w.locator('.plot-tab-name')).toHaveText(names);
  }
});
