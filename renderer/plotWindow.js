// A plot in its own window (opened from the plot's pop-out button). It starts
// with the points collected so far and keeps plotting the messages of the
// plot's topics, which the main process forwards. Changes made here (plot
// type, time window, freeze, zoom) only affect this window. Reload (Ctrl+R)
// in the main window starts it over.

import { el, button } from './ui.js';
import { LineChart } from './chart.js';
import { sanitizePlot } from './plotLayouts.js';
import { PlotData } from './plotData.js';
import { seriesKey } from './plotMath.js';
import { chartSeries, chartRange, chartAxis } from './plotView.js';
import { renderLegend, updateLegend, kindToggle, windowSelect, resetViewButton } from './plotCard.js';
import { normalizeSettings } from './settings.js';
import { comboFromEvent, keyBelongsToTarget, resolveBindings } from './keys.js';

const REDRAW_MS = 500;
const api = window.api;

const opened = await api.plotWindowInit();
if (opened?.plot) start(opened, resolveBindings(normalizeSettings(await api.storeGet('settings').catch(() => null)).keys));

function start(init, keys) {
  const plot = sanitizePlot(init.plot);
  document.title = init.title; // "<profile name> — <plot title>"
  const data = new PlotData();
  data.track(plot.series, (s) => {
    const pts = init.data?.[seriesKey(s.topic, s.segs)];
    return Array.isArray(pts) ? pts.filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.v)) : [];
  });
  const pointsOf = (topic, segs) => data.points(topic, segs);
  let frozenAt = null;
  let zoom = null; // { t0, t1, yMin?, yMax? }

  const card = el('div', 'plot-card plot-window-card');
  const head = el('div', 'plot-head');
  const title = el('span', 'plot-title', plot.title);
  title.title = init.tabName ? `From the tab “${init.tabName}”` : '';
  const freeze = button('Freeze', 'Stop the time axis', () => toggleFreeze(), 'btn small freeze-btn');
  const reset = resetViewButton(() => resetZoom());
  let kind;
  let legend;
  const host = el('div', 'plot-canvas');
  card.append(head, el('div'), host);
  document.body.append(card);

  const chart = new LineChart(host, {
    onHover: () => updateLegend(legend, plot, pointsOf, { hoverTime: chart.hoverTime, frozenAt }),
    onZoom: (z) => {
      zoom = z;
      reset.hidden = false;
      redraw();
    },
    onResetZoom: () => resetZoom(),
  });
  host.append(reset); // over the chart

  // Header and legend depend on the plot type (a State transitions plot has
  // no legend), so they are drawn again when it changes.
  function render() {
    card.classList.toggle('kind-states', plot.kind === 'states');
    const nextKind = kindToggle(plot, (k) => {
      plot.kind = k;
      if (zoom) zoom = { t0: zoom.t0, t1: zoom.t1 }; // a value zoom does not apply to the other type
      render();
    });
    if (kind) kind.replaceWith(nextKind);
    kind = nextKind;
    if (!head.children.length) {
      head.append(
        title,
        kind,
        windowSelect(plot, (sec) => {
          plot.windowSec = sec;
          redraw();
        }),
        freeze,
      );
    }
    const nextLegend = renderLegend(plot);
    (legend || card.children[1]).replaceWith(nextLegend);
    legend = nextLegend;
    redraw();
  }

  function redraw() {
    const series = chartSeries(plot, pointsOf);
    const yZoom = zoom && Number.isFinite(zoom.yMin) && Number.isFinite(zoom.yMax) ? zoom : null;
    chart.setData(series, chartRange(plot, series, { zoom, frozenAt }), chartAxis(plot, yZoom));
    updateLegend(legend, plot, pointsOf, { hoverTime: chart.hoverTime, frozenAt });
  }

  function toggleFreeze() {
    frozenAt = frozenAt ? null : Date.now();
    freeze.textContent = frozenAt ? 'Resume' : 'Freeze';
    freeze.classList.toggle('on', !!frozenAt);
    redraw();
  }

  function resetZoom() {
    zoom = null;
    reset.hidden = true;
    redraw();
  }

  api.onMessages(({ messages }) => {
    for (const msg of messages) data.ingest(msg);
  });

  api.onReset(() => {
    data.clear();
    if (frozenAt) toggleFreeze();
    resetZoom();
  });

  // The user's Hold shortcut (Space by default) freezes; Esc resets the zoom;
  // Close the tab (Mod+W) closes this window.
  freeze.title = `Stop the time axis${keys.hold ? ` (${keys.hold})` : ''}`;
  document.addEventListener('keydown', (e) => {
    const combo = comboFromEvent(e);
    if (keyBelongsToTarget(combo, e.target)) return;
    if (keys.hold && combo === keys.hold && !e.repeat) {
      e.preventDefault();
      toggleFreeze();
    } else if (keys.closeTab && combo === keys.closeTab) {
      e.preventDefault();
      window.close();
    } else if (e.key === 'Escape' && zoom) {
      resetZoom();
    }
  });

  render();
  setInterval(() => !frozenAt && redraw(), REDRAW_MS);
  // Exposed for end-to-end tests.
  window.__plotWindow = { plot, data, chart };
}
