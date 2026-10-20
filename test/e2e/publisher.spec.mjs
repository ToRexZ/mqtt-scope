// Publisher: topic suggestions, payload formats and validation, QoS/retain,
// keyboard shortcut, error handling, and loading messages from the tree,
// the inspector and files.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, rowByPath, waitForTopic, viewerButton, mockDialogs, dialogCalls, tempDir, toast, menu } from './fixtures.mjs';

function publisher(page) {
  const root = page.locator('#publisher-host .publisher');
  return {
    root,
    topic: root.locator('.topic-input'),
    qos: root.locator('.pub-row').nth(0).locator('select'),
    retain: root.getByLabel('Retain'),
    format: root.locator('.pub-row').nth(1).locator('select'),
    payload: root.locator('.payload-editor'),
    validity: root.locator('.validity'),
    publish: root.getByRole('button', { name: 'Publish', exact: true }),
    button: (name) => root.getByRole('button', { name, exact: true }),
  };
}

const receivedOn = (client, topic) => client.received.filter((m) => m.topic === topic);

test('publisher: suggestions, validation, formats, QoS/retain, Ctrl+Enter, errors', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('sensors/a/temp', '1', { retain: true });
  await broker.publish('sensors/b/temp', '2', { retain: true });
  await broker.publish('other/x', '3', { retain: true });
  const { app, page, errors } = await env.connected(broker);
  await waitForTopic(page, 'other/x');
  const watcher = await env.client(broker.port);
  await watcher.subscribe('pub/#', 2);
  const pub = publisher(page);

  // Topic suggestions come from the tree.
  await pub.topic.fill('sens');
  await expect(page.locator('#pub-topics option')).toHaveCount(2);
  expect(await page.locator('#pub-topics option').evaluateAll((os) => os.map((o) => o.value).sort())).toEqual(['sensors/a/temp', 'sensors/b/temp']);
  await pub.topic.fill('');
  await expect(page.locator('#pub-topics option')).toHaveCount(3);

  // JSON validity indicator.
  await pub.topic.fill('pub/json');
  await expect(pub.format).toHaveValue('json');
  await pub.payload.fill('{"a": 1}');
  await expect(pub.validity).toHaveText('✓ valid JSON');
  await expect(pub.validity).not.toHaveClass(/bad/);
  await pub.payload.fill('{"a": ');
  await expect(pub.validity).toHaveText(/^✗ /);
  await expect(pub.validity).toHaveClass(/bad/);

  // Invalid JSON is not published.
  await pub.publish.click();
  await expect(toast(page, 'error').filter({ hasText: 'Invalid JSON — fix it or switch the format to Text' })).toBeVisible();

  // Format / Minify.
  await pub.payload.fill('{"a":1,"b":[1,2],"c":{"d":"x"}}');
  await pub.button('Format').click();
  await expect(pub.payload).toHaveValue(JSON.stringify({ a: 1, b: [1, 2], c: { d: 'x' } }, null, 2));
  await pub.button('Minify').click();
  await expect(pub.payload).toHaveValue('{"a":1,"b":[1,2],"c":{"d":"x"}}');

  // Ctrl+Enter publishes.
  await pub.payload.press('Control+Enter');
  await watcher.waitFor((m) => m.topic === 'pub/json');
  await expect(toast(page).filter({ hasText: 'Published to pub/json' }).first()).toBeVisible();
  expect(receivedOn(watcher, 'pub/json').map((m) => m.payload.toString())).toEqual(['{"a":1,"b":[1,2],"c":{"d":"x"}}']);

  // Format on invalid JSON reports an error and keeps the text.
  await pub.payload.fill('not json');
  await pub.button('Format').click();
  await expect(toast(page, 'error').filter({ hasText: 'Not valid JSON' })).toBeVisible();
  await expect(pub.payload).toHaveValue('not json');

  // Text format sends the text as-is.
  await pub.format.selectOption('text');
  await expect(pub.validity).toHaveText('');
  await pub.topic.fill('pub/text');
  await pub.payload.fill('hello {not json} ünïcødé');
  await pub.publish.click();
  const text = await watcher.waitFor((m) => m.topic === 'pub/text');
  expect(text.payload.toString('utf8')).toBe('hello {not json} ünïcødé');

  // Hex format sends exact bytes.
  await pub.format.selectOption('hex');
  await pub.payload.fill('abc');
  await expect(pub.validity).toHaveText('✗ Odd number of hex digits');
  await pub.payload.fill('00 01 ff 7f 0x10 AB');
  await expect(pub.validity).toHaveText('6 bytes');
  await pub.topic.fill('pub/hex');
  await pub.publish.click();
  const hex = await watcher.waitFor((m) => m.topic === 'pub/hex');
  expect([...hex.payload]).toEqual([0x00, 0x01, 0xff, 0x7f, 0x10, 0xab]);

  // QoS and Retain.
  await pub.format.selectOption('text');
  await pub.topic.fill('pub/retained');
  await pub.payload.fill('kept');
  await pub.qos.selectOption('1');
  await pub.retain.check();
  // Retained publishes ask first.
  await mockDialogs(app, { confirm: true });
  await pub.publish.click();
  await expect.poll(() => dialogCalls(app)).toContainEqual(expect.objectContaining({ message: 'Publish a retained message to pub/retained?' }));
  const live = await watcher.waitFor((m) => m.topic === 'pub/retained');
  expect(live.qos).toBe(1);
  const late = await env.client(broker.port);
  await late.subscribe('pub/retained', 2);
  const retained = await late.waitFor((m) => m.topic === 'pub/retained');
  expect(retained.retain).toBe(true);
  expect(retained.payload.toString()).toBe('kept');
  // The app's own tree shows it as well.
  await waitForTopic(page, 'pub/retained');

  // Wildcards and empty topics are refused; the connection stays up.
  await pub.qos.selectOption('0');
  await pub.retain.uncheck();
  await pub.topic.fill('pub/+/bad');
  await pub.publish.click();
  await expect(toast(page, 'error').filter({ hasText: 'Publish failed: Topic must not contain wildcards (+ or #)' })).toBeVisible();
  await pub.topic.fill('pub/#');
  await pub.publish.click();
  await expect(toast(page, 'error').filter({ hasText: 'wildcards' }).first()).toBeVisible();
  await pub.topic.fill('');
  await pub.publish.click();
  await expect(toast(page, 'error').filter({ hasText: 'Publish failed: Topic is required' })).toBeVisible();
  expect(await page.evaluate(() => window.__mqttscope.status.state)).toBe('connected');
  await expect(page.locator('#status-text')).toHaveText(/^Connected/);
  await pub.topic.fill('pub/after');
  await pub.payload.fill('still works');
  await pub.publish.click();
  await watcher.waitFor((m) => m.topic === 'pub/after');

  // Nothing was sent for the invalid attempts.
  expect(watcher.received.map((m) => m.topic)).toEqual(['pub/json', 'pub/text', 'pub/hex', 'pub/retained', 'pub/after']);
  expect(errors).toEqual([]);
});

