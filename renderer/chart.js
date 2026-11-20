// Canvas time chart. In a time-series chart numeric series share one y-axis
// (2px lines by default, recessive grid) and state series (e.g. booleans) are
// drawn as state-transition lanes below it. A 'states' chart draws every
// series as a lane that shares the full height. Each lane has its label on
// its own line above the bar, so labels are never cut to fit a gutter.
//
// Hovering shows a time bar and a tooltip; other charts can be told to show
// the bar at the same instant (setHoverTime). The wheel zooms the timeline
// around the pointer, the sideways wheel (or Shift+wheel) and a pan drag move
// it, and a box drag selects a region to zoom into: all reported through
// opts.onZoom. Which drag pans and which draws the box: setPlotMouse().
// Double-click asks to reset (opts.onResetZoom).

import { el } from './ui.js';
import { formatTime } from './payload.js';
import { niceTicks, formatValue, nearest, stateSegments, isBinary, pointsBetween, decimate, zoomAround, panBy, dataExtent } from './plotMath.js';
import { paletteVar, seriesCss } from './plotView.js';
import { DEFAULT_MOUSE, normalizeMouse, dragAction } from './mouseBindings.js';

export { niceTicks, formatValue };

const PAD = { t: 12, r: 16, b: 26 };
const LANE_LABEL = 16; // label line above a lane's bar
const LANE_GAP = 6;
const MIXED_BAR = 16; // bar height of lanes under a numeric chart
const MIN_BAR = 10;
const MIN_DRAG = 6;
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400].map((s) => s * 1000);

const WHEEL_ZOOM = 0.002; // zoom factor per pixel of wheel: exp(deltaY × this)

// The drags of every chart in this window (Settings → Keyboard → Plot mouse).
let mouse = { ...DEFAULT_MOUSE };
export function setPlotMouse(bindings) {
  mouse = normalizeMouse(bindings);
}

// The plots area scrolled just now: a wheel that reaches a plot mid-scroll
// keeps scrolling rather than zooming it.
let scrolledAt = -Infinity;
const SCROLL_GRACE_MS = 300;
export function noteScroll() {
  scrolledAt = performance.now();
}

const sameRange = (a, b) =>
  Math.abs(a.t0 - b.t0) < 1e-6 && Math.abs(a.t1 - b.t1) < 1e-6 && (a.yMin ?? null) === (b.yMin ?? null) && (a.yMax ?? null) === (b.yMax ?? null);
const BUTTON_MASK = [1, 4, 2]; // MouseEvent.buttons bit of button 0 (left), 1 (middle), 2 (right)

// Colour of a series for the canvas: its own colour, else its palette colour.
const seriesColor = (s, token) => s.color || token(paletteVar(s.slot));

