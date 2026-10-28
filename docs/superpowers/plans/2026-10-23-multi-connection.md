# Multiple Connections in Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MQTT Scope 0.4.0 holds several live broker connections per window as Chrome-style tabs, each with its own tree, inspector, plots and publisher; tabs reorder, move between windows, tear off, and come back on launch.

**Architecture:** Main owns every MQTT client in a `ConnectionRegistry` keyed by an app-wide connection id (`c1`, `c2`, …) that is also the tab id; every `mqtt:*` IPC call and event carries it. The renderer's `app.js` becomes a window shell (tab strip, shortcuts, settings) over `ConnectionTab` instances that own what `app.js` holds as globals today; only the active tab's DOM is attached, so element ids stay unique and hidden tabs skip drawing. Moving a tab is orchestrated by main: hold the connection's events, export the tab's state from one renderer, import it in the other, re-parent pop-outs, release.

**Tech Stack:** Electron 44, mqtt.js, vanilla ES modules (renderer), CommonJS (main), node:test, Playwright (Electron), aedes test brokers.

**Spec:** `docs/superpowers/specs/2026-10-22-multi-connection-design.md`

## Global Constraints

- Version 0.4.0. No new runtime dependencies. Main is CommonJS, renderer ES modules; follow existing comment density and naming; `npm run lint` clean.
- Renderer windows stay sandboxed with the existing CSP; the renderer never names a window or file path for main to act on beyond ids main gave it.
- Connection id = tab id: a string `c<n>` from a main-process counter, unique for the app's lifetime, unchanged when the tab moves.
- Copy (exact): tab label for an unconnected tab `New connection`; window title `MQTT Scope — <active tab label>`; pop-out titles `<profile name> — <topic>` and `<profile name> — <plot title>`; delete tooltip `Close its tab first`; edit hint `reconnect to apply`; window-close confirm `Close <n> connections?`; setting `Reopen tabs on launch`.
- Tab sizing: minimum tab width `100` px; name scroll speed `30` px/s with a `1.5` s pause at each end; no motion under `prefers-reduced-motion: reduce` (ellipsis instead).
- Shortcut defaults (rebindable, `keys.js`): newTab `Mod+T`, closeTab `Mod+W`, nextTab `Mod+Tab` (`Ctrl+Tab` on macOS), prevTab `Mod+Shift+Tab` (`Ctrl+Shift+Tab` on macOS), nextTabAlt `Mod+PageDown`, prevTabAlt `Mod+PageUp`, goToTab1…goToTab8 `Mod+1`…`Mod+8`, goToLastTab `Mod+9`, reopenTab `Mod+Shift+T`, tabInspector `Alt+1`, tabPlots `Alt+2`; `connections` (`Mod+K`) opens a new tab.
- Shared, not per tab: settings, saved/recent messages, shortcuts, localStorage panel sizes (`mqttscope.treeWidth`, `mqttscope.treeHeight`, `mqttscope.publisherHeight`, `mqttscope.plotSettingsWidth`) and viewer prefs (`mqttscope.viewer.*`).
- Per tab, unchanged values: history limits from settings, pause queue 200 000 messages / 256 MB, plot budget per `PlotData`. No app-wide cap.
- New store names in `main/jsonStore.js`: `profileLayouts`, `windowState`. `plotTabs.json` and `plots.json` are read (migration) but never written from 0.4.0 on.
- Test hooks: renderer `window.__mqttscope` keeps `tree, treeView, viewer, plots, publisher, status` as getters for the active tab, plus `connections`, `settings`, `shell`; main exposes `globalThis.__mqttscopeConnections` (the registry) only when `!app.isPackaged`.
- Every task ends with its own tests green plus `npm run test:unit`; tasks that touch the renderer or main also run the full `npx playwright test` and fix only tests whose expectation the spec changes.

## Review Focus

- A tab closed, or its window reloaded, while its connection is still connecting or reconnecting: no late event reaches any window, no client lingers on the broker. → Task 1 `close drops late events`; Task 2 `reloading a window closes its connections`.
- Messages arriving while a tab moves to another window: none lost, none duplicated, order kept. → Task 14 `a tab moves with its connection; messages published during the move all arrive in order`.
- Launch with a restored tab whose profile was deleted, whose broker is down, or with a corrupt `windowState.json`: the app starts with usable tabs. → Task 12 `restore skips deleted profiles and survives a corrupt state file`.
- The same topic published on two brokers: each tab's tree, inspector, plots, pop-out and pop-out plot shows only its own broker's values. → Task 2 `a pop-out only receives its own connection's messages`; Task 5 `two tabs on two brokers with the same topic stay separate`.
- Tab shortcuts pressed while typing in the publisher payload, the topic filter or the in-tab connection dialog: tab shortcuts work, typing is untouched. → Task 8 `tab shortcuts work while typing`.

---

## Stage 1: several connections per window

### Task 1: Connection registry in main

**Files:**
- Create: `main/connections.js`
- Test: `test/unit/connections.test.mjs`, `test/integration/connections.test.mjs`

**Interfaces:**
- Produces (CommonJS `module.exports = { ConnectionRegistry }`):
  - `new ConnectionRegistry({ createSession = () => new MqttSession() })` — an EventEmitter.
  - `create(ownerId: number) -> string` (`'c1'`, `'c2'`, …).
  - `get(connId) -> { session, ownerId, profileId } | null`; `ofOwner(ownerId) -> string[]`; `size`.
  - `connect(connId, profile) -> { ok: true, url } | { ok: false, error } | { ok: false, duplicate: { connId, ownerId } }` — binds `profileId = profile.id`; refuses when another connection is bound to the same profile id.
  - `disconnect(connId)`; `close(connId)` (disconnect, unbind, forget); `closeOwner(ownerId)`.
  - `findProfile(profileId) -> { connId, ownerId } | null`; `openProfileIds() -> string[]`.
  - `activeCount() -> number` (sessions with `session.active`, all owners).
  - `hold(connId)`; `setOwner(connId, ownerId)`; `release(connId)`.
  - Events: `'status' (connId, ownerId, status)`, `'warning' (connId, ownerId, message)`, `'batch' (connId, ownerId, batch)`, `'openProfiles' (ids: string[])` whenever the bound set changes. While held, the three connection events are queued and emitted on `release` in order with the owner current at release.

