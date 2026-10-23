# Update Notice and Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MQTT Scope 0.3.0 tells every install about newer releases through a quiet top-bar button, self-updates AppImage and Windows-installer builds on request, and gives other installs the right manual step.

**Architecture:** Pure helpers (`main/updateCheck.js`) decide versions, install kind and copy; a main-process state machine (`main/updater.js`) owns checking, skip, download and restart, and is broadcast to every main window over IPC; `main/updateEngine.js` wraps electron-updater (or a fake for tests); the renderer (`renderer/updateButton.js`) only renders state and sends intents. CI adds update description files and a release-attached PKGBUILD.

**Tech Stack:** Electron 44, electron-updater 6, electron-builder 26, node:test, Playwright (Electron), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-21-update-notice-design.md`

## Global Constraints

- Repo `ToRexZ/mqtt-scope`; latest-release API `https://api.github.com/repos/ToRexZ/mqtt-scope/releases/latest`; release page `https://github.com/ToRexZ/mqtt-scope/releases/tag/v<version>`.
- Automatic checks: at startup and every 6 h (`6 * 60 * 60 * 1000` ms) while the `checkForUpdates` setting is on (default `true`). Request timeout 15 s. Only `Accept` and `User-Agent: MQTT-Scope/<version>` headers.
- An automatic check that fails shows nothing (logged with `log.warn('update', …)`). Only Help → Check for Updates… toasts "latest" or errors.
- No modal dialogs, focus changes, downloads, restarts or installs without a click. `autoUpdater.autoDownload = false`, `autoInstallOnAppQuit = true`.
- The renderer never sends a URL; main builds every URL it opens. Release notes go into the DOM as text only (`textContent`), never HTML.
- Test overrides (work in packaged builds too): `MQTTSCOPE_UPDATE_URL` (base URL serving `release.json` in GitHub release JSON shape, and the electron-updater generic feed), `MQTTSCOPE_UPDATE_KIND` (forces the install kind), `MQTTSCOPE_UPDATE_FAKE=1` (fake download/install engine). The test suite never touches the network.
- Unpackaged runs (`npm start`, e2e) never check unless `MQTTSCOPE_UPDATE_URL` is set.
- pacman marker file: `<resources>/pacman-package`. Never create `resources/package-type`.
- `electron-updater@^6.8.9` in `dependencies`. Version 0.3.0. Main process is CommonJS, renderer ES modules; follow existing comment density; `npm run lint` clean.

## Review Focus

- GitHub unreachable, slow, or rate-limited (HTTP 403) on an automatic check: nothing appears and no toast; a later successful check still works. → Task 2 test `automatic check failure is silent and leaves state unchanged`.
- Odd tags (`0.3.1` without `v`, `v0.4.0-beta.1`, `release-1`, `null` body, `draft`/`prerelease` true): only a clean `x.y.z` newer than the running version is offered. → Task 1 `parseRelease` tests.
- Release notes containing HTML, Markdown or thousands of lines: shown as literal text in a scrolling panel. → Task 4 test `release notes are shown as text`.
- A window opened after an update was found, or during a download: shows the same button state at once. → Task 4 test `a new window shows the current update state`.
- Download fails midway: button reads "Update failed", panel shows the error with Retry, Retry can succeed. → Task 2 test `failed download can be retried`.

---

### Task 1: Version, release and install-kind helpers

**Files:**
- Create: `main/updateCheck.js`
- Test: `test/unit/updateCheck.test.mjs`

**Interfaces:**
- Produces (CommonJS exports):
  - `LATEST_RELEASE_API: string`, `CHECK_INTERVAL_MS: number` (21600000)
  - `parseVersion(s: string): [number, number, number] | null` — optional leading `v`; anything else (pre-release suffix, extra parts) → `null`
  - `isNewer(candidate: string, current: string): boolean` — false if either is unparsable
  - `parseRelease(json: object): { version: string, notes: string } | null` — from `tag_name`, `body` (null → `''`); `null` when `draft` or `prerelease` is true or the tag is unparsable
  - `releasePageUrl(version: string): string`
  - `pacmanCommand(version: string): string`
  - `installKind({ platform, env, isPackaged, resourcesPath, exists }): 'appimage'|'nsis'|'portable'|'pacman'|'manual'|'dev'`
  - `SELF_UPDATING: Set<string>` = `appimage`, `nsis`

