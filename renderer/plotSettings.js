// The settings panel for the selected plot (laid out like Lichtblick's plot
// panel): title, plot type, time window, legend, y-axis range and, per
// series, visibility, label, colour, display style and line width. Changes
// go through the plot model, which validates and saves them.
//
//   renderPlotSettings(container, {
//     model, plot,           // plot: the selected plot, or null
//     openSeries,            // Set of series ids whose details are open (kept across renders)
//     onChanged(what),       // what the plot needs: 'title' (its title text), 'redraw',
//                            // 'card' (draw its card again) or 'all' (everything)
//     onAddSeries(), onHide(),
//   });

import { el, button } from './ui.js';
import { iconButton, setIcon } from './icons.js';
import { WINDOWS, MAX_SERIES } from './plotLayouts.js';
import { WINDOW_LABELS, KIND_LABELS, DISPLAY_LABELS, labelOf, sourceLabel, paletteVar } from './plotView.js';
import { resolvedColor } from './plotCard.js';

const LINE_WIDTHS = [1, 2, 3, 4, 5, 6];

export function renderPlotSettings(container, { model, plot, openSeries, onChanged, onAddSeries, onHide }) {
  container.textContent = '';
  const heading = el('div', 'ps-heading');
  heading.append(el('span', '', 'Plot settings'), iconButton('chevrons-left', 'Hide the settings panel', onHide, 'btn icon small ps-hide'));
  container.append(heading);
  if (!plot) {
    container.append(el('div', 'placeholder small', model.plots.length ? 'Select a plot to change its settings.' : 'Add a plot to configure it here.'));
    return;
  }
  const update = (patch, what) => model.updatePlot(plot.id, patch) && onChanged(what);

  // General
  const title = Object.assign(el('input', 'input'), { value: plot.title, name: 'plot-title', spellcheck: false });
  title.addEventListener('input', () => update({ title: title.value }, 'title'));
  const kind = select('plot-kind', Object.entries(KIND_LABELS), plot.kind);
  kind.addEventListener('change', () => update({ kind: kind.value }, 'all'));
  const win = select('plot-window', WINDOWS.map((sec) => [String(sec), WINDOW_LABELS[sec]]), String(plot.windowSec));
  win.addEventListener('change', () => update({ windowSec: Number(win.value) }, 'card'));

  // Legend
  const check = (label, key) => {
    const c = Object.assign(el('input'), { type: 'checkbox', checked: plot[key], name: `plot-${key}` });
    c.addEventListener('change', () => update({ [key]: c.checked }, 'card'));
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
      update({ [key]: Number.isFinite(v) ? v : null }, 'redraw');
    });
    return i;
  };

  // Series
  const seriesHead = el('div', 'ps-series-head');
  const add = button('+ Add series', 'Pick more values for this plot', onAddSeries, 'btn small');
  add.disabled = plot.series.length >= MAX_SERIES;
  seriesHead.append(el('span', 'muted small', `${plot.series.length} of ${MAX_SERIES}`), add);
  const list = el('div', 'ps-series');
  for (const s of plot.series) list.append(seriesSettings(model, plot, s, { openSeries, onChanged }));

  // A State transitions plot labels its lanes and has no y axis.
  const legend = section('Legend', check('Show legend', 'legend'), check('Show values', 'legendValues'));
  legend.hidden = plot.kind === 'states';
  const yAxis = section('Y axis', row('Min', axisInput('yMin')), row('Max', axisInput('yMax')));
  yAxis.hidden = plot.kind === 'states';
  const xAxis = section('X axis', check('Vertical lines at timestamps', 'timeGrid'));
  container.append(section('General', row('Title', title), row('Plot type', kind), row('Time window', win)), legend, xAxis, yAxis, section('Series', seriesHead, list));
}