export class LineChart {
  // opts.onHover(t | null): the hovered time (for syncing other charts).
  // opts.onZoom({ t0, t1, yMin?, yMax? }): zoomed or panned (no yMin/yMax:
  //   the value range stays as it is).
  // opts.onResetZoom(): double-click.
  constructor(container, opts = {}) {
    this.opts = opts;
    this.root = el('div', 'chart-box');
    this.canvas = el('canvas', 'chart');
    this.tip = el('div', 'chart-tip');
    this.tip.hidden = true;
    this.root.append(this.canvas, this.tip);
    container.append(this.root);
    this.series = [];
    this.range = null;
    this.axis = {};
    this.hoverTime = null; // time under the time bar, local or synced
    this.localHover = false;
    this.geom = null;
    this.drag = null;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.canvas);
    this.canvas.addEventListener('mousemove', (e) => {
      const g = this.geom;
      if (!g || this.drag) return;
      const x = e.clientX - this.canvas.getBoundingClientRect().left;
      const t = x < g.left || x > g.right ? null : timeAt(g, x);
      this.localHover = t !== null;
      this.hoverTime = t;
      this.requestDraw();
      this.opts.onHover?.(t);
    });
    this.canvas.addEventListener('mouseleave', () => {
      if (this.drag) return;
      this.localHover = false;
      this.hoverTime = null;
      this.tip.hidden = true;
      this.requestDraw();
      this.opts.onHover?.(null);
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll
      if (this.drag) return; // one drag at a time: a second button does nothing
      const action = dragAction(e, mouse);
      if (action === 'box') this.startDrag(e);
      else if (action === 'pan') this.startPan(e);
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right drags; plots have no menu
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('dblclick', () => this.opts.onResetZoom?.());
  }

  // series: [{ label, slot, color?, display?, width?, points: [{t, v}] }]
  // range: { t0, t1 } or null for the data extent.
  // axis: { yMin?, yMax?, kind?: 'timeseries' | 'states', timeGrid?: vertical lines at the time ticks }.
  // home: the range shown without a zoom (null: the data); zooming out and
  //   panning may go as far as it and the data collected.
  // until: the freeze (ms) — zooming and panning never go past it.
  setData(series, range = null, axis = {}, home = null, until = null) {
    this.series = series;
    this.range = range;
    this.axis = axis || {};
    this.home = home;
    this.until = until;
    this.draw();
  }

  // The plot area and time range to zoom or pan in: what is drawn, else
  // (zoomed in where there are no points) the last layout with this range.
  viewGeom() {
    if (this.geom) return this.geom;
    const base = this.lastGeom || this.defaultGeom(); // a new chart (plots drawn again) has no last layout
    if (!base || !this.range) return null;
    return { ...base, t0: this.range.t0, t1: this.range.t1, y: null };
  }

  defaultGeom() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return w && h ? { left: 48, right: w - PAD.r, top: PAD.t, bottom: h - PAD.b } : null;
  }

  // `r` shows everything there is to see (the data and the normal view).
  showsAll(r) {
    const full = this.extentFor(r);
    const tol = Math.max(1e-6, (full.t1 - full.t0) * 0.02); // live data moves on between frames
    const covers = (a, b) => a.t0 <= b.t0 + tol && a.t1 >= b.t1 - tol;
    return covers(r, full) && (!this.home || covers(this.home, full));
  }

  // The time range differs from the normal view.
  isZoomed() {
    return this.home ? !(this.range && sameRange(this.range, this.home)) : this.range !== null;
  }

  // How far zooming out and panning may go from `range`.
  extentFor(range) {
    const h = this.home;
    const e = dataExtent(this.series, h ? { t0: Math.min(range.t0, h.t0), t1: Math.max(range.t1, h.t1) } : range);
    if (this.until !== null && this.until !== undefined) e.t1 = Math.max(range.t1, Math.min(e.t1, this.until)); // data after the freeze is not shown
    return e;
  }

  // Time bar from another chart; ignored while this chart is hovered itself.
  setHoverTime(t) {
    if (this.localHover) return;
    this.hoverTime = t;
    this.requestDraw();
  }

  // Hover moves draw at most once per frame, however fast the mouse moves.
  requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  dispose() {
    this.endDrag?.();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.ro.disconnect();
    this.root.remove();
  }

  // ------------------------------------------------------------ zoom

