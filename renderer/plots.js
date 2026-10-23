// Plots tab: named tabs of live plots, arranged like Lichtblick's panels,
// with a settings panel for the selected plot. This module wires the pieces
// together and draws the tab strip and the plot cards:
//
//   plotModel.js     tabs, plots and their arrangement (all the rules; saved)
//   plotData.js      the points collected for every plotted series
//   plotView.js      what a chart and a legend show for a plot
//   plotCard.js      legend and controls shared with pop-out plot windows
//   mosaic.js        the split layout: resizing gaps, dragging plots around
//   plotSettings.js  the settings panel
//   chart.js         drawing one plot
//
// Zoom, freeze and full screen are view state here; they are not saved.

import { el, button, toast, promptText, showMenu, splitter } from './ui.js';
import { icon, iconButton } from './icons.js';
import { LineChart } from './chart.js';
import { MAX_SERIES } from './plotLayouts.js';
import { PlotModel } from './plotModel.js';
import { PlotData, pointsFromMessages } from './plotData.js';
import { renderMosaic } from './mosaic.js';
import { renderPlotSettings } from './plotSettings.js';
import { renderLegend, updateLegend, kindToggle, windowSelect, resetViewButton } from './plotCard.js';
import { openPlotPicker } from './plotPicker.js';
import { seriesKey } from './plotMath.js';
import { MIN_PLOT_WIDTH, labelOf, sourceLabel, defaultDisplay, layoutWeight, minPlotHeight, chartSeries, chartRange, chartAxis } from './plotView.js';

