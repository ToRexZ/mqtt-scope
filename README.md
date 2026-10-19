# MQTT Scope

[![CI](https://github.com/ToRexZ/mqtt-scope/actions/workflows/ci.yml/badge.svg)](https://github.com/ToRexZ/mqtt-scope/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/ToRexZ/mqtt-scope)](https://github.com/ToRexZ/mqtt-scope/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Desktop MQTT client for inspecting busy brokers: an auto-subscribed live topic
tree, a large message inspector, live plots, and a publisher with a library of
saved messages. Runs on Linux, Windows and macOS.

**[Website](https://torexz.github.io/mqtt-scope/)** · **[Download the latest release](https://github.com/ToRexZ/mqtt-scope/releases/latest)**

![Inspector](docs/screenshots/inspector.png)

## Features

**Connections**
- Save any number of broker connections: `mqtt://`, `mqtts://` (TLS, custom CA,
  client certificates), `ws://`, `wss://`; MQTT 3.1.1 or 5.0; username/password;
  client ID; keep-alive; clean session.
- Each connection has its own subscription list (default `#` and `$SYS/#`), so
  the tree fills automatically. **Subscriptions…** adds or removes filters on the
  live connection, optionally saving the change to the connection.
- **Several brokers at once**: File → New Window (or start the app again) opens
  another window with its own connection. Saved connections, messages and plots
  are shared between windows.
- Passwords are encrypted with the operating system keychain when one is
  available; the connection dialog says when it is not.

**Topic tree**
- Every topic level is a node with live message and topic counts. Topics flash
  when they update.
- Virtualised: stays smooth with tens of thousands of topics.
- Filter by substring or MQTT wildcard (`fleet/+/heartbeat`, `sensors/#`),
  optionally also searching payloads.
- Right-click: copy topic or value, publish to the topic, open in its own
  window, add to a plot, hide, delete retained message(s) for a topic or a
  whole branch. Deleting is only offered for topics that were received as
  retained, and the confirmation lists every topic.
- Pause freezes the view and queues incoming messages (the newest 200,000 /
  256 MB are kept; anything older is counted as dropped).

**Inspector**
- Views: collapsible JSON **Tree** (fields that changed since the previous
  message are highlighted), syntax-highlighted **Text** with line numbers,
  **Raw**, **Hex**, structural **Diff** against the previous message, and
  **Chart** of a numeric payload or JSON field.
- Live updates keep your scroll position and expanded nodes. **Held** freezes
  the view on one message while new ones keep arriving; pick any message from
  the history list (it holds still while the mouse is over it).
- Integers larger than 2^53 (64-bit ids, nanosecond timestamps) are shown
  exactly in Text and Raw and kept exact when re-publishing; the Tree view warns
  that it rounds them.
- Search: in the Tree view it filters a large JSON document down to the
  matching branches.
- Big messages: multi-megabyte JSON opens instantly (children are rendered on
  demand). **Maximize** (F11) gives the inspector the whole window; **Pop out**
  opens a topic in a separate live window.
- MQTT 5 metadata: content type, response topic, user properties.

![Search in a large message](docs/screenshots/search-large-message.png)

**Plots**
- **+ New plot** (or **+ Series** on a plot, or right-click a topic → *Choose
  values to plot…*) opens a picker: a scrollable, filterable list of topics on
  the left; the structure of the selected message on the right with a checkbox
  next to every number. Pick values from several topics at once.
- A **settings panel** for the selected plot, laid out like Lichtblick's:
  title (rename), time window, legend on/off and values, fixed or automatic
  y-axis range, and per series: visibility, label (alias), **colour picker**
  or palette colour, display style and line width.
- **Booleans as state bars**: true/false values show as a horizontal bar that
  changes colour (each series can be a line, line with points, steps or a state
  bar; booleans default to a state bar).
- **Synced time bar**: hovering one plot moves the time bar on every plot and
  shows the values at that moment in each legend.
- **Layouts**: save the plots as named layouts, switch between them, and export
  or import a layout as a `.json` file to share with colleagues.
- Quick add: right-click a numeric topic, or a number in the inspector's Tree
  view, → *Add to new plot* / *Add to plot “…”*. Up to 8 series per plot,
  freeze, CSV export (time, series alias, topic, path, value).

![Plots](docs/screenshots/plots.png)

![Plot picker](docs/screenshots/plot-picker.png)

**Publisher**
- JSON (validated, format/minify), text or hex-byte payloads; QoS; retain;
  Ctrl+Enter to send; load a payload from a file.
- **Saved messages**: store frequently sent messages (name + topic + payload +
  options). Messages for the selected topic are listed first; ▶ sends one with a
  single click. A **Recent** list keeps the last 50 publishes.
- Safety for live systems: the topic follows the tree selection only until you
  edit the message (**Follow tree** turns it back on); Retain is never copied
  from received messages and resets when the topic changes; retained publishes
  ask for confirmation; a publish in flight blocks repeats (double clicks, held
  Ctrl+Enter); topics containing `+` or `#` are refused.

![Publisher with saved messages](docs/screenshots/publisher-saved.png)

## Install

Download the file for your platform from the
[releases page](https://github.com/ToRexZ/mqtt-scope/releases/latest):

| Platform | File |
|---|---|
| Linux | `MQTT-Scope-<version>-linux-x86_64.AppImage` (`chmod +x` and run) or `…-linux-x64.tar.gz` |
| Windows | `MQTT-Scope-<version>-win-x64-setup.exe` (installer) or `…-win-x64-portable.exe` |
| macOS | `MQTT-Scope-<version>-mac-arm64.dmg` (Apple silicon) or `.zip` |

**Arch Linux**: `yay -S mqtt-scope-bin` once the AUR package is published; until
then build the same package from this repository:

```sh
git clone https://github.com/ToRexZ/mqtt-scope && cd mqtt-scope/packaging/aur && makepkg -si
```

The AppImage needs FUSE 2 (`sudo pacman -S fuse2` on Arch, `sudo apt install
libfuse2` on Ubuntu 22.04+); without it run it with
`APPIMAGE_EXTRACT_AND_RUN=1`, or use the `.tar.gz`.

Builds are not code-signed yet: on macOS right-click → Open the first time; on
Windows choose "More info → Run anyway".

## Keyboard shortcuts

All shortcuts can be changed in **Settings → Keyboard** (click one and press the
new keys; clashes are flagged). Defaults (Ctrl is Cmd on macOS):

| Keys | Action |
|---|---|
| Enter | Connect to the selected connection (↑ ↓ choose it) |
| Ctrl+K | Connections |
| Ctrl+Shift+S | Subscriptions |
| Ctrl+Shift+N | New window (another broker) |
| Ctrl+, | Settings |
| Ctrl+F | Filter topics (or search the message when the inspector has focus) |
| Ctrl+Enter | Publish (in the publisher) |
| F11 | Maximize inspector (Esc restores) |
| Ctrl+1 / Ctrl+2 | Inspector / Plots |
| Ctrl+Shift+A | Add data to a new plot |
| Ctrl+Shift+P | Pause / resume |
| ↑ ↓ ← → Enter | Navigate / expand the topic tree |
| Enter / Shift+Enter | Next / previous search match |

## Settings and data

Settings → General: messages kept per topic (default 100), history size per
topic (default 64 MB; the latest message is always kept), and whether clicking
a topic in the tree also expands it one level (default on).

Data lives in the app data folder (File → Open Data Folder):
`profiles.json` (connections), `savedMessages.json`, `plots.json`,
`settings.json`, `logs/main.log`. Set `MQTTSCOPE_USER_DATA=/some/dir` to use a
different folder (e.g. a portable install).

## Development

Requires Node.js 22+.

```sh
npm install
npm run demo-broker   # local broker with simulated AGV / sensor / factory traffic on :1883 and ws :9001
npm start             # run the app
```

### Tests

```sh
npm run test:unit          # pure logic (node:test)
npm run test:integration   # MQTT session against an in-process broker: TCP, TLS, WebSocket, auth, reconnects
npm run test:e2e           # drives the real Electron app with Playwright (headless)
npm test                   # all of the above
```

The MQTT 5 integration test runs against `eclipse-mosquitto:2` in Docker and is
skipped when Docker is unavailable.

### Packaging

```sh
npm run dist:linux   # AppImage + tar.gz
npm run dist:win     # NSIS installer + portable exe (build on Windows)
npm run dist:mac     # dmg + zip (build on macOS)
npm run verify:package   # launch the packaged app and check it connects
```

CI (`.github/workflows/ci.yml`) runs all tests on every push and pull request.

### Releasing

```sh
npm version patch        # or minor / major: bumps package.json and creates a v* tag
git push --follow-tags
```

The tag makes CI build installers on Linux, Windows and macOS, smoke-test each
packaged app, and attach them to a GitHub Release with generated notes.

`node scripts/screenshots.mjs` regenerates the screenshots in `docs/`.

### Architecture

```
main/          Electron main process (CommonJS)
  main.js        windows (one MQTT session each), menu, IPC
  mqttSession.js an MQTT connection; batches messages every 50 ms for the UI
  profileStore.js, jsonStore.js   persisted data (atomic writes)
  preload.js     the only API the UI can call (contextIsolation + sandbox)
renderer/      UI (plain ES modules, no framework or build step)
  app.js         wiring; topicTree.js data model; treeView.js virtual list
  viewer.js      inspector; jsonTree.js, jsonDiff.js, payload.js
  plots.js, plotPicker.js, plotLayouts.js, fields.js, chart.js, plotMath.js   plots
  keys.js        keyboard shortcuts (defaults, rebinding, matching)
  publisher.js, connectionDialog.js, subscriptionsDialog.js, settings.js
test/          unit, integration, e2e (+ helpers: in-process broker, app launcher)
```

Payloads are untrusted: they are only ever inserted as text or escaped HTML,
the UI runs sandboxed with a strict Content Security Policy, and navigation
and new windows are blocked.

## License

[MIT](LICENSE) © 2026 Victor Risager
