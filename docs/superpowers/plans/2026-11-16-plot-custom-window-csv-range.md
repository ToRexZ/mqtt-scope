# Custom Plot Time Window + CSV Range Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a plot use any time window from 1 min to 24 h, set with an hours + minutes picker. Let CSV export write either every collected point or only the visible range.

**Architecture:**
- Pure helpers go in the DOM-free modules, so they run under `node --test`:
  - `isValidWindow` in `plotLayouts.js`
  - `windowLabel`, `splitWindow` and `plotCsv` in `plotView.js`
- The picker popover is a new DOM module, `renderer/windowPicker.js`. It is opened by the shared `windowSelect` in `plotCard.js`, which the plot header, the settings panel and the pop-out window all use.
- In `plots.js`, the CSV button opens the existing `showMenu`.

**Tech Stack:** Electron, vanilla ES modules, `node:test` (unit), Playwright (e2e), ESLint.

**Spec:** `docs/superpowers/specs/2026-11-16-plot-custom-window-csv-range-design.md`

## Global Constraints

- `windowSec` stays in seconds. Valid values: a preset (`WINDOWS = [60, 300, 900, 3600, 0]`), or a whole number of minutes from 60 to 86400.
- Presets and their labels stay unchanged: `1 min`, `5 min`, `15 min`, `1 h`, `All`.
- Custom labels: `"<h> h <m> min"`, `"<h> h"` or `"<m> min"` (e.g. `1 h 30 min`, `2 h`, `45 min`).
- The picker has hours 0–24 and minutes 0–59, digits only. Apply is disabled when the total is < 1 min or > 24 h. It opens with the current window, or 1 h 0 min when the window is All.
- CSV header stays `time_iso,epoch_ms,series,topic,path,value`. It still exports every series of the plot, hidden ones included. Formula neutralising is kept.
- CSV menu labels: `All collected points` and `Visible range`. The visible-range file name is `<title>_visible.csv`.
- No CSV in the pop-out window, no new presets, no seconds-level windows.
- Work on branch `feat/custom-window-csv-range`, never on `main`.

## Review Focus

1. **Esc in the picker.** It must only close the picker. It must not also reset the plot zoom, leave full screen or close the pop-out zoom: call `stopPropagation` on the popover's keydown.
2. **Space and digits typed in the picker.** They must not freeze plots or fire shortcuts. `keyBelongsToTarget` already skips number inputs; the e2e test pins it.
3. **Cancel after picking Custom….** The dropdown shows the previous value again, not "Custom…", and nothing is saved.
4. **A custom window saved by this version and loaded again.** It is still the custom value after a restart (`sanitizePlot`), and the header and settings both label it.
5. **Visible range while frozen.** Points that arrived after the freeze are not exported, but All collected points still includes them.

---

### Task 1: Custom window values (pure)

**Files:**
- Modify: `renderer/plotLayouts.js:8,56` (add `isValidWindow`, use it in `sanitizePlot`)
- Modify: `renderer/plotModel.js:301` (use `isValidWindow` in `updatePlot`)
- Modify: `renderer/plotView.js:12` (add `windowLabel`, `splitWindow`)
- Test: `test/unit/plotLayouts.test.mjs`, `test/unit/plotModel.test.mjs`, `test/unit/plotView.test.mjs`

**Interfaces:**
- Produces:
  - `isValidWindow(sec: any) -> boolean` from `plotLayouts.js`
  - `MAX_WINDOW_SEC = 86400` from `plotLayouts.js`
  - `windowLabel(sec: number) -> string` from `plotView.js`
  - `splitWindow(sec: number) -> { hours: number, minutes: number }` from `plotView.js` (`0` → `{ hours: 1, minutes: 0 }`)

- [ ] **Step 1: Write the failing tests**

