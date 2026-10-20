// Plot definitions, plot tabs and their layout: validation, defaults,
// migration of older saved data, the split layout and the file format used
// to share a tab's plots. Pure (no DOM).

import { pathFromSegments } from './jsonPath.js';

export const LAYOUT_FORMAT = 'mqtt-scope-plot-layout';
export const WINDOWS = [60, 300, 900, 3600, 0];
// 'timeseries': numbers on a y-axis (state series as bars below);
// 'states': every series as a full-width state-transition lane.
export const PLOT_KINDS = ['timeseries', 'states'];
export const MAX_COLUMNS = 4;
export const DISPLAYS = ['line', 'points', 'step', 'state'];
export const MAX_SERIES = 8; // series per plot (one per palette colour)
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const DISPLAY_SET = new Set(DISPLAYS);

// The saved plots document this version writes (see plotsDocFrom).
export const PLOTS_DOC_VERSION = 2;

const newId = () => Math.random().toString(36).slice(2, 10);

// Where a series' data comes from: the topic, plus the JSON path if any.
export const sourceLabel = (topic, segs) => (segs && segs.length ? `${topic} › ${pathFromSegments(segs)}` : topic);
const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A series with every field present and valid; null when unusable.
export function sanitizeSeries(s, slotFallback = 0) {
  if (!s || typeof s !== 'object' || typeof s.topic !== 'string' || !s.topic) return null;
  const segs = Array.isArray(s.segs) && s.segs.length ? s.segs.filter((x) => typeof x === 'string' || (Number.isInteger(x) && x >= 0)) : null;
  if (Array.isArray(s.segs) && segs && segs.length !== s.segs.length) return null;
  const out = {
    id: typeof s.id === 'string' && s.id ? s.id : newId(),
    topic: s.topic,
    segs: segs && segs.length ? segs : null,
    slot: Number.isInteger(s.slot) && s.slot >= 0 ? s.slot % MAX_SERIES : slotFallback % MAX_SERIES,
    display: DISPLAY_SET.has(s.display) ? s.display : 'line',
    width: Number.isInteger(s.width) && s.width >= 1 && s.width <= 6 ? s.width : 2,
    visible: s.visible !== false,
  };
  if (typeof s.alias === 'string' && s.alias.trim()) out.alias = s.alias.trim().slice(0, 120);
  if (typeof s.color === 'string' && HEX_COLOR.test(s.color)) out.color = s.color.toLowerCase();
  return out;
}

export function sanitizePlot(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.series)) return null;
  const series = p.series
    .map((s, i) => sanitizeSeries(s, i))
    .filter(Boolean)
    .slice(0, MAX_SERIES);
  return {
    id: typeof p.id === 'string' && p.id ? p.id : newId(),
    title: typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 120) : series[0]?.topic || 'Plot',
    kind: PLOT_KINDS.includes(p.kind) ? p.kind : 'timeseries',
    windowSec: WINDOWS.includes(p.windowSec) ? p.windowSec : 300,
    legend: p.legend !== false,
    legendValues: p.legendValues !== false,
    // Vertical lines at the time axis' timestamps (as in Lichtblick).
    timeGrid: p.timeGrid !== false,
    yMin: finiteOrNull(p.yMin),
    yMax: finiteOrNull(p.yMax),
    series,
  };
}

export const sanitizePlots = (list) => (Array.isArray(list) ? list.map(sanitizePlot).filter(Boolean) : []);

export function sanitizeLayouts(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((l) => l && typeof l === 'object' && typeof l.name === 'string' && l.name.trim())
    .map((l) => ({ id: typeof l.id === 'string' && l.id ? l.id : newId(), name: l.name.trim().slice(0, 80), plots: sanitizePlots(l.plots) }));
}

// Deep copy with fresh ids, so a loaded layout never shares objects with
// the saved one.
export function clonePlots(plots) {
  return sanitizePlots(JSON.parse(JSON.stringify(plots)));
}

// Whether two plot lists describe the same plots (ids ignored).
export function samePlots(a, b) {
  const strip = (list) => JSON.stringify(sanitizePlots(list).map(({ id, series, ...p }) => ({ ...p, series: series.map(({ id: _id, ...s }) => s) })));
  return strip(a) === strip(b);
}

