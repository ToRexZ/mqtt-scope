# Repeat publish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The publisher can send the composed message repeatedly at a rate in Hz (typed or picked) until stopped.

**Architecture:** A DOM-free `renderer/repeat.js` holds the rate rules and a `Repeater` loop with injected timers (unit-testable). `Publisher` adds the Repeat controls, checks the message once at Start (split out of `sendNow` as `prepare`), and drives the `Repeater`. `ConnectionTab.onStatus` stops it when the connection is no longer up; `dispose` stops it.

**Tech Stack:** Electron, vanilla ES modules, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-repeat-publish-design.md`

## Global Constraints

- Preset rates: 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100 Hz; default 1 Hz; typed rates 0.01–100 Hz, decimals allowed.
- The message is fixed at Start (topic, payload bytes, QoS, retain); retained confirmation, hex/JSON checks and the Recent entry happen once.
- Never two publishes in flight from one repeat; the next send waits for the previous one, then for the rest of the interval (from the previous send's start).
- No "Published to …" toast per message; one toast when it stops on its own (failure, disconnect).
- Existing behaviour with Repeat unticked is unchanged (`publish()` still resolves to the send result).

## Review Focus

1. A slow publish (QoS 2, slow broker) at 100 Hz → sends don't pile up; Stop takes effect at once and a late reply doesn't restart or count.
2. Stop then Start quickly → the old loop's pending timer/reply never sends or counts into the new run.
3. Tab closed, moved to another window, or connection dropped while running → no sends afterwards, no errors.
4. Typed rate edge cases: `0`, `-1`, `abc`, `1e3`, `100.5`, ` 2 `, `0.01`, `.5` → valid exactly for 0.01–100.
5. Editing the message while running → nothing sent changes; the note appears only while the editor differs from what is being sent.

---

### Task 1: Rates and the repeat loop

**Files:** Create `renderer/repeat.js`; Test `test/unit/repeat.test.mjs`

**Interfaces — Produces:**
- `RATES: number[]`, `MIN_RATE = 0.01`, `MAX_RATE = 100`
- `parseRate(text) -> number | null` (plain decimal, trimmed, in range)
- `formatRate(hz) -> string` (`1`, `0.5`, `12.5`)
- `class Repeater({ send: () => Promise<{ok, error?}>, onTick(count), onStop(reason, error), timers: { set, clear, now } })` with `start(rate)`, `stop(reason = 'stopped', error)`, `setRate(rate)`, `running`, `count`, `rate`.

- [ ] **Step 1: Unit tests** with a fake clock/timers object:
  - `parseRate`: `'1'`→1, `' 2 '`→2, `'.5'`→0.5, `'0.01'`→0.01, `'100'`→100; null for `'0'`, `'-1'`, `'abc'`, `''`, `'1e3'`, `'100.5'`, `'0.001'`, `'0x10'`.
  - `formatRate(0.5)`→`'0.5'`, `formatRate(10)`→`'10'`.
  - start(10): sends at once; after 100 ms another; `count` and `onTick` follow sends that succeeded.
  - a send that takes 250 ms at 10 Hz → next send right after it, never two in flight.
  - stop() while a send is in flight → its reply doesn't count or schedule; `onStop('stopped')` once.
  - a failed send → `onStop('failed', error)`, no more sends.
  - start → stop → start: the first run's pending reply/timer has no effect on the second.
  - setRate(1) while running → the next wait uses 1000 ms.
- [ ] **Step 2: Run** `node --test test/unit/repeat.test.mjs` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `renderer/repeat.js`.
- [ ] **Step 4: Run** it, then `npm run test:unit` — Expected: PASS.
- [ ] **Step 5: Commit** `Repeat loop and rate rules for the publisher`.

### Task 2: Repeat in the publisher

**Files:** Modify `renderer/publisher.js` (controls, `prepare`, `publish()` toggles, draft), `renderer/connectionTab.js` (stop on status not connected), `renderer/styles.css`; Create `test/e2e/publisherRepeat.spec.mjs`; Docs README publisher bullet, CHANGELOG.

**Interfaces:** Consumes Task 1. `Publisher.stopRepeat(reason)`; `draft()` gains `repeat: boolean, rate: string`.

UI: row 1 gets `☐ Repeat at [ 1 ] ▾ Hz` before the send button (`label` "Repeat", input `name="repeat-rate"`, a `▾` button titled "Common rates" opening a menu `0.1 Hz … 100 Hz`); the send button reads Publish / Start / `Stop (n)`; a note row `.repeat-note` under row 1.

- [ ] **Step 1: E2E test** (watcher client subscribed to `rep/#`):
  - Repeat ticked → button `Start`; rate `abc`, `0`, `500` → input marked invalid and Start disabled; `10` → enabled.
  - ▾ menu lists the ten presets; picking `20 Hz` sets the field to `20`.
  - Start at 10 Hz with `{"alive":true}` → watcher gets ≥ 5 identical payloads within ~1 s; button matches `/^Stop \(\d+\)$/`; no "Published to" toast.
  - Editing the payload while running → `.repeat-note` visible, sent payloads unchanged; restoring the text hides the note.
  - Stop → no new messages after 400 ms; button `Start`.
  - Ctrl+Enter in the payload starts; again stops.
  - Retain ticked + Start → one confirmation (dialogCalls) for many sends; received messages are retained.
  - Disconnect while running → button `Start`, info toast, no messages after.
  - Repeat unticked → `Publish` sends once as before.
- [ ] **Step 2: Run** `npx playwright test test/e2e/publisherRepeat.spec.mjs --workers=1` — Expected: FAIL (no Repeat control).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it, `test/e2e/publisher.spec.mjs` and `test/e2e/tabMove.spec.mjs` — Expected: PASS.
- [ ] **Step 5: Docs** README publisher bullet, CHANGELOG Added.
- [ ] **Step 6: Commit** `Publisher: repeat a message at a chosen rate`.