- [ ] **Step 1: Write the failing tests** (`requireFromRoot('./main/updateCheck.js')`, style of `test/unit/jsonStore.test.mjs`)

```js
test('parseVersion', () => {
  assert.deepEqual(parseVersion('v0.3.1'), [0, 3, 1]);
  assert.deepEqual(parseVersion('0.3.1'), [0, 3, 1]);
  for (const bad of ['v0.4.0-beta.1', 'release-1', '1.2', '1.2.3.4', '', null, undefined]) assert.equal(parseVersion(bad), null);
});
test('isNewer compares numerically', () => {
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.3.0', '0.3.0'), false);
  assert.equal(isNewer('0.2.9', '0.3.0'), false);
  assert.equal(isNewer('garbage', '0.3.0'), false);
});
test('parseRelease', () => {
  assert.deepEqual(parseRelease({ tag_name: 'v0.3.1', body: 'Fixed x' }), { version: '0.3.1', notes: 'Fixed x' });
  assert.deepEqual(parseRelease({ tag_name: 'v0.3.1', body: null }), { version: '0.3.1', notes: '' });
  assert.equal(parseRelease({ tag_name: 'v0.4.0-beta.1' }), null);
  assert.equal(parseRelease({ tag_name: 'v0.4.0', prerelease: true }), null);
  assert.equal(parseRelease({ tag_name: 'v0.4.0', draft: true }), null);
  assert.equal(parseRelease(null), null);
});
test('pacmanCommand fetches that version into its own folder', () => {
  assert.equal(
    pacmanCommand('0.3.1'),
    'mkdir -p ~/.cache/mqtt-scope-pkg/0.3.1 && cd ~/.cache/mqtt-scope-pkg/0.3.1 && ' +
      'curl -fLO https://github.com/ToRexZ/mqtt-scope/releases/download/v0.3.1/PKGBUILD ' +
      '-fLO https://github.com/ToRexZ/mqtt-scope/releases/download/v0.3.1/mqtt-scope.desktop && makepkg -si',
  );
});
test('installKind', () => {
  const k = (o) => installKind({ platform: 'linux', env: {}, isPackaged: true, resourcesPath: '/r', exists: () => false, ...o });
  assert.equal(k({ env: { APPIMAGE: '/a/MQTT.AppImage' } }), 'appimage');
  assert.equal(k({ exists: (p) => p === path.join('/r', 'pacman-package') }), 'pacman');
  assert.equal(k({}), 'manual'); // tar.gz
  assert.equal(k({ platform: 'win32' }), 'nsis');
  assert.equal(k({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\x' } }), 'portable');
  assert.equal(k({ platform: 'darwin' }), 'manual');
  assert.equal(k({ isPackaged: false }), 'dev');
  assert.equal(k({ isPackaged: false, env: { MQTTSCOPE_UPDATE_URL: 'http://127.0.0.1:1' } }), 'manual');
  assert.equal(k({ isPackaged: false, env: { MQTTSCOPE_UPDATE_KIND: 'pacman' } }), 'pacman');
  assert.equal(k({ env: { MQTTSCOPE_UPDATE_KIND: 'bogus' } }), 'manual'); // invalid override ignored
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/unit/updateCheck.test.mjs`
Expected: FAIL, `Cannot find module './main/updateCheck.js'`

