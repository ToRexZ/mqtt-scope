# Plot series by name — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A series added from an array of named entries (`key`/`name`) selects the entry by name in every message, and is labelled with the names.

**Architecture:** A new path step, the selector `{ field, equals }`, lives in `segs` next to keys and indices. `jsonPath.js` reads, prints and parses it. `namedSegs()` turns a picked positional path into one with selectors, using the message it was picked from. Plots convert at the one place series are added (`PlotsPanel`), the inspector chart converts on *Chart this field*. Everything downstream (points, CSV, save, compare) already goes through `segs`.

**Tech Stack:** Electron, vanilla ES modules, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-plot-series-by-key-design.md`

## Global Constraints

- Name fields, in order: `key`, then `name`; only a non-empty string no other element of that array has.
- A selector step is exactly `{ field: 'key' | 'name', equals: <non-empty string> }`, keys in that order.
- Path text: `[?(@.key=="BRAKE_MODE")]`, `equals` written with `JSON.stringify`.
- Label with selectors: `topic › name › name`, array field before a selector dropped, a final `value` after a selector dropped.
- Paths without selectors: unchanged everywhere (labels, CSV, saved files).
- Missing named entry in a message → no point (never 0).
- Duplicate name in a later message → first match.

## Review Focus

1. A name containing `"`, `\`, `]` or `)` → path text escapes it and `parsePath` reads it back to the same step.
2. A message where the named entry is gone → no point, and the line doesn't drop to 0.
3. The same field added twice (Tree menu, picker, chart button) → one series; "Add to plot …" disabled when the plot has it.
4. A layout saved by 0.4.1 (positional) → loads and plots as before; a selector with a bad field or empty name → series rejected, not crashed.
5. Arrays whose name field repeats, isn't a string, or is missing on the picked element → that step stays positional.

---

### Task 1: Selector steps in JSON paths

**Files:**
- Modify: `renderer/jsonPath.js`, `renderer/payload.js` (`extractNumber` reads through `getAt`)
- Test: `test/unit/jsonPath.test.mjs`, `test/unit/payload.test.mjs`

**Interfaces:**
- Produces: `isSelector(step) -> boolean`, `childPath(parent, step)` (selector → `${parent}[?(@.${field}==${JSON.stringify(equals)})]`), `getAt(value, segs)` (selector → first array element that is an object with `el[field] === equals`, else `undefined`), `parsePath(text)` (reads the selector form), `namedSegs(value, segs) -> segs` (positional → selectors where Global Constraints allow; selectors already present are kept and followed), `nameParts(segs) -> string[] | null` (label parts; null when no selector).

- [ ] **Step 1: Write failing tests** (`jsonPath.test.mjs`, new `describe('selectors')`):
  - `pathFromSegments(['status', {field:'name', equals:'A/B'}, 'values', {field:'key', equals:'T'}, 'value'])` → `$.status[?(@.name=="A/B")].values[?(@.key=="T")].value`
  - `parsePath` of that text deep-equals the segs; round-trip for `equals` = `'q"x\\y])'`.
  - `getAt({status:[{name:'B'},{name:'A',v:2}]}, ['status',{field:'name',equals:'A'},'v'])` → 2; missing name → undefined; selector on a non-array → undefined.
  - `namedSegs(diag, ['status',1,'values',0,'value'])` → selectors for both arrays; `namedSegs` keeps a step positional when: name duplicated in the array, field not a string, element not an object, array of numbers; `key` preferred over `name` when both exist; already-named segs come back equal.
  - `nameParts([...status/A/B/values/T/value])` → `['A/B','T']`; `['status',sel,'level']` → `['A','level']`; `['a',0]` → null.
  - `payload.test.mjs`: `extractNumber` of a diagnostics message with a selector path whose entry moved index → the number from the string `"21.5"`; entry missing → undefined.
- [ ] **Step 2: Run** `node --test test/unit/jsonPath.test.mjs test/unit/payload.test.mjs` — Expected: FAIL (`namedSegs`/`nameParts` not exported).
- [ ] **Step 3: Implement** in `jsonPath.js`; `extractNumber` uses `getAt` instead of its own loop.
- [ ] **Step 4: Run** the same — Expected: PASS; then `npm run test:unit` — Expected: all pass.
- [ ] **Step 5: Commit** `Selector steps in JSON paths: read, print, parse, choose`.