const SAVE_DELAY_MS = 300;
const REDRAW_MS = 500;
const FULLSCREEN_WAIT_MS = 600;

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
  // opts: api, getHistory(topic) -> messages[], getTopicNodes() -> iterable of
  //       topic nodes, onCountChange(n), onAdded()
  constructor(host, opts) {
    this.opts = opts;
    this.api = opts.api;
    this.model = new PlotModel(null, {
      weightOf: layoutWeight,
      onChange: () => {
        this.trackSeries();
        this.persist();
      },
    });
    this.data = new PlotData();
    this.charts = new Map(); // plot id -> LineChart (the tab on screen)
    this.cards = new Map(); // plot id -> card element (the tab on screen)
    this.openSeries = new Set(); // series ids expanded in the settings panel
    this.zoomByTab = new Map(); // tab id -> { t0, t1 }
    this.yZoom = new Map(); // plot id -> { yMin, yMax }
    this.soloId = null; // plot shown full screen
    this.hoverTime = null;
    this.frozenAt = null;
    this.visible = false;
    this.build(host);
    this.trackSeries();
    this.redrawTimer = setInterval(() => this.visible && !this.frozenAt && this.redraw(), REDRAW_MS);
    this.onFullscreen = () => this.onFullscreenChange();
    document.addEventListener('fullscreenchange', this.onFullscreen);
  }

  // Stops the redraw timer, the charts and the document listener (the tab
  // closed). Collected data is left to the garbage collector.
  dispose() {
    clearInterval(this.redrawTimer);
    this.redrawTimer = null;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    if (this.soloId) this.leaveSolo();
    this.disposeCharts();
    this.visible = false;
    this.root.remove();
  }

  // ------------------------------------------------------------ reading

  get tab() {
    return this.model.tab;
  }

  // Plots of the tab on screen.
  get plots() {
    return this.model.plots;
  }

  get selectedId() {
    return this.model.selectedId;
  }

  set selectedId(id) {
    this.model.select(id);
  }

  // Points collected for a series: [{ t, v }], oldest first.
  points(topic, segs) {
    return this.data.points(topic, segs);
  }

  // ------------------------------------------------------------ persistence

  // keepActive: another window saved; stay on the tab shown here.
  async load({ keepActive = false } = {}) {
    try {
      const [tabs, legacy] = await Promise.all([this.api.storeGet('plotTabs'), this.api.storeGet('plots')]);
      this.model.load(tabs, { legacy, keepActive });
      if (this.model.newer && !this.warnedNewer) {
        this.warnedNewer = true;
        toast('These plots were saved by a newer MQTT Scope. Changes made here are not saved, so nothing it added is lost.', 'error');
      }
    } catch (err) {
      toast(`Could not load plots: ${err.message}`, 'error');
    }
    this.trackSeries();
    this.renderAll();
  }

  // Picks up plot definitions saved by another window (collected data stays).
  async reload() {
    if (this.saveTimer) return; // this window has changes about to be saved
    await this.load({ keepActive: true });
  }

  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DELAY_MS);
  }

  // Saves the tabs, and the tab on screen in the 0.1 format for older versions.
  async flushSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.model.newer) return;
    try {
      // The 0.1 copy first: other windows reload when plotTabs changes.
      await this.api.storeSet('plots', this.model.legacyDoc());
      await this.api.storeSet('plotTabs', this.model.toDoc());
    } catch (err) {
      toast(`Could not save plots: ${err.message}`, 'error');
    }
  }

  // Collect data for exactly the plotted series; new ones start from the
  // messages the topic tree has kept.
  trackSeries() {
    this.data.track(this.model.allSeries(), (s) => pointsFromMessages(this.opts.getHistory(s.topic), s.segs));
    this.opts.onCountChange?.(this.model.allPlots().length);
  }

  // ------------------------------------------------------------ data

  ingest(msg) {
    this.data.ingest(msg);
  }

  // Restarts every timeline: forgets collected points, zoom and freeze.
  reset() {
    this.data.clear();
    this.zoomByTab.clear();
    this.yZoom.clear();
    if (this.frozenAt) this.toggleFreeze();
    this.updateZoomUi();
    this.redraw();
  }

  setVisible(v) {
    this.visible = v;
    if (v) this.redraw();
    else if (this.soloId) this.exitFullscreen(); // the Plots tab was hidden
  }

  // ------------------------------------------------------------ editing plots

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

  // The model's addSeries, with the display style the latest message suggests.
  add(plotId, topic, segs, alias = '') {
    const history = this.opts.getHistory(topic) || [];
    return this.model.addSeries(plotId, { topic, segs, alias, display: defaultDisplay(history[history.length - 1], segs) });
  }

  // Adds one series; creates the plot (in the tab on screen) when plotId is
  // null. Returns the plot id, or null when nothing was added.
  addSeries(plotId, topic, segs, { alias = '', quiet = false } = {}) {
    const res = this.add(plotId, topic, segs, alias);
    if (res.full) {
      toast(`A plot holds at most ${MAX_SERIES} series`, 'error');
      return null;
    }
    if (!quiet && res.series) {
      this.renderAll();
      toast(`Plotting ${labelOf(res.series)}`);
    }
    return res.plot?.id ?? null;
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
    const count = { added: 0, already: 0, full: 0 };
    for (const item of result.items) {
      const res = this.add(id, item.topic, item.segs, item.alias);
      if (res.full) count.full++;
      else if (res.series) count.added++;
      else if (res.plot) count.already++;
      id = res.plot?.id ?? id;
    }
    if (!result.plotId && id) this.model.settleKind(id);
    if (id) this.model.select(id);
    this.renderAll();
    const notes = [count.already && `${count.already} already plotted`, count.full && `${count.full} did not fit (at most ${MAX_SERIES} per plot)`].filter(Boolean);
    toast(`${count.added ? `Added ${count.added} series` : 'Nothing added'}${notes.length ? `; ${notes.join(', ')}` : ''}`, count.full && !count.added ? 'error' : 'info');
    this.opts.onAdded?.();
  }

  async renameSeries(plot, series) {
    const alias = await promptText({
      title: 'Series alias',
      label: `Name shown in the legend for ${sourceLabel(series.topic, series.segs)} (leave empty to use the topic)`,
      value: series.alias || '',
      allowEmpty: true,
    });
    if (alias !== null && this.model.updateSeries(plot.id, series.id, { alias })) this.renderAll();
  }

  async renamePlot(plot) {
    const title = await promptText({ title: 'Rename plot', label: 'Title', value: plot.title });
    if (title !== null && this.model.updatePlot(plot.id, { title })) this.renderAll();
  }

  removePlot(plot) {
    this.yZoom.delete(plot.id);
    if (this.model.removePlot(plot.id)) this.renderAll();
  }

  setKind(plot, kind) {
    if (!this.model.updatePlot(plot.id, { kind })) return;
    this.yZoom.delete(plot.id);
    this.renderAll();
  }

  select(plotId) {
    if (!this.model.select(plotId)) return;
    for (const [id, card] of this.cards) card.classList.toggle('selected', id === plotId);
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
      for (const p of this.data.points(s.topic, s.segs)) {
        rows.push(`${new Date(p.t).toISOString()},${p.t},${q(labelOf(s))},${q(s.topic)},${q(path)},${p.v}`);
      }
    }
    this.api.saveFile(`${plot.title.replace(/[^\w.-]+/g, '_')}.csv`, rows.join('\n')).then((f) => f && toast(`Saved ${f}`));
  }

  // Opens the plot live in its own window (it stays in the tab as well).
  popOut(plot) {
    const data = {};
    for (const s of plot.series) data[seriesKey(s.topic, s.segs)] = this.data.points(s.topic, s.segs);
    this.api.openPlotWindow({ plot: JSON.parse(JSON.stringify(plot)), data, tabName: this.tab.name });
  }

  // ------------------------------------------------------------ zoom

  isZoomed() {
    return this.zoomByTab.has(this.tab.id) || this.plots.some((p) => this.yZoom.has(p.id));
  }

  // The time range zooms every plot of the tab (they share one timeline); the
  // value range only the plot it was selected in.
  zoom(plot, z) {
    if (!(z.t1 > z.t0)) return;
    this.zoomByTab.set(this.tab.id, { t0: z.t0, t1: z.t1 });
    if (Number.isFinite(z.yMin) && Number.isFinite(z.yMax) && z.yMax > z.yMin) this.yZoom.set(plot.id, { yMin: z.yMin, yMax: z.yMax });
    this.updateZoomUi();
    this.redraw();
  }

  resetZoom() {
    this.zoomByTab.delete(this.tab.id);
    for (const p of this.plots) this.yZoom.delete(p.id);
    this.updateZoomUi();
    this.redraw();
  }

  // Shows "Reset view" in the toolbar and on every zoomed plot (a time zoom
  // applies to the whole tab, a value zoom to one plot).
  updateZoomUi() {
    this.zoomBtn.hidden = !this.isZoomed();
    const timeZoomed = this.zoomByTab.has(this.tab.id);
    for (const [id, card] of this.cards) {
      const b = card.querySelector('.reset-view');
      if (b) b.hidden = !(timeZoomed || this.yZoom.has(id));
    }
  }

  // Esc: leave full screen first, then reset the zoom. Returns whether there
  // was something to undo.
  handleEscape() {
    if (this.soloId) {
      this.exitFullscreen();
      return true;
    }
    if (this.isZoomed()) {
      this.resetZoom();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ full screen

  // One plot fills the Plots panel, and the panel goes full screen (or, when
  // the system does not allow it, covers the window). The plot is remembered
  // by id, so it stays full screen while its card is drawn again (after an
  // edit, or when another window saves).
  async toggleFullscreen(plotId) {
    if (this.soloId === plotId) return this.exitFullscreen();
    this.soloId = plotId;
    this.root.classList.add('solo');
    this.renderGrid();
    if (document.fullscreenElement === this.root) return;
    const request = (this.fullscreenRequest = {});
    const fallback = () => {
      if (this.fullscreenRequest !== request || document.fullscreenElement === this.root) return;
      this.fullscreenRequest = null;
      if (this.soloId) this.root.classList.add('fill-window');
    };
    const timer = setTimeout(fallback, FULLSCREEN_WAIT_MS);
    try {
      await this.root.requestFullscreen();
    } catch {
      fallback();
    } finally {
      clearTimeout(timer);
    }
  }

  exitFullscreen() {
    this.leaveSolo();
    this.renderGrid();
  }

  // Leaves full screen without drawing anything.
  leaveSolo() {
    this.soloId = null;
    this.fullscreenRequest = null;
    this.root.classList.remove('solo', 'fill-window');
    if (document.fullscreenElement === this.root) document.exitFullscreen().catch(() => {});
  }

  onFullscreenChange() {
    if (document.fullscreenElement === this.root) {
      this.root.classList.remove('fill-window');
      if (!this.soloId) document.exitFullscreen().catch(() => {}); // cancelled while waiting
    } else if (this.soloId && !this.root.classList.contains('fill-window')) {
      this.exitFullscreen(); // left with the system's Esc
    }
  }

  // ------------------------------------------------------------ tabs

  switchTab(id) {
    if (this.model.switchTab(id)) this.renderAll();
  }

  async addTab() {
    const name = await promptText({ title: 'New tab', label: 'Tab name', value: this.model.nextTabName(), okLabel: 'Create' });
    if (name === null || !name.trim()) return;
    this.model.addTab(name);
    this.renderAll();
  }

  async renameTab(tab) {
    const name = await promptText({ title: 'Rename tab', label: 'Tab name', value: tab.name });
    if (name !== null && this.model.renameTab(tab.id, name)) this.renderTabs();
  }

  duplicateTab(tab) {
    if (this.model.duplicateTab(tab.id)) this.renderAll();
  }

  async deleteTab(tab) {
    const n = tab.plots.length;
    if (n && !(await this.api.confirm({ message: `Delete the tab “${tab.name}”?`, detail: `Its ${n} plot${n === 1 ? '' : 's'} will be removed.`, okLabel: 'Delete' }))) return;
    this.zoomByTab.delete(tab.id);
    if (this.model.deleteTab(tab.id)) this.renderAll();
  }

  async exportTab(tab) {
    const file = this.model.exportTab(tab.id);
    const saved = file && (await this.api.saveFile(file.name, file.text));
    if (saved) toast(`Saved ${saved}`);
  }

  async importTab() {
    let file;
    try {
      file = await this.api.readFileBytes();
    } catch (err) {
      return toast(err.message, 'error');
    }
    if (!file) return;
    try {
      const tab = this.model.importTab(new TextDecoder().decode(file.bytes), file.name.replace(/(\.mqtt-scope-layout)?\.json$/i, ''));
      this.renderAll();
      toast(`Imported “${tab.name}”`);
    } catch (err) {
      toast(`Could not import ${file.name}: ${err.message}`, 'error');
    }
  }

  tabMenu(tab, at) {
    showMenu(at.left, at.bottom + 4, [
      { label: 'Rename tab…', action: () => this.renameTab(tab) },
      { label: 'Duplicate tab', action: () => this.duplicateTab(tab) },
      'separator',
      { label: 'Export tab to a file…', disabled: !tab.plots.length, action: () => this.exportTab(tab) },
      { label: 'Import tab from a file…', action: () => this.importTab() },
      'separator',
      { label: 'Delete tab…', action: () => this.deleteTab(tab) },
    ]);
  }

  arrangeMenu(at) {
    const choose = (columns) => () => {
      this.model.arrange(columns);
      this.renderGrid();
    };
    showMenu(at.left, at.bottom + 4, [
      { label: 'Automatic (stack a few, then columns)', action: choose(0) },
      { label: 'Stack: one per row', action: choose(1) },
      ...[2, 3, 4].map((c) => ({ label: `${c} per row`, action: choose(c) })),
    ]);
  }

  // A plot dropped somewhere: next to another plot, or on another tab.
  movePlot(id, target) {
    if (target.type === 'leaf') {
      if (this.model.movePlot(id, target.id, target.edge)) this.renderGrid();
      return;
    }
    const plot = this.model.plot(id);
    const dest = this.model.tabs.find((t) => t.id === target.tabId);
    if (!plot || !dest || !this.model.movePlotToTab(id, dest.id)) return;
    this.yZoom.delete(id);
    this.renderAll();
    toast(`Moved “${plot.title}” to “${dest.name}”`);
  }

  // ------------------------------------------------------------ rendering

  build(host) {
    const settingsShown = loadPref('settings', true);
    this.root = el('div', 'plots' + (settingsShown ? '' : ' no-settings'));
    const bar = el('div', 'plots-toolbar');
    this.tabStrip = el('div', 'plot-tabs');
    this.freezeBtn = button('Freeze', 'Stop the time axis so you can inspect (Space)', () => this.toggleFreeze());
    this.zoomBtn = button('', 'Back to the live view for every plot in this tab (double-click a plot, or Esc)', () => this.resetZoom(), 'btn zoom-reset');
    this.zoomBtn.append(icon('zoom-out'), document.createTextNode(' Reset view'));
    this.zoomBtn.hidden = true;
    this.settingsBtn = button('Settings', 'Show or hide the plot settings panel', () => this.toggleSettings(), 'btn' + (settingsShown ? ' on' : ''));
    bar.append(
      this.tabStrip,
      iconButton('plus', 'New tab', () => this.addTab(), 'btn icon tab-add'),
      iconButton('more', 'Tab actions', (e) => this.tabMenu(this.tab, e.currentTarget.getBoundingClientRect()), 'btn icon tab-more'),
      el('span', 'toolbar-sep'),
      button('+ New plot', 'Pick topics and values to plot', () => this.openPicker()),
      button('Arrange', 'Lay the plots out in rows (replaces your own arrangement)', (e) => this.arrangeMenu(e.currentTarget.getBoundingClientRect()), 'btn arrange-btn'),
      this.freezeBtn,
      this.zoomBtn,
      this.settingsBtn,
      el('span', 'muted small plots-hint', 'Drag a plot by its title to move it. Drag across a plot to zoom.'),
    );
    const main = el('div', 'plots-main');
    this.side = el('div', 'plot-settings');
    const sideSplit = el('div', 'splitter x ps-splitter');
    sideSplit.title = 'Drag to resize the settings panel';
    // While the panel is hidden, a slim rail brings it back.
    const rail = el('div', 'ps-rail');
    rail.append(iconButton('chevrons-right', 'Show the settings panel', () => this.toggleSettings(true), 'btn icon small'));
    this.grid = el('div', 'plots-grid');
    main.append(this.side, sideSplit, rail, this.grid);
    this.root.append(bar, main);
    host.append(this.root);
    splitter(sideSplit, {
      axis: 'x',
      storageKey: 'mqttscope.plotSettingsWidth',
      initial: 300,
      min: 200,
      max: () => Math.max(220, Math.min(700, this.root.clientWidth - 360)),
      // On the body: every connection tab shares the width.
      apply: (px) => document.body.style.setProperty('--ps-w', `${px}px`),
    });
  }

  renderAll() {
    this.renderTabs();
    this.renderGrid();
    this.renderSettings();
    this.updateZoomUi();
  }

  renderTabs() {
    this.tabStrip.textContent = '';
    for (const tab of this.model.tabs) {
      const t = el('button', 'plot-tab' + (tab.id === this.model.activeTabId ? ' active' : ''));
      t.type = 'button';
      t.dataset.tabId = tab.id;
      t.title = `${tab.name} — double-click to rename, right-click for more`;
      t.append(el('span', 'plot-tab-name', tab.name), el('span', 'count', tab.plots.length ? String(tab.plots.length) : ''));
      t.addEventListener('click', () => this.switchTab(tab.id));
      t.addEventListener('dblclick', () => this.renameTab(tab));
      t.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.tabMenu(tab, { left: e.clientX, bottom: e.clientY });
      });
      this.tabStrip.append(t);
    }
  }

  disposeCharts() {
    for (const c of this.charts.values()) c.dispose();
    this.charts.clear();
    this.cards.clear();
  }

  renderGrid() {
    this.disposeCharts();
    this.grid.textContent = '';
    this.renderTabs();
    if (this.soloId && !this.plots.some((p) => p.id === this.soloId)) this.leaveSolo(); // its plot was removed or moved
    if (!this.plots.length) {
      this.grid.classList.add('empty');
      this.grid.append(
        el('div', 'placeholder', 'No plots in this tab yet. Click “+ New plot”, or right-click a numeric topic in the tree (or a number in the inspector’s Tree view) and choose “Add to plot”.'),
      );
      return;
    }
    this.grid.classList.remove('empty');
    // Full screen shows just one plot, as the whole layout.
    const layout = this.soloId || this.model.layout();
    this.grid.append(
      renderMosaic(layout, {
        leaf: (id) => this.renderCard(this.model.plot(id)),
        dragHandle: this.soloId ? null : '.plot-head',
        noDrag: 'button, select, input, .seg',
        label: (id) => this.model.plot(id)?.title ?? '',
        externalTarget: (under) => {
          const tabEl = under.closest('.plot-tab');
          return tabEl && tabEl.dataset.tabId !== this.model.activeTabId ? { type: 'tab', tabId: tabEl.dataset.tabId, element: tabEl } : null;
        },
        onResize: (split, sizes) => this.model.setSplitSizes(split, sizes),
        onMove: (id, target) => this.movePlot(id, target),
      }),
    );
    this.redraw();
  }

  // Draws one plot's card again in place (after a change to its series or
  // settings) without rebuilding the others.
  rerenderCard(plotId) {
    const old = this.cards.get(plotId);
    const plot = this.model.plot(plotId);
    if (!old || !plot) return this.renderGrid();
    this.charts.get(plotId)?.dispose();
    const card = this.renderCard(plot);
    const leaf = old.parentElement;
    leaf.style.minWidth = card.style.minWidth;
    leaf.style.minHeight = card.style.minHeight;
    old.replaceWith(card);
    this.redraw();
  }

  renderCard(plot) {
    const solo = this.soloId === plot.id;
    const card = el('div', 'plot-card' + (plot.id === this.model.selectedId ? ' selected' : '') + (plot.kind === 'states' ? ' kind-states' : ''));
    card.dataset.plotId = plot.id;
    card.style.minWidth = `${MIN_PLOT_WIDTH}px`;
    card.style.minHeight = `${minPlotHeight(plot)}px`;
    card.addEventListener('mousedown', () => this.select(plot.id));

    const head = el('div', 'plot-head');
    const grip = el('span', 'plot-grip');
    grip.title = 'Drag to move this plot';
    grip.append(icon('move', 13));
    const title = el('span', 'plot-title', plot.title);
    title.title = 'Drag to move, double-click to rename';
    title.addEventListener('dblclick', () => this.renamePlot(plot));
    const full = iconButton(solo ? 'minimize' : 'maximize', solo ? 'Exit full screen (Esc)' : 'Show this plot full screen', () => this.toggleFullscreen(plot.id), 'btn icon small fullscreen-btn');
    head.append(
      grip,
      title,
      kindToggle(plot, (kind) => this.setKind(plot, kind)),
      windowSelect(plot, (windowSec) => {
        if (!this.model.updatePlot(plot.id, { windowSec })) return;
        this.renderSettings();
        this.redraw();
      }),
      // In a narrow plot these move into the ⋯ menu (see styles.css).
      button('+ Series', 'Add more values to this plot', () => this.openPicker(plot.id), 'btn small wide-only'),
      button('CSV', 'Export collected points as CSV', () => this.exportCsv(plot), 'btn small wide-only'),
      iconButton('settings', 'Plot settings', () => {
        this.select(plot.id);
        this.toggleSettings(true);
      }, 'btn icon small'),
      iconButton('external-link', 'Open this plot in its own window', () => this.popOut(plot), 'btn icon small popout-btn wide-only'),
      full,
      iconButton('more', 'More', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        showMenu(r.left, r.bottom + 4, [
          { label: 'Add series…', action: () => this.openPicker(plot.id) },
          { label: 'Export CSV…', action: () => this.exportCsv(plot) },
          { label: 'Open in its own window', action: () => this.popOut(plot) },
          'separator',
          { label: plot.kind === 'states' ? 'Show as lines' : 'Show as state transitions', action: () => this.setKind(plot, plot.kind === 'states' ? 'timeseries' : 'states') },
        ]);
      }, 'btn icon small narrow-only plot-more'),
      iconButton('x', 'Remove plot', () => this.removePlot(plot), 'btn icon small'),
    );

    const legend = renderLegend(plot, {
      onToggle: (s) => {
        if (!this.model.updateSeries(plot.id, s.id, { visible: !s.visible })) return;
        this.rerenderCard(plot.id);
        if (plot.id === this.model.selectedId) this.renderSettings();
      },
      onRename: (s) => this.renameSeries(plot, s),
      onRemove: (s) => this.model.removeSeries(plot.id, s.id) && this.renderAll(),
    });
    const host = el('div', 'plot-canvas');
    const reset = resetViewButton(() => this.resetZoom());
    reset.hidden = !(this.zoomByTab.has(this.tab.id) || this.yZoom.has(plot.id));
    card.append(head, legend, host);
    this.cards.set(plot.id, card);
    this.charts.set(
      plot.id,
      new LineChart(host, {
        onHover: (t) => this.syncHover(plot.id, t),
        onZoom: (z) => this.zoom(plot, z),
        onResetZoom: () => this.resetZoom(),
      }),
    );
    host.append(reset); // over the chart
    return card;
  }

  renderSettings() {
    renderPlotSettings(this.side, {
      model: this.model,
      plot: this.model.selected,
      openSeries: this.openSeries,
      onAddSeries: () => this.openPicker(this.model.selectedId),
      onHide: () => this.toggleSettings(false),
      onChanged: (what) => {
        const plot = this.model.selected;
        if (!plot) return;
        if (what === 'title') {
          const t = this.cards.get(plot.id)?.querySelector('.plot-title');
          if (t) t.textContent = plot.title;
        } else if (what === 'redraw') {
          this.redraw();
        } else if (what === 'card') {
          this.rerenderCard(plot.id); // the settings panel stays, so its inputs keep focus
        } else {
          this.yZoom.delete(plot.id);
          this.renderAll();
        }
      },
    });
  }

  // Hovering one plot moves the time bar on every plot and shows the values
  // at that moment in the legends.
  syncHover(fromId, t) {
    this.hoverTime = t;
    for (const [id, chart] of this.charts) if (id !== fromId) chart.setHoverTime(t);
    this.updateLegends();
  }

  updateLegends() {
    const pointsOf = (topic, segs) => this.data.points(topic, segs);
    for (const plot of this.plots) {
      const legend = this.cards.get(plot.id)?.querySelector('.plot-legend');
      if (legend && !legend.hidden) updateLegend(legend, plot, pointsOf, { hoverTime: this.hoverTime, frozenAt: this.frozenAt });
    }
  }

  redraw() {
    if (!this.visible) return;
    const zoom = this.zoomByTab.get(this.tab.id) || null;
    const now = Date.now();
    const pointsOf = (topic, segs) => this.data.points(topic, segs);
    for (const plot of this.plots) {
      const chart = this.charts.get(plot.id);
      if (!chart) continue;
      const series = chartSeries(plot, pointsOf);
      chart.setData(series, chartRange(plot, series, { zoom, frozenAt: this.frozenAt, now }), chartAxis(plot, this.yZoom.get(plot.id)));
    }
    this.updateLegends();
  }
}