- [ ] **Step 1: Write the failing unit tests** (fake session: an EventEmitter with `connect(p)` returning `{ ok: true, url: 'mqtt://x' }` and setting `active = true`, `disconnect()` setting `active = false`, `status`)

```js
test('create returns app-wide unique ids', () => { const r = reg(); assert.deepEqual([r.create(1), r.create(2), r.create(1)], ['c1', 'c2', 'c3']); });
test('events carry the connection id and its owner', () => { /* session emits 'status' → registry emits ('status', 'c1', 1, status) */ });
test('connect refuses a profile bound to another connection', () => {
  // c1 connect({id:'a'}) ok; c2 connect({id:'a'}) → { ok:false, duplicate:{ connId:'c1', ownerId:1 } }; c1 connect({id:'a'}) again → ok
});
test('connecting another profile rebinds the connection', () => { /* c1: a then b → openProfileIds() deepEqual ['b'] */ });
test('close drops late events', () => { /* close('c1'); fake session emits 'batch' → registry emits nothing; session.disconnect called */ });
test('closeOwner closes only that window', () => { /* c1,c2 owner 1; c3 owner 2 → closeOwner(1) → size 1, get('c3') kept */ });
test('hold queues events in order; release delivers them to the new owner', () => {
  // hold c1; session emits batch A, status S, batch B; setOwner(c1, 2); release → emitted [batch A, status S, batch B] each with ownerId 2
});
test('activeCount counts active sessions of every owner', () => {});
test('openProfiles fires when the bound set changes', () => { /* connect a → ['a']; connect same again → no event; close → [] */ });
```

- [ ] **Step 2: Run `node --test test/unit/connections.test.mjs`** — Expected: FAIL, `Cannot find module '../../main/connections.js'`.
- [ ] **Step 3: Implement `ConnectionRegistry`** in `main/connections.js`; wire each session's events through a per-connection forwarder that checks the entry still exists.
- [ ] **Step 4: Run it again** — Expected: PASS.
- [ ] **Step 5: Integration test** `two connections on two brokers keep their messages apart` in `test/integration/connections.test.mjs`: real `MqttSession`s via `createSession: () => new MqttSession(FAST)` (from `_session.mjs`), two aedes brokers both publishing `same/topic`; each `'batch'` arrives with the matching connId only. Run `node --test test/integration/connections.test.mjs` — Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -m "Connection registry: several MQTT sessions by connection id"`

### Task 2: Route IPC, pop-outs and the updater by connection

**Files:**
- Modify: `main/main.js` (windows map, IPC, child windows, crash/close/reload, updater count), `main/preload.js`, `renderer/app.js` (minimal), `renderer/popout.js`, `renderer/plotWindow.js`
- Create: `renderer/tabApi.js`
- Test: `test/e2e/connectionRouting.spec.mjs`

**Interfaces:**
- Consumes: `ConnectionRegistry` (Task 1).
- Produces — IPC (all `mqtt:*`/`conn:*` handlers reject a connId not owned by the sender's main window, or by a pop-out's owner, with `Unknown connection`):
  - `conn:open () -> connId` (owner = sender's main window); `conn:close (connId)` (also closes that connection's pop-out windows).
  - `mqtt:connect (connId, profile)`, `mqtt:disconnect|status|subscriptions (connId)`, `mqtt:publish (connId, msg)`, `mqtt:subscribe (connId, { topic, qos })`, `mqtt:unsubscribe (connId, topic)`.
  - Events to the owner window: `mqtt:messages { connId, messages, dropped }`, `mqtt:status { connId, status }`, `mqtt:warning { connId, message }`.
  - `popout:open { connId, topic, title, history }`, `plotwin:open { connId, title, plot, data, tabName }`, `children:reset (connId)`. A child window is registered as `{ win, ownerId, connId, topics }` and receives a batch only when `child.connId === connId` and the topic matches.
- Produces — preload `window.api`: `openConnection()`, `closeConnection(connId)`, `connect(connId, profile)`, `disconnect(connId)`, `status(connId)`, `publish(connId, msg)`, `subscribe(connId, topic, qos)`, `unsubscribe(connId, topic)`, `subscriptions(connId)`, `openPopout({ connId, topic, title, history })`, `openPlotWindow({ connId, title, … })`, `resetChildWindows(connId)`; `onMessages/onStatus/onWarning` callbacks receive the objects above.
- Produces — `renderer/tabApi.js`: `bindConnection(api, connId, { name: () => string }) -> object` with `connect(profile)`, `disconnect()`, `status()`, `publish(msg)`, `subscribe(topic, qos)`, `unsubscribe(topic)`, `subscriptions()`, `openPopout(topic, history)` (title `${name()} — ${topic}`), `openPlotWindow(init)` (title `${name()} — ${init.plot.title}`), `resetChildWindows()`, and every other `api` member passed through unchanged. Views (`MessageViewer`, `PlotsPanel`, `Publisher`, `openSubscriptions`) receive this object as their `api`.

- [ ] **Step 1: Write the failing e2e tests** in `test/e2e/connectionRouting.spec.mjs` (drive `window.api` from `page.evaluate`; the UI has one tab until Task 5):

```js
test('one window, two connections: each gets only its own broker', async ({ env }) => {
  // brokers A, B both retain same/topic ('a' / 'b'); app connected to A through the dialog
  // page.evaluate: id = await api.openConnection(); collect api.onMessages where m.connId === id; await api.connect(id, profileB)
  // expect collected payloads only 'b'; __mqttscope.tree.find('same/topic').message payload 'a'
});
test('a pop-out only receives its own connection's messages', async ({ env }) => {
  // open pop-out of same/topic from the tab; publish on B; pop-out history length unchanged; publish on A → +1
  // pop-out title === 'Test broker <portA> — same/topic'
});
test('closing a connection closes its pop-outs only', async ({ env }) => {
  // pop-outs of both connections open; api.closeConnection(second) → its pop-out closes, the first connection's stays
});
test('closing a connection mid-connect leaves no session', async ({ env }) => {
  // connect second connection to an unused port, close it; app.evaluate(() => globalThis.__mqttscopeConnections.size) === 1
});
test('reloading a window closes its connections', async ({ env }) => {
  // connected; page.reload(); broker client count drops to 0 before the window reconnects; registry size counts only new ones
});
test('the update restart counts connections of every tab', async ({ env }) => {
  // two connected connections in one window → app.evaluate(() => globalThis.__mqttscopeConnections.activeCount()) === 2
});
```

- [ ] **Step 2: Run `npx playwright test test/e2e/connectionRouting.spec.mjs`** — Expected: FAIL (`api.openConnection is not a function`).
- [ ] **Step 3: Implement main routing.** `windows` maps `webContents.id -> { win }`; one module-level `registry`; `createMainWindow` no longer makes a session; `'closed'` and `render-process-gone` call `registry.closeOwner(id)`; `win.webContents.on('did-start-loading', …)` calls `registry.closeOwner(id)` (a reload starts over); updater `connectedCount: () => registry.activeCount()`; `globalThis.__mqttscopeConnections = registry` when `!app.isPackaged`.
- [ ] **Step 4: Implement preload, `tabApi.js`, and the minimal `app.js` change**: at start `connId = await api.openConnection()`, `tabApi = bindConnection(api, connId, { name: () => activeProfile?.name || '' })` passed to the views; message/status/warning handlers ignore other connIds. `popout.js` and `plotWindow.js` take `document.title` from `init.title`.
- [ ] **Step 5: Run the new spec, then `npx playwright test` and `npm run test:unit`** — Expected: all PASS.
- [ ] **Step 6: Commit** — `git commit -m "Route MQTT IPC, pop-outs and the update count by connection id"`

### Task 3: ConnectionTab: per-tab state, views and DOM

**Files:**
- Create: `renderer/connectionTab.js`
- Modify: `renderer/app.js` (window shell), `renderer/index.html` (header stays; tab content becomes `<template id="tab-template">` + `<div id="tab-host">`), `renderer/styles.css`, `renderer/ui.js` (`splitter` re-reads the stored size on mousedown), `renderer/treeView.js`, `renderer/viewer.js`, `renderer/plots.js`, `renderer/publisher.js`
- Test: `test/e2e/tabsCore.spec.mjs`

**Interfaces:**
- Consumes: `bindConnection` (Task 2).
- Produces — `export class ConnectionTab`:
  - `constructor({ api, connId, settings, shell })`; `shell` gives `getBinding(id)`, `showConnections()`, `onChange(tab)` (label, state or data changed).
  - Fields: `connId` (= tab id), `profile` (snapshot of the profile last connected, or null), `status`, `everConnected`, `root` (toolbar row, `#layout`, status bar; attached only while active), `tree`, `treeView`, `viewer`, `plots`, `publisher`.
  - `label` (getter: profile name or `New connection`), `hasPlotData` (getter: any tracked series has points).
  - `async connect(profile)` (clears the tree when the broker differs, as `onConnect` does today); `ingestBatch({ messages, dropped })`; `onStatus(status)`; `onWarning(message)`.
  - `activate(host)` / `deactivate()` (attach/detach `root`, keep tree and viewer scroll positions, set plots visible or not, re-read viewer prefs).
  - `render()` (one frame; the shell calls it every 120 ms for the active tab only); `tickRate()` (the shell calls it every 1 s for every tab).
  - `applySettings(settings)`; `handlers` (object keyed by the existing per-connection action ids: `subscriptions, find, publish, maximize, tabInspector, tabPlots, newPlot, pause, hold, reset, clear`); `handleEscape() -> boolean`; `flush() -> Promise`; `dispose()` (stops timers, observers and listeners; never disconnects).
