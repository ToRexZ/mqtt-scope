// Saved messages library and recent publishes, persisted across restarts.

import path from 'node:path';
import { test, expect, makeUserData, profile, connect, mockDialogs, dialogCalls, answerPrompt, toast, waitForFile } from './fixtures.mjs';

function publisher(page) {
  const root = page.locator('#publisher-host .publisher');
  return {
    root,
    topic: root.locator('.topic-input'),
    qos: root.locator('.pub-row').nth(0).locator('select'),
    retain: root.getByLabel('Retain'),
    format: root.locator('.pub-row').nth(1).locator('select'),
    payload: root.locator('.payload-editor'),
    button: (name) => root.getByRole('button', { name, exact: true }),
    items: root.locator('.lib-list .lib-item'),
    names: root.locator('.lib-list .lib-item .lib-name'),
    item: (name) => root.locator('.lib-list .lib-item').filter({ has: page.locator('.lib-name', { hasText: new RegExp(`^${name}$`) }) }),
    only: root.getByLabel('This topic only'),
  };
}

async function compose(pub, { topic, payload, format = 'text', qos = '0', retain = false }) {
  await pub.topic.fill(topic);
  await pub.format.selectOption(format);
  await pub.payload.fill(payload);
  await pub.qos.selectOption(qos);
  await pub.retain.setChecked(retain);
}