### Task 2: Saving and labelling series with selectors

**Files:**
- Modify: `renderer/plotLayouts.js` (`sanitizeSeries`, new `seriesLabel(topic, segs)`), `renderer/plotView.js` (`labelOf`), `renderer/plotModel.js` (new plot title)
- Test: `test/unit/plotLayouts.test.mjs`, `test/unit/plotView.test.mjs`, `test/unit/plotModel.test.mjs`

**Interfaces:**
- Consumes: `isSelector`, `nameParts`, `pathFromSegments` (Task 1).
- Produces: `seriesLabel(topic, segs) -> string` (`topic › A/B › T` with selectors, else `sourceLabel`); `sanitizeSeries` keeps a valid selector as a fresh `{ field, equals }`.

- [ ] **Step 1: Failing tests:**
  - `sanitizeSeries({topic:'d', segs:['status',{equals:'A',field:'name'}]}).segs[1]` deep-equals `{field:'name', equals:'A'}` and `JSON.stringify` puts `field` first; rejected (null): `{field:'id',equals:'A'}`, `{field:'key',equals:''}`, `{field:'key'}`, `{field:'key',equals:'A',x:1}`.
  - `seriesLabel('diagnostics', segs)` → `diagnostics › A/B › T`; positional → same as `sourceLabel`.
  - `labelOf({topic, segs})` → `seriesLabel`; alias still wins.
  - `plotModel.addSeries(null, {topic, segs:selectorSegs})` → new plot title `diagnostics › A/B › T`.
  - `plotCsv` path column for selector segs → `$.status[?(@.name=="A/B")]…` (quoted, `"` doubled).
- [ ] **Step 2: Run** `node --test test/unit/plotLayouts.test.mjs test/unit/plotView.test.mjs test/unit/plotModel.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm run test:unit` — Expected: PASS.
- [ ] **Step 5: Commit** `Series keep selector steps; labels show the names`.

### Task 3: Adding series by name (plots and inspector)

**Files:**
- Modify: `renderer/plots.js` (`namedSeriesSegs(topic, segs)` from the topic's latest message; used by `menuItems` and `add`; passed to the picker), `renderer/plotPicker.js` (duplicate check compares named segs), `renderer/viewer.js` (*Chart this field* stores named segs; chart title uses `seriesLabel`-style names)
- Create: `test/e2e/plotSeriesByName.spec.mjs`

**Interfaces:**
- Consumes: `namedSegs` (Task 1), `seriesLabel` (Task 2).

- [ ] **Step 1: Write the e2e test** (fails today). Broker: topic `diag`, messages alternating node A `{status:[{name:'BRAKE/FRONT', level:0, values:[{key:'MODE',value:'3'},{key:'TEMP',value:'21.5'}]}]}` and node B `{status:[{name:'MOTOR', level:1, values:[{key:'TEMP',value:'60'}]}, {name:'BRAKE/FRONT', level:2, values:[{key:'TEMP',value:'22.5'},{key:'MODE',value:'4'}]}]}`. Assert:
  - Inspector Tree, right-click TEMP's `value` under BRAKE/FRONT → *Add to new plot* → legend `diag › BRAKE/FRONT › TEMP`; its points are only 21.5/22.5 (never 60).
  - Right-click the same leaf again → *Add to plot "…"* is disabled.
  - Picker: check `level` under MOTOR → legend `diag › MOTOR › level`; message A gives no point.
  - *Chart this field* on BRAKE/FRONT `level` → chart title names `BRAKE/FRONT`.
  - CSV path column has `$.status[?(@.name=="BRAKE/FRONT")].values[?(@.key=="TEMP")].value`.
  - Restart: legend labels unchanged; a 0.4.1 layout with a positional series (`segs:['status',0,'level']`) loads and plots.
- [ ] **Step 2: Run** `npx playwright test test/e2e/plotSeriesByName.spec.mjs --workers=1` — Expected: FAIL (label is the positional path).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it, then the plot/inspector specs (`plot*.spec.mjs plots.spec.mjs inspector.spec.mjs`) — Expected: PASS.
- [ ] **Step 5: Docs:** README plot bullet (series from named entries follow the name), CHANGELOG `[Unreleased]` → Added (incl. older versions skip such series).
- [ ] **Step 6: Commit** `Series from named array entries follow the name`.
