# Search shows the whole matching entry

Small change. Requested by a user (San, 13 Nov; a colleague hit the same):
"I diagnostic core når jeg søger på en key, kunne det være fedt den måske viste
value på den key."

## Why

The inspector Tree's search shows only what matches and the branches leading to
it. In ROS diagnostics a key/value pair is an entry `{ "key": "BRAKE_MODE",
"value": "3" }`; searching `BRAKE_MODE` matches the `key` text, so the tree
shows `"key": "BRAKE_MODE"` and hides the `value` right next to it, which is
what you were looking for.

## Goals

- When a search matches a value inside an entry of an array (an object
  directly in an array), the innermost such entry is shown in full: all its
  fields, nested containers open or closed as they were (a click toggles).
  A matching key name shows its own value already, so it doesn't open its
  entry (searching `temp` across robots still shows just each robot's temp).
  - `BRAKE_MODE` → `{ "key": "BRAKE_MODE", "value": "3" }`.
  - `BRAKE_SYSTEM/FRONT_WHEEL` (a `status[].name`) → that status entry: level,
    message, hardware_id and its `values` list.
  - `21.5` (a value) → its entry, so you see which key it belongs to.
- Matches stay highlighted and counted as today; the match count and the
  "Showing only branches that match" note don't change.
- Matches outside array entries behave as today.

## Non-goals

- No change to the Text/Raw views' search.
- No change to how many matches are counted or which text matches.

## Approaches considered

- **Show the innermost array entry in full (chosen).** Fits key/value lists and
  any list of records; a whole entry is small.
- *Show the matched value's siblings in any object.* Matching a top-level field
  would show the whole top level.
- *Only when the match is a `key`/`name` field.* Searching a value (`21.5`)
  would still hide which key it belongs to.

## Testing

- Unit (`searchJson`): matches inside entries report the entry to show in full;
  innermost entry only; matches outside arrays unchanged; count unchanged.
- E2E: diagnostics message, search `BRAKE_MODE` → its `value` line visible;
  search the status name → the entry's `level` visible and `values` closed;
  a plain object match still hides its siblings.
