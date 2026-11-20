# Inspector: chart numeric text, search shows the entry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the inspector Tree, numbers written as text can be charted and plotted from the right-click menu, and a search hit inside an array entry shows the whole entry.

**Architecture:** #2 changes one predicate in `viewer.js` `jsonMenu` to the plots' rule (`isDecimal`). #3 makes `searchJson` also return `whole` (innermost array entry around each match); `JsonTree` shows those entries unfiltered, as it already does below a matching key.

**Tech Stack:** Electron, vanilla ES modules, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-chart-numeric-strings-design.md`, `docs/superpowers/specs/2026-11-19-search-shows-entry-design.md`

## Global Constraints

- Chartable in the Tree = finite number, boolean, or `isDecimal` text (same as `fields.js` `plottable`).
- "Array entry" = a plain object (not array, not null) directly inside an array; only the innermost one around a match is shown whole.
- Match count, highlights and the search note text are unchanged.

## Review Focus

1. Numeric text with spaces/exponent (`" -3 "`, `"1e3"`) → chartable; `"0x10"`, `"NaN"`, `"Infinity"`, `""` → not.
2. A match in a nested entry (`status[i].values[j].key`) → only `values[j]` whole, `status[i]` shows just the chain plus its own matches.
3. A whole entry's nested containers start closed and open on click; the Tree's "expand all"/remembered expansion after the search is cleared is unchanged.
4. Matches outside arrays (plain objects, top level) → siblings still hidden.
5. A large message (thousands of entries) with a common search term → no noticeable slowdown (one pass, no extra walks).

---

### Task 1: Chart numbers written as text (#2)

**Files:** Modify `renderer/viewer.js` (`jsonMenu`); Test: `test/e2e/inspectorNumericText.spec.mjs` (new)

- [ ] **Step 1: E2E test** — topic `diag` with `{status:[{name:'A', values:[{key:'T',value:'21.5'},{key:'S',value:'OK'},{key:'E',value:' -3e1 '}]}]}` then `value:'22.5'`: right-click `$.status[0].values[0].value` → labels `['Copy value','Copy path','Chart this field (kept history)','Choose values to plot…','Add to new plot']`, nothing disabled; *Chart this field* → `A › T · 2 points in kept history`; *Add to new plot* → legend `diag › A › T`, points `[21.5, 22.5]`; `values[2].value` → enabled; `values[1].value` (`OK`) → only `Chart this field` disabled, no plot items.
- [ ] **Step 2: Run** `npx playwright test test/e2e/inspectorNumericText.spec.mjs --workers=1` — Expected: FAIL (menu has no plot items / chart disabled).
- [ ] **Step 3: Implement** `numeric` = `typeof v === 'number' && Number.isFinite(v) || typeof v === 'boolean' || isDecimal(v)`.
- [ ] **Step 4: Run** it and `test/e2e/plots.spec.mjs` (its "strings cannot be charted" check) — Expected: PASS.
- [ ] **Step 5: Commit** `Inspector: chart and plot numbers written as text`.

### Task 2: Search shows the whole matching entry (#3)

**Files:** Modify `renderer/jsonTree.js` (`searchJson` returns `whole`; `JsonTree` treats `whole` like a matching key); Test: `test/unit/jsonTree.test.mjs`, `test/e2e/inspectorNumericText.spec.mjs` (second test)

**Interfaces:** Produces `searchJson(value, query) -> { visible, matches, count, whole: Set<path> }`.

- [ ] **Step 1: Unit tests** (`searchJson`):
  - diag `{status:[{name:'BRAKE',level:1,values:[{key:'MODE',value:'3'},{key:'TEMP',value:'21'}]}]}`, query `mode` → `whole` = `{'$.status[0].values[0]'}`; `matches` = `{'$.status[0].values[0].key'}`; count 1.
  - query `brake` → `whole` = `{'$.status[0]'}`.
  - query `21` → `whole` = `{'$.status[0].values[1]'}`.
  - key match inside an entry (`level`) → `whole` = `{'$.status[0]'}`.
  - the existing `v` fixture: `abc` → `whole` = `{'$.list[0]'}` (`'ABCD'` is not an entry); `21.5` → empty; `NAME` → empty.
- [ ] **Step 2: Run** `node --test test/unit/jsonTree.test.mjs` — Expected: FAIL (`whole` undefined).
- [ ] **Step 3: Implement** in `searchJson` (track the innermost entry while walking) and `JsonTree` (`unfiltered` also for `whole` paths).
- [ ] **Step 4: E2E** (new test in the same spec): search `MODE` → `$.status[0].values[0].value` visible, `$.status[0].values[1]` not; search `BRAKE` → `$.status[0].level` visible, `$.status[0].values` visible and closed (`▸`), opens on click; a plain object `{cfg:{a:'x',b:'y'}}` search `x` → `$.cfg.b` hidden; match count note unchanged (`(1 matches)`).
- [ ] **Step 5: Run** the unit file, the new spec and `test/e2e/inspector.spec.mjs` — Expected: PASS.
- [ ] **Step 6: Docs** README inspector bullet, CHANGELOG `[Unreleased]` Added (both changes).
- [ ] **Step 7: Commit** `Inspector search shows the whole matching entry`.
