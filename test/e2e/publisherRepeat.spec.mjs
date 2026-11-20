// Publisher Repeat: send the composed message over and over at a rate in Hz
// (typed, or picked from a menu) until stopped; checks run once at Start,
// edits don't change what is sent, and a disconnect stops it.

import { test, expect, mockDialogs, dialogCalls, toast, menuLabels, menu, rowByPath } from './fixtures.mjs';

function publisher(page) {
  const root = page.locator('#publisher-host .publisher');
  return {
    root,
    topic: root.locator('.topic-input'),
    retain: root.getByLabel('Retain'),
    payload: root.locator('.payload-editor'),
    repeat: root.getByLabel('Repeat at'),
    rate: root.locator('input[name="repeat-rate"]'),
    rates: root.getByRole('button', { name: 'Common rates' }),
    send: root.locator('.pub-row').first().locator('.btn.primary'),
    note: root.locator('.repeat-note'),
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('repeat: rate typed or picked, start/stop, snapshot, shortcut, retain once, disconnect', async ({ env }) => {
  const broker = await env.broker();
  const { app, page, errors } = await env.connected(broker);
  const watcher = await env.client(broker.port);
  await watcher.subscribe('rep/#', 1);
  const on = (topic) => watcher.received.filter((m) => m.topic === topic);
  const pub = publisher(page);
  await pub.topic.fill('rep/hb');
  await pub.payload.fill('{"alive":true}');

  // Unticked: Publish sends once, as before.
  await expect(pub.send).toHaveText('Publish');
  await pub.send.click();
  await expect.poll(() => on('rep/hb').length).toBe(1);
  await expect(toast(page).filter({ hasText: 'Published to rep/hb' })).toBeVisible();

  // Ticked: Start, at a typed rate; only valid rates allow it.
  await pub.repeat.check();
  await expect(pub.send).toHaveText('Start');
  await expect(pub.rate).toHaveValue('1');
  for (const bad of ['abc', '0', '500', '1e3']) {
    await pub.rate.fill(bad);
    await expect(pub.rate).toHaveClass(/bad/);
    await expect(pub.send).toBeDisabled();
  }
  await pub.rate.fill('10');
  await expect(pub.rate).not.toHaveClass(/bad/);
  await expect(pub.send).toBeEnabled();

  // ▾ offers the common rates.
  await pub.rates.click();
  expect(await menuLabels(page)).toEqual(['0.1 Hz', '0.2 Hz', '0.5 Hz', '1 Hz', '2 Hz', '5 Hz', '10 Hz', '20 Hz', '50 Hz', '100 Hz']);
  await menu(page, '20 Hz');
  await expect(pub.rate).toHaveValue('20');
  await pub.rate.fill('10');

  // Start: the same message again and again, counted on the button.
  const before = on('rep/hb').length;
  await pub.send.click();
  await expect(pub.send).toHaveText(/^Stop \(\d+\)$/);
  await expect.poll(() => on('rep/hb').length - before, { timeout: 3000 }).toBeGreaterThanOrEqual(5);
  await expect(toast(page).filter({ hasText: 'Published to rep/hb' })).toHaveCount(0);

  // Editing while it runs doesn't change what is sent; a note says so.
  await expect(pub.note).toBeHidden();
  await pub.payload.fill('{"alive":false}');
  await expect(pub.note).toBeVisible();
  await expect(pub.note).toContainText('as it was at Start');
  const mark = on('rep/hb').length;
  await expect.poll(() => on('rep/hb').length - mark).toBeGreaterThanOrEqual(3);
  expect(new Set(on('rep/hb').map((m) => m.payload.toString()))).toEqual(new Set(['{"alive":true}']));
  await pub.payload.fill('{"alive":true}');
  await expect(pub.note).toBeHidden();

  // Stop: nothing more arrives.
  await pub.send.click();
  await expect(pub.send).toHaveText('Start');
  await sleep(150);
  const stopped = on('rep/hb').length;
  await sleep(400);
  expect(on('rep/hb').length).toBe(stopped);

  // The Publish shortcut starts and stops it too.
  await pub.payload.click();
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Enter`);
  await expect(pub.send).toHaveText(/^Stop \(\d+\)$/);
  await expect.poll(() => on('rep/hb').length - stopped).toBeGreaterThanOrEqual(2);
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Enter`);
  await expect(pub.send).toHaveText('Start');

  // Retained: one confirmation for the whole run, and the broker keeps it.
  await mockDialogs(app, {});
  await pub.topic.fill('rep/retained');
  await pub.retain.check();
  await pub.send.click();
  await expect.poll(() => on('rep/retained').length).toBeGreaterThanOrEqual(4);
  await pub.send.click();
  expect((await dialogCalls(app)).filter((c) => c.kind === 'confirm')).toHaveLength(1);
  const late = await env.client(broker.port);
  await late.subscribe('rep/retained', 1);
  const kept = await late.waitFor((m) => m.topic === 'rep/retained');
  expect([kept.retain, kept.payload.toString()]).toEqual([true, '{"alive":true}']);
  await pub.retain.uncheck();

  // Unticking Repeat while running stops it.
  await pub.topic.fill('rep/hb');
  await pub.send.click();
  await expect(pub.send).toHaveText(/^Stop/);
  await pub.repeat.uncheck();
  await expect(pub.send).toHaveText('Publish');
  await sleep(150);
  const unticked = on('rep/hb').length;
  await sleep(400);
  expect(on('rep/hb').length).toBe(unticked);

  // A disconnect stops it, with a note why.
  await pub.repeat.check();
  await pub.send.click();
  await expect(pub.send).toHaveText(/^Stop/);
  await page.locator('#btn-disconnect').click();
  await expect(pub.send).toHaveText('Start');
  await expect(toast(page).filter({ hasText: 'Repeat to rep/hb stopped: disconnected' })).toBeVisible();
  await sleep(150);
  const gone = on('rep/hb').length;
  await sleep(400);
  expect(on('rep/hb').length).toBe(gone);
  expect(errors).toEqual([]);
});

test('repeat: keeps its rate hidden, shows when it runs, fits narrow windows, edge cases', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('other/x', 'hello', { retain: true });
  const { app, page, errors } = await env.connected(broker);
  const watcher = await env.client(broker.port);
  await watcher.subscribe('rep/#', 1);
  const on = (topic) => watcher.received.filter((m) => m.topic === topic);
  const pub = publisher(page);
  // Background throttling of the window (tests switch it off; a user's window has it on).
  const throttling = (set) =>
    app.evaluate(({ BrowserWindow }, value) => {
      const wc = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')).webContents;
      if (value !== undefined) wc.setBackgroundThrottling(value);
      return wc.getBackgroundThrottling();
    }, set);
  await pub.topic.fill('rep/hb');
  await pub.payload.fill('{"alive":true}');
  await pub.repeat.check();

  // A decimal comma works; ▾ works from the keyboard.
  await pub.rate.fill('0,5');
  await expect(pub.rate).not.toHaveClass(/bad/);
  await expect(pub.rate).toHaveAttribute('aria-invalid', 'false');
  await pub.rate.fill('abc');
  await expect(pub.rate).toHaveAttribute('aria-invalid', 'true');
  await expect(pub.rates).toHaveAttribute('aria-haspopup', 'menu');
  await pub.rates.focus();
  await page.keyboard.press('Enter');
  await expect(pub.rates).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(pub.rate).toHaveValue('0.5');
  await expect(pub.rates).toHaveAttribute('aria-expanded', 'false');

  // Narrow window: the topic stays usable and the button stays in view.
  await page.setViewportSize({ width: 900, height: 700 });
  const box = await pub.topic.boundingBox();
  expect(box.width).toBeGreaterThan(150);
  const sendBox = await pub.send.boundingBox();
  const rootBox = await pub.root.boundingBox();
  expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(rootBox.x + rootBox.width);
  await page.setViewportSize({ width: 1400, height: 900 });

  // While repeating, a hidden or minimized window keeps its timers' rate:
  // background throttling is off, and on again after Stop.
  expect(await throttling(true)).toBe(true);
  await pub.rate.fill('10');
  await pub.send.click();
  await expect(pub.send).toHaveText(/^Stop/);
  await expect.poll(() => throttling()).toBe(false);

  // Collapsed publisher: its header says it repeats and can stop it; the tab
  // is marked too.
  await expect(page.locator('.conn-tab.active')).toHaveClass(/repeating/);
  await page.locator('#publisher-host').getByRole('button', { name: 'Collapse publisher' }).click();
  const head = page.locator('#publisher-host .repeat-head');
  await expect(head).toBeVisible();
  await expect(head).toContainText('Repeating rep/hb');
  await head.getByRole('button', { name: 'Stop' }).click();
  await expect(head).toBeHidden();
  await expect.poll(() => throttling()).toBe(true);
  await expect(page.locator('.conn-tab.active')).not.toHaveClass(/repeating/);
  await page.locator('#publisher-host').getByRole('button', { name: 'Expand publisher' }).click();
  await expect(pub.send).toHaveText('Start');

  // A message loaded from elsewhere while repeating: the note says it isn't sent.
  await pub.send.click();
  await expect(pub.send).toHaveText(/^Stop/);
  await (await rowByPath(page, 'other/x')).click({ button: 'right' });
  await menu(page, 'Publish to this topic…');
  await expect(pub.topic).toHaveValue('other/x');
  await expect(pub.note).toBeVisible();
  await expect.poll(() => on('rep/hb').length).toBeGreaterThan(on('rep/hb').length);
  expect(watcher.received.filter((m) => m.topic === 'other/x')).toHaveLength(0);

  // Stop stays clickable while a one-off publish is still out.
  await page.evaluate(() => {
    const p = window.__mqttscope.publisher;
    const real = p.api;
    p.api = Object.create(real);
    p.api.publish = (m) => (m.topic === 'rep/slow' ? new Promise((r) => setTimeout(() => r({ ok: true }), 6000)) : real.publish(m));
    p.send({ topic: 'rep/slow', payload: 'x', format: 'text', qos: 0, retain: false });
  });
  expect(await page.evaluate(() => window.__mqttscope.publisher.busy)).toBe(true);
  await expect(pub.send).toBeEnabled({ timeout: 1000 });
  await pub.send.click({ timeout: 1000 });
  await expect(pub.send).toHaveText('Start', { timeout: 1000 });
  expect(await page.evaluate(() => window.__mqttscope.publisher.busy), 'the one-off is still out').toBe(true);

  // Starting with no topic: the error names the problem, Recent stays as it was.
  await expect.poll(() => page.evaluate(() => window.__mqttscope.publisher.busy), { timeout: 8000 }).toBe(false); // the slow one-off is done
  await pub.topic.fill('');
  const recent = await page.evaluate(() => window.__mqttscope.publisher.recent.length);
  await pub.send.click();
  await expect(toast(page, 'error').filter({ hasText: 'Repeat to (no topic) stopped — publish failed' })).toBeVisible();
  await expect(pub.send).toHaveText('Start');
  expect(await page.evaluate(() => window.__mqttscope.publisher.recent.length)).toBe(recent);

  // A disconnect names the topic it stopped.
  await pub.topic.fill('rep/hb');
  await pub.payload.fill('{"alive":true}');
  await pub.send.click();
  await expect(pub.send).toHaveText(/^Stop/);
  await page.locator('#btn-disconnect').click();
  await expect(toast(page).filter({ hasText: 'Repeat to rep/hb stopped: disconnected' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('repeat: closing its tab stops it', async ({ env }) => {
  const broker = await env.broker();
  const { app, page, errors } = await env.connected(broker);
  const throttling = (set) =>
    app.evaluate(({ BrowserWindow }, value) => {
      const wc = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')).webContents;
      if (value !== undefined) wc.setBackgroundThrottling(value);
      return wc.getBackgroundThrottling();
    }, set);
  await throttling(true); // as for a user's window
  const watcher = await env.client(broker.port);
  await watcher.subscribe('rep/#', 1);
  const pub = publisher(page);
  await pub.topic.fill('rep/close');
  await pub.payload.fill('1');
  await pub.repeat.check();
  await pub.rate.fill('20');
  await pub.send.click();
  await expect.poll(() => watcher.received.length).toBeGreaterThanOrEqual(3);
  await page.evaluate(() => window.__mqttscope.shell.closeTab(window.__mqttscope.shell.active.connId));
  await sleep(200);
  const after = watcher.received.length;
  await sleep(500);
  expect(watcher.received.length).toBe(after);
  // Stopped with the tab, not by a failed publish afterwards; the window
  // throttles its timers again.
  await expect.poll(() => throttling()).toBe(true);
  await expect(toast(page).filter({ hasText: 'Repeat to' }), 'no note about a tab that was closed').toHaveCount(0);
  expect(errors).toEqual([]);
});
