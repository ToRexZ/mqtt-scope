// Plots tab: live charts of numeric topics or JSON fields, a settings panel
// for the selected plot (modelled on Lichtblick's plot panel) and named
// layouts that can be shared as files. Plot definitions and layouts are
// saved; data points are collected while the app runs.

import { el, button, toast, promptText, showMenu } from './ui.js';
import { decode, extractNumber, formatDateTime } from './payload.js';
import { getAt } from './jsonPath.js';
import { LineChart, MAX_SERIES, DISPLAYS } from './chart.js';
import { seriesKey, windowRange, nearest, formatValue } from './plotMath.js';
import { openPlotPicker, sourceLabel } from './plotPicker.js';
import { WINDOWS, sanitizePlot, sanitizePlots, sanitizeLayouts, clonePlots, samePlots, layoutFile, parseLayoutFile } from './plotLayouts.js';

const MAX_POINTS = 100000; // per series: 1 h at ~25 Hz
const WINDOW_LABELS = { 60: '1 min', 300: '5 min', 900: '15 min', 3600: '1 h', 0: 'All' };

// A series shows its alias when it has one, else where its data comes from.
const labelOf = (s) => s.alias || sourceLabel(s.topic, s.segs);
const newId = () => Math.random().toString(36).slice(2, 10);
const paletteColor = (slot) => getComputedStyle(document.documentElement).getPropertyValue(`--series-${(slot % MAX_SERIES) + 1}`).trim();
const colorOf = (s) => s.color || paletteColor(s.slot);

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(`mqttscope.plots.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem(`mqttscope.plots.${key}`, JSON.stringify(value));
  } catch {}
}

export class PlotsPanel {
  // opts: api, getHistory(topic) -> messages[], getTopicNodes() -> iterable of topic nodes,
  //       onCountChange(n), onAdded()
  constructor(host, opts) {
    this.opts = opts;
    this.api = opts.api;
    this.plots = [];
    this.layouts = [];
    this.activeLayoutId = null;
    this.selectedId = null;
    this.data = new Map(); // seriesKey -> points[]
    this.byTopic = new Map(); // topic -> Set of series keys
    this.charts = new Map(); // plot id -> LineChart
    this.openSeries = new Set(); // series ids expanded in the settings panel
    this.hoverTime = null;
    this.frozenAt = null;
    this.visible = false;
    this.build(host);
    setInterval(() => this.visible && !this.frozenAt && this.redraw(), 500);
  }

  build(host) {
    this.root = el('div', 'plots' + (loadPref('settings', true) ? '' : ' no-settings'));
    const bar = el('div', 'plots-toolbar');
    this.layoutSelect = el('select', 'select layout-select');
    this.layoutSelect.title = 'Saved plot layouts';
    this.layoutSelect.addEventListener('change', () => this.switchLayout(this.layoutSelect.value));
    this.saveBtn = button('Save', 'Save the plots to the current layout', () => this.saveLayout());
    this.freezeBtn = button('Freeze', 'Stop the time axis so you can inspect', () => this.toggleFreeze());
    this.settingsBtn = button('Settings', 'Show or hide the plot settings panel', () => this.toggleSettings(), 'btn' + (loadPref('settings', true) ? ' on' : ''));
    bar.append(
      el('span', 'field-label', 'Layout'),
      this.layoutSelect,
      this.saveBtn,
      button('Save as…', 'Save the plots as a new layout', () => this.saveLayoutAs()),
      button('⋯', 'More layout actions', (e) => this.layoutMenu(e), 'btn icon layout-more'),
      el('span', 'toolbar-sep'),
      button('+ New plot', 'Pick topics and values to plot', () => this.openPicker()),
      this.freezeBtn,
      this.settingsBtn,
      el('span', 'muted small plots-hint', 'Right-click a numeric topic or value to plot it. Hover a plot to compare all plots at that moment.'),
    );
    const main = el('div', 'plots-main');
    this.side = el('div', 'plot-settings');
    this.grid = el('div', 'plots-grid');
    main.append(this.side, this.grid);
    this.root.append(bar, main);
    host.append(this.root);
  }

  // ------------------------------------------------------------ persistence

  async load() {
    try {
      const doc = await this.api.storeGet('plots');
      this.plots = sanitizePlots(doc?.plots);
      this.layouts = sanitizeLayouts(doc?.layouts);
      this.activeLayoutId = this.layouts.some((l) => l.id === doc?.activeLayoutId) ? doc.activeLayoutId : null;
    } catch (err) {
      toast(`Could not load plots: ${err.message}`, 'error');
    }
    if (!this.plots.some((p) => p.id === this.selectedId)) this.selectedId = this.plots[0]?.id ?? null;
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
    this.renderLayoutBar();
  }

  flushSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return this.api
      .storeSet('plots', { plots: this.plots, layouts: this.layouts, activeLayoutId: this.activeLayoutId })
      .catch((err) => toast(`Could not save plots: ${err.message}`, 'error'));
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

  get selected() {
    return this.plots.find((p) => p.id === this.selectedId) || null;
  }

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

  // Booleans default to a state bar, everything else to a line.
  defaultDisplay(topic, segs) {
    const h = this.opts.getHistory(topic) || [];
    const msg = h[h.length - 1];
    if (!msg) return 'line';
    const d = decode(msg);
    const v = segs && segs.length ? (d.kind === 'json' ? getAt(d.value, segs) : undefined) : d.value;
    return typeof v === 'boolean' ? 'state' : 'line';
  }

  // Adds one series; creates the plot when plotId is null. Returns the plot id,
  // or null when nothing was added.
  addSeries(plotId, topic, segs, { alias = '', quiet = false } = {}) {
    segs = segs && segs.length ? segs : null;
    let plot = this.plots.find((p) => p.id === plotId);
    if (!plot) {
      plot = sanitizePlot({ id: newId(), title: alias || sourceLabel(topic, segs), windowSec: 300, series: [] });
      this.plots.push(plot);
      this.selectedId = plot.id;
    }
    if (plot.series.length >= MAX_SERIES) {
      toast(`A plot holds at most ${MAX_SERIES} series`, 'error');
      return null;
    }
    if (plot.series.some((s) => seriesKey(s.topic, s.segs) === seriesKey(topic, segs))) return plot.id;
    const used = new Set(plot.series.map((s) => s.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const series = { id: newId(), topic, segs, slot, display: this.defaultDisplay(topic, segs), width: 2, visible: true, ...(alias ? { alias } : {}) };
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
    this.selectedId = id;
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

  async renamePlot(plot) {
    const name = await promptText({ title: 'Rename plot', label: 'Title', value: plot.title });
    if (!name || !name.trim()) return;
    plot.title = name.trim();
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
    const i = this.plots.indexOf(plot);
    this.plots = this.plots.filter((p) => p !== plot);
    if (this.selectedId === plot.id) this.selectedId = (this.plots[i] || this.plots[i - 1])?.id ?? null;
    this.reindex();
    this.renderAll();
    this.persist();
  }

  select(plotId) {
    if (this.selectedId === plotId) return;
    this.selectedId = plotId;
    for (const card of this.grid.querySelectorAll('.plot-card')) card.classList.toggle('selected', card.dataset.plotId === plotId);
    this.renderSettings();
  }

  toggleFreeze() {
    this.frozenAt = this.frozenAt ? null : Date.now();
    this.freezeBtn.textContent = this.frozenAt ? 'Resume' : 'Freeze';
    this.freezeBtn.classList.toggle('on', !!this.frozenAt);
    this.redraw();
  }

  toggleSettings(force) {
    const show = force ?? this.root.classList.contains('no-settings');
    this.root.classList.toggle('no-settings', !show);
    this.settingsBtn.classList.toggle('on', show);
    savePref('settings', show);
    for (const c of this.charts.values()) c.draw();
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

  // ------------------------------------------------------------ layouts

  get activeLayout() {
    return this.layouts.find((l) => l.id === this.activeLayoutId) || null;
  }

  get layoutDirty() {
    const l = this.activeLayout;
    return l ? !samePlots(l.plots, this.plots) : this.plots.length > 0;
  }

  renderLayoutBar() {
    const sel = this.layoutSelect;
    sel.textContent = '';
    if (!this.activeLayout) sel.append(Object.assign(el('option', '', this.plots.length ? 'Unsaved layout' : 'No layout'), { value: '' }));
    for (const l of this.layouts) {
      const dirty = l.id === this.activeLayoutId && this.layoutDirty;
      sel.append(Object.assign(el('option', '', `${l.name}${dirty ? ' •' : ''}`), { value: l.id }));
    }
    sel.value = this.activeLayoutId || '';
    this.saveBtn.classList.toggle('on', this.layoutDirty && !!this.activeLayout);
    this.saveBtn.title = this.activeLayout ? `Save the plots to “${this.activeLayout.name}”` : 'Save the plots as a new layout';
  }

  async confirmDiscard() {
    if (!this.layoutDirty || !this.plots.length) return true;
    return this.api.confirm({
      message: 'Discard changes to the current plots?',
      detail: this.activeLayout ? `They are not saved to “${this.activeLayout.name}”.` : 'They are not saved in any layout.',
      okLabel: 'Discard',
    });
  }

  applyPlots(plots, layoutId) {
    this.plots = clonePlots(plots);
    this.activeLayoutId = layoutId;
    this.selectedId = this.plots[0]?.id ?? null;
    this.reindex();
    for (const p of this.plots) for (const s of p.series) this.backfill(s);
    this.renderAll();
    this.persist();
  }

  async switchLayout(id) {
    const layout = this.layouts.find((l) => l.id === id);
    if (!layout || id === this.activeLayoutId) return this.renderLayoutBar();
    if (!(await this.confirmDiscard())) return this.renderLayoutBar();
    this.applyPlots(layout.plots, layout.id);
    toast(`Layout “${layout.name}”`);
  }

  saveLayout() {
    const l = this.activeLayout;
    if (!l) return this.saveLayoutAs();
    l.plots = clonePlots(this.plots);
    this.persist();
    toast(`Saved layout “${l.name}”`);
  }

  async saveLayoutAs() {
    const name = (await promptText({ title: 'Save layout', label: 'Layout name', value: this.activeLayout ? `${this.activeLayout.name} copy` : 'My layout', okLabel: 'Save' }))?.trim();
    if (!name) return;
    const existing = this.layouts.find((l) => l.name === name);
    if (existing && !(await this.api.confirm({ message: `Replace the layout “${name}”?`, okLabel: 'Replace' }))) return;
    const layout = existing || { id: newId(), name, plots: [] };
    layout.plots = clonePlots(this.plots);
    if (!existing) this.layouts.push(layout);
    this.activeLayoutId = layout.id;
    this.persist();
    toast(`Saved layout “${name}”`);
  }

  async renameLayout() {
    const l = this.activeLayout;
    if (!l) return;
    const name = (await promptText({ title: 'Rename layout', label: 'Layout name', value: l.name }))?.trim();
    if (!name) return;
    l.name = name;
    this.persist();
  }

  async deleteLayout() {
    const l = this.activeLayout;
    if (!l) return;
    if (!(await this.api.confirm({ message: `Delete the layout “${l.name}”?`, detail: 'The plots on screen stay until you change them.', okLabel: 'Delete' }))) return;
    this.layouts = this.layouts.filter((x) => x !== l);
    this.activeLayoutId = null;
    this.persist();
  }

  async exportLayout() {
    const name = this.activeLayout?.name || 'Plots';
    const file = await this.api.saveFile(`${name.replace(/[^\w.-]+/g, '_')}.mqtt-scope-layout.json`, layoutFile(name, this.plots));
    if (file) toast(`Saved ${file}`);
  }

  async importLayout() {
    let file;
    try {
      file = await this.api.readFileBytes();
    } catch (err) {
      return toast(err.message, 'error');
    }
    if (!file) return;
    let layout;
    try {
      layout = parseLayoutFile(new TextDecoder().decode(file.bytes), file.name.replace(/(\.mqtt-scope-layout)?\.json$/i, ''));
    } catch (err) {
      return toast(`Could not import ${file.name}: ${err.message}`, 'error');
    }
    if (!(await this.confirmDiscard())) return;
    let name = layout.name;
    for (let n = 2; this.layouts.some((l) => l.name === name); n++) name = `${layout.name} (${n})`;
    const saved = { id: newId(), name, plots: clonePlots(layout.plots) };
    this.layouts.push(saved);
    this.applyPlots(saved.plots, saved.id);
    toast(`Imported layout “${name}”`);
  }

  layoutMenu(e) {
    const r = e.target.getBoundingClientRect();
    const has = !!this.activeLayout;
    showMenu(r.left, r.bottom + 4, [
      { label: 'Rename layout…', disabled: !has, action: () => this.renameLayout() },
      { label: 'Delete layout…', disabled: !has, action: () => this.deleteLayout() },
      'separator',
      { label: 'Export layout to a file…', disabled: !this.plots.length, action: () => this.exportLayout() },
      { label: 'Import layout from a file…', action: () => this.importLayout() },
    ]);
  }

  // ------------------------------------------------------------ rendering

  renderAll() {
    for (const c of this.charts.values()) c.dispose();
    this.charts.clear();
    this.grid.textContent = '';
    if (!this.plots.length) {
      this.grid.append(
        el('div', 'placeholder', 'No plots yet. Click “+ New plot”, or right-click a numeric topic in the tree (or a number in the inspector’s Tree view) and choose “Add to plot”.'),
      );
    }
    for (const plot of this.plots) this.grid.append(this.renderCard(plot));
    this.renderSettings();
    this.renderLayoutBar();
    this.redraw();
  }

  renderCard(plot) {
    const card = el('div', 'plot-card' + (plot.id === this.selectedId ? ' selected' : ''));
    card.dataset.plotId = plot.id;
    card.addEventListener('mousedown', () => this.select(plot.id));
    const head = el('div', 'plot-head');
    const title = el('span', 'plot-title', plot.title);
    title.title = 'Double-click to rename';
    title.addEventListener('dblclick', () => this.renamePlot(plot));
    const win = el('select', 'select small');
    for (const sec of WINDOWS) win.append(Object.assign(el('option', '', WINDOW_LABELS[sec]), { value: String(sec), selected: sec === plot.windowSec }));
    win.addEventListener('change', () => {
      plot.windowSec = Number(win.value);
      this.renderSettings();
      this.persist();
      this.redraw();
    });
    head.append(
      title,
      win,
      button('+ Series', 'Add more values to this plot', () => this.openPicker(plot.id), 'btn small'),
      button('CSV', 'Export collected points as CSV', () => this.exportCsv(plot), 'btn small'),
      button('⚙', 'Plot settings', () => {
        this.select(plot.id);
        this.toggleSettings(true);
      }, 'btn icon small'),
      button('×', 'Remove plot', () => this.removePlot(plot), 'btn icon small'),
    );
    const legend = el('div', 'plot-legend');
    legend.hidden = !plot.legend;
    for (const s of plot.series) {
      const chip = el('span', 'legend-chip' + (s.visible ? '' : ' off'));
      const sw = button('', s.visible ? 'Hide this series' : 'Show this series', () => {
        s.visible = !s.visible;
        this.renderAll();
        this.persist();
      }, 'swatch swatch-toggle');
      sw.style.background = colorOf(s);
      const label = el('span', 'legend-label' + (s.alias ? ' aliased' : ''), labelOf(s));
      label.title = `${sourceLabel(s.topic, s.segs)}\nDouble-click to ${s.alias ? 'change the' : 'set an'} alias`;
      label.addEventListener('dblclick', () => this.renameSeries(s));
      const last = el('span', 'legend-value');
      last.dataset.key = seriesKey(s.topic, s.segs);
      last.hidden = !plot.legendValues;
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
    this.charts.set(plot.id, new LineChart(host, { onHover: (t) => this.syncHover(plot.id, t) }));
    return card;
  }

  // Hovering one plot moves the time bar on every plot and shows the values
  // at that moment in the legends.
  syncHover(fromId, t) {
    this.hoverTime = t;
    for (const [id, chart] of this.charts) if (id !== fromId) chart.setHoverTime(t);
    this.updateLegendValues();
  }

  updateLegendValues() {
    for (const plot of this.plots) {
      const card = this.grid.querySelector(`.plot-card[data-plot-id="${plot.id}"]`);
      if (!card) continue;
      for (const span of card.querySelectorAll('.legend-value')) {
        const pts = this.data.get(span.dataset.key) || [];
        const p = this.hoverTime !== null ? nearest(pts, this.hoverTime) : pts[pts.length - 1];
        const series = plot.series.find((s) => seriesKey(s.topic, s.segs) === span.dataset.key);
        span.textContent = !p ? '–' : series?.display === 'state' && (p.v === 0 || p.v === 1) ? String(p.v === 1) : String(Number(p.v.toPrecision(6)));
        span.title = p ? formatDateTime(p.t) : 'No data yet';
        span.classList.toggle('at-hover', this.hoverTime !== null);
      }
    }
  }

  redraw() {
    if (!this.visible) return;
    const now = this.frozenAt || Date.now();
    for (const plot of this.plots) {
      const chart = this.charts.get(plot.id);
      if (!chart) continue;
      const series = plot.series
        .filter((s) => s.visible)
        .map((s) => ({
          label: labelOf(s),
          slot: s.slot,
          color: s.color,
          display: s.display,
          width: s.width,
          points: this.data.get(seriesKey(s.topic, s.segs)) || [],
        }));
      chart.setData(series, plot.windowSec ? windowRange(series, plot.windowSec, now) : null, { yMin: plot.yMin, yMax: plot.yMax });
    }
    this.updateLegendValues();
  }

  // The settings panel for the selected plot (cf. Lichtblick's plot panel).
  renderSettings() {
    const side = this.side;
    side.textContent = '';
    const plot = this.selected;
    if (!plot) {
      side.append(el('div', 'placeholder small', this.plots.length ? 'Select a plot to change its settings.' : 'Add a plot to configure it here.'));
      return;
    }
    side.append(el('div', 'ps-heading', 'Plot settings'));
    const section = (name, ...children) => {
      const d = el('details', 'ps-section');
      d.open = true;
      d.append(el('summary', '', name), ...children);
      return d;
    };
    const row = (label, control) => {
      const r = el('label', 'ps-row');
      r.append(el('span', 'ps-label', label), control);
      return r;
    };
    const commit = (redrawCards = false) => {
      if (redrawCards) this.renderCardsOnly();
      else this.redraw();
      this.persist();
    };

    // General
    const titleInput = Object.assign(el('input', 'input'), { value: plot.title, name: 'plot-title', spellcheck: false });
    titleInput.addEventListener('input', () => {
      if (!titleInput.value.trim()) return;
      plot.title = titleInput.value.trim();
      const t = this.grid.querySelector(`.plot-card[data-plot-id="${plot.id}"] .plot-title`);
      if (t) t.textContent = plot.title;
      this.persist();
    });
    const win = el('select', 'select');
    win.name = 'plot-window';
    for (const sec of WINDOWS) win.append(Object.assign(el('option', '', WINDOW_LABELS[sec]), { value: String(sec), selected: sec === plot.windowSec }));
    win.addEventListener('change', () => {
      plot.windowSec = Number(win.value);
      const cardSel = this.grid.querySelector(`.plot-card[data-plot-id="${plot.id}"] select`);
      if (cardSel) cardSel.value = win.value;
      commit();
    });

    // Legend
    const check = (label, key) => {
      const c = Object.assign(el('input'), { type: 'checkbox', checked: plot[key], name: `plot-${key}` });
      c.addEventListener('change', () => {
        plot[key] = c.checked;
        commit(true);
      });
      const l = el('label', 'check');
      l.append(c, document.createTextNode(` ${label}`));
      return l;
    };

    // Y axis
    const axisInput = (key) => {
      const i = Object.assign(el('input', 'input'), { type: 'number', placeholder: 'Auto', name: `plot-${key}`, value: plot[key] ?? '' });
      i.step = 'any';
      i.addEventListener('change', () => {
        const v = i.value.trim() === '' ? null : Number(i.value);
        plot[key] = Number.isFinite(v) ? v : null;
        commit();
      });
      return i;
    };

    // Series
    const seriesHead = el('div', 'ps-series-head');
    const add = button('+ Add series', 'Pick more values for this plot', () => this.openPicker(plot.id), 'btn small');
    add.disabled = plot.series.length >= MAX_SERIES;
    seriesHead.append(el('span', 'muted small', `${plot.series.length} of ${MAX_SERIES}`), add);
    const list = el('div', 'ps-series');
    for (const s of plot.series) list.append(this.renderSeriesSettings(plot, s));

    side.append(
      section('General', row('Title', titleInput), row('Time window', win)),
      section('Legend', check('Show legend', 'legend'), check('Show values', 'legendValues')),
      section('Y axis', row('Min', axisInput('yMin')), row('Max', axisInput('yMax'))),
      section('Series', seriesHead, list),
    );
  }

  renderSeriesSettings(plot, s) {
    const item = el('details', 'ps-series-item' + (s.visible ? '' : ' off'));
    item.dataset.seriesId = s.id;
    item.open = this.openSeries.has(s.id);
    item.addEventListener('toggle', () => (item.open ? this.openSeries.add(s.id) : this.openSeries.delete(s.id)));
    const save = (cards = true) => {
      if (cards) this.renderCardsOnly();
      else this.redraw();
      this.persist();
    };

    const summary = el('summary', 'ps-series-summary');
    const eye = button(s.visible ? '👁' : '◌', s.visible ? 'Hide' : 'Show', (e) => {
      e.preventDefault();
      s.visible = !s.visible;
      eye.textContent = s.visible ? '👁' : '◌';
      item.classList.toggle('off', !s.visible);
      save();
    }, 'btn icon small ps-eye');
    const sw = el('span', 'swatch');
    sw.style.background = colorOf(s);
    const name = el('span', 'ps-series-name', labelOf(s));
    name.title = sourceLabel(s.topic, s.segs);
    const remove = button('×', 'Remove series', (e) => {
      e.preventDefault();
      this.removeSeries(plot, s);
    }, 'btn icon small');
    summary.append(eye, sw, name, remove);

    const body = el('div', 'ps-series-body');
    const row = (label, control) => {
      const r = el('label', 'ps-row');
      r.append(el('span', 'ps-label', label), control);
      return r;
    };
    body.append(row('Source', el('code', 'ps-source', sourceLabel(s.topic, s.segs))));

    const alias = Object.assign(el('input', 'input'), { value: s.alias || '', placeholder: sourceLabel(s.topic, s.segs), name: 'series-alias', spellcheck: false });
    alias.addEventListener('input', () => {
      if (alias.value.trim()) s.alias = alias.value.trim();
      else delete s.alias;
      name.textContent = labelOf(s);
      save();
    });
    body.append(row('Label', alias));

    // Colour: any colour from the picker, or one of the palette colours.
    const colors = el('div', 'ps-colors');
    const picker = Object.assign(el('input', 'ps-color'), { type: 'color', value: colorOf(s), name: 'series-color', title: 'Pick any colour' });
    const setColor = () => {
      sw.style.background = colorOf(s);
      picker.value = colorOf(s);
      for (const b of colors.querySelectorAll('.ps-palette')) b.classList.toggle('on', !s.color && Number(b.dataset.slot) === s.slot);
      save();
    };
    picker.addEventListener('input', () => {
      s.color = picker.value.toLowerCase();
      setColor();
    });
    colors.append(picker);
    for (let slot = 0; slot < MAX_SERIES; slot++) {
      const b = button('', `Palette colour ${slot + 1}`, () => {
        s.slot = slot;
        delete s.color;
        setColor();
      }, 'ps-palette' + (!s.color && s.slot === slot ? ' on' : ''));
      b.dataset.slot = String(slot);
      b.style.background = `var(--series-${slot + 1})`;
      colors.append(b);
    }
    body.append(row('Colour', colors));

    const display = el('select', 'select');
    display.name = 'series-display';
    for (const [v, l] of DISPLAYS) display.append(Object.assign(el('option', '', l), { value: v, selected: v === s.display }));
    const width = el('select', 'select');
    width.name = 'series-width';
    for (const w of [1, 2, 3, 4]) width.append(Object.assign(el('option', '', `${w} px`), { value: String(w), selected: w === s.width }));
    const widthRow = row('Line width', width);
    widthRow.hidden = s.display === 'state';
    display.addEventListener('change', () => {
      s.display = display.value;
      widthRow.hidden = s.display === 'state';
      save(false);
    });
    width.addEventListener('change', () => {
      s.width = Number(width.value);
      save(false);
    });
    body.append(row('Display', display), widthRow);
    item.append(summary, body);
    return item;
  }

  // Rebuilds the plot cards (legend changes) without touching the settings
  // panel, so its inputs keep focus while typing.
  renderCardsOnly() {
    for (const c of this.charts.values()) c.dispose();
    this.charts.clear();
    this.grid.textContent = '';
    for (const plot of this.plots) this.grid.append(this.renderCard(plot));
    this.renderLayoutBar();
    this.redraw();
  }
}