- [ ] **Step 3: Implement `main/updateCheck.js`** with the exports above. `installKind` checks a valid `MQTTSCOPE_UPDATE_KIND` first, then unpackaged → `dev` (or `manual` when `MQTTSCOPE_UPDATE_URL` is set), then platform rules.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/unit/updateCheck.test.mjs && npm run -s lint`
Expected: all pass, lint clean

- [ ] **Step 5: Commit** — `git add main/updateCheck.js test/unit/updateCheck.test.mjs && git commit -m "Update helpers: versions, releases, install kinds"`

---

### Task 2: Update state machine

**Files:**
- Create: `main/updater.js`
- Modify: `main/jsonStore.js` (add `'updates'` to `NAMES`)
- Test: `test/unit/updater.test.mjs`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `class Updater extends EventEmitter` (CommonJS export `{ Updater }`)
  - `constructor({ currentVersion, kind, fetchRelease, engine, store, isEnabled, connectedCount, log })` — `fetchRelease(): Promise<object>` (GitHub release JSON); `engine: { download(onProgress: (percent) => void): Promise<void>, quitAndInstall(): void } | null`; `store: { get(): object|null, set(obj): void }` (the `updates` store: `{ skipped?: string }`); `isEnabled(): boolean`; `connectedCount(): number`
  - `state: UpdateState` getter, where `UpdateState = { status: 'none'|'available'|'downloading'|'ready'|'error', current, kind, latest: { version, notes } | null, progress: number|null, error: string|null, pacmanCommand: string|null }`
  - `start(): void` — no-op for `kind === 'dev'`; else `tick()` now and every `CHECK_INTERVAL_MS`
  - `tick(): Promise<void>` — one automatic check: does nothing while `!isEnabled()`, else `check()`
  - `stop(): void`
  - `check({ manual = false } = {}): Promise<{ result: 'available'|'latest'|'error'|'disabled', version?: string, error?: string }>` — `disabled` for `dev`; a manual check clears a skip of that same version
  - `skip(): void` — stores `latest.version` as skipped, status → `none`
  - `download(): Promise<void>` — only for `SELF_UPDATING` kinds; `downloading` with progress, then `ready`, or `error`
  - `restart({ force = false } = {}): { confirm: number } | { ok: true }` — returns `{ confirm: n }` when `n = connectedCount() > 0` and not forced; otherwise `engine.quitAndInstall()`
  - emits `'state'` with the new `UpdateState` on every change

- [ ] **Step 1: Write the failing tests** (fakes for fetch/engine/store; `mock.timers` from `node:test` for the interval)

```js
test('newer release → available, with notes and pacman command for pacman kind', async () => { /* status 'available', latest {version:'0.3.1',notes}, pacmanCommand === pacmanCommand('0.3.1') only when kind 'pacman' */ });
test('same or older release → none, check returns latest', async () => { /* result 'latest' */ });
test('automatic check failure is silent and leaves state unchanged', async () => { /* fetch rejects: no 'state' event, state.status 'none', error null; manual check returns { result: 'error', error } */ });
test('skip hides that version until a newer one; manual check un-skips it', async () => { /* skip → none + store {skipped:'0.3.1'}; auto check of 0.3.1 → none; 0.3.2 → available; manual check of 0.3.1 → available and store skipped cleared */ });
test('download reports progress then ready; non-self kinds cannot download', async () => { /* progress events 0..100, status 'ready'; kind 'manual' → download() rejects */ });
test('failed download can be retried', async () => { /* first engine.download rejects 'net::ERR_CONNECTION_RESET' → status 'error', error message; second resolves → 'ready' */ });
test('restart asks to confirm while connected, force installs', () => { /* connectedCount 2 → {confirm:2}, engine not called; force → {ok:true}, quitAndInstall called once */ });
test('start checks now and every 6 h, skipping while disabled; dev never checks', () => { /* mock.timers.tick(CHECK_INTERVAL_MS) → 2nd fetch; isEnabled false → no fetch; kind 'dev' start → 0 fetches */ });
```

- [ ] **Step 2: Run to verify they fail** — `node --test test/unit/updater.test.mjs` → FAIL, module not found

- [ ] **Step 3: Implement `Updater` in `main/updater.js`** and add `'updates'` to `NAMES` in `main/jsonStore.js`. Automatic failures go to `log.warn('update', err.message)` only.

- [ ] **Step 4: Run** — `npm run -s test:unit && npm run -s lint` → all pass (jsonStore tests still green)

- [ ] **Step 5: Commit** — `git commit -m "Update state machine: check, skip, download, restart"`

---

### Task 3: Main-process wiring, engine, IPC and Help menu

**Files:**
- Create: `main/updateEngine.js`
- Modify: `main/main.js` (start(), registerIpc(), buildMenu() Help submenu), `main/preload.js`, `package.json` (dependency), `test/helpers/app.mjs` (`launchApp({ env })`)
- Create: `test/helpers/releaseServer.mjs`
- Test: `test/e2e/updates.spec.mjs` (main-side cases)

**Interfaces:**
- Consumes: `Updater`, `installKind`, `releasePageUrl`, `SELF_UPDATING`.
- Produces:
  - `createEngine({ kind, feedUrl, log }): Engine | null` in `main/updateEngine.js` — `null` unless kind is self-updating; `MQTTSCOPE_UPDATE_FAKE=1` → fake (progress 0/50/100 over ~300 ms; `quitAndInstall` sets `globalThis.__updateInstalled = true` and does not quit); otherwise lazy-`require('electron-updater')`, `setFeedURL({ provider: 'generic', url: feedUrl })` when `feedUrl` is set, `checkForUpdates()` then `downloadUpdate()` with `download-progress` → `onProgress(p.percent)`.
  - IPC handles: `update:state`, `update:download`, `update:restart` (arg `force: boolean`), `update:skip`, `update:openRelease` (main calls `shell.openExternal(releasePageUrl(state.latest.version))`). Copying the pacman command uses the existing `copyText`.
  - Test handle: only when `MQTTSCOPE_UPDATE_URL` is set, `globalThis.__mqttscopeUpdater = updater` in main (like the renderer's `window.__mqttscope`), so e2e tests can call `tick()` through `app.evaluate`.
  - Broadcast: `update:state` (UpdateState) to every main window on each `'state'`; `update:checked` (check result) to the focused main window after Help → **Check for Updates…** (item placed after "Keyboard Shortcuts…").
  - preload `window.api`: `updateState()`, `onUpdateState(cb)`, `onUpdateChecked(cb)`, `updateDownload()`, `updateRestart(force)`, `updateSkip()`, `updateOpenRelease()`.
  - `fetchRelease`: `net.fetch(base ? `${base}/release.json` : LATEST_RELEASE_API, { headers, signal: AbortSignal.timeout(15000) })`, non-2xx → `Error(\`HTTP ${status}\`)`.
  - `isEnabled`: `stores.get('settings')?.checkForUpdates !== false`; `connectedCount`: main windows whose `session.status.state === 'connected'`.
  - `test/helpers/releaseServer.mjs`: `startReleaseServer(release: object|null): Promise<{ url, setRelease(obj), requests: () => number, close() }>` (127.0.0.1, random port, serves `/release.json`; `null` → 503).

- [ ] **Step 1: `npm install electron-updater@^6.8.9`** → added to `dependencies` in `package.json` and `package-lock.json`.

- [ ] **Step 2: Write failing e2e tests** (state read via `page.evaluate(() => window.api.updateState())`, menu clicked via `app.evaluate(({ Menu }) => …find('Check for Updates…').click())`)

```js
test('unpackaged run without override never contacts anything', …) // state.status 'none', kind 'dev'
test('override: startup check finds a newer release and every window gets it', …) // MQTTSCOPE_UPDATE_URL → status 'available', latest.version '9.9.9'; second window (File → New Window) has same state
test('Help → Check for Updates reports latest and offline', …) // release = current version → update:checked {result:'latest'}; server closed → {result:'error'}
test('openRelease opens the page main builds', …) // stub shell.openExternal; expect 'https://github.com/ToRexZ/mqtt-scope/releases/tag/v9.9.9'
```

- [ ] **Step 3: Run** — `npx playwright test test/e2e/updates.spec.mjs` → FAIL (`window.api.updateState is not a function`)

- [ ] **Step 4: Implement** `main/updateEngine.js`, the wiring in `main/main.js` (create the `Updater` in `start()` after `stores`, `updater.start()` after the first window), preload methods, `launchApp({ env })` merging extra env.

- [ ] **Step 5: Run** — `npx playwright test test/e2e/updates.spec.mjs && npm run -s lint` → pass

- [ ] **Step 6: Commit** — `git commit -m "Wire the updater into the main process and Help menu"`

---

### Task 4: Top-bar button, panel and setting

**Files:**
- Create: `renderer/updateButton.js`
- Modify: `renderer/index.html` (`<button id="btn-update" class="btn update" hidden></button>` directly before `#btn-settings`), `renderer/app.js` (call `initUpdateButton`), `renderer/settings.js` (`checkForUpdates`), `renderer/styles.css`, `test/unit/settings.test.mjs` (defaults now include `checkForUpdates: true`)
- Test: `test/e2e/updates.spec.mjs` (UI cases)

**Interfaces:**
- Consumes: preload API from Task 3, `toast`, `el`, `button` from `renderer/ui.js`.
- Produces: `initUpdateButton(api, buttonEl: HTMLButtonElement): void`.

Exact copy:
- Button: `↑ Update ${version}` · `Downloading ${pct}%` · `Restart to update` · `Update failed`; hidden for `none`.
- Panel (anchored under the button, not a modal; closes on Escape or outside click): heading `MQTT Scope ${version}`, line `You have ${current}`, notes as text or `No release notes.`
- Self kinds: `Download update` / `Later`; while downloading `Downloading… ${pct}%` / `Later`; ready `Restart to update` / `Later`; confirm `Restarting disconnects ${n} broker${n === 1 ? '' : 's'}.` with `Restart` / `Cancel`; error `${error}` with `Retry` / `Later`.
- `manual`: `Download` (calls `updateOpenRelease`) / `Later`.
- `pacman`: `Installed by the package manager. Update with:`, the command in `<code>`, `Copy command` / `Later`.
- Footer: `Skip this version`, and `Open release page` for every kind except `manual`.
- `update:checked` toasts: latest → `You're on the latest version (${current})`; error → `Couldn't check for updates: ${error}` (kind `error`); disabled → `Update checks are off in development builds`; available → open the panel.
- Setting checkbox in Settings → General: ` Check for updates (asks GitHub at startup and every 6 hours)`.

- [ ] **Step 1: Write failing e2e tests** (`MQTTSCOPE_UPDATE_URL` + `MQTTSCOPE_UPDATE_KIND` + `MQTTSCOPE_UPDATE_FAKE=1`)

```js
test('notice: button, panel, Later keeps it, Skip hides it until a newer release', …) // '↑ Update 9.9.9'; Later → still visible; Skip → hidden; server 9.9.10 + Help check → '↑ Update 9.9.10'
test('self-updating: download progress, confirm while connected, restart installs', …) // kind appimage; 'Downloading' then 'Restart to update'; connected to test broker → 'Restarting disconnects 1 broker.'; Restart → app.evaluate(() => globalThis.__updateInstalled) === true
test('manual build opens the release page; pacman build shows the command', …) // shell.openExternal stubbed; <code> text === pacmanCommand('9.9.9'); Copy command → clipboard
test('release notes are shown as text', …) // body '<img src=x onerror=alert(1)>\n- item' → panel text contains it literally, no <img> element
test('a new window shows the current update state', …) // after 'available' and mid-download, File → New Window shows same button text
test('turning the setting off stops automatic checks; Help still checks', …) // Settings → General uncheck; requests() constant across a forced tick; Help → toast
```

- [ ] **Step 2: Run** — `npx playwright test test/e2e/updates.spec.mjs` → new tests FAIL (`#btn-update` hidden/missing)

- [ ] **Step 3: Implement** `renderer/updateButton.js`, the `index.html` button, `initUpdateButton(api, $('#btn-update'))` in `app.js`, `checkForUpdates` default/normalize/checkbox in `settings.js` (same pattern as `autoExpand`), styles following `.btn` and `.ctx-menu`. The setting test fires automatic checks with `app.evaluate(() => globalThis.__mqttscopeUpdater.tick())`.

- [ ] **Step 4: Run** — `npm test` → lint, unit, integration, e2e all pass

- [ ] **Step 5: Commit** — `git commit -m "Top-bar update button and panel; Check for updates setting"`

---

### Task 5: Release pipeline: update files, release-attached PKGBUILD, pacman marker

**Files:**
- Modify: `package.json` (`build.publish: [{ "provider": "github", "owner": "ToRexZ", "repo": "mqtt-scope" }]`), `.github/workflows/ci.yml`, `packaging/aur/PKGBUILD` (+ `.SRCINFO`)

**Interfaces:**
- Produces: release assets `latest.yml`, `latest-linux.yml`, `latest-mac.yml`, `*.blockmap`, `PKGBUILD`, `mqtt-scope.desktop`; installed file `/opt/mqtt-scope/resources/pacman-package`.

- [ ] **Step 1: Verify the gap** — `npm run dist:linux -- --publish never && ls dist/latest-linux.yml` → missing before the `publish` config.
- [ ] **Step 2: Add `build.publish`**; rerun → `dist/latest-linux.yml` exists and names `MQTT-Scope-0.3.0-linux-x86_64.AppImage` (after Task 6's bump; before it, 0.2.1).
- [ ] **Step 3: CI** — `package` job uploads also `dist/latest*.yml` and `dist/*.blockmap`. New job `pkgbuild` (`needs: release`, `archlinux:base-devel`, `permissions: contents: write`) runs the existing "Update PKGBUILD for this release" logic, then `gh release upload "$GITHUB_REF_NAME" PKGBUILD mqtt-scope.desktop --clobber` (install `github-cli`; `GH_TOKEN: ${{ github.token }}`) and uploads `PKGBUILD .SRCINFO mqtt-scope.desktop` as artifact `aur-package`. `aur` job `needs: pkgbuild`, downloads `aur-package` instead of recomputing, push still gated on `AUR_SSH_PRIVATE_KEY`.
- [ ] **Step 4: PKGBUILD** — in `package()` add `touch "${pkgdir}/opt/${_pkgname}/resources/pacman-package"`; `makepkg --printsrcinfo > .SRCINFO`.
- [ ] **Step 5: Verify** — `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml','utf8'))"` exits 0; in a scratch copy of `packaging/aur` with the 0.2.1 sources, `makepkg -f` then `bsdtar -tf mqtt-scope-bin-*.pkg.tar.zst | grep resources/pacman-package` prints the path and `grep package-type` prints nothing.
- [ ] **Step 6: Commit** — `git commit -m "Release update files and a ready PKGBUILD with each release"`

---

### Task 6: Docs, changelog, version 0.3.0

**Files:**
- Modify: `README.md` (new "Updates" section; Arch install uses the release-attached PKGBUILD via `pacmanCommand`'s command; AppImage tip: rename to `MQTT-Scope.AppImage` for a stable path), `CHANGELOG.md` (`## [0.3.0] - <release date>` with Added entries, links), `package.json` + `package-lock.json` version `0.3.0`

- [ ] **Step 1: Write** the README and CHANGELOG text; bump version.
- [ ] **Step 2: Verify** — `node scripts/release-notes.mjs 0.3.0` prints the new section; `npm run -s test:unit` passes.
- [ ] **Step 3: Commit** — `git commit -m "MQTT Scope 0.3.0"`

---

### Task 7: Release gate — real AppImage self-update dry run (blocks tagging)

**Files:**
- Create: `scripts/update-dry-run.mjs`

**Interfaces:**
- Consumes: packaged builds from Task 5, `MQTTSCOPE_UPDATE_URL`, `log` line `start <version>` in `<userData>/logs/main.log`.

The script, end to end, without the network and without FUSE (`APPIMAGE_EXTRACT_AND_RUN=1` in the env it passes on):
1. `npm run dist:linux -- --publish never` → copy `dist/MQTT-Scope-0.3.0-linux-x86_64.AppImage` into a scratch `app/` folder.
2. `npx electron-builder --linux AppImage --publish never -c.extraMetadata.version=0.3.1 -c.directories.output=<scratch>/feed` → `feed/latest-linux.yml` + 0.3.1 AppImage; write `feed/release.json` `{ "tag_name": "v0.3.1", "body": "Dry run" }`; serve `feed/` on 127.0.0.1.
3. Extract the 0.3.0 AppImage (`--appimage-extract`), launch its binary with Playwright `_electron.launch({ executablePath })` and env `APPIMAGE=<app/…0.3.0…AppImage>`, `MQTTSCOPE_UPDATE_URL`, `MQTTSCOPE_USER_DATA=<scratch>/data`, `MQTTSCOPE_HIDDEN=1`, `APPIMAGE_EXTRACT_AND_RUN=1`.
4. Click `↑ Update 0.3.1` → `Download update` → wait `Restart to update` → click it.
5. Pass when: `<scratch>/data/logs/main.log` gains `start 0.3.1` within 60 s, `app/MQTT-Scope-0.3.1-linux-x86_64.AppImage` exists and the 0.3.0 file is gone; then end the relaunched process.
6. Second pass (fresh scratch): same up to `Restart to update`, then `app.close()` → pass when the 0.3.1 file replaced the 0.3.0 one (installed on quit).

- [ ] **Step 1: Write the script**
- [ ] **Step 2: Run it** — `node scripts/update-dry-run.mjs` → prints `PASS restart-to-update` and `PASS install-on-quit`. Any failure blocks the 0.3.0 tag.
- [ ] **Step 3: Commit** — `git commit -m "Release gate: AppImage self-update dry run"`
- [ ] **Step 4: Ship** — PR to main, CI green, merge, tag `v0.3.0` (annotated, "MQTT Scope 0.3.0"), watch the release; confirm the release lists `latest-linux.yml`, `latest.yml`, `PKGBUILD`, `mqtt-scope.desktop`.
