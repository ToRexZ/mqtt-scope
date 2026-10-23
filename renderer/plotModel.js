// The Plots tab's state: named tabs, their plots and how the plots are
// arranged, the tab on screen and the selected plot. Every rule about them
// lives here, with no DOM, so it runs in Node for tests.
//
// All changes go through the methods below; each one that changes something
// calls onChange() (the panel saves then). Plot, tab and layout objects
// handed out are live: read them, but change them only through these methods.
//
// Saved as toDoc(), one per profile (main/layoutStore.js). A profile from
// before 0.4.0 starts with the files of then, which are only read: the tabs
// (plotTabs) and the 0.1 document (plots); see plotsDocFrom in plotLayouts.js.

import {
  WINDOWS,
  PLOT_KINDS,
  DISPLAYS,
  MAX_SERIES,
  HEX_COLOR,
  PLOTS_DOC_VERSION,
  sourceLabel,
  sanitizePlot,
  newTab,
  plotsDocFrom,
  layoutFile,
  parseLayoutFile,
  syncLayout,
  autoLayout,
  layoutLeaves,
  removeFromLayout,
  moveInLayout,
  withFreshIds,
  isSplitNode,
} from './plotLayouts.js';
import { seriesKey } from './plotMath.js';

const newId = () => Math.random().toString(36).slice(2, 10);
const EDGES = new Set(['left', 'right', 'top', 'bottom', 'center']);

// A plot of nothing but state lanes reads best as state transitions.
export const kindFor = (plot) => (plot.series.length && plot.series.every((s) => s.display === 'state') ? 'states' : 'timeseries');

export class PlotModel {
  // doc: the saved tabs document (any version, or null), legacy: the 0.1
  // document. onChange(): after every change. weightOf(plot): relative
  // height of a plot when plots are arranged automatically.
  constructor(doc = null, { legacy = null, onChange = () => {}, weightOf = () => 1 } = {}) {
    this.onChange = onChange;
    this.weightOf = weightOf;
    this.load(doc, { legacy });
  }

  // Replaces the state with a profile's saved tabs, or for a profile from
  // before 0.4.0 with the plotTabs and plots files (legacy) of then (does not
  // call onChange).
  load(doc, { legacy = null } = {}) {
    const { tabs, activeTabId, newer } = plotsDocFrom(doc, legacy);
    const selected = this.selectedId;
    this.tabs = tabs;
    this.activeTabId = activeTabId;
    // Saved by a newer version: saving from here could lose what it added.
    this.newer = newer;
    for (const t of this.tabs) this.syncTabLayout(t);
    this.selectedId = this.plots.some((p) => p.id === selected) ? selected : (this.plots[0]?.id ?? null);
  }

  // The tabs document to save.
  toDoc() {
    return { version: PLOTS_DOC_VERSION, tabs: this.tabs, activeTabId: this.activeTabId, legacyMirror: this.plots };
  }

  // Keeps a tab's arrangement in step with its plots (new plots are added
  // below, removed ones taken out).
  syncTabLayout(tab) {
    const byId = new Map(tab.plots.map((p) => [p.id, p]));
    const next = syncLayout(tab.layout, tab.plots.map((p) => p.id), tab.columns, (id) => this.weightOf(byId.get(id)));
    if (JSON.stringify(next) !== JSON.stringify(tab.layout)) tab.layout = next;
  }

  changed() {
    for (const t of this.tabs) this.syncTabLayout(t);
    this.onChange();
  }

  // ------------------------------------------------------------ reading

  get tab() {
    return this.tabs.find((t) => t.id === this.activeTabId) || this.tabs[0];
  }

  // Plots of the tab on screen.
  get plots() {
    return this.tab.plots;
  }

  allPlots() {
    return this.tabs.flatMap((t) => t.plots);
  }

  // Every plotted series in every tab (what to collect data for).
  allSeries() {
    return this.allPlots().flatMap((p) => p.series);
  }

  plot(id) {
    return this.allPlots().find((p) => p.id === id) || null;
  }

  tabOf(plotId) {
    return this.tabs.find((t) => t.plots.some((p) => p.id === plotId)) || null;
  }

  get selected() {
    return this.plots.find((p) => p.id === this.selectedId) || null;
  }

  // Selects a plot of the tab on screen. Returns whether the selection changed.
  select(id) {
    if (id === this.selectedId || !this.plots.some((p) => p.id === id)) return false;
    this.selectedId = id;
    return true;
  }

  // The arrangement of the tab on screen (null when it has no plots).
  layout() {
    return this.tab.layout;
  }

  // ------------------------------------------------------------ tabs

  // `base`, or `base (2)`, `base (3)`… when a tab already has that name.
  uniqueName(base, except = null) {
    let name = base;
    for (let n = 2; this.tabs.some((t) => t !== except && t.name === name); n++) name = `${base} (${n})`;
    return name;
  }

  // A suggested name for a new tab: "Plots 2", "Plots 3"…
  nextTabName() {
    let n = this.tabs.length + 1;
    while (this.tabs.some((t) => t.name === `Plots ${n}`)) n++;
    return `Plots ${n}`;
  }

