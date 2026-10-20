// Pieces of a plot card shared by the Plots tab and pop-out plot windows:
// the legend, the Lines/States toggle, the time-window menu and the
// "Reset view" button.

import { el, button } from './ui.js';
import { icon } from './icons.js';
import { WINDOWS } from './plotLayouts.js';
import { seriesKey } from './plotMath.js';
import { WINDOW_LABELS, labelOf, sourceLabel, seriesCss, paletteVar, showsLegend, legendValue } from './plotView.js';

// A series' colour as #rrggbb (its own, else its palette colour).
export function resolvedColor(series) {
  return series.color || getComputedStyle(document.documentElement).getPropertyValue(paletteVar(series.slot)).trim();
}

// The legend: one chip per series (hidden series greyed out). With actions,
// the swatch toggles visibility, the label can be renamed and the series
// removed: actions = { onToggle(series), onRename(series), onRemove(series) }.
export function renderLegend(plot, actions = null) {
  const legend = el('div', 'plot-legend');
  legend.hidden = !showsLegend(plot);
  for (const s of plot.series) {
    const chip = el('span', 'legend-chip' + (s.visible ? '' : ' off'));
    chip.dataset.key = seriesKey(s.topic, s.segs);
    const sw = actions ? button('', s.visible ? 'Hide this series' : 'Show this series', () => actions.onToggle(s), 'swatch swatch-toggle') : el('span', 'swatch');
    sw.style.background = seriesCss(s);
    const label = el('span', 'legend-label' + (s.alias ? ' aliased' : ''), labelOf(s));
    label.title = sourceLabel(s.topic, s.segs) + (actions ? `\nDouble-click to ${s.alias ? 'change the' : 'set an'} alias` : '');
    if (actions) label.addEventListener('dblclick', () => actions.onRename(s));
    const value = el('span', 'legend-value');
    value.hidden = !plot.legendValues;
    chip.append(sw, label, value);
    if (actions) chip.append(button('✎', 'Set alias', () => actions.onRename(s), 'chip-edit'), button('×', 'Remove series', () => actions.onRemove(s), 'chip-x'));
    legend.append(chip);
  }
  return legend;
}

// Writes the legend's values: at the hovered time, else at the freeze, else
// the latest.
export function updateLegend(legend, plot, pointsOf, { hoverTime = null, frozenAt = null } = {}) {
  for (const chip of legend.querySelectorAll('.legend-chip')) {
    const s = plot.series.find((x) => seriesKey(x.topic, x.segs) === chip.dataset.key);
    const span = chip.querySelector('.legend-value');
    if (!s || !span) continue;
    const { text, title } = legendValue(plot, s, pointsOf(s.topic, s.segs), { hoverTime, frozenAt });
    span.textContent = text;
    span.title = title;
    span.classList.toggle('at-hover', hoverTime !== null);
  }
}

// The Lines / States switch. onKind(kind) is called with the chosen type.
export function kindToggle(plot, onKind) {
  const box = el('div', 'seg kind-toggle');
  for (const [kind, label, tip] of [
    ['timeseries', 'Lines', 'Values as lines on a y-axis'],
    ['states', 'States', 'Every series as state transitions'],
  ]) {
    const b = button(label, tip, () => onKind(kind), 'seg-btn' + (plot.kind === kind ? ' on' : ''));
    b.dataset.kind = kind;
    box.append(b);
  }
  return box;
}

// "Reset view", shown on a plot while it is zoomed (place it in the plot's
// canvas area; it starts hidden). onReset() goes back to the live view.
export function resetViewButton(onReset) {
  const b = button('', 'Back to the live view (or double-click the plot, or Esc)', onReset, 'btn small reset-view');
  b.append(icon('zoom-out'), document.createTextNode(' Reset view'));
  b.hidden = true;
  return b;
}

// The time-window menu. onWindow(seconds) is called with the choice.
export function windowSelect(plot, onWindow) {
  const select = el('select', 'select small window-select');
  select.title = 'Time window';
  for (const sec of WINDOWS) select.append(Object.assign(el('option', '', WINDOW_LABELS[sec]), { value: String(sec), selected: sec === plot.windowSec }));
  select.addEventListener('change', () => onWindow(Number(select.value)));
  return select;
}
