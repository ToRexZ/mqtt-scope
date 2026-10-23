// Launches the real Electron app for end-to-end tests: isolated data
// directory, hidden windows, headless rendering.

import { _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function makeUserData({ profiles, savedMessages, plots, settings } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mqttscope-e2e-'));
  if (profiles) writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify(profiles));
  if (savedMessages) writeFileSync(path.join(dir, 'savedMessages.json'), JSON.stringify(savedMessages));
  if (plots) writeFileSync(path.join(dir, 'plots.json'), JSON.stringify(plots));
  if (settings) writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
}

export function profile(port, extra = {}) {
  return {
    id: `p${port}`,
    name: `Test broker ${port}`,
    protocol: 'mqtt',
    host: '127.0.0.1',
    port,
    mqttVersion: 4,
    subscriptions: [{ topic: '#', qos: 0 }],
    ...extra,
  };
}

// The update overrides (MQTTSCOPE_UPDATE_URL, _KIND, _FAKE) reach the app
// only through `env`, never from the shell that runs the tests.
const inheritedEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MQTTSCOPE_UPDATE_')));

// Returns { app, page, userData, errors }. `errors` collects renderer
// exceptions and console errors so tests can assert there were none.
// `env` adds or overrides environment variables for the app; `args` are extra
// command-line arguments; `preload` are modules the main process loads before
// main.js (electron -r).
export async function launchApp({ userData = makeUserData(), headless = !process.env.MQTTSCOPE_E2E_HEADED, env = {}, args = [], preload = [] } = {}) {
  const app = await electron.launch({
    args: [...preload.flatMap((m) => ['-r', m]), appDir, ...(headless ? ['--ozone-platform=headless'] : []), ...args],
    env: { ...inheritedEnv(), MQTTSCOPE_USER_DATA: userData, MQTTSCOPE_HIDDEN: headless ? '1' : '', ...env },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForFunction(() => !!window.__mqttscope);
  return { app, page, userData, errors };
}

// Replaces native dialogs in the main process so tests can drive them.
// answers: { confirm: boolean, saveFile: path|null, openFile: path|null }
export async function mockDialogs(app, answers) {
  await app.evaluate(({ dialog }, a) => {
    dialog.showMessageBox = async () => ({ response: a.confirm === false ? 1 : 0 });
    dialog.showSaveDialog = async () => (a.saveFile ? { canceled: false, filePath: a.saveFile } : { canceled: true });
    dialog.showOpenDialog = async () => (a.openFile ? { canceled: false, filePaths: [a.openFile] } : { canceled: true, filePaths: [] });
  }, answers);
}

// Connects using the connection dialog's selected profile.
export async function connect(page) {
  await page.waitForSelector('.conn-dialog');
  await page.click('.connect-btn');
  await page.waitForFunction(() => window.__mqttscope.status.state === 'connected', null, { timeout: 10000 });
}

// Opens a new tab with + and connects it to the profile named `profileName`
// in the connection dialog. Returns the new tab's id once it is connected.
export async function openTabTo(page, profileName) {
  const before = await page.evaluate(() => window.__mqttscope.shell.tabs.length);
  await page.click('.tab-new');
  await page.waitForFunction((n) => window.__mqttscope.shell.tabs.length === n + 1, before);
  const dialog = page.locator('.conn-dialog');
  await dialog.waitFor();
  const id = await page.evaluate(() => window.__mqttscope.shell.active.connId);
  await dialog.locator('.conn-item').filter({ has: page.locator('.conn-name').getByText(profileName, { exact: true }) }).click();
  await dialog.locator('.connect-btn').click();
  await page.waitForFunction((i) => window.__mqttscope.shell.tabs.find((t) => t.connId === i)?.status.state === 'connected', id, { timeout: 10000 });
  return id;
}

// The name shown on the active tab in the tab strip (a locator).
export const activeTabName = (page) => page.locator('.conn-tab.active .conn-tab-name');

// Selects a topic in the tree by path (expanding its parents).
export async function selectTopic(page, topic) {
  await page.waitForFunction((t) => !!window.__mqttscope.tree.find(t), topic, { timeout: 10000 });
  await page.evaluate((t) => {
    const { tree, treeView } = window.__mqttscope;
    const node = tree.find(t);
    treeView.reveal(node);
    treeView.select(node);
  }, topic);
}
