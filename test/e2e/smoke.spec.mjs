import { test, expect } from '@playwright/test';
import { startBroker } from '../helpers/broker.mjs';
import { launchApp, makeUserData, profile, connect, selectTopic } from '../helpers/app.mjs';

test('connects, builds the tree and shows a JSON message', async () => {
  const broker = await startBroker();
  const { app, page, errors } = await launchApp({ userData: makeUserData({ profiles: [profile(broker.port)] }) });
  try {
    await broker.publish('a/b/c', JSON.stringify({ hello: 'world', n: 1 }), { retain: true });
    await connect(page);
    await selectTopic(page, 'a/b/c');
    await expect(page.locator('.viewer-topic')).toHaveText('a/b/c');
    await expect(page.locator('.viewer-body .jt')).toContainText('"hello"');
    await expect(page.locator('.tree-row', { hasText: 'c' }).first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await broker.close();
  }
});