```js
// plotLayouts.test.mjs
test('isValidWindow: presets and whole minutes from 1 min to 24 h', () => {
  for (const v of [0, 60, 300, 900, 3600, 5400, 7200, 86400]) assert.equal(isValidWindow(v), true, String(v));
  for (const v of [-60, 30, 90, 86460, 1.5, NaN, '300', null]) assert.equal(isValidWindow(v), false, String(v));
});
test('sanitizePlot keeps a custom window', () => {
  assert.equal(sanitizePlot({ series: [{ topic: 't' }], windowSec: 5400 }).windowSec, 5400);
});
// plotModel.test.mjs
test('updatePlot accepts a custom window and refuses odd ones', () => {
  // build model + plot as the neighbouring updatePlot test does
  assert.equal(m.updatePlot(p.id, { windowSec: 7200 }), true);
  assert.equal(p.windowSec, 7200);
  assert.equal(m.updatePlot(p.id, { windowSec: 90 }), false);
});
// plotView.test.mjs
test('windowLabel', () => {
  assert.deepEqual([60, 300, 900, 3600, 0, 5400, 7200, 2700, 86400].map(windowLabel),
    ['1 min', '5 min', '15 min', '1 h', 'All', '1 h 30 min', '2 h', '45 min', '24 h']);
});
test('splitWindow', () => {
  assert.deepEqual(splitWindow(5400), { hours: 1, minutes: 30 });
  assert.deepEqual(splitWindow(0), { hours: 1, minutes: 0 });
});
```

The existing `windowSec: 42 → 300` (plotLayouts) and `windowSec: 7 → false` (plotModel) assertions must keep passing.

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit`
Expected: FAIL. `isValidWindow` / `windowLabel` / `splitWindow` are not exported.

- [ ] **Step 3: Implement**

- `isValidWindow`: `WINDOWS.includes(sec)`, or an integer with `sec % 60 === 0 && sec >= 60 && sec <= MAX_WINDOW_SEC`.
- Replace both `WINDOWS.includes(...)` checks (`sanitizePlot`, `updatePlot`) with it.
- `windowLabel`: `WINDOW_LABELS[sec]` when present, else the custom label format from Global Constraints.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit && npm run lint`
Expected: all pass, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add renderer/plotLayouts.js renderer/plotModel.js renderer/plotView.js test/unit/
git commit -m "Accept custom plot time windows (1 min to 24 h, whole minutes)"
```

---

### Task 2: Hours + minutes picker in the time-window dropdown

**Files:**
- Create: `renderer/windowPicker.js`
- Modify: `renderer/plotCard.js:76-83` (`windowSelect`)
- Modify: `renderer/plotSettings.js:38-39` (use `windowSelect` instead of `select('plot-window', …)`)
- Modify: `renderer/styles.css` (after `.ctx-sep`, ~line 1560: `.window-picker` styles, using the same tokens as `.ctx-menu`)
- Modify: `README.md` (Plots → settings panel / time window bullet), `CHANGELOG.md` (`[Unreleased]` → `### Added`)
- Test: `test/e2e/plotWindowPicker.spec.mjs` (new)

**Interfaces:**
- Consumes: `isValidWindow`, `MAX_WINDOW_SEC` (plotLayouts.js); `windowLabel`, `splitWindow` (plotView.js); `overlayHost`, `el`, `button` (ui.js)
- Produces:
  - `openWindowPicker(anchor: Element, sec: number, { onApply(sec), onCancel() }) -> void` (windowPicker.js)
  - `windowSelect(plot, onWindow, { name = undefined, className = 'select small window-select' } = {}) -> HTMLSelectElement` (plotCard.js)

`windowSelect` behaviour:
- Options, in order: the presets in duration order (1 min, 5 min, 15 min, 1 h). When `plot.windowSec` is a custom value, it is inserted in duration order. Then `All`, then `Custom…` (value `"custom"`).
- Choosing `Custom…` immediately puts the select back to the current value and calls `openWindowPicker(select, plot.windowSec, …)`.
- `onApply(sec)` rebuilds the options for `sec`, then calls `onWindow(sec)`.
- `onCancel` does nothing more, since the select already shows the old value.

`openWindowPicker` DOM:
- A fixed `.window-picker` below the anchor, appended to `overlayHost()`. Only one is open at a time.
- `input[type=number][name=window-hours]` (min 0, max 24) + `h`, then `input[name=window-minutes]` (min 0, max 59) + `min`.
- `Cancel` and `Apply` buttons. Apply is disabled unless `isValidWindow(h*3600 + m*60)` and the total is ≥ 60.
- Digits only: block other `beforeinput` data.
- The wheel over an input steps it by ±1, clamped (`preventDefault`).
- Enter applies when valid. Esc cancels, with `stopPropagation` (Review Focus 1). A mousedown outside cancels. Focus starts on hours, with its value selected.