export function layoutFile(name, plots, columns = 0, layout = null) {
  const clean = sanitizePlots(plots);
  return JSON.stringify(
    { format: LAYOUT_FORMAT, version: 1, name, columns: sanitizeColumns(columns), layout: sanitizeLayoutTree(layout, clean.map((p) => p.id)), plots: clean },
    null,
    2,
  );
}

// Parses a shared layout file; throws with a readable message when invalid.
export function parseLayoutFile(text, fallbackName = 'Imported layout') {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('Not a JSON file');
  }
  if (!doc || doc.format !== LAYOUT_FORMAT) throw new Error('Not an MQTT Scope plot layout');
  if (doc.version !== 1) throw new Error(`Unsupported layout version ${doc.version}`);
  const plots = sanitizePlots(doc.plots);
  if (!plots.length) throw new Error('The layout has no plots');
  const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim().slice(0, 80) : fallbackName;
  return { name, plots, columns: sanitizeColumns(doc.columns), layout: sanitizeLayoutTree(doc.layout, plots.map((p) => p.id)) };
}

// A copy of plots (and their layout) with new ids, so it never shares
// selection or zoom with the original.
export function withFreshIds(plots, layout = null) {
  const ids = new Map();
  const copy = clonePlots(plots).map((p) => {
    const id = newId();
    ids.set(p.id, id);
    return { ...p, id };
  });
  const remap = (n) => (typeof n === 'string' ? ids.get(n) ?? null : isSplit(n) ? { ...n, children: n.children.map(remap) } : null);
  return { plots: copy, layout: sanitizeLayoutTree(remap(layout), copy.map((p) => p.id)) };
}

// ------------------------------------------------------------------ tabs

// 0 means automatic (see autoColumns).
const sanitizeColumns = (c) => (Number.isInteger(c) && c >= 0 && c <= MAX_COLUMNS ? c : 0);

// `layout` arranges the tab's plots (see "split layout" below); null means
// not arranged yet, and the plots are placed automatically.
export function newTab(name = 'Plots', plots = []) {
  return { id: newId(), name, columns: 0, layout: null, plots };
}

export function sanitizeTab(t, fallbackName = 'Plots') {
  if (!t || typeof t !== 'object') return null;
  const plots = sanitizePlots(t.plots);
  return {
    id: typeof t.id === 'string' && t.id ? t.id : newId(),
    name: typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 80) : fallbackName,
    columns: sanitizeColumns(t.columns),
    layout: sanitizeLayoutTree(t.layout, plots.map((p) => p.id)),
    plots,
  };
}

// The saved plots document as { tabs, activeTabId, newer }. Older versions
// kept one working set of plots plus named layouts; each of those becomes a
// tab. Plot ids are made unique across tabs: older versions shared them
// between a layout and the plots taken from it. `newer` is set when the
// document was written by a newer version than this one.
export function migratePlotsDoc(doc) {
  let tabs;
  let activeTabId = null;
  if (doc && Array.isArray(doc.tabs)) {
    tabs = doc.tabs.map((t, i) => sanitizeTab(t, `Plots ${i + 1}`)).filter(Boolean);
    activeTabId = doc.activeTabId;
  } else {
    const plots = sanitizePlots(doc?.plots);
    const layouts = sanitizeLayouts(doc?.layouts);
    const active = layouts.find((l) => l.id === doc?.activeLayoutId) || null;
    tabs = [];
    if (plots.length || !layouts.length) tabs.push(newTab(active?.name || 'Plots', plots));
    if (active && plots.length && !samePlots(active.plots, plots)) tabs.push(newTab(`${active.name} (saved)`, active.plots));
    for (const l of layouts) if (l !== active || !plots.length) tabs.push(newTab(l.name, l.plots));
  }
  tabs = uniquePlotIds(tabs);
  if (!tabs.length) tabs.push(newTab());
  if (!tabs.some((t) => t.id === activeTabId)) activeTabId = tabs[0].id;
  return { tabs, activeTabId, newer: Number.isInteger(doc?.version) && doc.version > PLOTS_DOC_VERSION };
}

// Gives the plots of a tab new ids when any of them is already used (by an
// earlier tab or within the tab).
function uniquePlotIds(tabs) {
  const seen = new Set();
  return tabs.map((t) => {
    const ids = t.plots.map((p) => p.id);
    const clash = ids.some((id, i) => seen.has(id) || ids.indexOf(id) !== i);
    const tab = clash ? { ...t, ...withFreshIds(t.plots, t.layout) } : t;
    for (const p of tab.plots) seen.add(p.id);
    return tab;
  });
}

