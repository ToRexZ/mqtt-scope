// Connecting: refused connections, bad credentials, TLS with a private CA,
// WebSocket transport and disconnecting.

import { test, expect, makeUserData, profile, closedPort, makeCerts, mockDialogs, waitForTopic, row, activeTabName, recordDialogStatus, menu } from './fixtures.mjs';

// The Disconnect entry of the active tab's menu (the toolbar shows only once
// the tab has connected).
async function tabMenuDisconnect(page) {
  await page.locator('.conn-tab.active').click({ button: 'right' });
  return page.locator('.ctx-menu .ctx-item', { hasText: /^Disconnect$/ });
}

test('refused connection: the dialog reports the failure and keeps reporting it while retrying', async ({ env }) => {
  const port = await closedPort();
  const { page, errors } = await env.launch({ userData: makeUserData({ profiles: [profile(port)] }) });
  const dlg = page.locator('.conn-dialog');
  const line = dlg.locator('.conn-status-line');
  const log = await recordDialogStatus(page);

  await dlg.locator('.connect-btn').click();
  await expect(line).toHaveText(/Error: connect ECONNREFUSED|Reconnecting/);
  await expect(dlg).toBeVisible(); // stays so the user can fix the settings
  await expect(dlg.locator('.connect-btn')).toHaveText('Retry');
  await expect(await tabMenuDisconnect(page)).not.toHaveClass(/disabled/);
  await page.keyboard.press('Escape'); // closes the menu

  // Wait until the client has retried once, then look at everything the
  // dialog showed since Connect was clicked: once the attempt has failed the
  // reason must stay visible; the status line must never go blank.
  await expect.poll(log, { timeout: 8000 }).toContainEqual(expect.stringMatching(/^Reconnecting/));
  const shown = await log();
  const sinceConnect = shown.slice(shown.findIndex((t) => t?.startsWith('Connecting')));
  expect(sinceConnect[0]).toMatch(/^Connecting/);
  // Soft: a failure here is a reported bug; the rest of the test still runs.
  expect.soft(sinceConnect, `status line history: ${JSON.stringify(sinceConnect)}`).not.toContain('');

  // Disconnect in the tab's menu stops the attempts. The tab never connected:
  // it keeps the dialog, and has nothing to resume.
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  await expect(dlg).toBeVisible();
  await tabMenuDisconnect(page);
  await menu(page, 'Disconnect');
  await expect(line).toHaveText('');
  await expect(dlg.locator('.connect-btn')).toHaveText('Connect'); // no longer Retry: stopped, not failed
  expect(await page.evaluate(() => window.__mqttscope.status)).toEqual({ state: 'disconnected', url: `mqtt://127.0.0.1:${port}` });
  await expect(page.locator('.conn-tab.active')).toHaveAttribute('data-state', 'new');
  await expect(dlg).toBeVisible();
  await expect(await tabMenuDisconnect(page)).toHaveClass(/disabled/);
  expect(errors).toEqual([]);
});

test('wrong credentials show the broker error; fixing the password connects; Disconnect disconnects and offers Reconnect', async ({ env }) => {
  const broker = await env.broker({ users: { alice: 'correct-horse' } });
  const { page, errors } = await env.launch({
    userData: makeUserData({ profiles: [profile(broker.port, { username: 'alice', password: 'wrong' })] }),
  });
  const dlg = page.locator('.conn-dialog');
  await dlg.locator('.connect-btn').click();
  await expect(dlg.locator('.conn-status-line')).toHaveText('Error: Connection refused: Bad username or password');
  await expect(dlg.locator('.conn-status-line')).toHaveClass(/\berror\b/);
  await expect(dlg).toBeVisible();
  // The tab shows the failure on its dot, under the profile's name.
  await expect(page.locator('.conn-tab.active')).toHaveAttribute('data-state', 'error');
  await expect(activeTabName(page)).toHaveText(`Test broker ${broker.port}`);
  await expect(dlg.locator('.connect-btn')).toHaveText('Retry');

  await dlg.locator('[name="password"]').fill('correct-horse');
  await dlg.locator('.connect-btn').click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#status-text')).toHaveText(`Connected — mqtt://127.0.0.1:${broker.port}`);
  await expect(activeTabName(page)).toHaveText(`Test broker ${broker.port}`);
  await expect(page.locator('.conn-tab.active')).toHaveAttribute('data-state', 'connected');
  await expect(page.locator('.tree-empty')).toHaveText('Connected. Waiting for messages…');

  await page.locator('#btn-disconnect').click();
  await expect(page.locator('#status-text')).toHaveText(`Disconnected — mqtt://127.0.0.1:${broker.port}`);
  await expect(activeTabName(page)).toHaveText(`Test broker ${broker.port}`);
  await expect(page.locator('.conn-tab.active')).toHaveAttribute('data-state', 'disconnected');
  await expect(page.locator('#btn-disconnect')).toHaveText('Reconnect');
  await expect(page.locator('.tree-empty')).toHaveText('Not connected.');
  expect(await page.evaluate(() => window.__mqttscope.status.state)).toBe('disconnected');
  expect(errors).toEqual([]);
});

test('TLS: untrusted certificate is rejected, CA chosen with Browse… connects; WebSocket connects', async ({ env }) => {
  const certs = makeCerts();
  const broker = await env.broker({ tls: certs, ws: true });
  await broker.publish('secure/hello', 'over tls', { retain: true });
  const { app, page, errors } = await env.launch({
    userData: makeUserData({
      profiles: [
        profile(broker.tlsPort, { id: 'tls', name: 'TLS broker', protocol: 'mqtts', rejectUnauthorized: true }),
        profile(broker.wsPort, { id: 'ws', name: 'WS broker', protocol: 'ws', wsPath: '/mqtt' }),
      ],
    }),
  });
  const dlg = page.locator('.conn-dialog');
  await expect(dlg.locator('.conn-item.active .conn-name')).toHaveText('TLS broker');
  await expect(dlg.locator('fieldset.tls')).toBeVisible();

  // Without the CA the self-signed chain is refused.
  await dlg.locator('.connect-btn').click();
  await expect(dlg.locator('.conn-status-line')).toHaveText(/Error: .*(self[- ]signed|certificate)/i);

  // Pick the CA file through the (mocked) native file dialog.
  await mockDialogs(app, { openFile: certs.caFile });
  await dlg.locator('fieldset.tls .field', { hasText: 'CA certificate' }).getByRole('button', { name: 'Browse…' }).click();
  await expect(dlg.locator('[name="caFile"]')).toHaveValue(certs.caFile);
  await dlg.locator('.connect-btn').click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#status-text')).toHaveText(`Connected — mqtts://127.0.0.1:${broker.tlsPort}`);
  await waitForTopic(page, 'secure/hello');
  await expect(row(page, 'secure')).toBeVisible();

  // The WebSocket profile, in a new tab.
  await page.locator('.tab-new').click();
  await dlg.locator('.conn-item', { hasText: 'WS broker' }).click();
  await expect(dlg.locator('[name="wsPath"]')).toHaveValue('/mqtt');
  await dlg.locator('.connect-btn').click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#status-text')).toHaveText(`Connected — ws://127.0.0.1:${broker.wsPort}/mqtt`);
  await waitForTopic(page, 'secure/hello');
  expect(errors).toEqual([]);
});
