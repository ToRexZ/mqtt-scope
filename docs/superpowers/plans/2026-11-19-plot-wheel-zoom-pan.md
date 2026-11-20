# Plot wheel zoom, drag pan, rebindable box zoom — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wheel zooms a plot's timeline around the pointer, the horizontal wheel (or Shift+wheel) and a drag pan it, a right drag box-zooms, and Settings → Keyboard rebinds the two drags.

**Architecture:** Pure range maths in `plotMath.js` and binding rules in a new `renderer/mouseBindings.js` (unit-tested). `LineChart` turns wheel and drag gestures into the same `onZoom({ t0, t1, yMin?, yMax? })` it already emits for the box, so the tab-wide time zoom, Reset view and the pop-out window keep working. Bindings live in settings (`mouse: { pan, box }`), are applied with the other settings in each window, and shown as a "Plot mouse" group on the Keyboard page.

**Tech Stack:** Electron, vanilla ES modules, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-plot-wheel-zoom-pan-design.md`

## Global Constraints

- Drag choices: `left`, `right`, `middle`, `shift-left`, `ctrl-left` (Ctrl, or Cmd on macOS); defaults pan `left`, box `right`; the two must differ.
- Wheel step: factor `exp(deltaY × 0.002)` (≈ 20% per 100 px notch), centred on the pointer's time; trackpad deltas zoom smoothly.
- Limits: narrowest 10 ms; widest = the data collected (first point to the latest of now/last point); panning stops at both ends.
- Wheel acts only over the chart's plotting area; over headers, legends and gaps the plots area scrolls as before.
- A pan drag moves the value range too only when that plot has a value zoom.
- Double-click and Esc reset; Reset view as today.

## Review Focus

1. Wheel over a plot inside the scrolling plots area → zooms, never scrolls the area; over a legend → scrolls.
2. Right-drag never opens a context menu; middle-drag never starts autoscroll.
3. A pan that reaches the first point or now → stops there, width unchanged; zooming out past the data → stops at the data.
4. Frozen plot: wheel/pan within what was collected up to the freeze; live plot: the first wheel/pan fixes the range (Reset view back to live).
5. Bindings changed in Settings → apply at once in the window, persist, and a pop-out opened afterwards uses them; equal bindings can't be saved.

---

### Task 1: Range maths and binding rules

**Files:** Modify `renderer/plotMath.js`; Create `renderer/mouseBindings.js`; Test `test/unit/plotMath.test.mjs`, `test/unit/mouseBindings.test.mjs`

**Interfaces — Produces:**
- `zoomAround(range, at, factor, extent, minWidth = 10) -> { t0, t1 }` (the time at `at` stays put; clamped to `extent`, width ≥ `minWidth`)
- `panBy(range, dt, extent) -> { t0, t1 }` (same width, clamped inside `extent`)
- `dataExtent(series, range) -> { t0, t1 }` (first point … max(range.t1, last point); falls back to `range`)
- `MOUSE_CHOICES: [[id, label]]`, `DEFAULT_MOUSE = { pan: 'left', box: 'right' }`, `normalizeMouse(raw) -> { pan, box }` (invalid or equal → defaults), `dragAction(event, bindings) -> 'pan' | 'box' | null`

- [ ] **Step 1: Unit tests**: zoom in/out keeps the pointer's time; clamps to extent; min 10 ms; pan clamps both ends keeping width; extent with and without points; `dragAction` for each choice incl. Shift/Ctrl/Meta, right/middle buttons, modifiers not bound → null; `normalizeMouse` defaults, invalid values, equal values.
- [ ] **Step 2: Run** `node --test test/unit/plotMath.test.mjs test/unit/mouseBindings.test.mjs` — Expected: FAIL (missing exports).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them and `npm run test:unit` — Expected: PASS.
- [ ] **Step 5: Commit** `Plot zoom/pan maths and mouse binding rules`.

### Task 2: Chart gestures and plots wiring

**Files:** Modify `renderer/chart.js` (wheel, pan drag, box on its binding, no context menu/autoscroll on the chart, module-level `setPlotMouse(bindings)`), `renderer/plotView.js` (`chartAxis` adds `yZoomed`), `renderer/plots.js` and `renderer/plotWindow.js` (time-only zoom keeps a value zoom), `renderer/app.js` (apply bindings), existing e2e tests that box-zoom with a left drag → right drag; Create `test/e2e/plotZoomPan.spec.mjs`.

- [ ] **Step 1: E2E test** (wheel events dispatched on the canvas; headless Chromium doesn't deliver real cancelable wheel events): wheel up over a point → narrower range containing that time, every plot of the tab follows, Reset view shown; wheel down → wider, stops at the data; sideways wheel and Shift+wheel → range moves by the drag amount, width unchanged, stops at the ends; left drag right → earlier times; right drag → box zoom (and no context menu); double-click → back to live; wheel over a legend doesn't zoom; frozen plot stays within the freeze; pop-out: wheel and drags work there.
- [ ] **Step 2: Run** `npx playwright test test/e2e/plotZoomPan.spec.mjs --workers=1` — Expected: FAIL.
- [ ] **Step 3: Implement**, then switch existing box-zoom drags in `plotGrid`, `plotWindow`, `plotPanel`, `plotPersistence`, `holdReload`, `layout`, `publisher`, `tabsCore` specs to the right button where they zoom.
- [ ] **Step 4: Run** the new spec and `plot*.spec.mjs plots.spec.mjs holdReload layout publisher tabsCore` — Expected: PASS.
- [ ] **Step 5: Commit** `Plots: wheel zoom, drag to pan, right-drag box zoom`.

### Task 3: Bindings in Settings

**Files:** Modify `renderer/settings.js` (`mouse` in DEFAULT_SETTINGS/normalize; "Plot mouse" group on the Keyboard page: Pan and Box zoom selects, wheel hint, conflict note disables Save, Reset all includes them), `renderer/plotWindow.js` (bindings from settings at open); Test `test/unit/settings.test.mjs`, e2e in `plotZoomPan.spec.mjs` (+ `test/e2e/settings.spec.mjs` if the page is listed there).

- [ ] **Step 1: Tests**: unit `normalizeSettings` keeps valid `mouse`, defaults otherwise; e2e: set Pan = Right drag and Box zoom = Left drag → Save → right drag pans, left drag box-zooms; equal choices → note and Save disabled; Reset all → defaults; restart keeps them; a pop-out opened after uses them.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit file, the e2e specs and `settings.spec.mjs`, `keyboard.spec.mjs` — Expected: PASS.
- [ ] **Step 5: Docs** README plots bullets (Zoom, pan) and keyboard section, CHANGELOG Added.
- [ ] **Step 6: Commit** `Settings: rebind the plot pan and box-zoom drags`.