// The plots to show, from the two saved documents:
//   tabsDoc    the tabs ("plotTabs"), written by this version
//   legacyDoc  the 0.1 document ("plots"), which this version keeps as a
//              copy of the tab on screen so older versions still find it
// When an older version has changed the 0.1 document since this version last
// wrote it, its plots are kept as an extra tab instead of being lost. This
// version marks the 0.1 document it writes (writtenBy); older versions drop
// the mark when they save, so a marked document is never taken for theirs,
// even when it and the tabs were saved at different moments.
export function plotsDocFrom(tabsDoc, legacyDoc) {
  if (!tabsDoc) return migratePlotsDoc(legacyDoc);
  const doc = migratePlotsDoc(tabsDoc);
  const older = legacyDoc && legacyDoc.writtenBy === undefined ? sanitizePlots(legacyDoc.plots) : [];
  if (older.length && !samePlots(older, sanitizePlots(tabsDoc.legacyMirror))) {
    let name = 'Plots (older version)';
    for (let n = 2; doc.tabs.some((t) => t.name === name); n++) name = `Plots (older version ${n})`;
    doc.tabs.push(newTab(name, withFreshIds(older).plots));
  }
  return doc;
}

// ------------------------------------------------------------------ grid

// Plots fill the tab in a grid: stacked full-width rows for a few plots
// (time series read best wide), then two or three columns.
export const autoColumns = (n) => (n <= 3 ? 1 : n <= 8 ? 2 : 3);

export function gridShape(n, columns = 0) {
  if (n <= 0) return { cols: 1, rows: 0 };
  const cols = Math.max(1, Math.min(columns || autoColumns(n), n));
  return { cols, rows: Math.ceil(n / cols) };
}

// Weights for `count` tracks: the saved ones when they fit, else equal.
export function normalizeWeights(weights, count) {
  if (!Array.isArray(weights) || weights.length !== count || !weights.every((w) => Number.isFinite(w) && w > 0)) return Array(count).fill(1);
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (w * count) / sum);
}

// Moves the boundary after track `i` by `delta` px. `sizes` are the tracks'
// current pixel sizes; the two neighbours keep at least `min` px (a number,
// or [before, after] for different minimums).
export function resizeWeights(weights, sizes, i, delta, min) {
  const out = weights.slice();
  const total = sizes[i] + sizes[i + 1];
  if (!(total > 0) || i < 0 || i + 1 >= weights.length) return out;
  let [minA, minB] = Array.isArray(min) ? min : [min, min];
  if (minA + minB > total) {
    // Not enough room for both minimums: share what there is in proportion.
    const k = total / (minA + minB);
    minA *= k;
    minB *= k;
  }
  const a = Math.max(minA, Math.min(total - minB, sizes[i] + delta));
  const pair = weights[i] + weights[i + 1];
  out[i] = (pair * a) / total;
  out[i + 1] = pair - out[i];
  return out;
}

// ------------------------------------------------------------------ split layout
//
// Like Lichtblick's panel layout: a tree whose leaves are plot ids and whose
// inner nodes split their space between children, side by side ('row') or
// stacked ('col'), in proportion to `sizes`.
//
//   'p1'                                               one plot
//   { dir: 'col', children: ['p1', 'p2'], sizes: [2, 1] }  p1 above p2, twice as tall

const DIRS = new Set(['row', 'col']);
const isSplit = (n) => !!n && typeof n === 'object' && DIRS.has(n.dir) && Array.isArray(n.children);
export const isSplitNode = isSplit;

export function layoutLeaves(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (isSplit(node)) for (const c of node.children) layoutLeaves(c, out);
  return out;
}