test('publisher: filled from tree selection, Edit & publish, context menu and Load file…', async ({ env }) => {
  const broker = await env.broker();
  const cfg = { mode: 'auto', limits: { max: 10 } };
  await broker.publish('dev/cfg', JSON.stringify(cfg), { retain: true });
  await broker.publish('dev/bin', Buffer.from([0, 1, 0xff]), { retain: true });
  await broker.publish('dev/note', 'plain text', { retain: true });
  const { app, page, errors } = await env.connected(broker);
  await waitForTopic(page, 'dev/note');
  const watcher = await env.client(broker.port);
  await watcher.subscribe('dev/#');
  const pub = publisher(page);

  // Selecting a topic fills the publish topic.
  await (await rowByPath(page, 'dev/note')).click();
  await expect(pub.topic).toHaveValue('dev/note');
  await expect(pub.payload).toHaveValue('');

  // Collapse the publisher; Edit & publish brings it back with the message loaded.
  await pub.root.locator('.pub-head').getByRole('button', { name: 'Collapse publisher' }).click();
  await expect(pub.root).toHaveClass(/collapsed/);
  await (await rowByPath(page, 'dev/cfg')).click();
  await viewerButton(page, 'Edit & publish').click();
  await expect(pub.root).not.toHaveClass(/collapsed/);
  await expect(pub.topic).toHaveValue('dev/cfg');
  await expect(pub.format).toHaveValue('json');
  await expect(pub.payload).toHaveValue(JSON.stringify(cfg, null, 2));
  // The retain flag of a received retained message is never carried over.
  await expect(pub.retain).not.toBeChecked();
  await expect(pub.qos).toHaveValue('0');
  await expect(pub.payload).toBeFocused();
  // Edit and send it back.
  await pub.payload.fill(JSON.stringify({ ...cfg, mode: 'manual' }));
  await pub.publish.click();
  const sent = await watcher.waitFor((m) => m.topic === 'dev/cfg' && !m.retain);
  expect(JSON.parse(sent.payload)).toEqual({ ...cfg, mode: 'manual' });

  // Binary messages load as hex.
  await (await rowByPath(page, 'dev/bin')).click();
  await viewerButton(page, 'Edit & publish').click();
  await expect(pub.format).toHaveValue('hex');
  await expect(pub.payload).toHaveValue('00 01 ff');
  await expect(pub.validity).toHaveText('3 bytes');

  // Tree context menu "Publish to this topic…".
  await (await rowByPath(page, 'dev/note')).click({ button: 'right' });
  await menu(page, 'Publish to this topic…');
  await expect(pub.topic).toHaveValue('dev/note');
  await expect(pub.format).toHaveValue('text');
  await expect(pub.payload).toHaveValue('plain text');

  // Load file…: JSON file, binary file, cancelled dialog.
  const dir = tempDir();
  const jsonFile = path.join(dir, 'payload.json');
  writeFileSync(jsonFile, '{\n  "from": "file",\n  "n": [1, 2, 3]\n}\n');
  await mockDialogs(app, { openFile: jsonFile });
  await pub.button('Load file…').click();
  await expect(toast(page).filter({ hasText: 'Loaded payload.json' })).toBeVisible();
  await expect(pub.format).toHaveValue('json');
  await expect(pub.payload).toHaveValue('{\n  "from": "file",\n  "n": [1, 2, 3]\n}\n');
  await expect(pub.validity).toHaveText('✓ valid JSON');
  await pub.topic.fill('dev/fromfile');
  await pub.publish.click();
  const fromFile = await watcher.waitFor((m) => m.topic === 'dev/fromfile');
  expect(fromFile.payload.toString()).toBe('{\n  "from": "file",\n  "n": [1, 2, 3]\n}\n');

  const binFile = path.join(dir, 'blob.bin');
  writeFileSync(binFile, Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]));
  await mockDialogs(app, { openFile: binFile });
  await pub.button('Load file…').click();
  await expect(pub.format).toHaveValue('hex');
  await expect(pub.payload).toHaveValue('de ad 00 be ef');
  await pub.publish.click();
  const blob = await watcher.waitFor((m) => m.topic === 'dev/fromfile' && m.payload.length === 5);
  expect([...blob.payload]).toEqual([0xde, 0xad, 0x00, 0xbe, 0xef]);

  await mockDialogs(app, { openFile: null });
  await pub.button('Load file…').click();
  await expect(pub.payload).toHaveValue('de ad 00 be ef');
  expect(errors).toEqual([]);
});

