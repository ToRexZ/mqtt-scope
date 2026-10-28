// Shared fixtures and helpers for the end-to-end suite.
//
// `env` owns every broker, release server, app and test client a test creates
// and tears them down afterwards (apps first, then clients, then servers), even
// when the test fails.

import { test as base, expect } from '@playwright/test';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startBroker, testClient } from '../helpers/broker.mjs';
import { startReleaseServer } from '../helpers/releaseServer.mjs';
import { launchApp, makeUserData, profile, connect } from '../helpers/app.mjs';

export { expect };
export { makeUserData, profile, connect };
export { selectTopic, openTabTo, activeTabName, reconnected } from '../helpers/app.mjs';
export { makeCerts, until } from '../helpers/broker.mjs';

export const test = base.extend({
  // Playwright requires the destructuring form for a fixture with no dependencies.
  // eslint-disable-next-line no-empty-pattern
  env: async ({}, use) => {
    const apps = [];
    const clients = [];
    const brokers = [];
    const releaseServers = [];
    const env = {
      async broker(opts) {
        const b = await startBroker(opts);
        brokers.push(b);
        return b;
      },
      async launch(opts) {
        const ctx = await launchApp(opts);
        apps.push(ctx);
        await unthrottle(ctx.app);
        return ctx;
      },
      // A fake release endpoint (see helpers/releaseServer.mjs).
      async releaseServer(release) {
        const s = await startReleaseServer(release);
        releaseServers.push(s);
        return s;
      },
      // Starts an app whose only profile points at `broker` and connects it.
      // Other options (e.g. `env`) go to launchApp.
      async connected(broker, { userData, extra, connectNow = true, ...launchOpts } = {}) {
        const ctx = await env.launch({ ...launchOpts, userData: userData || makeUserData({ profiles: [profile(broker.port, extra)] }) });
        if (connectNow) await connect(ctx.page);
        return ctx;
      },
      async client(port, opts) {
        const c = await testClient(port, opts);
        clients.push(c);
        return c;
      },
      async closeApp(ctx) {
        await closeQuietly(ctx.app);
      },
    };
    await use(env);
    for (const a of apps) await closeQuietly(a.app);
    for (const c of clients) await c.end().catch(() => {});
    for (const b of brokers) await b.close().catch(() => {});
    for (const s of releaseServers) await s.close();
  },
});

// Windows are created hidden in tests. Chromium throttles animation frames of
// hidden windows to ~1/s after a few seconds, which makes every Playwright
// click wait ~2 s for its stability check. A user's window is visible, so show
// every window (without focusing it). Under --ozone-platform=headless nothing
// appears on screen.
async function unthrottle(app) {
  if (process.env.MQTTSCOPE_E2E_HEADED) return;
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const fix = (w) => {
      w.webContents.setBackgroundThrottling(false);
      if (!w.isVisible()) w.showInactive();
    };
    for (const w of BrowserWindow.getAllWindows()) fix(w);
    electronApp.on('browser-window-created', (_e, w) => fix(w));
  });
}

async function closeQuietly(app) {
  try {
    await app.close();
  } catch {}
}

export function tempDir(prefix = 'mqttscope-e2e-files-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// ------------------------------------------------------------ tree

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The visible tree row whose name is exactly `name`.
export function row(page, name) {
  return page
    .locator('#tree-scroll .tree-row:not([hidden])')
    .filter({ has: page.locator('.name').filter({ hasText: new RegExp(`^${escapeRe(name)}$`) }) });
}

// The visible tree row for a full topic path (names can repeat across
// branches). Collapsed ancestors are expanded by clicking their carets.
// Each row is scrolled to the middle of the tree first: the tree reuses row
// elements while scrolling, so a row Playwright scrolled to itself could show
// another topic by the time it is clicked.
export async function rowByPath(page, topic) {
  const index = (t) => page.evaluate((p) => window.__mqttscope.treeView.rows.findIndex((r) => r.node.path === p), t);
  const parts = topic.split('/');
  for (let n = 1; n <= parts.length; n++) {
    const p = parts.slice(0, n).join('/');
    await expect.poll(() => index(p), { message: `tree row for ${p}` }).toBeGreaterThanOrEqual(0);
    const i = await index(p);
    await page.evaluate((x) => {
      const { treeView } = window.__mqttscope;
      const rowHeight = treeView.inner.offsetHeight / treeView.rows.length;
      treeView.scrollEl.scrollTop = x * rowHeight - (treeView.scrollEl.clientHeight - rowHeight) / 2;
    }, i);
    const r = page.locator(`#tree-scroll .tree-row[data-index="${i}"]:not([hidden])`);
    await expect(r).toBeInViewport({ ratio: 1 });
    if (n === parts.length) return r;
    if ((await r.locator('.caret').textContent()) === '▸') {
      await r.locator('.caret').click();
      await expect(r.locator('.caret')).toHaveText('▾');
    }
  }
}

// Rendered rows in display order.
export function treeRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#tree-scroll .tree-row:not([hidden])')]
      .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
      .map((r) => ({
        name: r.querySelector('.name').textContent,
        depth: (parseInt(r.style.paddingLeft, 10) - 4) / 16,
        caret: r.querySelector('.caret').textContent,
        value: r.querySelector('.value').hidden ? null : r.querySelector('.value').textContent,
        badge: r.querySelector('.badge').textContent,
        selected: r.classList.contains('selected'),
        emptyLevel: r.querySelector('.name').classList.contains('empty-level'),
      })),
  );
}

