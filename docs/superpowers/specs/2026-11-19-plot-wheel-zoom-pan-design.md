# Plot zoom with the wheel, pan by dragging

Requested by the maintainer (19 Nov): "zoom the timeline in plots, and also pan
by clicking and dragging … zoom with the scrollwheel, horizontal scroll with the
horizontal scroll wheel, … left click and dragging as panning, and right
clicking as box zooming, but make that bindable in the keybinds section in
settings."

## Why

Today the only way to zoom is to drag a box, and the only way back is Reset
view; there is no way to move along the timeline or zoom out a little. Wheel
zoom and drag-to-pan are what people expect from plotting tools (Lichtblick,
Grafana, PlotJuggler).

## Goals

1. **Wheel zooms the timeline** around the pointer: wheel up/away zooms in,
   down/towards zooms out, in steps (about 20% per notch; a trackpad's small
   steps zoom smoothly). All plots of the tab follow, as the box zoom does now.
2. **Horizontal wheel pans the timeline** (a mouse's side wheel or a trackpad's
   sideways swipe). Shift + wheel pans as well, for mice without one.
3. **Left drag pans**: the timeline (all plots of the tab) and, when that plot
   has a value zoom, its value range too.
4. **Right drag box-zooms**: today's drag box (time, or time and values when
   started in the value area) moves to the right button. A right click without
   dragging does nothing (no menu on plots today).
5. **Bindable** in Settings → Keyboard, in a new "Plot mouse" group:
   - *Pan*: Left drag (default), Right drag, Middle drag, Shift + left drag,
     Ctrl + left drag.
   - *Box zoom*: Right drag (default), same choices.
   - The two can't share a binding (the settings page says so, like key
     conflicts); Reset all restores both.
6. **Leaving live**: zooming or panning a live plot fixes its time range (like a
   box zoom does now); **Reset view**, double-click and Esc go back to live, as
   today. While frozen, zoom/pan works within what was collected.
7. **Limits**: zoom in to 10 ms wide at most; zoom out stops at the data
   collected (the "All" range); panning stops at the first point and at now.
8. Same behaviour in the pop-out plot window (its own zoom, as today).

## Non-goals

- No wheel zoom of the value axis (a value zoom still comes from the box).
- No touch gestures (pinch) beyond what the trackpad sends as wheel events.
- No keyboard zoom/pan keys.

## Constraints

- The wheel must not scroll the plots area while over a plot's chart; it still
  scrolls the plots area over headers, legends and gaps.
- Mouse bindings live in settings next to key bindings and sync between windows
  the same way.
- Existing tests that box-zoom with a left drag switch to the right button.

## Approaches considered

- **Zoom/pan through the existing zoom range (chosen).** A wheel step or a drag
  sets the same `{ t0, t1 }` time zoom the box sets today, so Reset view, the
  zoom shared by the tab's plots and the pop-out window all keep working.
- *A separate pan offset next to the zoom.* Two states to reset and sync.

## Testing

- Unit: zoom-around-pointer and pan maths (steps, limits, minimum width), mouse
  binding settings (defaults, validation, conflicts).
- E2E (wheel events sent to the canvas; headless Chromium doesn't deliver real
  cancelable wheel events): wheel in/out around the pointer, horizontal pan,
  left-drag pan, right-drag box zoom, Reset view back to live, all plots follow,
  pop-out window, swapped bindings in settings take effect and persist.
- Checked once by hand in a real window: wheel and drags with a real mouse.