  // Adds a tab at the end and shows it.
  addTab(name) {
    const tab = newTab(this.uniqueName(String(name).trim().slice(0, 80) || this.nextTabName()));
    this.tabs.push(tab);
    this.show(tab.id);
    this.changed();
    return tab;
  }

  // Shows a tab. Returns whether it changed.
  switchTab(id) {
    if (id === this.activeTabId || !this.tabs.some((t) => t.id === id)) return false;
    this.show(id);
    this.changed();
    return true;
  }

  show(id) {
    this.activeTabId = id;
    this.selectedId = this.plots[0]?.id ?? null;
  }

  // Returns the name given (made unique), or null when nothing changed.
  renameTab(id, name) {
    const tab = this.tabs.find((t) => t.id === id);
    const clean = String(name ?? '').trim().slice(0, 80);
    if (!tab || !clean || clean === tab.name) return null;
    tab.name = this.uniqueName(clean, tab);
    this.changed();
    return tab.name;
  }

  // A copy of the tab (new plot ids, same arrangement) right after it, shown.
  duplicateTab(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return null;
    const { plots, layout } = withFreshIds(tab.plots, tab.layout);
    const copy = { ...newTab(this.uniqueName(`${tab.name} copy`), plots), columns: tab.columns, layout };
    this.tabs.splice(this.tabs.indexOf(tab) + 1, 0, copy);
    this.show(copy.id);
    this.changed();
    return copy;
  }

  // Removes a tab; the neighbour is shown when it was on screen. The last
  // tab is replaced by an empty one.
  deleteTab(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return false;
    const wasActive = this.tabs[i].id === this.activeTabId;
    this.tabs.splice(i, 1);
    if (!this.tabs.length) this.tabs.push(newTab());
    if (wasActive || !this.tabs.some((t) => t.id === this.activeTabId)) this.show((this.tabs[i] || this.tabs[i - 1]).id);
    this.changed();
    return true;
  }

  // The tab as a shareable file: { name (suggested file name), text }.
  exportTab(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return null;
    return { name: `${tab.name.replace(/[^\w.-]+/g, '_')}.mqtt-scope-layout.json`, text: layoutFile(tab.name, tab.plots, tab.columns, tab.layout) };
  }

  // Adds a tab from a shared file (new plot ids) and shows it. Throws a
  // readable error for files that are not plot layouts.
  importTab(text, fallbackName = 'Imported') {
    const file = parseLayoutFile(text, fallbackName);
    const { plots, layout } = withFreshIds(file.plots, file.layout);
    const tab = { ...newTab(this.uniqueName(file.name), plots), columns: file.columns, layout };
    this.tabs.push(tab);
    this.show(tab.id);
    this.changed();
    return tab;
  }

  // ------------------------------------------------------------ plots

  // Adds a series ({ topic, segs, alias, display }) to a plot, or to a new
  // plot in the tab on screen when plotId is null (titled after the series,
  // selected, and showing state transitions when the series is a state lane).
  // Returns { plot, series }: series is null when the plot already has it;
  // { plot, full: true } when the plot already has MAX_SERIES series.
  addSeries(plotId, { topic, segs = null, alias = '', display = 'line' }) {
    segs = segs && segs.length ? segs : null;
    alias = String(alias || '').trim();
    let plot = plotId ? this.plot(plotId) : null;
    if (plotId && !plot) return { plot: null, series: null };
    if (plot && plot.series.some((s) => seriesKey(s.topic, s.segs) === seriesKey(topic, segs))) return { plot, series: null };
    if (plot && plot.series.length >= MAX_SERIES) return { plot, series: null, full: true };
    const created = !plot;
    if (created) {
      plot = sanitizePlot({ id: newId(), title: alias || sourceLabel(topic, segs), windowSec: 300, series: [] });
      this.plots.push(plot);
      this.selectedId = plot.id;
    }
    const used = new Set(plot.series.map((s) => s.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const series = { id: newId(), topic, segs, slot, display: DISPLAYS.includes(display) ? display : 'line', width: 2, visible: true };
    if (alias) series.alias = alias.slice(0, 120);
    plot.series.push(series);
    if (created) plot.kind = kindFor(plot);
    this.changed();
    return { plot, series };
  }

  // For a plot created from several series at once: state transitions when
  // every series is a state lane.
  settleKind(plotId) {
    const plot = this.plot(plotId);
    if (!plot || plot.kind === kindFor(plot)) return;
    plot.kind = kindFor(plot);
    this.changed();
  }

  removeSeries(plotId, seriesId) {
    const plot = this.plot(plotId);
    if (!plot || !plot.series.some((s) => s.id === seriesId)) return false;
    plot.series = plot.series.filter((s) => s.id !== seriesId);
    this.changed();
    return true;
  }

  // Removes a plot; the selection moves to its neighbour.
  removePlot(id) {
    const tab = this.tabOf(id);
    if (!tab) return false;
    const i = tab.plots.findIndex((p) => p.id === id);
    tab.plots = tab.plots.filter((p) => p.id !== id);
    tab.layout = removeFromLayout(tab.layout, id);
    if (this.selectedId === id) this.selectedId = (tab.plots[i] || tab.plots[i - 1])?.id ?? null;
    this.changed();
    return true;
  }

  // Changes plot settings; invalid values are ignored. Keys: title, kind,
  // windowSec, legend, legendValues, timeGrid, yMin, yMax (null = automatic).
  updatePlot(id, patch) {
    const plot = this.plot(id);
    if (!plot) return false;
    let changed = false;
    const set = (key, value) => {
      if (plot[key] === value) return;
      plot[key] = value;
      changed = true;
    };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'title' && typeof value === 'string' && value.trim()) set('title', value.trim().slice(0, 120));
      else if (key === 'kind' && PLOT_KINDS.includes(value)) set('kind', value);
      else if (key === 'windowSec' && WINDOWS.includes(value)) set('windowSec', value);
      else if ((key === 'legend' || key === 'legendValues' || key === 'timeGrid') && typeof value === 'boolean') set(key, value);
      else if ((key === 'yMin' || key === 'yMax') && (value === null || (typeof value === 'number' && Number.isFinite(value)))) set(key, value);
    }
    if (changed) this.changed();
    return changed;
  }