- Produces — `dispose()` on `TreeView`, `MessageViewer`, `PlotsPanel`, `Publisher` (afterwards `PlotsPanel.redrawTimer` and `TreeView.resizeObserver` are `null`); `MessageViewer.reloadPrefs()`. `Publisher`'s datalist id is unique per instance.
- Produces — shell in `app.js`: `async openTab({ profile = null, connect = false, activate = true } = {}) -> ConnectionTab`, `async closeTab(id)`, `activate(id)`; test hook `window.__mqttscope.shell = { tabs, active, openTab, closeTab, activate }` and the active-tab getters listed in Global Constraints.
- Panel sizes are applied as CSS variables on `document.body` (`--tree-w`, `--tree-h`, `--pub-h`, `--ps-w`) so every tab shares them.

- [ ] **Step 1: Write the failing e2e tests** in `test/e2e/tabsCore.spec.mjs` (open tabs through `__mqttscope.shell`; no tab strip yet):

```js
test('a hidden tab keeps receiving and recording, and skips drawing', async ({ env }) => {
  // tab 1 → broker A; tab 2 = await shell.openTab(); tab2.connect(profileB); add a plot of b/value in tab 2; activate tab 1
  // publish 100 numeric messages on b/value
  // tab2.tree.find('b/value').messageCount === 100; tab2.plots.points('b/value', null).length >= 100
  // document.contains(tab2.root) === false; activate tab 2 → #stat-msgs contains '100'
});
test('switching tabs keeps selection, expansion, scroll position and the inspector', async ({ env }) => {});
test('a closed tab stops its timers and observers', async ({ env }) => {
  // open and close 20 tabs; no page errors; each closed tab: plots.redrawTimer === null, treeView.resizeObserver === null
});
test('panel sizes are shared by all tabs', async ({ env }) => {
  // drag #split-main in tab 1 by +120 px; activate tab 2; its .tree-pane width equals tab 1's
});
```