test('publisher safety: topic stops following the tree once edited, retain resets, no double sends, retained confirm', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('robot/a/instantActions', '{}', { retain: true });
  await broker.publish('robot/b/instantActions', '{}', { retain: true });
  const { app, page, errors } = await env.connected(broker);
  await waitForTopic(page, 'robot/b/instantActions');
  const watcher = await env.client(broker.port);
  await watcher.subscribe('robot/#', 1);
  const pub = publisher(page);
  const follow = pub.root.getByRole('button', { name: 'Follow tree' });

  // Following: selection fills the topic and resets Retain.
  await (await rowByPath(page, 'robot/a/instantActions')).click();
  await expect(pub.topic).toHaveValue('robot/a/instantActions');
  await expect(follow).toHaveClass(/\bon\b/);
  await pub.retain.check();
  await (await rowByPath(page, 'robot/b/instantActions')).click();
  await expect(pub.topic).toHaveValue('robot/b/instantActions');
  await expect(pub.retain).not.toBeChecked();

  // Typing a payload locks the topic: clicking around the tree no longer retargets it.
  await pub.format.selectOption('text');
  await pub.payload.fill('STOP');
  await expect(follow).not.toHaveClass(/\bon\b/);
  await (await rowByPath(page, 'robot/a/instantActions')).click();
  await expect(pub.topic).toHaveValue('robot/b/instantActions');
  // Turning following back on takes the selected topic.
  await follow.click();
  await expect(pub.topic).toHaveValue('robot/a/instantActions');

  // A double click and a held Ctrl+Enter send exactly once each.
  await pub.publish.dblclick();
  await pub.payload.click();
  await page.keyboard.down('Control');
  for (let i = 0; i < 5; i++) await page.keyboard.down('Enter'); // repeats
  await page.keyboard.up('Enter');
  await page.keyboard.up('Control');
  await broker.publish('robot/zz', 'marker');
  await watcher.waitFor((m) => m.topic === 'robot/zz');
  const sent = () => watcher.received.filter((m) => m.topic === 'robot/a/instantActions' && m.payload.toString() === 'STOP');
  await expect.poll(() => sent().length).toBe(2);
  await page.waitForTimeout(300);
  expect(sent().length).toBe(2);

  // Cancelling the retained confirmation sends nothing.
  await pub.retain.check();
  await mockDialogs(app, { confirm: false });
  await pub.publish.click();
  await expect.poll(() => dialogCalls(app)).toContainEqual(expect.objectContaining({ message: 'Publish a retained message to robot/a/instantActions?' }));
  await page.waitForTimeout(300);
  expect(sent().length).toBe(2);
  await expect(pub.publish).toBeEnabled();
  expect(errors).toEqual([]);
});
