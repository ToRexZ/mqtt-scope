// Local MQTT broker with simulated traffic for trying out MQTT Scope.
//
//   node scripts/demo-broker.mjs [--port 1883] [--ws-port 9001] [--fleet 500]
//
// Publishes VDA5050-style AGV messages, sensor values, factory machine
// states, binary payloads and a large retained JSON document.

import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { parseArgs } from 'node:util';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '1883' },
    'ws-port': { type: 'string', default: '9001' },
    fleet: { type: 'string', default: '500' },
  },
});

const broker = await Aedes.createBroker();
const tcp = createServer(broker.handle);
tcp.listen(Number(args.port), () => console.log(`MQTT  tcp://localhost:${args.port}`));
const http = createHttpServer();
new WebSocketServer({ server: http }).on('connection', (ws, req) => broker.handle(createWebSocketStream(ws), req));
http.listen(Number(args['ws-port']), () => console.log(`MQTT  ws://localhost:${args['ws-port']}/mqtt`));

const publish = (topic, payload, { retain = false, qos = 0 } = {}) =>
  broker.publish({ cmd: 'publish', topic, payload: typeof payload === 'string' ? Buffer.from(payload) : payload, qos, retain, dup: false }, () => {});
const json = (topic, value, opts) => publish(topic, JSON.stringify(value), opts);
const rnd = (min, max) => min + Math.random() * (max - min);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round = (v, d = 3) => Number(v.toFixed(d));

// ---------------------------------------------------------------- AGVs

const AGVS = ['AGV-001', 'AGV-002', 'AGV-003', 'AGV-004'];
const base = (agv) => `uagv/v2/DemoRobotics/${agv}`;
let headerId = 0;
const header = (agv) => ({
  headerId: ++headerId,
  timestamp: new Date().toISOString(),
  version: '2.0.0',
  manufacturer: 'DemoRobotics',
  serialNumber: agv,
});
const agvState = new Map(
  AGVS.map((agv, i) => [agv, { x: 5 + i * 3, y: 2, theta: 0, battery: 60 + i * 10, t: Math.random() * 10, orderUpdateId: 0 }]),
);

function nodes(n, prefix) {
  return Array.from({ length: n }, (_, i) => ({
    nodeId: `${prefix}-N${String(i).padStart(3, '0')}`,
    sequenceId: i * 2,
    released: i < n / 2,
    nodePosition: { x: round(i * 1.5), y: round(Math.sin(i / 3) * 4), theta: round(Math.cos(i / 5)), mapId: 'hall-1', allowedDeviationXY: 0.5 },
    actions: i % 7 === 0 ? [{ actionType: 'pick', actionId: `act-${i}`, blockingType: 'HARD', actionParameters: [{ key: 'stationType', value: 'floor' }] }] : [],
  }));
}

function stateMessage(agv) {
  const s = agvState.get(agv);
  return {
    ...header(agv),
    orderId: `order-${agv}-${Math.floor(headerId / 30)}`,
    orderUpdateId: s.orderUpdateId,
    lastNodeId: `${agv}-N${String(Math.floor(s.t) % 40).padStart(3, '0')}`,
    lastNodeSequenceId: (Math.floor(s.t) % 40) * 2,
    driving: Math.random() > 0.2,
    paused: false,
    newBaseRequest: false,
    distanceSinceLastNode: round(rnd(0, 1.5)),
    operatingMode: 'AUTOMATIC',
    nodeStates: nodes(24, agv).map(({ nodeId, sequenceId, released, nodePosition }) => ({ nodeId, sequenceId, released, nodePosition })),
    edgeStates: Array.from({ length: 23 }, (_, i) => ({ edgeId: `${agv}-E${i}`, sequenceId: i * 2 + 1, released: i < 10 })),
    agvPosition: { x: round(s.x), y: round(s.y), theta: round(s.theta), mapId: 'hall-1', positionInitialized: true, localizationScore: round(rnd(0.85, 1), 2) },
    velocity: { vx: round(rnd(0, 1.2)), vy: 0, omega: round(rnd(-0.3, 0.3)) },
    loads: Math.random() > 0.5 ? [{ loadId: 'PAL-4711', loadType: 'EUR', weight: 312.5 }] : [],
    actionStates: [
      { actionId: 'act-0', actionType: 'pick', actionStatus: pick(['WAITING', 'RUNNING', 'FINISHED']) },
      { actionId: 'act-7', actionType: 'drop', actionStatus: 'WAITING' },
    ],
    batteryState: { batteryCharge: round(s.battery, 1), batteryVoltage: round(44 + s.battery / 25, 2), charging: s.battery < 25, reach: Math.round(s.battery * 120) },
    errors: Math.random() > 0.9 ? [{ errorType: 'laserScannerWarning', errorLevel: 'WARNING', errorDescription: 'Protective field interrupted' }] : [],
    information: [{ infoType: 'temperature', infoLevel: 'INFO', infoReferences: [{ referenceKey: 'motor', referenceValue: String(round(rnd(38, 52), 1)) }] }],
    safetyState: { eStop: 'NONE', fieldViolation: false },
  };
}

