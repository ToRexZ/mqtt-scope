// Publisher Repeat: send the composed message over and over at a rate in Hz
// (typed, or picked from a menu) until stopped; checks run once at Start,
// edits don't change what is sent, and a disconnect stops it.

import { test, expect, mockDialogs, dialogCalls, toast, menuLabels, menu } from './fixtures.mjs';

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
  await expect(toast(page).filter({ hasText: 'Repeat stopped: disconnected' })).toBeVisible();
  await sleep(150);
  const gone = on('rep/hb').length;
  await sleep(400);
  expect(on('rep/hb').length).toBe(gone);
  expect(errors).toEqual([]);
});