  // Changes series settings; invalid values are ignored. Keys: alias ('' to
  // use the topic), color (#rrggbb, null for the palette colour), slot
  // (palette colour; clears color), display, width (1–6), visible.
  updateSeries(plotId, seriesId, patch) {
    const s = this.plot(plotId)?.series.find((x) => x.id === seriesId);
    if (!s) return false;
    const before = JSON.stringify(s);
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'alias' && typeof value === 'string') {
        if (value.trim()) s.alias = value.trim().slice(0, 120);
        else delete s.alias;
      } else if (key === 'color' && value === null) delete s.color;
      else if (key === 'color' && typeof value === 'string' && HEX_COLOR.test(value)) s.color = value.toLowerCase();
      else if (key === 'slot' && Number.isInteger(value) && value >= 0 && value < MAX_SERIES) {
        s.slot = value;
        delete s.color;
      } else if (key === 'display' && DISPLAYS.includes(value)) s.display = value;
      else if (key === 'width' && Number.isInteger(value) && value >= 1 && value <= 6) s.width = value;
      else if (key === 'visible' && typeof value === 'boolean') s.visible = value;
    }
    const changed = JSON.stringify(s) !== before;
    if (changed) this.changed();
    return changed;
  }

  // Puts plot `id` next to plot `targetId` in the tab on screen: an edge
  // ('left' | 'right' | 'top' | 'bottom') splits the target's space, 'center'
  // swaps the two. The plot list follows the on-screen order.
  movePlot(id, targetId, edge) {
    if (!EDGES.has(edge) || id === targetId) return false;
    const tab = this.tab;
    if (!tab.plots.some((p) => p.id === id) || !tab.plots.some((p) => p.id === targetId)) return false;
    tab.layout = moveInLayout(tab.layout, id, targetId, edge);
    const order = layoutLeaves(tab.layout);
    tab.plots = order.map((pid) => tab.plots.find((p) => p.id === pid));
    this.changed();
    return true;
  }

  // Moves a plot to the end of another tab.
  movePlotToTab(id, tabId) {
    const from = this.tabOf(id);
    const to = this.tabs.find((t) => t.id === tabId);
    if (!from || !to || from === to) return false;
    const plot = from.plots.find((p) => p.id === id);
    from.plots = from.plots.filter((p) => p.id !== id);
    from.layout = removeFromLayout(from.layout, id);
    to.plots.push(plot);
    if (this.selectedId === id) this.selectedId = this.plots[0]?.id ?? null;
    this.changed();
    return true;
  }

  // Lays the tab's plots out again in rows: 0 = automatic, else n per row.
  arrange(columns) {
    const tab = this.tab;
    tab.columns = Number.isInteger(columns) && columns >= 0 && columns <= 4 ? columns : 0;
    const byId = new Map(tab.plots.map((p) => [p.id, p]));
    tab.layout = autoLayout(tab.plots.map((p) => p.id), tab.columns, (id) => this.weightOf(byId.get(id)));
    this.changed();
  }

  // New sizes for a split of the arrangement on screen (one positive number
  // per child). Returns whether they were applied.
  setSplitSizes(split, sizes) {
    if (!isSplitNode(split) || !containsNode(this.tab.layout, split)) return false;
    if (!Array.isArray(sizes) || sizes.length !== split.children.length || !sizes.every((x) => Number.isFinite(x) && x > 0)) return false;
    if (sizes.every((x, i) => x === split.sizes[i])) return false;
    split.sizes = sizes.slice();
    this.changed();
    return true;
  }
}

function containsNode(tree, node) {
  if (tree === node) return true;
  return isSplitNode(tree) && tree.children.some((c) => containsNode(c, node));
}