export const rowNames = async (page) => (await treeRows(page)).map((r) => '  '.repeat(r.depth) + r.name);

export async function waitForTopic(page, topic) {
  await page.waitForFunction((t) => !!window.__mqttscope.tree.find(t)?.messageCount, topic, { timeout: 10_000 });
}

// ------------------------------------------------------------ menus, dialogs

// Like helpers/app.mjs mockDialogs (same answers object), but also records
// every native dialog the app opens so tests can check what was asked.
export async function mockDialogs(app, answers) {
  await app.evaluate(({ dialog }, a) => {
    const calls = (globalThis.__dialogCalls ||= []);
    const opts = (args) => args.find((x) => x && typeof x === 'object' && ('message' in x || 'defaultPath' in x || 'properties' in x)) || {};
    // The action is the button that is not Cancel (see main/dialogs.js).
    dialog.showMessageBox = async (...args) => {
      const o = opts(args);
      calls.push({ kind: 'confirm', message: o.message, detail: o.detail });
      const cancel = o.cancelId ?? 1;
      return { response: a.confirm === false ? cancel : Math.max(0, (o.buttons || []).findIndex((_, i) => i !== cancel)) };
    };
    dialog.showSaveDialog = async (...args) => {
      calls.push({ kind: 'save', defaultPath: opts(args).defaultPath });
      return a.saveFile ? { canceled: false, filePath: a.saveFile } : { canceled: true };
    };
    dialog.showOpenDialog = async (...args) => {
      calls.push({ kind: 'open', title: opts(args).title });
      return a.openFile ? { canceled: false, filePaths: [a.openFile] } : { canceled: true, filePaths: [] };
    };
  }, answers);
}

export const dialogCalls = (app) => app.evaluate(() => globalThis.__dialogCalls || []);

export async function menu(page, label) {
  const item = page.locator('.ctx-menu .ctx-item').filter({ hasText: new RegExp(`^${escapeRe(label)}$`) });
  await expect(item).toBeVisible();
  await item.click();
}

export async function menuLabels(page) {
  await expect(page.locator('.ctx-menu')).toBeVisible();
  return page.locator('.ctx-menu .ctx-item').allTextContents();
}

// Answers the in-page prompt modal (ui.js promptText) with its OK button.
// (Pressing Enter is covered separately: see keyboard.spec.mjs.)
export async function answerPrompt(page, value) {
  const box = page.locator('.modal.prompt');
  const input = box.locator('input.input');
  await expect(input).toBeVisible();
  const handle = await box.elementHandle();
  await input.fill(value);
  await box.locator('button[type="submit"]').click();
  // This prompt closed (another one may open right after it).
  await handle.waitForElementState('hidden');
}

export const toast = (page, kind) => page.locator(kind ? `.toast.${kind}` : '.toast');

// ------------------------------------------------------------ inspector

export const viewerBody = (page) => page.locator('#viewer-host .viewer-body');
export const viewerTab = (page, mode) => page.locator(`#viewer-host .viewer-toolbar .tab[data-mode="${mode}"]`);
export const viewerButton = (page, label) => page.locator('#viewer-host .viewer').getByRole('button', { name: label, exact: true });
export const historyItems = (page) => page.locator('#viewer-host .history-item');

export async function clipboard(app) {
  return app.evaluate(({ clipboard: c }) => c.readText());
}

// Runs `action` and returns the window it opens, sized like a real window.
export async function popupFrom(app, action) {
  const [popup] = await Promise.all([app.waitForEvent('window'), action()]);
  await popup.waitForLoadState('domcontentloaded');
  await popup.setViewportSize({ width: 1200, height: 900 });
  const errors = [];
  popup.on('pageerror', (e) => errors.push(String(e)));
  popup.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { popup, errors };
}

// ------------------------------------------------------------ files

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export async function waitForFile(file, pred = () => true, message = file) {
  await expect
    .poll(
      () => {
        if (!existsSync(file)) return false;
        try {
          return !!pred(readFileSync(file));
        } catch {
          return false;
        }
      },
      { message: `waiting for ${message}`, timeout: 10_000 },
    )
    .toBe(true);
  return readFileSync(file);
}

// The plot layout saved for a profile (see main/layoutStore.js), once
// `pred(layout)` holds.
export async function waitForLayout(userData, profileId, pred = () => true) {
  const layoutOf = (b) => JSON.parse(b).byProfile?.[profileId];
  const buf = await waitForFile(path.join(userData, 'profileLayouts.json'), (b) => !!layoutOf(b) && pred(layoutOf(b)), `the plot layout of ${profileId}`);
  return layoutOf(buf);
}

// A port nothing listens on.
export async function closedPort() {
  const { createServer } = await import('node:net');
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

// Records every value `#status-text` takes, so short-lived states are not missed.
export async function recordStatus(page) {
  await page.evaluate(() => {
    const el = document.querySelector('#status-text');
    window.__statusLog = [el.textContent];
    new MutationObserver(() => window.__statusLog.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  return () => page.evaluate(() => window.__statusLog.slice());
}

// Records every text the connection dialog's status line shows (null while no
// dialog shows), including short-lived ones.
export async function recordDialogStatus(page) {
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
