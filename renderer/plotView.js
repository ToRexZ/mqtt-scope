// How plots are presented, independent of any DOM: series labels, what the
// chart is given, the time range shown, legend text, default display styles
// and the sizes plots need. Shared by the Plots tab and pop-out plot windows.

import { decode, formatDateTime } from './payload.js';
import { getAt } from './jsonPath.js';
import { windowRange, nearest, isBinary, pointAtOrBefore } from './plotMath.js';
import { MAX_SERIES, sourceLabel } from './plotLayouts.js';

export { sourceLabel };

export const WINDOW_LABELS = { 60: '1 min', 300: '5 min', 900: '15 min', 3600: '1 h', 0: 'All' };
export const KIND_LABELS = { timeseries: 'Time series', states: 'State transitions' };
export const DISPLAY_LABELS = [
  ['line', 'Line'],
  ['points', 'Line and points'],
  ['step', 'Steps'],
  ['state', 'State lane'],
];

// The CSS variable holding palette colour `slot`, and a series' colour as a
// CSS value (its own colour, else its palette colour).
export const paletteVar = (slot) => `--series-${((slot ?? 0) % MAX_SERIES) + 1}`;
export const seriesCss = (s) => s.color || `var(${paletteVar(s.slot)})`;

// Plots can be resized down to these sizes; below that the plots area scrolls.
export const MIN_PLOT_WIDTH = 220;
export const MIN_PLOT_HEIGHT = 130;

// A series shows its alias when it has one, else where its data comes from.
export const labelOf = (series) => series.alias || sourceLabel(series.topic, series.segs);

// A boolean value is shown as a state lane, anything else as a line.
export function defaultDisplay(message, segs) {
  if (!message) return 'line';
  const d = decode(message);
  const v = segs && segs.length ? (d.kind === 'json' ? getAt(d.value, segs) : undefined) : d.value;
  return typeof v === 'boolean' ? 'state' : 'line';
}

const visibleSeries = (plot) => plot.series.filter((s) => s.visible);
const laneCount = (plot) => (plot.kind === 'states' ? visibleSeries(plot).length : visibleSeries(plot).filter((s) => s.display === 'state').length);
// State transitions plots label their lanes instead of having a legend.
export const showsLegend = (plot) => plot.legend && plot.kind !== 'states';

// Height below which a plot's lanes would overlap: header, padding and time
// axis plus ~16 px per lane (labels then sit inside the bars).
export function minPlotHeight(plot) {
  return Math.max(MIN_PLOT_HEIGHT, (plot.kind === 'states' ? 84 : 108) + (showsLegend(plot) ? 22 : 0) + laneCount(plot) * 16);
}

// Relative height a plot gets when placed automatically: lanes need room.
export function layoutWeight(plot) {
  if (!plot) return 1;
  return (plot.kind === 'states' ? 60 : 220) + Math.max(plot.kind === 'states' ? 1 : 0, laneCount(plot)) * 34;
}

// The chart's input for a plot: its visible series with their points.
export function chartSeries(plot, pointsOf) {
  return visibleSeries(plot).map((s) => ({
    label: labelOf(s),
    slot: s.slot,
    color: s.color,
    display: s.display,
    width: s.width,
    points: pointsOf(s.topic, s.segs),
  }));
}

// Time range shown: a zoomed range, else the plot's time window ending now
// (or when frozen). The window "All" shows the data extent (null), or while
// frozen everything up to the freeze.
export function chartRange(plot, series, { zoom = null, frozenAt = null, now = Date.now() } = {}) {
  if (zoom) return { t0: zoom.t0, t1: zoom.t1 };
  if (plot.windowSec) return windowRange(series, plot.windowSec, frozenAt || now);
  if (!frozenAt) return null;
  const first = Math.min(...series.map((s) => (s.points.length ? s.points[0].t : Infinity)));
  return Number.isFinite(first) && first < frozenAt ? { t0: first, t1: frozenAt } : null;
}

// Axis settings for the chart: a value zoom wins over the plot's fixed range.
export function chartAxis(plot, yZoom = null) {
  return { yMin: yZoom ? yZoom.yMin : plot.yMin, yMax: yZoom ? yZoom.yMax : plot.yMax, kind: plot.kind, timeGrid: plot.timeGrid !== false };
}

// Legend value of a series, as { text, title }: the point nearest the
// hovered time, else the last one at the freeze, else the latest. State
// series of true/false values read "true"/"false".
export function legendValue(plot, series, points, { hoverTime = null, frozenAt = null } = {}) {
  let p = hoverTime !== null ? nearest(points, hoverTime) : frozenAt ? pointAtOrBefore(points, frozenAt) : points[points.length - 1];
  if (p && frozenAt && p.t > frozenAt) p = pointAtOrBefore(points, frozenAt); // nothing newer than the freeze
  if (!p) return { text: '–', title: 'No data yet' };
  const asState = (plot.kind === 'states' || series.display === 'state') && isBinary(points);
  return { text: asState ? String(p.v === 1) : String(Number(p.v.toPrecision(6))), title: formatDateTime(p.t) };
}