for (const agv of AGVS) {
  json(`${base(agv)}/connection`, { ...header(agv), connectionState: 'ONLINE' }, { retain: true });
  json(
    `${base(agv)}/factsheet`,
    {
      ...header(agv),
      typeSpecification: { seriesName: 'Demo Carrier', agvKinematic: 'DIFF', agvClass: 'CARRIER', maxLoadMass: 500, localizationTypes: ['NATURAL'], navigationTypes: ['AUTONOMOUS'] },
      physicalParameters: { speedMin: 0, speedMax: 1.5, accelerationMax: 0.8, decelerationMax: 1.2, heightMin: 0.4, heightMax: 0.4, width: 0.7, length: 1.1 },
      protocolFeatures: {
        optionalParameters: [],
        agvActions: ['pick', 'drop', 'startCharging', 'stopCharging', 'initPosition', 'cancelOrder', 'factsheetRequest'].map((actionType) => ({
          actionType,
          actionScopes: ['INSTANT', 'NODE'],
        })),
      },
    },
    { retain: true },
  );
}

setInterval(() => {
  for (const agv of AGVS) {
    const s = agvState.get(agv);
    s.t += 0.2;
    s.x += Math.cos(s.t / 4) * 0.15;
    s.y += Math.sin(s.t / 4) * 0.15;
    s.theta = round(Math.atan2(Math.sin(s.t / 4), Math.cos(s.t / 4)));
    s.battery = s.battery <= 5 ? 100 : s.battery - 0.02;
    json(`${base(agv)}/visualization`, { ...header(agv), agvPosition: { x: round(s.x), y: round(s.y), theta: s.theta, mapId: 'hall-1', positionInitialized: true }, velocity: { vx: round(rnd(0.5, 1.2)), vy: 0, omega: 0 } });
  }
}, 200);

setInterval(() => {
  for (const agv of AGVS) json(`${base(agv)}/state`, stateMessage(agv));
}, 1000);

setInterval(() => {
  const agv = pick(AGVS);
  agvState.get(agv).orderUpdateId++;
  json(`${base(agv)}/order`, {
    ...header(agv),
    orderId: `order-${agv}-${Date.now()}`,
    orderUpdateId: agvState.get(agv).orderUpdateId,
    nodes: nodes(120, agv),
    edges: Array.from({ length: 119 }, (_, i) => ({ edgeId: `${agv}-E${i}`, sequenceId: i * 2 + 1, released: true, startNodeId: `${agv}-N${i}`, endNodeId: `${agv}-N${i + 1}`, maxSpeed: 1.2, actions: [] })),
  });
}, 15000);

// ---------------------------------------------------------------- sensors and machines

