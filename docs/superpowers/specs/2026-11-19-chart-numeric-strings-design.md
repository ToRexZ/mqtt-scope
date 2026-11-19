# Chart numbers written as text

Small change. Requested by a user (San, 13 Nov): "I samme topic er der værdier
string, og kan derfor ikke bruge chart this field … Men de virker på plot."

## Why

ROS diagnostics send every value as text (`"value": "21.5"`). Plots already
read such text as a number, but the inspector Tree's right-click menu only
offers *Chart this field* and *Add to plot* for real JSON numbers and
true/false, so those values can only be plotted through the picker.

## Goals

- In the inspector Tree, a value that plots can read is chartable: a number,
  true/false, or text that is a plain decimal number (`"21.5"`, `" -3 "`,
  `"1e3"`), the same rule the plot picker uses (`isDecimal`).
- For those values the menu enables *Chart this field (kept history)* and shows
  *Add to new plot* / *Add to plot "…"*, as for numbers today.
- Text that isn't a number (`"OK"`, `"0x10"`, `"NaN"`, `""`) stays disabled.

## Non-goals

- No change to which values plots accept.
- No charting of text states (e.g. `"OK"`/`"WARN"`) as lanes.

## Approaches considered

- **Use the plots' rule in the Tree menu (chosen).** One rule for "can be
  plotted" everywhere.
- *A separate, looser rule for the menu.* Would offer values the chart then
  can't draw.

## Testing

- E2E: a diagnostics message with `"value": "21.5"` → *Chart this field* enabled
  and charts the kept history; *Add to new plot* plots it. `"OK"` → disabled,
  no plot items. Existing "strings cannot be charted" check keeps passing for
  non-numeric text.