- [ ] **Step 1: Write the failing e2e test**

Build the setup like `test/e2e/plotPanel.spec.mjs` `setup()` (a broker, a plot of a numeric topic, the settings panel open).

```js
test('custom time window: picker in header and settings, cancel, persistence', async ({ env }) => {
  const card = page.locator('.plot-card').first();
  const header = card.locator('.window-select');
  // Header: Custom… opens the picker filled with the current window (5 min → 0 h 5 min).
  await header.selectOption('custom');
  const picker = page.locator('.window-picker');
  await expect(picker.locator('input[name="window-hours"]')).toHaveValue('0');
  await expect(picker.locator('input[name="window-minutes"]')).toHaveValue('5');
  // Space and letters typed in the picker do nothing else (no freeze, no input).
  await picker.locator('input[name="window-hours"]').press('Space');
  await expect(page.getByRole('button', { name: 'Freeze' })).toBeVisible();
  // Esc cancels: the picker closes and the header still shows 5 min.
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(header).toHaveValue('300');
  // 0 h 0 min cannot be applied; 1 h 30 min can.
  await header.selectOption('custom');
  await picker.locator('input[name="window-hours"]').fill('0');
  await picker.locator('input[name="window-minutes"]').fill('0');
  await expect(picker.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await picker.locator('input[name="window-hours"]').fill('1');
  await picker.locator('input[name="window-minutes"]').fill('30');
  await picker.locator('input[name="window-minutes"]').press('Enter');
  await expect(header).toHaveValue('5400');
  await expect(header.locator('option:checked')).toHaveText('1 h 30 min');
  await expect(panel(page).locator('select[name="plot-window"] option:checked')).toHaveText('1 h 30 min');
  // Settings panel: 2 h via its own Custom….
  await panel(page).locator('select[name="plot-window"]').selectOption('custom');
  await picker.locator('input[name="window-hours"]').fill('2');
  await picker.locator('input[name="window-minutes"]').fill('0');
  await picker.getByRole('button', { name: 'Apply' }).click();
  await expect(header).toHaveValue('7200');
  // Saved: plotTabs.json carries 7200, and a relaunch still shows "2 h".
}
```

Also add a pop-out check to `test/e2e/plotWindow.spec.mjs` near its existing `.window-select` step (line 81): `Custom…` → 1 h 30 min → `.window-select` value `5400`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/e2e/plotWindowPicker.spec.mjs`
Expected: FAIL. There is no `custom` option.

- [ ] **Step 3: Implement `windowPicker.js`, `windowSelect`, settings-panel switch and CSS** as specified above. Settings call: `windowSelect(plot, (sec) => update({ windowSec: sec }, 'card'), { name: 'plot-window', className: 'select' })`.

- [ ] **Step 4: Run to verify it passes, plus the suites touching the window select**

Run: `npx playwright test test/e2e/plotWindowPicker.spec.mjs test/e2e/plotPanel.spec.mjs test/e2e/plotWindow.spec.mjs test/e2e/holdReload.spec.mjs test/e2e/plots.spec.mjs && npm run lint`
Expected: all pass.

- [ ] **Step 5: Docs.** README: the time-window bullet mentions "or **Custom…** (hours + minutes, up to 24 h)". CHANGELOG `[Unreleased]` → `### Added`: "Custom plot time window: pick any hours + minutes up to 24 h from **Custom…** in the time-window menu."

- [ ] **Step 6: Commit**

```bash
git add renderer/windowPicker.js renderer/plotCard.js renderer/plotSettings.js renderer/styles.css test/e2e/ README.md CHANGELOG.md
git commit -m "Custom plot time window picker (hours + minutes)"
```

---

### Task 3: CSV export: all collected points or visible range

