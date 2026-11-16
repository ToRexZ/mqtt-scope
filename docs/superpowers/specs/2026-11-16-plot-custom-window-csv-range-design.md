# Custom plot time window + CSV range choice

Small change. Requested by a user (San) after using 0.2.0.

## Why

- The plot time window is a fixed list (1 min, 5 min, 15 min, 1 h, All). San wants windows in between, like 1.5 h or 2 h, without having to type units.
- CSV export always writes every collected point. San wants to choose between everything and only the time window.

## Goals

1. **Custom window picker.** The time-window dropdown gets a **Custom…** entry. Choosing it opens a small popover anchored to the dropdown, with two steppers:
   ```
   [  1 ▴▾ ] h   [ 30 ▴▾ ] min      Cancel  Apply
   ```
   - Arrows, the scroll wheel and ↑/↓ change the values; the boxes take digits only.
   - Range is 1 min to 24 h, in whole minutes: hours 0–24, minutes 0–59. Apply is disabled outside that range.
   - The popover opens filled with the current window (1 h 0 min when the window is All).
   - Enter applies. Esc or a click outside cancels, and the dropdown goes back to its previous value.
   - Once applied, the dropdown shows the custom value as its own entry ("1 h 30 min", "2 h", "45 min"), next to the presets and Custom…. A value that equals a preset just selects that preset.
   - It appears in all three places that set a window: the plot header, the settings panel (Time window) and the pop-out plot window.
2. **CSV range choice.** The plot's **CSV** button, and **Export CSV…** in the narrow-plot ⋯ menu, open a menu with two items:
   - **All collected points**: today's behaviour.
   - **Visible range**: only points inside what the plot shows right now (zoom, otherwise the window, ending at the freeze when frozen). With the window set to All and nothing frozen or zoomed, this matches "All".
   - The file name gets `_visible` for the second choice (builder's call).

## Non-goals

- No history kept across sessions; data is still in memory since you connected.
- No new presets; the list stays as it is.
- No seconds-level custom windows.
- No CSV export from the pop-out window, which doesn't have one today.
- No change to which series are exported (all series of the plot, hidden ones included, as today).

## Constraints

- `windowSec` stays in seconds. Valid values: a preset, or a whole number of minutes from 60 to 86400 s. Both `sanitizePlot` (`plotLayouts.js`) and `updatePlot` (`plotModel.js`) must accept custom values. Today both reject anything that isn't a preset.
- **Back compatibility:** 0.2.0 and older read a custom window as 5 min. That's acceptable. Tab export files carry the value.
- **Retention:** each series keeps at most 100k points (about 1 h at 25 Hz). A window longer than the kept data shows what's kept, the same as "All".

## Approaches considered

**Picker**
- **Hours + minutes steppers (chosen).** No units to type, and covers 1.5 h and 2 h directly.
- *Number + unit dropdown.* Allows decimals, but has more parts.
- *More presets only.* Simplest, but you can't pick a value outside the list.
- *Free text ("1.5h").* Rejected: the user doesn't want to type units.

**CSV**
- **Menu on the CSV button (chosen).** The choice is explicit on every export.
- *Per-plot setting in the settings panel.* Rejected: a hidden state that's easy to forget is on.

## Left to the builder

- Shared code: one picker component in `plotCard.js`, used by the header, the settings panel and the pop-out window.
- Pure helpers with unit tests: `isValidWindow`, `windowLabel(sec)`, and points-in-range filtering for CSV.
- E2E: pick a custom window (header + settings), check that it persists and the label is right, and test both CSV menu items.
- README and CHANGELOG lines.