setInterval(() => {
  for (const hall of ['hall-1', 'hall-2']) {
    const t = Date.now() / 60000;
    publish(`sensors/${hall}/temperature`, String(round(21 + Math.sin(t * 2) * 2 + rnd(-0.2, 0.2), 2)));
    publish(`sensors/${hall}/humidity`, String(round(45 + Math.cos(t) * 5 + rnd(-0.5, 0.5), 1)));
    json(`sensors/${hall}/air`, { co2: Math.round(rnd(420, 900)), pm25: round(rnd(2, 15), 1), ok: true });
  }
}, 1000);

const STATUSES = ['RUNNING', 'RUNNING', 'RUNNING', 'IDLE', 'FAULT'];
const counters = {};
for (let line = 1; line <= 3; line++) {
  for (let m = 1; m <= 12; m++) {
    const id = `factory/line-${line}/machine-${String(m).padStart(2, '0')}`;
    counters[id] = Math.floor(rnd(1000, 9000));
    publish(`${id}/status`, pick(STATUSES), { retain: true });
    json(`${id}/config`, { firmware: '3.4.1', cycleTimeMs: Math.round(rnd(800, 2000)), operator: pick(['day', 'night']) }, { retain: true });
  }
}
setInterval(() => {
  const id = pick(Object.keys(counters));
  publish(`${id}/status`, pick(STATUSES), { retain: true });
}, 2000);
setInterval(() => {
  for (const id of Object.keys(counters)) publish(`${id}/counter`, String((counters[id] += Math.floor(rnd(0, 3)))));
}, 3000);

setInterval(() => {
  const img = Buffer.alloc(4096);
  img.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  for (let i = 8; i < img.length; i++) img[i] = Math.floor(Math.random() * 256);
  publish('camera/dock-1/thumbnail', img);
}, 5000);

// Safety signals: booleans that flip now and then (try a State transitions plot).
const safety = { front_brake_manual_release: false, rear_brake_manual_release: false, bumper_bar: true, is_standing_still: false, encoders_ok: true, radar_obstacle_not_detected: true };
setInterval(() => {
  for (const k of Object.keys(safety)) if (Math.random() < 0.08) safety[k] = !safety[k];
  json('robot/status/safety/hardware', safety);
}, 500);

setInterval(() => publish('logs/gateway', `${new Date().toISOString()} INFO gateway: forwarded ${Math.floor(rnd(10, 400))} frames`), 1500);

// Edge cases: leading slash, empty levels, empty payload, unicode.
publish('/leading/slash', 'topic starts with a slash', { retain: true });
publish('empty//level', 'topic with an empty level', { retain: true });
publish('edge/empty-payload', '', { retain: false });
publish('edge/unicode/ünïcødé', 'Grüße 👋 — 日本語', { retain: true });

// A large retained document (~1.5 MB).
json(
  'maps/hall-1/graph',
  {
    mapId: 'hall-1',
    generated: new Date().toISOString(),
    nodes: Array.from({ length: 6000 }, (_, i) => ({ id: `N${i}`, x: round(rnd(0, 200)), y: round(rnd(0, 80)), zone: pick(['A', 'B', 'C', 'charging', 'dock']), neighbours: [`N${(i + 1) % 6000}`, `N${(i + 7) % 6000}`] })),
  },
  { retain: true },
);

// ---------------------------------------------------------------- fleet (scale)

const fleet = Number(args.fleet);
for (let i = 1; i <= fleet; i++) {
  json(`fleet/robot-${String(i).padStart(4, '0')}/heartbeat`, { ok: true, uptime: Math.floor(rnd(0, 1e6)), fw: '1.2.3' }, { retain: true });
}
if (fleet) {
  setInterval(() => {
    for (let k = 0; k < 20; k++) {
      const i = 1 + Math.floor(Math.random() * fleet);
      json(`fleet/robot-${String(i).padStart(4, '0')}/heartbeat`, { ok: Math.random() > 0.02, uptime: Math.floor(rnd(0, 1e6)), fw: '1.2.3' }, { retain: true });
    }
  }, 1000);
}

console.log(`Simulating ${AGVS.length} AGVs, 36 machines, ${fleet} fleet robots. Ctrl+C to stop.`);