// Keeps only known plot ids (each once), drops empty splits, lifts a split's
// only child, merges a split into a parent of the same direction, and repairs
// sizes. Returns null when nothing is left.
export function sanitizeLayoutTree(node, ids) {
  const known = new Set(ids);
  const seen = new Set();
  const clean = (n, depth) => {
    if (typeof n === 'string') {
      if (!known.has(n) || seen.has(n)) return null;
      seen.add(n);
      return n;
    }
    if (!isSplit(n) || depth > 32) return null;
    const children = [];
    const sizes = [];
    n.children.forEach((c, i) => {
      const cc = clean(c, depth + 1);
      if (cc === null) return;
      const size = Number.isFinite(n.sizes?.[i]) && n.sizes[i] > 0 ? n.sizes[i] : 1;
      if (isSplit(cc) && cc.dir === n.dir) {
        // Same direction: its children become ours, sharing its size.
        const total = cc.sizes.reduce((a, b) => a + b, 0);
        cc.children.forEach((g, j) => {
          children.push(g);
          sizes.push((size * cc.sizes[j]) / total);
        });
      } else {
        children.push(cc);
        sizes.push(size);
      }
    });
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    return { dir: n.dir, children, sizes };
  };
  return clean(node, 0);
}

// The automatic arrangement: rows of `columns` plots (see gridShape), stacked.
// weightOf(id) gives a plot's relative height (e.g. more for many lanes).
export function autoLayout(ids, columns = 0, weightOf = () => 1) {
  if (!ids.length) return null;
  if (ids.length === 1) return ids[0];
  const { cols } = gridShape(ids.length, columns);
  const rows = [];
  for (let i = 0; i < ids.length; i += cols) rows.push(ids.slice(i, i + cols));
  const rowNodes = rows.map((r) => (r.length === 1 ? r[0] : { dir: 'row', children: r, sizes: r.map(() => 1) }));
  if (rowNodes.length === 1) return rowNodes[0];
  return { dir: 'col', children: rowNodes, sizes: rows.map((r) => Math.max(...r.map((id) => weightOf(id)))) };
}

// The tab's layout with exactly these plots: unknown ones removed, new ones
// added below the rest, sized by weightOf (relative to their neighbours).
export function syncLayout(tree, ids, columns = 0, weightOf = () => 1) {
  let t = sanitizeLayoutTree(tree, ids);
  if (!t) return autoLayout(ids, columns, weightOf);
  // The weight of a subtree: stacked heights add up, side by side the tallest counts.
  const weight = (n) => (typeof n === 'string' ? weightOf(n) : n.dir === 'col' ? n.children.reduce((a, c) => a + weight(c), 0) : Math.max(...n.children.map(weight)));
  const present = new Set(layoutLeaves(t));
  for (const id of ids) {
    if (present.has(id)) continue;
    if (isSplit(t) && t.dir === 'col') {
      // Keep the scale of the existing sizes (they may have been resized).
      const scale = t.sizes.reduce((a, b) => a + b, 0) / t.children.reduce((a, c) => a + weight(c), 0);
      t = { ...t, children: [...t.children, id], sizes: [...t.sizes, weightOf(id) * scale] };
    } else {
      t = { dir: 'col', children: [t, id], sizes: [weight(t), weightOf(id)] };
    }
  }
  return t;
}

export function removeFromLayout(tree, id) {
  return sanitizeLayoutTree(tree, layoutLeaves(tree).filter((x) => x !== id));
}

// Moves plot `id` next to plot `target`: 'left' | 'right' | 'top' | 'bottom'
// splits the target's space; 'center' swaps the two plots.
export function moveInLayout(tree, id, target, edge) {
  const leaves = layoutLeaves(tree);
  if (id === target || !leaves.includes(id) || !leaves.includes(target)) return tree;
  if (edge === 'center') {
    const swap = (n) => (typeof n === 'string' ? (n === id ? target : n === target ? id : n) : { ...n, children: n.children.map(swap) });
    return swap(tree);
  }
  const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const before = edge === 'left' || edge === 'top';
  const place = (n) => {
    if (n === target) return { dir, children: before ? [id, n] : [n, id], sizes: [1, 1] };
    if (typeof n === 'string') return n;
    const i = n.children.indexOf(target);
    if (i >= 0 && n.dir === dir) {
      // Same direction: become the target's sibling and share its size.
      const children = n.children.slice();
      const sizes = n.sizes.slice();
      const half = sizes[i] / 2;
      sizes[i] = half;
      children.splice(before ? i : i + 1, 0, id);
      sizes.splice(before ? i : i + 1, 0, half);
      return { ...n, children, sizes };
    }
    return { ...n, children: n.children.map(place) };
  };
  return sanitizeLayoutTree(place(removeFromLayout(tree, id)), leaves);
}