test('saved messages: save, send, order, filter, rename, delete, recent, persistence', async ({ env }) => {
  const broker = await env.broker();
  const userData = makeUserData({ profiles: [profile(broker.port)] });
  const first = await env.launch({ userData });
  const { app, page } = first;
  await connect(page);
  const watcher = await env.client(broker.port);
  await watcher.subscribe('lib/#', 2);
  const pub = publisher(page);
  await expect(pub.root.locator('.lib-list')).toHaveText('Nothing saved yet. Compose a message and click “Save…”.');

  // Save… asks for a name, defaulting to the last topic level.
  await compose(pub, { topic: 'lib/a', payload: 'payload A' });
  await pub.button('Save…').click();
  await expect(page.locator('.modal.prompt input')).toHaveValue('a');
  await expect(page.locator('.modal.prompt')).toContainText('Name for this message on lib/a');
  await answerPrompt(page, 'Alpha msg');
  await expect(toast(page).filter({ hasText: 'Saved “Alpha msg”' })).toBeVisible();
  await expect(pub.names).toHaveText(['Alpha msg']);
  await expect(pub.item('Alpha msg').locator('.lib-topic')).toHaveText('lib/a');
  await expect(pub.item('Alpha msg').locator('.lib-preview')).toHaveText('payload A');

  await compose(pub, { topic: 'lib/b', payload: '{"b": 2}', format: 'json', qos: '1', retain: true });
  await pub.button('Save…').click();
  await answerPrompt(page, 'Beta msg');
  await compose(pub, { topic: 'lib/c', payload: 'C' });
  await pub.button('Save…').click();
  await answerPrompt(page, 'Gamma');

  // Cancelling the prompt saves nothing.
  await pub.button('Save…').click();
  await page.locator('.modal.prompt').getByRole('button', { name: 'Cancel' }).click();
  await expect(pub.items).toHaveCount(3);

  // Entries for the current topic come first.
  await expect(pub.names).toHaveText(['Gamma', 'Alpha msg', 'Beta msg']);
  await expect(pub.items.first()).toHaveClass(/match/);
  await pub.topic.fill('lib/b');
  await expect(pub.names).toHaveText(['Beta msg', 'Alpha msg', 'Gamma']);
  await expect(pub.item('Beta msg')).toHaveClass(/match/);
  await expect(pub.item('Alpha msg')).not.toHaveClass(/match/);

  // "This topic only".
  await pub.only.check();
  await expect(pub.names).toHaveText(['Beta msg']);
  await pub.topic.fill('lib/nothing');
  await expect(pub.root.locator('.lib-list')).toHaveText('No saved messages for this topic');
  await pub.only.uncheck();
  await expect(pub.items).toHaveCount(3);

  // ▶ sends the saved message with its own options (retained ones ask first).
  await mockDialogs(app, { confirm: true });
  await pub.item('Beta msg').locator('.send').click();
  await expect.poll(() => dialogCalls(app)).toContainEqual(expect.objectContaining({ message: 'Publish a retained message to lib/b?' }));
  const beta = await watcher.waitFor((m) => m.topic === 'lib/b');
  expect(beta.payload.toString()).toBe('{"b": 2}');
  expect(beta.qos).toBe(1);
  const late = await env.client(broker.port);
  await late.subscribe('lib/b');
  expect((await late.waitFor((m) => m.topic === 'lib/b')).retain).toBe(true);

  // Clicking an entry loads it into the editor.
  await pub.item('Gamma').locator('.lib-text').click();
  await expect(pub.topic).toHaveValue('lib/c');
  await expect(pub.payload).toHaveValue('C');
  await expect(pub.format).toHaveValue('text');
  await pub.item('Beta msg').locator('.lib-text').click();
  await expect(pub.format).toHaveValue('json');
  await expect(pub.qos).toHaveValue('1');
  await expect(pub.retain).toBeChecked();

  // Rename.
  await pub.item('Gamma').getByRole('button', { name: '✎' }).click();
  await expect(page.locator('.modal.prompt input')).toHaveValue('Gamma');
  await answerPrompt(page, 'Gamma renamed');
  await expect(pub.item('Gamma renamed')).toHaveCount(1);
  await expect(pub.item('Gamma')).toHaveCount(0);

  // Delete: cancelled, then confirmed.
  await mockDialogs(app, { confirm: false });
  await pub.item('Gamma renamed').getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => dialogCalls(app)).toContainEqual(expect.objectContaining({ message: 'Delete saved message “Gamma renamed”?' }));
  await expect(pub.items).toHaveCount(3);
  await mockDialogs(app, { confirm: true });
  await pub.item('Gamma renamed').getByRole('button', { name: 'Delete' }).click();
  await expect(pub.items).toHaveCount(2);
  await expect(pub.item('Gamma renamed')).toHaveCount(0);

  // Recent lists what was sent, newest first.
  await compose(pub, { topic: 'lib/a', payload: 'payload A2' });
  await pub.button('Publish').click();
  await watcher.waitFor((m) => m.topic === 'lib/a');
  await pub.button('Recent').click();
  await expect(pub.root.locator('.lib-list .lib-item .lib-topic')).toHaveText(['lib/a', 'lib/b']);
  await expect(pub.root.locator('.lib-list .lib-item .lib-preview')).toHaveText(['payload A2', '{"b": 2}']);
  await expect(pub.root.locator('.lib-list .lib-item .lib-name').first()).toHaveText(/^\d\d:\d\d:\d\d\.\d{3}$/);
  // Sending the same message again moves it to the top instead of duplicating it.
  await pub.root.locator('.lib-list .lib-item').nth(1).locator('.send').click();
  await expect(pub.root.locator('.lib-list .lib-item .lib-topic')).toHaveText(['lib/b', 'lib/a']);
  // ★ saves a recent message to the library.
  await pub.root.locator('.lib-list .lib-item').nth(1).getByRole('button', { name: '★' }).click();
  await answerPrompt(page, 'From recent');
  await expect(pub.names).toHaveText(['Alpha msg', 'From recent', 'Beta msg']);

  // Persisted.
  const file = path.join(userData, 'savedMessages.json');
  await waitForFile(file, (b) => {
    const d = JSON.parse(b);
    return d.saved.length === 3 && d.recent.length === 2 && d.saved.some((s) => s.name === 'From recent');
  });
  expect(first.errors).toEqual([]);
  await env.closeApp(first);

  const second = await env.launch({ userData });
  await connect(second.page); // the publisher shows in a connected tab
  const pub2 = publisher(second.page);
  await expect(pub2.names).toHaveText(['Alpha msg', 'From recent', 'Beta msg']);
  await expect(pub2.item('Beta msg').locator('.lib-preview')).toHaveText('{"b": 2}');
  await pub2.item('Beta msg').locator('.lib-text').click();
  await expect(pub2.topic).toHaveValue('lib/b');
  await expect(pub2.qos).toHaveValue('1');
  await expect(pub2.retain).toBeChecked();
  await pub2.button('Recent').click();
  await expect(pub2.root.locator('.lib-list .lib-item .lib-topic')).toHaveText(['lib/b', 'lib/a']);
  expect(second.errors).toEqual([]);
});
