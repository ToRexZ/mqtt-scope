// Connecting: refused connections, bad credentials, TLS with a private CA,
// WebSocket transport and disconnecting.

import { test, expect, makeUserData, profile, closedPort, makeCerts, mockDialogs, waitForTopic, row } from './fixtures.mjs';

// Logs every text the dialog's status line shows, including short-lived ones.
async function recordDialogStatus(page) {
  await page.evaluate(() => {
    window.__dialogStatus = [];
    let last;
    const read = () => {
      const t = document.querySelector('.conn-dialog .conn-status-line')?.textContent ?? null;
      if (t !== last) window.__dialogStatus.push((last = t));
    };
    read();
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return () => page.evaluate(() => window.__dialogStatus.slice());
}

test('refused connection: the dialog reports the failure and keeps reporting it while retrying', async ({ env }) => {
  const port = await closedPort();
  const { page, errors } = await env.launch({ userData: makeUserData({ profiles: [profile(port)] }) });
  const dlg = page.locator('.conn-dialog');
  const line = dlg.locator('.conn-status-line');
  const log = await recordDialogStatus(page);

  await dlg.locator('.connect-btn').click();
  await expect(line).toHaveText(/Error: connect ECONNREFUSED|Reconnecting/);
  await expect(dlg).toBeVisible(); // stays open so the user can fix the settings
  await expect(page.locator('#btn-disconnect')).toBeVisible();

  // Wait until the client has retried once, then look at everything the
  // dialog showed since Connect was clicked: once the attempt has failed the
  // reason must stay visible; the status line must never go blank.
  await expect.poll(log, { timeout: 8000 }).toContainEqual(expect.stringMatching(/^Reconnecting/));
  const shown = await log();
  const sinceConnect = shown.slice(shown.findIndex((t) => t?.startsWith('Connecting')));
  expect(sinceConnect[0]).toMatch(/^Connecting/);
  // Soft: a failure here is a reported bug; the rest of the test still runs.
  expect.soft(sinceConnect, `status line history: ${JSON.stringify(sinceConnect)}`).not.toContain('');

  // Close the dialog; Disconnect in the top bar stops the attempts.
  await dlg.locator('.modal-close').click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#status-text')).toHaveText(/ECONNREFUSED|Reconnecting|Offline/);
  await page.locator('#btn-disconnect').click();
  await expect(page.locator('#status-text')).toHaveText(`Disconnected — mqtt://127.0.0.1:${port}`);
  await expect(page.locator('#btn-disconnect')).toBeHidden();
  expect(errors).toEqual([]);
});

test('wrong credentials show the broker error; fixing the password connects; Disconnect disconnects', async ({ env }) => {
  const broker = await env.broker({ users: { alice: 'correct-horse' } });
  const { page, errors } = await env.launch({
    userData: makeUserData({ profiles: [profile(broker.port, { username: 'alice', password: 'wrong' })] }),
  });
  const dlg = page.locator('.conn-dialog');
  await dlg.locator('.connect-btn').click();
  await expect(dlg.locator('.conn-status-line')).toHaveText('Error: Connection refused: Bad username or password');
  await expect(dlg.locator('.conn-status-line')).toHaveClass(/\berror\b/);
  await expect(dlg).toBeVisible();
  await expect(page.locator('#status-text')).toHaveText('Error: Connection refused: Bad username or password');

  await dlg.locator('[name="password"]').fill('correct-horse');
  await dlg.locator('.connect-btn').click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#status-text')).toHaveText(`Connected — mqtt://127.0.0.1:${broker.port}`);
  await expect(page.locator('#conn-label')).toHaveText(`Test broker ${broker.port}`);
  await expect(page.locator('.tree-empty')).toHaveText('Connected. Waiting for messages…');

  await page.locator('#btn-disconnect').click();
  await expect(page.locator('#status-text')).toHaveText(`Disconnected — mqtt://127.0.0.1:${broker.port}`);
  await expect(page.locator('#conn-label')).toHaveText(`Test broker ${broker.port} · Disconnected`);
  await expect(page.locator('#btn-disconnect')).toBeHidden();
  await expect(page.locator('.tree-empty')).toHaveText('Not connected. Click the connection button above.');
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

  // Switch to the WebSocket profile.
  await page.locator('#btn-connections').click();
  await dlg.locator('.conn-item', { hasText: 'WS broker' }).click();
  await expect(dlg.locator('[name="wsPath"]')).toHaveValue('/mqtt');
  await dlg.locator('.connect-btn').click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#status-text')).toHaveText(`Connected — ws://127.0.0.1:${broker.wsPort}/mqtt`);
  await waitForTopic(page, 'secure/hello');
  expect(errors).toEqual([]);
});
