// Regenerates docs/screenshots/*.png by driving the app against the demo broker.
//
//   node scripts/screenshots.mjs

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, makeUserData, profile, openTabTo } from '../test/helpers/app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'screenshots');
mkdirSync(out, { recursive: true });

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const wsPort = await freePort();
const broker = spawn(process.execPath, [path.join(root, 'scripts', 'demo-broker.mjs'), '--port', String(port), '--ws-port', String(wsPort)], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) => broker.stdout.on('data', (d) => String(d).includes('Simulating') && resolve()));

const { app, page } = await launchApp({
  userData: makeUserData({
    profiles: [
      profile(port, { id: 'demo', name: 'Demo broker', host: 'localhost', subscriptions: [{ topic: '#', qos: 0 }, { topic: '$SYS/#', qos: 0 }] }),
      profile(wsPort, { id: 'demo-ws', name: 'Demo over WebSocket', protocol: 'ws', host: 'localhost', wsPath: '/mqtt' }),
      profile(8883, { id: 'prod', name: 'Production (TLS)', protocol: 'mqtts', host: 'mqtt.example.com', username: 'fleet-monitor' }),
    ],
    savedMessages: {
      saved: [
        { id: 's1', name: 'Start charging', topic: 'uagv/v2/DemoRobotics/AGV-001/instantActions', payload: '{\n  "headerId": 1,\n  "actions": [{ "actionType": "startCharging", "actionId": "a1", "blockingType": "HARD" }]\n}', format: 'json', qos: 1, retain: false },
        { id: 's2', name: 'Cancel order', topic: 'uagv/v2/DemoRobotics/AGV-001/instantActions', payload: '{\n  "headerId": 2,\n  "actions": [{ "actionType": "cancelOrder", "actionId": "a2", "blockingType": "HARD" }]\n}', format: 'json', qos: 1, retain: false },
        { id: 's3', name: 'Machine reset', topic: 'factory/line-1/machine-01/cmd', payload: 'RESET', format: 'text', qos: 0, retain: false },
      ],
      recent: [],
    },
  }),
});

const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const select = (topic) =>
  page.evaluate((t) => {
    const { tree, treeView } = window.__mqttscope;
    const node = tree.find(t);
    treeView.reveal(node);
    treeView.select(node);
  }, topic);

