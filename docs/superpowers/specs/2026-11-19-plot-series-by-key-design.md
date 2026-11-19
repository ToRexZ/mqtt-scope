# Plot series follow array entries by name

Requested by a user (San, 13 Nov) after using 0.4.x: plots show `value[11]`
instead of the name, "lidt frem og tilbage".

## Why

- A series taken from an array of named entries (ROS diagnostics:
  `status[].name`, `values[].key`) is stored and read by position, e.g.
  `$.status[0].values[11].value`. The legend shows that path, so you can't tell
  what is plotted without going back to the message.
- Position is also wrong data waiting to happen: when entries change order, or
  several nodes publish to one `/diagnostics` topic, `status[0]` is a different
  device in different messages, and the series silently mixes them.

## Goals

1. **Pick by name.** When a series is added and its path goes through an array
   element that is an object with a name field, that step selects the element
   by name instead of by position, at every level of the path.
   - Name fields, in this order: `key`, then `name` (builder's call; covers
     `diagnostic_msgs`). Used only when the field is a string that no other
     element of that array has in the message the series is picked from;
     otherwise the step stays positional, as today.
   - Applies to every way of adding a series from a field: the plot picker
     ("Choose values to plot…"), the inspector Tree's *Add to new plot* /
     *Add to plot "…"*, and the inspector's *Chart this field*.
2. **Every message is searched.** Each message's entry with that name is used,
   wherever it sits in the array. A message without it gives no point.
3. **Readable label.** The default label is the topic and the names, e.g.
   `diagnostics › BRAKE_SYSTEM/FRONT_WHEEL › BRAKE_MODE`:
   - a selector shows its name; the array field just before it (`status`,
     `values`) is left out;
   - a final `value` right after a selector is left out (the value of a
     key/value pair);
   - other fields after a selector are kept: `… › BRAKE_SYSTEM/FRONT_WHEEL › level`.
   - Paths without a selector keep today's label (`topic › $.a.b[0]`).
4. **Full path where paths are shown.** Tooltip, the settings panel's Source
   row and the CSV `path` column show the full path in JSONPath filter syntax:
   `$.status[?(@.name=="BRAKE_SYSTEM/FRONT_WHEEL")].values[?(@.key=="BRAKE_MODE")].value`.

## Non-goals

- No migration: series saved by position keep working as before; re-add one to
  get the by-name form.
- No editing of selectors by hand, and no matching on non-string fields or on
  fields other than `key`/`name`.
- The inspector's *Copy path* keeps the exact (positional) path of that node.

## Constraints

- `segs` stays an array; a selector step is `{ "field": "key", "equals": "BRAKE_MODE" }`.
  `sanitizeSeries` accepts it (field `key` or `name`, `equals` a non-empty
  string); anything else in `segs` is still rejected.
- Two series are the same series when their steps are equal (the existing
  `seriesKey`), so the same name picked twice is one series.
- **Back compatibility:** 0.4.1 and older reject a series with a selector step
  when loading, so such series are left out there (no wrong data). Tab export
  files carry them. CHANGELOG says so.
- Duplicate names inside one later message: the first match is used.

## Approaches considered

- **Selector steps in the path (chosen).** One path form used everywhere: read,
  label, CSV, save, compare.
- *A separate "match by name" note on the series next to the positional path.*
  Two things to keep in sync; every reader needs both.
- *Name in the label only.* Rejected by the user: data gets mixed when the
  order changes.

## Testing (asked for: thorough)

- Unit: choosing selectors from a message (unique, duplicate, non-string,
  nested, no name field), reading values with selectors (moved, missing,
  numeric strings), path text and parse round-trip, labels, `sanitizeSeries`,
  `seriesKey`, CSV path.
- E2E: a diagnostics topic where two nodes alternate and entries change order;
  series added from the picker and from the inspector Tree follow the name;
  legend label; *Chart this field*; CSV path column; saved and reloaded after a
  restart; old positional series still load.