- [ ] **Step 2: Run `npx playwright test test/e2e/tabsCore.spec.mjs`** — Expected: FAIL (`shell` undefined).
- [ ] **Step 3: Add `dispose()` to the four views and `reloadPrefs()` to the viewer** (store the interval id and ResizeObserver; remove document listeners added in constructors).
- [ ] **Step 4: Move per-connection state and handlers from `app.js` into `ConnectionTab`**, and the per-tab markup into the template: toolbar row (`#btn-disconnect`, `#btn-subscriptions`, stats, `#btn-pause`, `#btn-clear`), `#layout`, status bar. The header keeps brand, connection pill (until Task 5), spacer, Update, Settings. Ids inside the template stay as they are: only the active tab is in the document. The shell routes `onMessages/onStatus/onWarning` by connId, runs the two timers, dispatches shortcuts (window actions in the shell, the rest to `active.handlers`), and opens one tab at start (the modal connection dialog still connects the active tab).
- [ ] **Step 5: Run the new spec, `npx playwright test`, `npm run test:unit`** — Expected: all PASS.
- [ ] **Step 6: Commit** — `git commit -m "Per-tab connection state: ConnectionTab and a window shell"`

## Stage 2: the tab strip

### Task 4: Tab order model

**Files:**
- Create: `renderer/tabSet.js`
- Modify: `renderer/app.js` (the shell keeps its tabs in a `TabSet`)
- Test: `test/unit/tabSet.test.mjs`

**Interfaces:**
- Produces — `export class TabSet`: `ids() -> string[]`, `size`, `activeId`, `add(id, { index = size, activate = true } = {})`, `remove(id) -> string|null` (the new active id: right neighbour, else left; unchanged when a background tab is removed), `move(id, toIndex)`, `activate(id) -> boolean`, `next(step) -> string|null` (wraps), `nth(n) -> string|null` (1-based), `last() -> string|null`, `othersOf(id) -> string[]`, `rightOf(id) -> string[]`, `pushClosed(entry)`, `popClosed() -> entry|null` (keeps the last 25).

- [ ] **Step 1: Write the failing tests**

```js
test('add appends and activates; index inserts', () => {});
test('removing the active tab activates its right neighbour, else its left', () => { /* a b c, active b, remove b → 'c'; active c, remove c → 'b' */ });
test('removing a background tab keeps the active one', () => {});
test('next and previous wrap around', () => { /* a b c active c: next(1) 'a'; active a: next(-1) 'c' */ });
test('nth is 1-based and null past the end; last is the last tab', () => {});
test('move reorders and keeps the active tab', () => {});
test('othersOf and rightOf list in strip order', () => {});
test('closed tabs reopen newest first, at most 25 kept', () => {});
```

- [ ] **Step 2: Run `node --test test/unit/tabSet.test.mjs`** — Expected: FAIL (module missing).
- [ ] **Step 3: Implement `TabSet` and use it in the shell.**
- [ ] **Step 4: Run it and `npm run test:unit`** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Tab order model"`

### Task 5: Tab strip: tabs, dots, switching, closing, toolbar

**Files:**
- Create: `renderer/tabStrip.js`, `renderer/logo.svg` (copy of `build/icon.svg`)
- Modify: `renderer/index.html` (header: `.brand` with logo and `.brand-text`, `.conn-tabs`, `button.tab-new`, spacer, Update, Settings; pill removed), `renderer/styles.css` (dot colours move from `.conn-pill[data-state]` to `.conn-tab[data-state]`), `renderer/app.js`, `renderer/connectionTab.js`, `test/helpers/app.mjs`, existing specs using `#conn-label` / `#btn-connections`
- Test: `test/e2e/tabs.spec.mjs`, `test/unit/tabStrip.test.mjs`