function seriesSettings(model, plot, s, { openSeries, onChanged }) {
  const item = el('details', 'ps-series-item' + (s.visible ? '' : ' off'));
  item.dataset.seriesId = s.id;
  item.open = openSeries.has(s.id);
  item.addEventListener('toggle', () => (item.open ? openSeries.add(s.id) : openSeries.delete(s.id)));
  const update = (patch, what = 'card') => model.updateSeries(plot.id, s.id, patch) && onChanged(what);

  const summary = el('summary', 'ps-series-summary');
  const eye = iconButton(s.visible ? 'eye' : 'eye-off', s.visible ? 'Hide' : 'Show', (e) => {
    e.preventDefault();
    update({ visible: !s.visible });
    setIcon(eye, s.visible ? 'eye' : 'eye-off');
    eye.title = s.visible ? 'Hide' : 'Show';
    eye.setAttribute('aria-label', eye.title);
    item.classList.toggle('off', !s.visible);
  }, 'btn icon small ps-eye');
  const sw = el('span', 'swatch');
  sw.style.background = resolvedColor(s);
  const name = el('span', 'ps-series-name', labelOf(s));
  name.title = sourceLabel(s.topic, s.segs);
  const remove = iconButton('x', 'Remove series', (e) => {
    e.preventDefault();
    if (model.removeSeries(plot.id, s.id)) onChanged('all');
  }, 'btn icon small');
  summary.append(eye, sw, name, remove);

  const body = el('div', 'ps-series-body');
  body.append(row('Source', el('code', 'ps-source', sourceLabel(s.topic, s.segs))));

  const alias = Object.assign(el('input', 'input'), { value: s.alias || '', placeholder: sourceLabel(s.topic, s.segs), name: 'series-alias', spellcheck: false });
  alias.addEventListener('input', () => {
    update({ alias: alias.value });
    name.textContent = labelOf(s);
  });
  body.append(row('Label', alias));

  // Colour: any colour from the picker, or one of the palette colours.
  const colors = el('div', 'ps-colors');
  const picker = Object.assign(el('input', 'ps-color'), { type: 'color', value: resolvedColor(s), name: 'series-color', title: 'Pick any colour' });
  const showColor = () => {
    sw.style.background = resolvedColor(s);
    picker.value = resolvedColor(s);
    for (const b of colors.querySelectorAll('.ps-palette')) b.classList.toggle('on', !s.color && Number(b.dataset.slot) === s.slot);
  };
  picker.addEventListener('input', () => {
    update({ color: picker.value });
    showColor();
  });
  colors.append(picker);
  for (let slot = 0; slot < MAX_SERIES; slot++) {
    const b = button('', `Palette colour ${slot + 1}`, () => {
      update({ slot });
      showColor();
    }, 'ps-palette' + (!s.color && s.slot === slot ? ' on' : ''));
    b.dataset.slot = String(slot);
    b.style.background = `var(${paletteVar(slot)})`;
    colors.append(b);
  }
  body.append(row('Colour', colors));

  // In a state-transitions plot every series is a lane, so style does not apply.
  const display = select('series-display', DISPLAY_LABELS, s.display);
  const width = select('series-width', LINE_WIDTHS.map((w) => [String(w), `${w} px`]), String(s.width));
  const displayRow = row('Display', display);
  displayRow.hidden = plot.kind === 'states';
  const widthRow = row('Line width', width);
  widthRow.hidden = plot.kind === 'states' || s.display === 'state';
  display.addEventListener('change', () => {
    update({ display: display.value }, 'card');
    widthRow.hidden = s.display === 'state';
  });
  width.addEventListener('change', () => update({ width: Number(width.value) }, 'redraw'));
  body.append(displayRow, widthRow);
  item.append(summary, body);
  return item;
}

function section(name, ...children) {
  const d = el('details', 'ps-section');
  d.open = true;
  d.append(el('summary', '', name), ...children);
  return d;
}

function row(label, control) {
  const r = el('label', 'ps-row');
  r.append(el('span', 'ps-label', label), control);
  return r;
}

function select(name, options, value) {
  const s = el('select', 'select');
  s.name = name;
  for (const [v, l] of options) s.append(Object.assign(el('option', '', l), { value: v, selected: v === value }));
  return s;
}
