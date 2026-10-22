// Launches the packaged app (dist/*-unpacked) headless, connects it to an
// in-process broker and checks a message arrives. Run after `npm run dist:*`.
//
//   node scripts/verify-package.mjs [path/to/executable]

import { _electron as electron } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { startBroker } from '../test/helpers/broker.mjs';
import { makeUserData, profile } from '../test/helpers/app.mjs';

// electron-builder names output folders after platform and arch
// (linux-unpacked, win-unpacked, mac, mac-arm64, mac-universal).
function findExecutable() {
  if (!existsSync('dist')) return null;
  const dirs = readdirSync('dist');
  const pick = (re, rel) => dirs.filter((d) => re.test(d)).map((d) => path.join('dist', d, rel)).find(existsSync);
  if (process.platform === 'linux') return pick(/^linux(-\w+)?-unpacked$/, 'mqtt-scope');
  if (process.platform === 'win32') return pick(/^win(-\w+)?-unpacked$/, 'MQTT Scope.exe');
  return pick(/^mac(-\w+)?$/, 'MQTT Scope.app/Contents/MacOS/MQTT Scope');
}
const exe = process.argv[2] || findExecutable();
if (!exe || !existsSync(exe)) {
  console.error(`Packaged executable not found: ${exe}. Contents of dist/: ${existsSync('dist') ? readdirSync('dist').join(', ') : '(missing)'}`);
  process.exit(1);
}

const broker = await startBroker();
// Update checks off: a packaged app would otherwise ask GitHub at startup.
const userData = makeUserData({ profiles: [profile(broker.port)], settings: { checkForUpdates: false } });
const app = await electron.launch({
  executablePath: path.resolve(exe),
  args: process.platform === 'linux' ? ['--ozone-platform=headless'] : [],
  // XDG_DATA_HOME: where a packaged AppImage adds its menu entry; never the real ~/.local/share.
  env: { ...process.env, MQTTSCOPE_USER_DATA: userData, MQTTSCOPE_HIDDEN: '1', XDG_DATA_HOME: path.join(userData, 'share') },
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.waitForSelector('.conn-dialog .connect-btn');
  await page.click('.connect-btn');
  await page.waitForFunction(() => window.__mqttscope.status.state === 'connected', null, { timeout: 15000 });
  await broker.publish('verify/package', '{"ok":true}', { retain: true });
  await page.waitForFunction(() => !!window.__mqttscope.tree.find('verify/package'), null, { timeout: 15000 });
  if (errors.length) throw new Error(`Renderer errors: ${errors.join('\n')}`);
  console.log(`OK: ${exe} connected and received a message (v${await app.evaluate(({ app: electronApp }) => electronApp.getVersion())})`);
} finally {
  await app.close();
  await broker.close();
}