**Interfaces:**
- Consumes: `TabSet` (Task 4), `ConnectionTab` (Task 3).
- Produces — `export function dotState(status, everConnected) -> 'new'|'connected'|'connecting'|'error'|'disconnected'` (connected → green; connecting, reconnecting, offline → amber; error, or disconnected with `unexpected` → red; disconnected by the user → grey; never connected and not connecting → `new`, no dot).
- Produces — `export class TabStrip`: `constructor(header, { onActivate(id), onClose(id), onNew(), onContextMenu(id, x, y), onMove(id, toIndex) })`, `render(tabs: { id, label, state, active }[])`. Each tab is `button.conn-tab[data-id][data-state]` with `span.dot`, `span.conn-tab-name`, `span.conn-tab-close`.
- Produces — shell `closeTab(id)`: asks `api.confirm({ message: 'Close “<label>”?', detail: 'Its plots hold recorded data, which is lost when the tab closes. The plots themselves are kept.', okLabel: 'Close' })` only when `tab.hasPlotData`; then `dispose()`, `api.closeConnection`, `pushClosed({ profileId })` for a bound tab; an emptied window gets a fresh tab (with the modal dialog until Task 9). Toolbar `#btn-disconnect` reads `Reconnect` when the tab was disconnected by the user and reconnects its profile.
- Produces — `test/helpers/app.mjs`: `openTabTo(page, profileName)` (click `.tab-new`, pick `.conn-item` by name, `.connect-btn`, wait until that tab's `status.state === 'connected'`) and `activeTabName(page)`.

- [ ] **Step 1: Write the failing tests**

Unit (`tabStrip.test.mjs`): one `dotState` case per state above.

E2E (`tabs.spec.mjs`):

```js
test('two tabs on two brokers with the same topic stay separate', async ({ env }) => {
  // profiles A, B; connect A; openTabTo(page, 'Broker B'); strip names ['Broker A','Broker B']
  // both publish same/topic; click tab A → inspector of same/topic shows A's payload; tab B → B's; plots of same/topic per tab show their own values
});
test('the dot shows each connection's state, also for a background tab', async ({ env }) => {
  // close broker B while tab A is active → .conn-tab[data-id=B] data-state 'connecting' or 'error'; restart B → 'connected'
});
test('closing a tab with recorded plot data asks first', async ({ env }) => {
  // mockDialogs confirm:false → tab stays; confirm:true → gone and broker B has no client
});
test('closing the last tab leaves a fresh tab', async ({ env }) => {});
test('the window title follows the active tab', async ({ env }) => { /* toHaveTitle('MQTT Scope — Broker B') */ });
test('Disconnect keeps the tab and its data; Reconnect resumes', async ({ env }) => {});
```

- [ ] **Step 2: Run both** — Expected: FAIL.
- [ ] **Step 3: Implement `tabStrip.js`, the header and the shell wiring** (`onChange` re-renders the strip and sets `document.title`). Update existing specs: `#conn-label` → `activeTabName(page)`, `#btn-connections` → `.tab-new`.
- [ ] **Step 4: Run the new tests, `npx playwright test`, `npm run test:unit`** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Tab strip: one tab per connection with its status dot"`

### Task 6: Strip sizing, brand collapse, scrolling names

**Files:**
- Create: `renderer/tabLayout.js`
- Modify: `renderer/tabStrip.js`, `renderer/styles.css`
- Test: `test/unit/tabLayout.test.mjs`, `test/e2e/tabs.spec.mjs`

**Interfaces:**
- Produces — `export const MIN_TAB = 100`; `export function stripLayout({ available, brandFull, brandIcon, plus, tabs }) -> { brand: 'full'|'icon', maxTab: number|null, scroll: boolean }` where `tabs` are the tabs' natural widths. Order: everything fits with the full brand → `full, null, false`; fits with the icon brand → `icon, null, false`; else water-filling: tabs narrower than the share keep their width, the others share the rest equally, `maxTab` is that share when it is ≥ `MIN_TAB` (`scroll: false`), else `maxTab = MIN_TAB, scroll: true`.
- Produces — `TabStrip` measures on a ResizeObserver and on render, applies `max-width` per tab, `.brand.icon-only`, `.conn-tabs.scrolling`; `+` stays visible right after the last tab (sticky at the strip's right edge while scrolling). A label whose text is cut gets class `scrolling` with `--shift` (px) and `--dur` (s) for a ping-pong keyframe at 30 px/s with 1.5 s pauses; reduced motion → no animation, `text-overflow: ellipsis`. Every tab's `title` is its full name.

- [ ] **Step 1: Write the failing tests**

```js
test('everything fits: full brand, natural widths', () => {});
test('the brand collapses before any tab shrinks', () => {});
test('short tabs keep their width, long ones share the rest', () => { /* available 600, icon 30, plus 30, tabs [80, 400, 400] → maxTab 230 */ });
test('below the minimum the strip scrolls', () => { /* 12 tabs of 200 in 900 → maxTab 100, scroll true */ });
```

E2E: `twelve tabs: icon-only brand, the strip scrolls, + stays in view`; `a cut-off name scrolls, and only ellipsizes with reduced motion` (`page.emulateMedia({ reducedMotion: 'reduce' })` → computed `animation-name` is `none`, `text-overflow` is `ellipsis`); `the tooltip is the full name`. (Profiles for these tests are long-named and all point at one broker.)

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and `npx playwright test test/e2e/tabs.spec.mjs test/e2e/layout.spec.mjs`** — Expected: PASS (the narrow stacked layout still works; the strip never wraps).
- [ ] **Step 5: Commit** — `git commit -m "Tab strip: shrink, collapse the brand, scroll long names"`

### Task 7: Tab menu, middle-click, reorder, reopen

**Files:**
- Modify: `renderer/tabStrip.js`, `renderer/app.js`
- Test: `test/e2e/tabs.spec.mjs`

**Interfaces:**
- Consumes: `TabSet.othersOf/rightOf/move/pushClosed/popClosed` (Task 4), shell `closeTab` (Task 5).
- Produces — shell `async closeTabs(ids)` (one confirm `Close <n> tabs?` when any holds plot data), `async reopenClosed()` (opens the newest closed entry whose profile still exists, connected, with empty data). Context menu items in order: `Close`, `Close other tabs`, `Close tabs to the right`, `Move to new window` (disabled until Task 14), `Disconnect` or `Reconnect`. Middle-click (`auxclick`, button 1) closes. Dragging a tab within the strip reorders it (HTML5 drag and drop, insertion marker, `onMove`).

- [ ] **Step 1: Write the failing e2e tests**: `the tab menu lists its actions and closes others and to the right`; `middle-click closes a tab`; `dragging a tab reorders the strip` (`locator.dragTo`); `reopen brings the last closed tab back, connected and empty` (via `shell.reopenClosed()`).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Tab menu, middle-click close, reorder and reopen"`

### Task 8: Tab shortcuts and menu entries

**Files:**
- Modify: `renderer/keys.js` (ACTIONS), `renderer/app.js` (handlers), `renderer/publisher.js` (Tab only without Ctrl/Meta/Alt), `main/main.js` (File menu: New Tab, Close Tab, Reopen Closed Tab; on macOS `Close Tab` Cmd+W and `Close Window` Cmd+Shift+W replace `role: 'close'`), `README.md` shortcut table can wait for Task 16
- Test: `test/unit/keys.test.mjs`, `test/e2e/keyboard.spec.mjs`

**Interfaces:**
- Produces — new ACTIONS ids with the defaults in Global Constraints: `newTab`, `closeTab`, `nextTab`, `prevTab`, `nextTabAlt`, `prevTabAlt`, `goToTab1`…`goToTab8`, `goToLastTab`, `reopenTab`; `tabInspector`/`tabPlots` move to `Alt+1`/`Alt+2`; `connections` label `Open a new connection tab`. Defaults that differ on macOS are chosen with `isMacPlatform()` when ACTIONS is built. No migration code: `normalizeOverrides` never saves an override equal to its default, so nobody has `Mod+1`/`Mod+2` stored for Inspector/Plots and everyone on the old defaults gets `Alt+1`/`Alt+2`; a custom binding that now clashes shows the existing conflict warning.

- [ ] **Step 1: Write the failing tests**

```js
test('default shortcuts do not clash', () => { assert.equal(conflicts(resolveBindings({})).size, 0); });
test('Ctrl+Tab is Mod+Tab off macOS and Ctrl+Tab on macOS', () => {
  assert.equal(comboFromEvent({ key: 'Tab', ctrlKey: true }, false), 'Mod+Tab');
  assert.equal(comboFromEvent({ key: 'Tab', ctrlKey: true }, true), 'Ctrl+Tab');
});
test('tab shortcuts have menu accelerators', () => { assert.equal(toAccelerator('Mod+Shift+T'), 'CmdOrCtrl+Shift+T'); assert.equal(toAccelerator('Mod+PageDown'), 'CmdOrCtrl+PageDown'); });
test('a saved custom binding for the Plots tab is kept', () => { assert.equal(resolveBindings(normalizeOverrides({ tabPlots: 'Mod+3' })).tabPlots, 'Mod+3'); });
```

E2E: `tab shortcuts: new, next, previous, go to, last, close, reopen`; `tab shortcuts work while typing` (focus the payload editor, type text, press Control+Tab → active tab changes, editor value unchanged; same in `#tree-filter` and in the connection dialog's name field); `Alt+1 and Alt+2 switch Inspector and Plots`.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and `npm run test:unit`** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Tab shortcuts and File menu entries"`

## Stage 3: the dialog in the tab, profiles, layouts, restore

### Task 9: Connection dialog inside the tab

**Files:**
- Modify: `renderer/connectionDialog.js`, `renderer/connectionTab.js`, `renderer/app.js`, `renderer/styles.css`, `test/e2e/updates.spec.mjs` (`closeConnectionDialog` becomes unnecessary), `test/e2e/connections.spec.mjs`, `test/e2e/connect-errors.spec.mjs`
- Test: `test/e2e/connections.spec.mjs`

**Interfaces:**
- Produces — `ConnectionDialog` (one per window): `mount(host, { closable, onConnect(profile), onCancel() })`, `unmount()`, `isMounted()`, `onStatus(status)`; no `.modal-overlay`; the box keeps class `conn-dialog`; the `×` (`.modal-close`) and Esc call `onCancel` only when `closable`.
- Produces — `ConnectionTab.mode`: `'picker'` until the first `connected` status, then `'session'`. A picker tab's root shows the dialog (the shell mounts the window's dialog into the active picker tab). Connect keeps the dialog with the status line and errors (Connect again = Retry); the label shows the profile name and the dot from the first Connect on.
- Produces — `+`, `newTab` and `connections` open a picker tab (when the active tab is already a picker, `connections` focuses it). A window starts with one picker tab (restore comes in Task 12). Cancel closes a picker tab unless it is the window's only tab.

- [ ] **Step 1: Write the failing e2e tests**: `the connection dialog lives in its tab; other tabs stay usable`; `Esc closes a New connection tab but not the window's only tab`; `a failed connect keeps the dialog with the error; Connect retries`; `the tab becomes a session on the first connect`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**, and update the three listed specs to the new flow.
- [ ] **Step 4: Run `npx playwright test`** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Connection dialog inside its tab"`

### Task 10: One tab per profile; open profiles can't be deleted; edits need a reconnect

**Files:**
- Modify: `main/main.js` (`conn:focus`, `conn:openProfiles`, broadcast `conn:openProfilesChanged`), `main/preload.js`, `renderer/connectionDialog.js`, `renderer/connectionTab.js`, `renderer/app.js`, `renderer/profiles.js`
- Test: `test/unit/profiles.test.mjs`, `test/e2e/connections.spec.mjs`

**Interfaces:**
- Consumes: `connect` duplicate result and `'openProfiles'` event (Task 1).
- Produces — IPC `conn:focus (connId)` (shows and focuses the owner window, sends it `tabs:activate { connId }`), `conn:openProfiles () -> string[]`, event `conn:openProfilesChanged (ids)` to every main window. Preload: `focusConnection(connId)`, `openProfiles()`, `onOpenProfilesChanged(cb)`, `onActivateTab(cb)`.
- Produces — `export function connectSignature(profile) -> string` in `profiles.js` (JSON of `protocol, host, port, wsPath, mqttVersion, username, password, clientId, keepalive, clean, rejectUnauthorized, caFile, certFile, keyFile`; not `name` or `subscriptions`).
- Behaviour: a duplicate connect activates the existing tab (here, or via `focusConnection` in another window) and closes the requesting picker tab unless it is its window's only tab. The dialog's Delete is disabled with title `Close its tab first` while the selected profile is open anywhere. A session tab shows `.reconnect-hint` (`reconnect to apply`, click reconnects) while `connectSignature` of its snapshot differs from the saved profile; a renamed profile renames its tab.

- [ ] **Step 1: Write the failing tests**: unit `connectSignature ignores the name and subscriptions` and `changes with the host`; e2e `opening an open profile switches to its tab`; `…in another window brings that window forward` (`app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow().webContents.id)`); `an open profile cannot be deleted`; `editing an open profile asks for a reconnect; renaming renames the tab`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and `npm run test:unit`** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "One tab per profile; open profiles are protected"`

### Task 11: Plot layouts per profile

**Files:**
- Create: `main/layoutStore.js`
- Modify: `main/jsonStore.js` (names `profileLayouts`, `windowState`), `main/main.js` (IPC; `profiles:save` removes layouts of deleted profiles; `migrate()` at start), `main/preload.js`, `renderer/plots.js` (load/save per profile; no more `plots`/`plotTabs` writes, no `reload()`), `renderer/connectionTab.js`, `renderer/app.js` (drop the `plotTabs` store-changed reload), `test/e2e/plotPersistence.spec.mjs`, `test/e2e/plotWindows2.spec.mjs`
- Test: `test/unit/layoutStore.test.mjs`, `test/e2e/plotPersistence.spec.mjs`

**Interfaces:**
- Produces — `createLayoutStore({ stores, profileIds: () => string[] })` returning:
  - `migrate()`: when `stores.get('profileLayouts')` is null, writes `{ version: 1, byProfile: {}, lastUsed: null, legacyProfiles: profileIds() }`.
  - `get(profileId) -> { doc, legacy }`: `byProfile[id]` → `{ doc, legacy: null }`; id in `legacyProfiles` → `{ doc: stores.get('plotTabs'), legacy: stores.get('plots') }`; else `byProfile[lastUsed]` when present → `{ doc: thatDoc, legacy: null }`; else the `plotTabs`/`plots` pair. Sets `lastUsed = profileId`.
  - `set(profileId, doc)`; `remove(ids: string[])` (also from `legacyProfiles`, and clears `lastUsed` when removed).
- Produces — IPC `layouts:get (profileId)`, `layouts:set (profileId, doc)`; preload `layoutGet`, `layoutSet`. Main does every read-modify-write, so two windows never overwrite each other.
- Produces — `PlotsPanel.loadProfile(profileId)` (`model.load(doc, { legacy })`; `profileId === null` shows the default empty tab and saves nothing); `flushSave()` writes `layoutSet(profileId, model.toDoc())`. `ConnectionTab.connect` calls `loadProfile` when the bound profile changes.

- [ ] **Step 1: Write the failing tests**

```js
test('migration remembers which profiles existed', () => {});
test('a profile from before the upgrade starts with the global layout', () => {});
test('a new profile starts with a copy of the last used layout', () => {});
test('set and get round-trip; other profiles are untouched', () => {});
test('removing a profile removes its layout and clears lastUsed', () => {});
test('no saved plots at all gives null documents', () => {});
```

E2E: `plot layouts are kept per profile` (userData with a `plotTabs.json` tab; profiles A and B both start with it; a plot added in A is not in B; relaunch keeps A's); `renaming a profile keeps its layout; deleting removes it`; `plotTabs.json and plots.json are never rewritten`.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**, then update the two listed specs (layouts no longer sync between windows of different profiles).
- [ ] **Step 4: Run `npm run test:unit` and `npx playwright test`** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Plot layouts per profile"`

### Task 12: Reopen tabs on launch; confirm closing several connections

**Files:**
- Create: `main/windowState.js`
- Modify: `main/main.js` (start, `createMainWindow({ bounds, restore, adopt })`, `tabs:init`, `tabs:report`, bounds tracking, close confirm), `main/preload.js`, `renderer/settings.js` (`restoreTabs: true`, checkbox ` Reopen tabs on launch`), `renderer/app.js` (initial tabs from `tabs:init`; debounced `reportTabs`)
- Test: `test/unit/windowState.test.mjs`, `test/unit/settings.test.mjs`, `test/e2e/restore.spec.mjs`

**Interfaces:**
- Produces — `class WindowState` (CommonJS): `constructor(doc)`, `report(windowId, { tabs: [{ profileId, connected }], active })`, `setBounds(windowId, bounds)`, `closed(windowId, { last })` (forgets the window unless it is the last one), `toDoc() -> { version: 1, windows: [{ bounds, tabs, active }] }` (creation order; windows without restorable tabs left out); `static restorable(doc, profileIds: Set) -> [{ bounds, tabs, active }]` (drops tabs of unknown profiles and empty windows, clamps `active`, tolerates any malformed input by returning `[]`).
- Produces — IPC `tabs:init () -> { tabs, active } | { tabs: [], adopt: true } | null` (once per window), `tabs:report ({ tabs, active })`; preload `initialTabs()`, `reportTabs(state)`. A tab reports `connected: false` only when the user disconnected it; picker tabs are not reported.
- Behaviour: main writes `windowState` 500 ms after a change and synchronously on `will-quit`; bounds come from `getNormalBounds()`, and a saved position off every display is dropped (size kept). At start, with `restoreTabs !== false` and restorable windows, each is created with its bounds and restored tabs (connected ones connect); otherwise one window with a picker tab. A second instance opens a plain window. Closing a window (not quitting) with `restoreTabs === false` and at least 2 active connections asks `Close <n> connections?` (buttons `Close`, `Cancel`).

- [ ] **Step 1: Write the failing tests**

```js
test('a reported window is saved with its tabs, active tab and bounds', () => {});
test('a window closed while others stay open is forgotten; the last one is kept', () => {});
test('restorable drops deleted profiles, empty windows and malformed input', () => {});
test('active is clamped to the restored tabs', () => {});
// settings.test.mjs
test('restoreTabs defaults to true and keeps a saved false', () => {});
```

E2E (`restore.spec.mjs`): `tabs come back after a relaunch, a disconnected one stays disconnected`; `with the setting off the app starts with one New connection tab`; `a window closed while another stays open does not come back`; `restore skips deleted profiles and survives a corrupt state file`; `an unreachable broker shows its error in its restored tab`; `closing a window with two connected tabs asks when restore is off`.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Fix existing specs that relaunch with the same userData and expected the dialog.
- [ ] **Step 4: Run `npm run test:unit` and `npx playwright test`** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Reopen tabs on launch"`

## Stage 4: moving tabs between windows

### Task 13: Export and import a tab's state

**Files:**
- Modify: `renderer/topicTree.js`, `renderer/plotData.js`, `renderer/viewer.js`, `renderer/publisher.js`, `renderer/plots.js`, `renderer/connectionTab.js`, `renderer/app.js` (test hook `shell.reimport(id)`)
- Test: `test/unit/topicTree.test.mjs`, `test/unit/plotData.test.mjs`, `test/e2e/tabsCore.spec.mjs`

**Interfaces:**
- Produces — `TopicTree.snapshot() -> { topics: [{ path, history, messageCount, retained, selfUpdate }], expanded: string[] }` and `TopicTree.restore(snapshot)` (rebuilds `topicCount`, `messageCount`, subtree counters, `lastUpdate`).
- Produces — `PlotData.snapshot() -> [{ topic, segs, points }]`, `PlotData.restore(snapshot)`.
- Produces — `MessageViewer.snapshot()/restore(s)` (pinned message ts, `expandedByTopic`, `plotByTopic`, search query); `Publisher.draft()/setDraft(d)` (`topic, payload, format, qos, retain, follow`); `PlotsPanel.snapshot()/restoreSnapshot(s)` (`model.toDoc()`, data, `zoomByTab`, `yZoom`, `frozenAt`, `selectedId`).
- Produces — `ConnectionTab.exportState() -> object` (also `profile, status, everConnected, mode, selectedPath, filter { text, values }, rightTab, paused, pauseQueue, droppedTotal`) and `static ConnectionTab.fromState(opts, state) -> ConnectionTab`. Exporting does not disconnect; the payloads stay `Uint8Array` (structured clone).

- [ ] **Step 1: Write the failing tests**

```js
test('snapshot and restore give the same tree', () => {
  // nested topics, a branch expanded with no message of its own, a removed topic, history trimmed by limit
  // restored rows(), topicCount, messageCount, each node's history and subtree counters equal the original
});
test('plot data round-trips', () => {});
```

E2E: `a tab's state survives export and import` — selection, filter, expanded nodes, publisher draft, a plot with points and a zoom, paused with a queue; `shell.reimport(id)`; all equal and new messages still arrive.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Export and import a tab's full state"`

### Task 14: Move a tab to another window; Move to new window

**Files:**
- Modify: `main/main.js` (`moveTab`, `tearOff`, request/reply helper, child re-parenting, closing an emptied window), `main/preload.js`, `renderer/app.js`, `renderer/tabStrip.js` (enable `Move to new window`)
- Test: `test/e2e/tabMove.spec.mjs`

**Interfaces:**
- Consumes: `registry.hold/setOwner/release` (Task 1), `exportState/fromState` (Task 13), `tabs:init` adopt mode (Task 12).
- Produces — main `async moveTab(connId, toWindowId, index)`: hold → `tab:export` to the owner (reply: state; the source removes the tab without disconnecting) → `tab:import { connId, state, index }` to the target (reply when built) → `setOwner` → children of `connId` get the new `ownerId` → release. A failed or timed-out (10 s) step gives the state back to the source at its old index and releases there. A main window left with no connections closes (its flush still runs, no confirm).
- Produces — `async tearOff(connId, point|null)`: new window via `createMainWindow({ bounds near point, adopt: true })` (cascaded from the source window when `point` is null), then `moveTab`.
- Produces — IPC `tabs:move ({ connId, toWindowId, index })`, `tabs:tearOff ({ connId })`; renderer handlers `onTabExport`, `onTabImport` (preload replies with `tab:reply { reqId, result | error }`). `globalThis.__mqttscopeMoveTab = moveTab` when `!app.isPackaged`.

- [ ] **Step 1: Write the failing e2e tests**

```js
test('a tab moves with its connection; messages published during the move all arrive in order', async ({ env }) => {
  // window 1: tabs A, B; window 2: tab C. Publish 500 numbered messages on A's broker while moving A to window 2 at index 0
  // broker A saw no disconnect; window 2 tab A: messageCount === 500 + earlier, history payloads strictly increasing
  // selection, plot points and publisher draft preserved; window 1 shows tab B
});
test('a moved tab's pop-outs keep receiving and close with it in its new window', async ({ env }) => {});
test('moving a window's last tab closes that window', async ({ env }) => {});
test('Move to new window opens a window with just that tab', async ({ env }) => {});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and `npx playwright test`** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Move tabs between windows"`

### Task 15: Drag tabs between windows and out into a new one

**Files:**
- Create: `main/tabDrag.js`
- Modify: `main/main.js`, `main/preload.js`, `renderer/tabStrip.js`, `renderer/app.js`
- Test: `test/unit/tabDrag.test.mjs`, `test/e2e/tabMove.spec.mjs`

**Interfaces:**
- Produces — `class TabDrag` (CommonJS): `constructor({ graceMs = 250, setTimer = setTimeout, clearTimer = clearTimeout })`, `start(connId, fromWindowId)`, `drop(toWindowId, index) -> { connId, fromWindowId, toWindowId, index } | null`, `end({ overSource }) -> Promise<'dropped'|'tearOff'|'none'>` (waits up to `graceMs` for a drop; no drop and not over the source → `'tearOff'`; over the source → `'none'`).
- Produces — IPC `tabs:dragStart (connId)` (main broadcasts `tabs:dragging { connId }` / `tabs:dragging null` to every main window), `tabs:drop ({ index })` (same window → reorder reply; other window → `moveTab`), `tabs:dragEnd ({ overSource })` (`'tearOff'` → `tearOff(connId, screen.getCursorScreenPoint())`).
- Produces — `TabStrip`: tabs are draggable with type `application/x-mqttscope-tab`; a strip accepts a drag while main reports one in progress (or the type is present) and shows the insertion marker; the source tracks `overSource` with document `dragenter`/`dragleave`. Same-window drops keep Task 7's local reorder.

- [ ] **Step 1: Write the failing tests**

```js
test('a drop within the grace period wins over tear-off', async () => {});
test('no drop and outside the source tears off', async () => {});
test('no drop over the source does nothing', async () => {});
test('a new drag cancels the previous one', async () => {});
```

E2E: `a drop on another window's strip moves the tab` (drive `tabDragStart` from page 1 and `tabDrop` from page 2 through `window.api`; real OS-level drags cannot be scripted).

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Manual check (with the user, on their Hyprland desktop; note results in the PR):** drag a tab to another window's strip; drag one out to empty desktop (new window appears, wherever the compositor puts it); drag one onto its own window's content (nothing happens); drag a window's last tab to another window (the source closes); pop-outs follow.
- [ ] **Step 6: Commit** — `git commit -m "Drag tabs between windows and tear them off"`

## Stage 5: release

### Task 16: Docs, version, screenshots

**Files:**
- Modify: `package.json`, `package-lock.json` (version `0.4.0`), `CHANGELOG.md`, `README.md`, `scripts/screenshots.mjs`, `docs/screenshots/*`, `site/index.html`

- [ ] **Step 1: Bump to 0.4.0** (`npm version 0.4.0 --no-git-tag-version`).
- [ ] **Step 2: CHANGELOG 0.4.0 entry** (tabs, background recording, moving and tearing off, per-profile plot layouts, restore setting, shortcuts with the Inspector/Plots move to Alt+1/Alt+2, downgrade note: 0.3 shows the pre-upgrade plot layout).
- [ ] **Step 3: README**: a Tabs section, the shortcuts table, the restore setting, per-profile layouts; remove mentions of the connection pill.
- [ ] **Step 4: Screenshots**: update `scripts/screenshots.mjs` for the tab strip (two tabs open in the hero shot), run it, check the images, and update `site/index.html` copy that describes a single connection.
- [ ] **Step 5: Full verification**: `npm test` — Expected: lint clean; unit, integration and e2e all PASS.
- [ ] **Step 6: Commit** — `git commit -m "MQTT Scope 0.4.0"`