  // Wheel over the plotting area: zoom around the pointer, or pan sideways.
  // Steps of one frame add up and are applied once, at the next frame.
  onWheel(e) {
    const g = this.viewGeom();
    if (!g || performance.now() - scrolledAt < SCROLL_GRACE_MS) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < g.left || x > g.right || y < g.top || y > g.bottom) return;
    e.preventDefault(); // the plots area doesn't scroll under the pointer
    const w = (this.wheel ||= { from: { t0: g.t0, t1: g.t1 }, range: { t0: g.t0, t1: g.t1 }, frame: 0 });
    const range = w.range;
    const extent = this.extentFor(range);
    // Mostly sideways (a side wheel, a trackpad swipe) or Shift: pan; else zoom.
    const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY || e.deltaX : 0;
    if (sideways) w.range = panBy(range, (sideways / (g.right - g.left)) * (range.t1 - range.t0), extent);
    else if (e.deltaY) w.range = zoomAround(range, range.t0 + ((x - g.left) / (g.right - g.left)) * (range.t1 - range.t0), Math.exp(e.deltaY * WHEEL_ZOOM), extent);
    w.x = x;
    w.frame ||= requestAnimationFrame(() => {
      this.wheel = null;
      if (sameRange(w.range, w.from)) return; // nothing moved: stay live
      if (this.showsAll(w.range)) {
        // Zoomed out to everything there is: that is the normal view.
        if (this.isZoomed()) this.opts.onResetZoom?.();
        return;
      }
      this.opts.onZoom?.(w.range);
      this.hoverAt(w.x); // the time bar follows the pointer into the new range
    });
  }

  // Shows the time bar at canvas x (the pointer), as a mouse move would.
  hoverAt(x) {
    const g = this.viewGeom();
    if (!g || x < g.left || x > g.right) return;
    this.localHover = true;
    this.hoverTime = timeAt(g, x);
    this.requestDraw();
    this.opts.onHover?.(this.hoverTime);
  }

  // After a drag: the time bar stays only if the pointer is over the plot.
  hoverAfterDrag(ev) {
    const rect = this.canvas.getBoundingClientRect();
    if (ev && ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) return this.hoverAt(ev.clientX - rect.left);
    this.localHover = false;
    this.hoverTime = null;
    this.tip.hidden = true;
    this.requestDraw();
    this.opts.onHover?.(null);
  }

  // Follows one drag of e.button until that button is released (done(ev)),
  // or it is cancelled by Esc or a lost release (cancel()). A right drag
  // keeps a context menu from opening where it is released (Windows opens it
  // on release).
  follow(e, { move, done, cancel }) {
    const button = e.button;
    const mask = BUTTON_MASK[button] ?? 0;
    const blockMenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // nor the app's own menus
    };
    if (button === 2) window.addEventListener('contextmenu', blockMenu, true);
    const finish = (ev, ok) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey, true);
      if (button === 2) setTimeout(() => window.removeEventListener('contextmenu', blockMenu, true), 300);
      this.drag = null;
      this.endDrag = null;
      if (ok) done(ev);
      else cancel();
      this.hoverAfterDrag(ev);
    };
    const onMove = (ev) => (ev.buttons & mask ? move(ev) : finish(ev, false)); // released outside the window
    const onUp = (ev) => ev.button === button && finish(ev, true);
    const onKey = (ev) => ev.key === 'Escape' && finish(null, false); // Esc also goes back to live (the app's Esc)
    this.endDrag = () => finish(null, false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey, true);
  }

  // Dragging moves the timeline (and the values, in a value zoom) with the
  // pointer; at most one zoom report per frame, none when nothing moved.
  startPan(e) {
    const g = this.viewGeom();
    if (!g) return;
    const rect = this.canvas.getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    if (x0 < g.left || x0 > g.right || y0 < g.top || y0 > g.bottom) return;
    e.preventDefault();
    const range = { t0: g.t0, t1: g.t1 };
    const extent = this.extentFor(range);
    const values = this.axis.yZoomed && g.y ? { min: g.y.min, max: g.y.max, px: g.y.bottom - g.y.top } : null;
    const start = values ? { ...range, yMin: values.min, yMax: values.max } : range;
    let last = start;
    let pending = null;
    let frame = 0;
    const report = () => {
      frame = 0;
      if (pending && !sameRange(pending, last)) this.opts.onZoom?.((last = pending));
      pending = null;
    };
    this.drag = { pan: true };
    this.root.classList.add('panning');
    this.follow(e, {
      move: (ev) => {
        const dx = ev.clientX - rect.left - x0;
        const dy = ev.clientY - rect.top - y0;
        const z = panBy(range, (-dx / (g.right - g.left)) * (range.t1 - range.t0), extent);
        if (values) {
          const dv = (dy / values.px) * (values.max - values.min);
          Object.assign(z, { yMin: values.min + dv, yMax: values.max + dv });
        }
        pending = z;
        frame ||= requestAnimationFrame(report);
      },
      done: () => {
        if (frame) cancelAnimationFrame(frame);
        report();
        this.root.classList.remove('panning');
      },
      cancel: () => {
        if (frame) cancelAnimationFrame(frame);
        pending = null;
        this.root.classList.remove('panning');
      },
    });
  }

  // A box drag selects the time range (and the values, when it starts in the
  // numeric area and is tall enough) to zoom into.
  startDrag(e) {
    const g = this.geom;
    if (!g) return;
    const rect = this.canvas.getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    if (x0 < g.left || x0 > g.right || y0 < g.top || y0 > g.bottom) return;
    e.preventDefault(); // no text selection while dragging
    const yZoom = !!g.y && y0 >= g.y.top && y0 <= g.y.bottom;
    const sel = el('div', 'chart-sel');
    this.root.append(sel);
    const d = { x0, y0, x1: x0, y1: y0, yZoom, sel };
    this.drag = d;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    this.follow(e, {
      move: (ev) => {
        d.x1 = clamp(ev.clientX - rect.left, g.left, g.right);
        d.y1 = ev.clientY - rect.top;
        const tall = d.yZoom && Math.abs(d.y1 - d.y0) >= 12;
        const top = tall ? clamp(Math.min(d.y0, d.y1), g.y.top, g.y.bottom) : g.top;
        const bottom = tall ? clamp(Math.max(d.y0, d.y1), g.y.top, g.y.bottom) : g.bottom;
        Object.assign(sel.style, {
          left: `${Math.min(d.x0, d.x1)}px`,
          width: `${Math.abs(d.x1 - d.x0)}px`,
          top: `${top}px`,
          height: `${bottom - top}px`,
        });
      },
      done: () => {
        sel.remove();
        if (Math.abs(d.x1 - d.x0) < MIN_DRAG) return;
        // `g`: the geometry when the drag started (the chart may have redrawn since).
        const zoom = { t0: timeAt(g, Math.min(d.x0, d.x1)), t1: timeAt(g, Math.max(d.x0, d.x1)) };
        if (d.yZoom && Math.abs(d.y1 - d.y0) >= 12) {
          const valueAt = (y) => g.y.min + (1 - (clamp(y, g.y.top, g.y.bottom) - g.y.top) / (g.y.bottom - g.y.top)) * (g.y.max - g.y.min);
          zoom.yMin = valueAt(Math.max(d.y0, d.y1));
          zoom.yMax = valueAt(Math.min(d.y0, d.y1));
        }
        this.opts.onZoom?.(zoom);
      },
      cancel: () => sel.remove(),
    });
  }

  // ------------------------------------------------------------ drawing

  draw() {
    const canvas = this.canvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(canvas);
    const token = (name) => css.getPropertyValue(name).trim();

    let t0 = this.range?.t0 ?? Infinity;
    let t1 = this.range?.t1 ?? -Infinity;
    if (!this.range) {
      for (const s of this.series) {
        if (!s.points.length) continue;
        t0 = Math.min(t0, s.points[0].t);
        t1 = Math.max(t1, s.points[s.points.length - 1].t);
      }
    }
    const allStates = this.axis.kind === 'states';
    const states = allStates ? this.series : this.series.filter((s) => s.display === 'state');
    // `points`: those in the time range; `all`: every point (to draw lines to the edges).
    const numeric = allStates ? [] : this.series.filter((s) => s.display !== 'state').map((s) => ({ ...s, all: s.points, points: pointsBetween(s.points, t0, t1) }));
    let min = Infinity;
    let max = -Infinity;
    for (const s of numeric) for (const p of s.points) (min = Math.min(min, p.v)), (max = Math.max(max, p.v));
    const hasStates = states.some((s) => s.points.length && s.points[0].t <= t1);

    ctx.font = '11px ui-monospace, "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    if ((!Number.isFinite(min) && !hasStates) || !Number.isFinite(t0) || t1 <= t0) {
      this.geom = null;
      ctx.fillStyle = token('--muted');
      ctx.textAlign = 'center';
      ctx.fillText('No data in this time window', w / 2, h / 2);
      this.tip.hidden = true;
      return;
    }

    // Vertical layout: numeric area on top, lanes below (or lanes only).
    const hasNumeric = numeric.length > 0 && Number.isFinite(min);
    const top = PAD.t;
    const bottom = h - PAD.b;
    let lanesTop = top;
    let bar = MIXED_BAR;
    let laneH = LANE_LABEL + MIXED_BAR + LANE_GAP;
    let laneStep = laneH;
    if (hasNumeric) {
      lanesTop = bottom - states.length * laneH + (states.length ? LANE_GAP : 0);
    } else if (states.length) {
      laneH = (bottom - top + LANE_GAP) / states.length;
      bar = Math.min(56, laneH - LANE_LABEL - LANE_GAP);
      // Spread the lanes over the whole height: first at the top, last at the bottom.
      if (states.length > 1 && bar >= MIN_BAR) laneStep = (bottom - top - LANE_LABEL - bar) / (states.length - 1);
      else laneStep = laneH;
    }
    const numBottom = states.length && hasNumeric ? lanesTop - LANE_GAP : bottom;

    // y ticks first: the gutter is as wide as the widest label.
    let y = null;
    if (hasNumeric && numBottom - top > 20) {
      const lo = Number.isFinite(this.axis.yMin) ? this.axis.yMin : min;
      const hi = Number.isFinite(this.axis.yMax) ? this.axis.yMax : max;
      const fixed = Number.isFinite(this.axis.yMin) && Number.isFinite(this.axis.yMax) && hi > lo;
      const count = Math.max(2, Math.floor((numBottom - top) / 50));
      y = fixed ? { ...niceTicks(lo, hi, count), min: lo, max: hi } : niceTicks(Math.min(lo, hi), Math.max(lo, hi), count);
      y.labels = y.ticks.filter((v) => v >= y.min - 1e-9 && v <= y.max + 1e-9).map((v) => [v, formatValue(v)]);
    }
    const gutter = y ? Math.max(...y.labels.map(([, l]) => ctx.measureText(l).width)) + 14 : 0;
    const left = Math.max(y ? 40 : 10, Math.ceil(gutter));
    const right = w - PAD.r;
    const X = (t) => left + ((t - t0) / (t1 - t0)) * (right - left);
    const Y = y ? (v) => top + (1 - (v - y.min) / (y.max - y.min)) * (numBottom - top) : null;
    // laneLabels: what each lane shows (read by tests and for debugging).
    this.geom = { left, right, top, bottom, t0, t1, y: y ? { top, bottom: numBottom, min: y.min, max: y.max } : null, lanes: states.length, laneLabels: [] };
    this.lastGeom = this.geom; // the plot area, for zooming where nothing is drawn

    // Time axis.
    ctx.fillStyle = token('--muted');
    const span = t1 - t0;
    const tStep = TIME_STEPS.find((s) => span / s <= Math.max(2, (right - left) / 110)) || TIME_STEPS.at(-1);
    ctx.textAlign = 'center';
    const ticks = [];
    for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) {
      ctx.fillText(formatTime(t).slice(0, tStep < 1000 ? 12 : 8), X(t), h - PAD.b / 2);
      ticks.push(Math.round(X(t)) + 0.5);
    }
    // Vertical lines at the timestamps: behind the lines of a numeric chart;
    // state lanes draw them over their bars (see drawLane).
    const timeGrid = this.axis.timeGrid !== false;
    this.geom.timeGrid = timeGrid ? ticks : [];
    const verticals = (from, to) => {
      ctx.beginPath();
      for (const x of ticks) {
        ctx.moveTo(x, from);
        ctx.lineTo(x, to);
      }
      ctx.stroke();
    };

    // Numeric area: grid, y labels, lines.
    if (y) {
      ctx.strokeStyle = token('--grid');
      ctx.fillStyle = token('--muted');
      ctx.lineWidth = 1;
      ctx.textAlign = 'right';
      for (const [v, label] of y.labels) {
        const yy = Math.round(Y(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(left, yy);
        ctx.lineTo(right, yy);
        ctx.stroke();
        ctx.fillText(label, left - 8, yy);
      }
      if (timeGrid) verticals(top, numBottom);
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top - 2, right - left, numBottom - top + 4);
      ctx.clip();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const s of numeric) {
        if (!s.points.length) continue;
        const color = seriesColor(s, token);
        ctx.strokeStyle = color;
        ctx.lineWidth = s.width || 2;
        ctx.beginPath();
        // At most a few points per pixel column: the line looks the same.
        const line = decimate(s.all, t0, t1, Math.ceil(right - left));
        line.forEach((p, i) => {
          if (i === 0) return ctx.moveTo(X(p.t), Y(p.v));
          if (s.display === 'step') ctx.lineTo(X(p.t), Y(line[i - 1].v));
          ctx.lineTo(X(p.t), Y(p.v));
        });
        ctx.stroke();
        if (s.display === 'points' || s.points.length <= 60) {
          ctx.fillStyle = color;
          const r = s.display === 'points' ? 3.5 : 3;
          for (const p of s.points.length <= 60 ? s.points : pointsBetween(line, t0, t1)) {
            ctx.beginPath();
            ctx.arc(X(p.t), Y(p.v), r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    // State-transition lanes: label line, then the bar.
    // Too little height for a label line: the label goes inside the bar.
    const inline = bar < MIN_BAR;
    const lanes = states.map((s, i) => {
      const laneTop = lanesTop + i * laneStep;
      if (inline) return { s, inline, barTop: laneTop, bar: Math.max(4, laneH - 2) };
      return { s, labelY: laneTop + LANE_LABEL / 2, barTop: laneTop + LANE_LABEL, bar };
    });
    for (const lane of lanes) this.drawLane(ctx, lane, { token, X, t0, t1, left, right, ticks: timeGrid ? ticks : [] });
    this.geom.laneBars = lanes.map((l) => ({ top: l.barTop, height: l.bar })); // for tests and debugging

    this.drawHover(ctx, { token, X, Y, numeric, states, t0, t1, left, right, top, bottom, w });
  }

  drawLane(ctx, { s, inline, labelY, barTop, bar }, { token, X, t0, t1, left, right, ticks }) {
    const color = seriesColor(s, token);
    const binary = isBinary(s.points);
    const segs = stateSegments(s.points, t0, t1);
    const show = (seg) => (binary ? (seg.on ? 'true' : 'false') : formatValue(seg.value));
    ctx.textAlign = 'left';

    ctx.fillStyle = token('--state-off');
    ctx.fillRect(left, barTop, right - left, bar);
    // Values other than true/false get shades of the series colour.
    const values = binary ? [] : [...new Set(segs.map((g) => g.value))].sort((a, b) => a - b);
    const alpha = (v) => (values.length < 2 ? 0.85 : 0.3 + (0.7 * values.indexOf(v)) / (values.length - 1));
    segs.forEach((seg, i) => {
      const x0 = X(seg.from);
      const x1 = X(seg.to);
      const width = Math.max(1, x1 - x0);
      const filled = binary ? seg.on : true;
      if (filled) {
        ctx.globalAlpha = binary ? 1 : alpha(seg.value);
        ctx.fillStyle = color;
        ctx.fillRect(x0, barTop, width, bar);
        ctx.globalAlpha = 1;
      }
      // A thin gap marks every transition, even between similar shades.
      if (i > 0) {
        ctx.fillStyle = token('--panel-2');
        ctx.fillRect(Math.round(x0) - 0.5, barTop, 1, bar);
      }
    });

    // Lines at the timestamps, over the bar (it would hide them) but under
    // the values written in it. Light on dark bars, dark on light ones: the
    // text colour, half see-through.
    if (ticks.length) {
      ctx.save();
      ctx.strokeStyle = token('--text');
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const x of ticks) {
        ctx.moveTo(x, barTop);
        ctx.lineTo(x, barTop + bar);
      }
      ctx.stroke();
      ctx.restore();
    }

    segs.forEach((seg) => {
      const x0 = X(seg.from);
      const width = Math.max(1, X(seg.to) - x0);
      const filled = binary ? seg.on : true;
      const text = show(seg);
      if (!inline && bar >= 12 && ctx.measureText(text).width + 10 <= width) {
        ctx.fillStyle = filled ? readableOn(color, binary ? 1 : alpha(seg.value), token('--state-off')) : token('--muted');
        ctx.fillText(text, x0 + 5, barTop + bar / 2 + 0.5);
      }
    });

    // Label with the value at the time bar (else the latest one).
    const t = this.hoverTime;
    const at = t !== null && t >= t0 && t <= t1 ? segs.find((g) => g.from <= t && t <= g.to) : segs.at(-1);
    const value = at ? show(at) : '';
    ctx.textAlign = 'left';
    const valueW = value ? ctx.measureText(`  ${value}`).width : 0;
    const label = fit(ctx, s.label, Math.max(20, right - left - valueW - (inline ? 12 : 0)));
    const labelW = ctx.measureText(label).width;
    const y = inline ? barTop + bar / 2 + 0.5 : labelY;
    if (inline) {
      // Keep the text readable over the bar.
      ctx.fillStyle = token('--panel-2');
      ctx.globalAlpha = 0.85;
      ctx.fillRect(left + 2, barTop + 1, labelW + valueW + 8, Math.max(2, bar - 2));
      ctx.globalAlpha = 1;
    }
    const x = left + (inline ? 6 : 0);
    this.geom.laneLabels.push({ label, value });
    ctx.fillStyle = token('--text');
    ctx.fillText(label, x, y);
    if (value) {
      ctx.fillStyle = token('--muted');
      ctx.fillText(`  ${value}`, x + labelW, y);
    }
  }

  drawHover(ctx, g) {
    const t = this.hoverTime;
    if (t === null || t < g.t0 || t > g.t1) {
      this.tip.hidden = true;
      return;
    }
    const x = Math.round(g.X(t)) + 0.5;
    ctx.strokeStyle = g.token('--muted');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, g.top);
    ctx.lineTo(x, g.bottom);
    ctx.stroke();

    const rows = [];
    for (const s of g.numeric) {
      const p = nearest(s.points, t);
      if (!p || !g.Y) continue;
      ctx.fillStyle = seriesColor(s, g.token);
      ctx.strokeStyle = g.token('--panel');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(g.X(p.t), g.Y(p.v), 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      rows.push([s, formatValue(p.v)]);
    }
    for (const s of g.states) {
      const seg = stateSegments(s.points, g.t0, g.t1).find((span) => span.from <= t && t <= span.to);
      if (seg) rows.push([s, isBinary(s.points) ? (seg.on ? 'true' : 'false') : formatValue(seg.value)]);
    }
    // Only the chart under the mouse shows the tooltip; synced charts show the bar.
    if (!this.localHover || !rows.length) {
      this.tip.hidden = true;
      return;
    }
    this.tip.textContent = '';
    this.tip.append(el('div', 'chart-tip-time', formatTime(t)));
    for (const [s, value] of rows) {
      const row = el('div', 'chart-tip-row');
      const sw = el('span', 'swatch');
      sw.style.background = seriesCss(s);
      row.append(sw, el('span', 'chart-tip-label', s.label), el('span', 'chart-tip-value', value));
      this.tip.append(row);
    }
    this.tip.hidden = false;
    const pos = x + 14;
    this.tip.style.left = `${pos + this.tip.offsetWidth > g.w ? x - this.tip.offsetWidth - 14 : pos}px`;
    this.tip.style.top = `${g.top}px`;
  }
}

// Shortens text with an ellipsis at the end to fit `width` pixels.
function fit(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > width) s = s.slice(0, -1);
  return `${s}…`;
}

// Dark or light text, whichever reads better on `color` drawn at `alpha`
// over the lane background `under`.
function readableOn(color, alpha, under) {
  const rgb = (c) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = rgb(color);
  const b = rgb(under) || [128, 128, 128];
  if (!a) return '#ffffff';
  const mix = a.map((c, i) => c * alpha + b[i] * (1 - alpha));
  const lum = (0.2126 * mix[0] + 0.7152 * mix[1] + 0.0722 * mix[2]) / 255;
  return lum > 0.55 ? '#111418' : '#ffffff';
}

// The time at x (px) in a chart's geometry.
function timeAt(g, x) {
  return g.t0 + ((x - g.left) / (g.right - g.left)) * (g.t1 - g.t0);
}
