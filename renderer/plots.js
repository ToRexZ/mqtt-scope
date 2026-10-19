// Plots tab: live charts of numeric topics or JSON fields. Plot definitions
// are persisted; the data points are collected while the app runs.

import { el, button, toast, promptText } from './ui.js';
import { extractNumber, formatDateTime } from './payload.js';
import { LineChart, MAX_SERIES } from './chart.js';
import { seriesKey, windowRange } from './plotMath.js';
import { openPlotPicker, sourceLabel } from './plotPicker.js';

const MAX_POINTS = 100000; // per series: 1 h at ~25 Hz
const WINDOWS = [
  [60, '1 min'],
  [300, '5 min'],
  [900, '15 min'],
  [3600, '1 h'],
  [0, 'All'],
];

// A series shows its alias when it has one, else where its data comes from.
const labelOf = (s) => s.alias || sourceLabel(s.topic, s.segs);
const newId = () => Math.random().toString(36).slice(2, 10);

export class PlotsPanel {
  // opts: api, getHistory(topic) -> messages[], getTopicNodes() -> iterable of topic nodes,
  //       onCountChange(n), onAdded()
  constructor(host, opts) {
    this.opts = opts;
    this.api = opts.api;
    this.plots = [];
    this.data = new Map(); // seriesKey -> points[]
    this.byTopic = new Map(); // topic -> Set of series keys
    this.charts = new Map(); // plot id -> LineChart
    this.frozenAt = null;
    this.visible = false;

    this.root = el('div', 'plots');
    const bar = el('div', 'plots-toolbar');
    this.freezeBtn = button('Freeze', 'Stop the time axis so you can inspect', () => this.toggleFreeze());
    bar.append(
      button('+ New plot', 'Pick topics and values to plot', () => this.openPicker()),
      this.freezeBtn,
      el('span', 'muted small', 'Or right-click a numeric topic or JSON value and choose “Add to plot”. Double-click a legend label to give it an alias.'),
    );
    this.grid = el('div', 'plots-grid');
    this.root.append(bar, this.grid);
    host.append(this.root);
    setInterval(() => this.visible && !this.frozenAt && this.redraw(), 500);
  }

  async load() {
    try {
      const doc = await this.api.storeGet('plots');
      if (doc && Array.isArray(doc.plots)) this.plots = doc.plots.filter((p) => p && Array.isArray(p.series));
    } catch (err) {
      toast(`Could not load plots: ${err.message}`, 'error');
    }
    this.reindex();
    for (const p of this.plots) for (const s of p.series) this.backfill(s);
    this.renderAll();
  }