**Files:**
- Modify: `renderer/plotView.js` (add `plotCsv`)
- Modify: `renderer/plots.js:283-294` (`exportCsv` uses `plotCsv`), `:641` (CSV button opens menu), `:652` (⋯ menu items)
- Modify: `test/e2e/plots.spec.mjs:159`, `test/e2e/plotPicker.spec.mjs:124`, `test/e2e/hardening.spec.mjs:238`. After the CSV click, add `await menu(page, 'All collected points')` (`menu` from fixtures.mjs).
- Modify: `README.md` (Plots: "CSV export (…)" bullet), `CHANGELOG.md`
- Test: `test/unit/plotView.test.mjs`, `test/e2e/plots.spec.mjs`

**Interfaces:**
- Consumes: `pointsBetween(points, t0, t1)` (plotMath.js, inclusive both ends); `chartSeries`, `chartRange` (plotView.js); `showMenu` (ui.js)
- Produces: `plotCsv(plot, pointsOf: (topic, segs) => points[], range: { t0, t1 } | null = null) -> string` (plotView.js). `null` means every point.

- [ ] **Step 1: Write the failing unit tests** (plotView.test.mjs)

```js
test('plotCsv: all points, or only those in the range (inclusive)', () => {
  const p = plot({}, [{ topic: 't', alias: '=Speed' }]);
  const pts = [{ t: 1000, v: 1 }, { t: 2000, v: 2 }, { t: 3000, v: 3 }];
  const all = plotCsv(p, () => pts).split('\n');
  assert.equal(all[0], 'time_iso,epoch_ms,series,topic,path,value');
  assert.equal(all.length, 4);
  assert.ok(all[1].includes(`"'=Speed"`), 'formula neutralised');
  const some = plotCsv(p, () => pts, { t0: 2000, t1: 3000 }).split('\n');
  assert.deepEqual(some.slice(1).map((l) => l.split(',')[1]), ['2000', '3000']);
  assert.equal(plotCsv(p, () => pts, { t0: 5000, t1: 6000 }).split('\n').length, 1, 'header only');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit`
Expected: FAIL. `plotCsv` is not exported.

- [ ] **Step 3: Implement**

- Move the row-building and `q()` quoting from `plots.js` `exportCsv` into `plotCsv`. Filter with `pointsBetween` when `range` is set.
- In `plots.js`:
  - `exportCsv(plot, visibleOnly = false)`. The range comes from `chartRange(plot, chartSeries(plot, pointsOf), { zoom: this.zoomByTab.get(this.tab.id) || null, frozenAt: this.frozenAt, now: Date.now() })` when `visibleOnly`, else `null`.
  - File name: `<title>.csv`, or `<title>_visible.csv` when `visibleOnly`.
- The CSV button calls `showMenu(r.left, r.bottom + 4, [{ label: 'All collected points', … }, { label: 'Visible range', … }])` from its rect. Tooltip: `Export points as CSV`.
- The ⋯ menu `Export CSV…` item becomes two items: `Export CSV: all collected points…` and `Export CSV: visible range…`.

- [ ] **Step 4: Write the e2e check (Review Focus 5)** in `test/e2e/plots.spec.mjs` after the existing CSV block:
  1. Freeze (`Freeze` button).
  2. Publish one more value on the plotted topic and wait until All collected points includes it.
  3. Export `Visible range` to a second temp file. Assert that file excludes the post-freeze value and includes the pre-freeze ones.
  4. Assert `dialogCalls` shows `defaultPath: 'Climate_visible.csv'`.
  5. Resume.

- [ ] **Step 5: Run to verify everything passes**

Run: `npm run test:unit && npx playwright test test/e2e/plots.spec.mjs test/e2e/plotPicker.spec.mjs test/e2e/hardening.spec.mjs && npm run lint`
Expected: all pass.

- [ ] **Step 6: Docs.**
  - README: "CSV export (time, series alias, topic, path, value): all collected points or only the visible range."
  - CHANGELOG `[Unreleased]` → `### Added`: "CSV export asks whether to save all collected points or only the visible range (time window, zoom or freeze)."

- [ ] **Step 7: Commit**

```bash
git add renderer/plotView.js renderer/plots.js test/ README.md CHANGELOG.md
git commit -m "CSV export: all collected points or only the visible range"
```

---

### Final check

- [ ] Run: `npm test` (lint + unit + integration + e2e). Expected: all green.