try {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForSelector('.conn-dialog');
  await page.click('.connect-btn');
  await page.waitForFunction(() => window.__mqttscope.status.state === 'connected');
  await page.waitForFunction(() => !!window.__mqttscope.tree.find('uagv/v2/DemoRobotics/AGV-001/state'), null, { timeout: 15000 });
  await page.waitForFunction(() => !!window.__mqttscope.tree.find('robot/status/safety/hardware'), null, { timeout: 15000 });
  // A second connection tab (the demo broker over WebSocket), so every shot
  // shows the tab strip with two tabs; the first tab stays the active one.
  const firstTab = await page.evaluate(() => window.__mqttscope.shell.active.connId);
  await openTabTo(page, 'Demo over WebSocket');
  // The connection list in a third tab: both demo connections open, every
  // broker checked (Production is not there).
  await page.click('.tab-new');
  await page.waitForSelector('.conn-dialog');
  await page.waitForFunction(() => !document.querySelector('.reach-dot.checking'), null, { timeout: 10000 });
  await shot('connections');
  await page.keyboard.press('Escape');
  await page.click(`.conn-tab[data-id="${firstTab}"]`);
  await page.waitForFunction((id) => window.__mqttscope.shell.active.connId === id, firstTab);
  // Two plot tabs: Fleet (lines) and Safety (state transitions + speed).
  await page.evaluate(() => {
    const { plots } = window.__mqttscope;
    const { model } = plots;
    const agv = (n) => `uagv/v2/DemoRobotics/AGV-00${n}/state`;
    model.renameTab(model.tabs[0].id, 'Fleet');
    const fleet = model.activeTabId;
    const id = plots.addSeries(null, agv(1), ['batteryState', 'batteryCharge'], { alias: 'AGV-001 battery %', quiet: true });
    plots.addSeries(id, agv(2), ['batteryState', 'batteryCharge'], { alias: 'AGV-002 battery %', quiet: true });
    plots.addSeries(id, agv(1), ['driving'], { alias: 'AGV-001 driving', quiet: true });
    model.updatePlot(id, { title: 'Fleet battery' });
    const t = plots.addSeries(null, 'sensors/hall-1/temperature', null, { alias: 'Hall 1 °C', quiet: true });
    plots.addSeries(t, 'sensors/hall-2/temperature', null, { alias: 'Hall 2 °C', quiet: true });
    model.updatePlot(t, { title: 'Temperature' });
    model.addTab('Safety');
    let safety = null;
    for (const [k, alias] of [
      ['bumper_bar', 'Bumper bar'],
      ['encoders_ok', 'Encoders OK'],
      ['radar_obstacle_not_detected', 'Radar clear'],
      ['is_standing_still', 'Standing still'],
      ['front_brake_manual_release', 'Front brake released'],
      ['rear_brake_manual_release', 'Rear brake released'],
    ]) {
      safety = plots.addSeries(safety, 'robot/status/safety/hardware', [k], { alias, quiet: true });
    }
    model.updatePlot(safety, { title: 'Safety signals' });
    const speed = plots.addSeries(null, agv(1), ['velocity', 'vx'], { alias: 'AGV-001 m/s', quiet: true });
    plots.addSeries(speed, agv(2), ['velocity', 'vx'], { alias: 'AGV-002 m/s', quiet: true });
    model.updatePlot(speed, { title: 'Speed' });
    model.switchTab(fleet);
    model.select(id);
    plots.renderAll();
  });
  await page.waitForTimeout(3000);
  await select('uagv/v2/DemoRobotics/AGV-001/state');
  await page.waitForTimeout(1200);
  await shot('inspector');
  await page.click('.tab[data-mode="diff"]');
  await page.waitForTimeout(400);
  await shot('diff');
  await page.click('.tab[data-mode="tree"]');
  await page.evaluate(() => {
    const { tree, treeView } = window.__mqttscope;
    tree.setExpandedRecursive(tree.root, false);
    for (const t of ['factory', 'factory/line-1', 'factory/line-1/machine-01', 'factory/line-1/machine-02', 'factory/line-1/machine-03', 'factory/line-2', 'sensors', 'sensors/hall-1']) tree.find(t).expanded = true;
    treeView.refresh();
    treeView.select(tree.find('factory/line-1'));
  });
  await page.waitForTimeout(1500);
  await shot('tree');
  await page.evaluate(() => {
    const { tree, treeView } = window.__mqttscope;
    tree.setExpandedRecursive(tree.root, false);
    treeView.refresh();
  });
  await select('maps/hall-1/graph');
  await page.fill('.viewer .search', 'charging');
  await page.waitForTimeout(800);
  await shot('search-large-message');
  await page.fill('.viewer .search', '');
  await page.waitForTimeout(20000);
  await page.click('.right-tabs .tab[data-tab="plots"]');
  await page.waitForTimeout(800);
  const box = await page.locator('.plot-card').first().locator('canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.72, box.y + 70);
  await page.waitForTimeout(300);
  await shot('plots');
  await page.click('.plot-tab:has-text("Safety")');
  await page.click('[title="Collapse publisher"]');
  await page.waitForTimeout(800);
  const states = await page.locator('.plot-card.kind-states canvas').boundingBox();
  await page.mouse.move(states.x + states.width * 0.42, states.y + states.height * 0.5);
  await page.waitForTimeout(300);
  await shot('plot-states');
  await page.click('[title="Expand publisher"]');
  await page.click('.plot-tab:has-text("Fleet")');
  await page.click('text=+ New plot');
  await page.fill('.picker-topic-search', 'AGV-001/state');
  await page.waitForFunction(() => document.querySelectorAll('.picker-topic').length === 1);
  await page.click('.picker-topic');
  await page.click('.picker-field:has-text("batteryCharge")');
  await page.click('.picker-field:has-text("vx")');
  await page.fill('.picker-alias >> nth=0', 'AGV-001 battery %');
  await page.fill('.picker-alias >> nth=1', 'AGV-001 speed');
  await shot('plot-picker');
  await page.keyboard.press('Escape');
  await page.click('.right-tabs .tab[data-tab="inspector"]');
  await select('uagv/v2/DemoRobotics/AGV-001/state');
  await page.fill('.topic-input', 'uagv/v2/DemoRobotics/AGV-001/instantActions');
  await page.waitForTimeout(300);
  await shot('publisher-saved');
  console.log(`Screenshots written to ${out}`);
} finally {
  await app.close();
  broker.kill();
}