  // Picks up plot definitions saved by another window (collected data stays).
  async reload() {
    if (this.saveTimer) return; // this window has changes about to be saved
    await this.load();
  }

  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 300);
  }

  flushSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return this.api.storeSet('plots', { plots: this.plots }).catch((err) => toast(`Could not save plots: ${err.message}`, 'error'));
  }

  reindex() {
    this.byTopic.clear();
    const live = new Set();
    for (const p of this.plots) {
      for (const s of p.series) {
        const key = seriesKey(s.topic, s.segs);
        if (!this.byTopic.has(s.topic)) this.byTopic.set(s.topic, new Set());
        this.byTopic.get(s.topic).add(key);
        live.add(key);
        if (!this.data.has(key)) this.data.set(key, []);
      }
    }
    // Free the points of series that are no longer plotted anywhere.
    for (const key of this.data.keys()) if (!live.has(key)) this.data.delete(key);
    this.opts.onCountChange?.(this.plots.length);
  }

  setVisible(v) {
    this.visible = v;
    if (v) this.redraw();
  }

  // ------------------------------------------------------------ data

  ingest(msg) {
    const keys = this.byTopic.get(msg.topic);
    if (!keys) return;
    for (const key of keys) {
      const segs = JSON.parse(key.split('\u0000')[1]);
      const v = extractNumber(msg, segs);
      if (v === undefined) continue;
      const pts = this.data.get(key);
      if (pts.length && msg.ts < pts[pts.length - 1].t) continue; // keep points ordered
      pts.push({ t: msg.ts, v });
      if (pts.length > MAX_POINTS) pts.splice(0, pts.length - MAX_POINTS);
    }
  }

  backfill(series) {
    const key = seriesKey(series.topic, series.segs);
    const pts = this.data.get(key);
    if (!pts || pts.length) return;
    for (const m of this.opts.getHistory(series.topic) || []) {
      const v = extractNumber(m, series.segs);
      if (v !== undefined) pts.push({ t: m.ts, v });
    }
  }

  clearData() {
    for (const pts of this.data.values()) pts.length = 0;
    this.redraw();
  }

  // ------------------------------------------------------------ editing

  // Context-menu entries for adding a topic/field to a new or existing plot.
  menuItems(topic, segs) {
    const items = [
      { label: 'Choose values to plot…', action: () => this.openPicker(null, topic) },
      { label: 'Add to new plot', action: () => this.addSeries(null, topic, segs) },
    ];
    for (const p of this.plots.slice(0, 12)) {
      items.push({
        label: `Add to plot “${p.title}”`,
        disabled: p.series.length >= MAX_SERIES || p.series.some((s) => seriesKey(s.topic, s.segs) === seriesKey(topic, segs)),
        action: () => this.addSeries(p.id, topic, segs),
      });
    }
    return items;
  }

  // Adds one series; creates the plot when plotId is null. Returns the plot id,
  // or null when nothing was added.
  addSeries(plotId, topic, segs, { alias = '', quiet = false } = {}) {
    segs = segs && segs.length ? segs : null;
    let plot = this.plots.find((p) => p.id === plotId);
    if (!plot) {
      plot = { id: newId(), title: alias || sourceLabel(topic, segs), windowSec: 300, series: [] };
      this.plots.push(plot);
    }
    if (plot.series.length >= MAX_SERIES) {
      toast(`A plot holds at most ${MAX_SERIES} series`, 'error');
      return null;
    }
    if (plot.series.some((s) => seriesKey(s.topic, s.segs) === seriesKey(topic, segs))) return plot.id;
    const used = new Set(plot.series.map((s) => s.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const series = { id: newId(), topic, segs, slot, ...(alias ? { alias } : {}) };
    plot.series.push(series);
    this.reindex();
    this.backfill(series);
    if (!quiet) {
      this.renderAll();
      this.persist();
      toast(`Plotting ${labelOf(series)}`);
    }
    return plot.id;
  }

  async openPicker(plotId = null, initialTopic = null) {
    const result = await openPlotPicker({
      topics: () => this.opts.getTopicNodes(),
      plots: this.plots,
      targetPlotId: plotId,
      initialTopic,
      maxSeries: MAX_SERIES,
    });
    if (!result || !result.items.length) return;
    let id = result.plotId;
    let added = 0;
    for (const item of result.items) {
      const before = this.plots.find((p) => p.id === id)?.series.length ?? 0;
      id = this.addSeries(id, item.topic, item.segs, { alias: item.alias, quiet: true }) ?? id;
      if ((this.plots.find((p) => p.id === id)?.series.length ?? 0) > before) added++;
    }
    this.renderAll();
    this.persist();
    toast(`Added ${added} series`);
    this.opts.onAdded?.();
  }

  async renameSeries(series) {
    const alias = await promptText({
      title: 'Series alias',
      label: `Name shown in the legend for ${sourceLabel(series.topic, series.segs)} (leave empty to use the topic)`,
      value: series.alias || '',
      allowEmpty: true,
    });
    if (alias === null) return;
    if (alias.trim()) series.alias = alias.trim();
    else delete series.alias;
    this.renderAll();
    this.persist();
  }

  removeSeries(plot, series) {
    plot.series = plot.series.filter((s) => s !== series);
    this.reindex();
    this.renderAll();
    this.persist();
  }

  removePlot(plot) {
    this.plots = this.plots.filter((p) => p !== plot);
    this.reindex();
    this.renderAll();
    this.persist();
  }

  toggleFreeze() {
    this.frozenAt = this.frozenAt ? null : Date.now();
    this.freezeBtn.textContent = this.frozenAt ? 'Resume' : 'Freeze';
    this.freezeBtn.classList.toggle('on', !!this.frozenAt);
    this.redraw();
  }

  exportCsv(plot) {
    // Quote text cells; a leading = + - @ would run as a formula in spreadsheets.
    const q = (v) => `"${String(v).replace(/^([=+\-@\t\r])/, "'$1").replace(/"/g, '""')}"`;
    const rows = ['time_iso,epoch_ms,series,topic,path,value'];
    for (const s of plot.series) {
      const path = s.segs && s.segs.length ? sourceLabel('', s.segs).replace(/^ › /, '') : '';
      for (const p of this.data.get(seriesKey(s.topic, s.segs)) || []) {
        rows.push(`${new Date(p.t).toISOString()},${p.t},${q(labelOf(s))},${q(s.topic)},${q(path)},${p.v}`);
      }
    }
    this.api.saveFile(`${plot.title.replace(/[^\w.-]+/g, '_')}.csv`, rows.join('\n')).then((f) => f && toast(`Saved ${f}`));
  }

  // ------------------------------------------------------------ rendering

  renderAll() {
    for (const c of this.charts.values()) c.dispose();
    this.charts.clear();
    this.grid.textContent = '';
    if (!this.plots.length) {
      this.grid.append(
        el(
          'div',
          'placeholder',
          'No plots yet. Right-click a numeric topic in the tree, or a number in the inspector’s Tree view, and choose “Add to plot”.',
        ),
      );
      return;
    }
    for (const plot of this.plots) this.grid.append(this.renderCard(plot));
    this.redraw();
  }

  renderCard(plot) {
    const card = el('div', 'plot-card');
    card.dataset.plotId = plot.id;
    const head = el('div', 'plot-head');
    const title = el('span', 'plot-title', plot.title);
    title.title = 'Double-click to rename';
    title.addEventListener('dblclick', async () => {
      const name = await promptText({ title: 'Rename plot', label: 'Title', value: plot.title });
      if (name) {
        plot.title = name;
        title.textContent = name;
        this.persist();
      }
    });
    const win = el('select', 'select small');
    for (const [sec, label] of WINDOWS) {
      const o = el('option', '', label);
      o.value = String(sec);
      if (sec === plot.windowSec) o.selected = true;
      win.append(o);
    }
    win.addEventListener('change', () => {
      plot.windowSec = Number(win.value);
      this.persist();
      this.redraw();
    });
    head.append(
      title,
      win,
      button('+ Series', 'Add more values to this plot', () => this.openPicker(plot.id), 'btn small'),
      button('CSV', 'Export collected points as CSV', () => this.exportCsv(plot), 'btn small'),
      button('×', 'Remove plot', () => this.removePlot(plot), 'btn icon small'),
    );
    const legend = el('div', 'plot-legend');
    for (const s of plot.series) {
      const chip = el('span', 'legend-chip');
      const sw = el('span', 'swatch');
      sw.style.background = `var(--series-${(s.slot % MAX_SERIES) + 1})`;
      const label = el('span', 'legend-label' + (s.alias ? ' aliased' : ''), labelOf(s));
      label.title = `${sourceLabel(s.topic, s.segs)}\nDouble-click to ${s.alias ? 'change the' : 'set an'} alias`;
      label.addEventListener('dblclick', () => this.renameSeries(s));
      const last = el('span', 'legend-value');
      last.dataset.key = seriesKey(s.topic, s.segs);
      chip.append(
        sw,
        label,
        last,
        button('✎', 'Set alias', () => this.renameSeries(s), 'chip-edit'),
        button('×', 'Remove series', () => this.removeSeries(plot, s), 'chip-x'),
      );
      legend.append(chip);
    }
    const host = el('div', 'plot-canvas');
    card.append(head, legend, host);
    this.charts.set(plot.id, new LineChart(host));
    return card;
  }

  redraw() {
    if (!this.visible) return;
    const now = this.frozenAt || Date.now();
    for (const plot of this.plots) {
      const chart = this.charts.get(plot.id);
      if (!chart) continue;
      const series = plot.series.map((s) => ({
        label: labelOf(s),
        slot: s.slot,
        points: this.data.get(seriesKey(s.topic, s.segs)) || [],
      }));
      chart.setData(series, plot.windowSec ? windowRange(series, plot.windowSec, now) : null);
      const card = this.grid.querySelector(`.plot-card[data-plot-id="${plot.id}"]`);
      for (const span of card.querySelectorAll('.legend-value')) {
        const pts = this.data.get(span.dataset.key);
        const p = pts && pts[pts.length - 1];
        span.textContent = p ? String(Number(p.v.toPrecision(6))) : '–';
        span.title = p ? formatDateTime(p.t) : 'No data yet';
      }
    }
  }
}
