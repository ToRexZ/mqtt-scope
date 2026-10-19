// Canvas time chart. Numeric series share one y-axis (2px lines by default,
// recessive grid); state series (e.g. booleans) are drawn as horizontal bars
// below it that change colour with the value. Hovering shows a time bar and a
// tooltip; other charts can be told to show the time bar at the same instant
// (setHoverTime) so plots stay in sync.

import { el } from './ui.js';
import { formatTime } from './payload.js';
import { niceTicks, formatValue, nearest, stateSegments, isBinary } from './plotMath.js';

export { niceTicks, formatValue };

export const MAX_SERIES = 8;
export const DISPLAYS = [
  ['line', 'Line'],
  ['points', 'Line and points'],
  ['step', 'Steps'],
  ['state', 'State bar (true/false)'],
];
const PAD = { l: 64, r: 16, t: 14, b: 26 };
const STATE_ROW = 16;
const STATE_GAP = 4;
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400].map((s) => s * 1000);

// Colour of a series: its own colour, else its palette slot.
export const seriesColor = (s, token) => s.color || token(`--series-${((s.slot ?? 0) % MAX_SERIES) + 1}`);

export class LineChart {
  // opts.onHover(t | null): called with the hovered time (for syncing other charts).
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
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.canvas);
    this.canvas.addEventListener('mousemove', (e) => {
      const g = this.geom;
      if (!g) return;
      const x = e.clientX - this.canvas.getBoundingClientRect().left;
      const t = x < g.left || x > g.right ? null : g.t0 + ((x - g.left) / (g.right - g.left)) * (g.t1 - g.t0);
      this.localHover = t !== null;
      this.hoverTime = t;
      this.draw();
      this.opts.onHover?.(t);
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.localHover = false;
      this.hoverTime = null;
      this.tip.hidden = true;
      this.draw();
      this.opts.onHover?.(null);
    });
  }

  // series: [{ label, slot, color?, display?, width?, points: [{t, v}] }]
  // range: { t0, t1 } or null for the data extent. axis: { yMin?, yMax? }.
  setData(series, range = null, axis = {}) {
    this.series = series;
    this.range = range;
    this.axis = axis || {};
    this.draw();
  }

  // Time bar from another chart; ignored while this chart is hovered itself.
  setHoverTime(t) {
    if (this.localHover) return;
    this.hoverTime = t;
    this.draw();
  }

  dispose() {
    this.ro.disconnect();
    this.root.remove();
  }

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
    const states = this.series.filter((s) => s.display === 'state');
    const numeric = this.series.filter((s) => s.display !== 'state').map((s) => ({ ...s, points: s.points.filter((p) => p.t >= t0 && p.t <= t1) }));
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

    // Layout: state rows under the numeric area (or alone at the top).
    const stateH = states.length ? states.length * (STATE_ROW + STATE_GAP) : 0;
    const hasNumeric = numeric.length > 0 && Number.isFinite(min);
    const plotTop = PAD.t;
    const plotBottom = hasNumeric ? h - PAD.b - stateH - (stateH ? 8 : 0) : PAD.t;
    const stateTop = hasNumeric ? plotBottom + 8 : PAD.t;
    const left = PAD.l;
    const right = w - PAD.r;
    const X = (t) => left + ((t - t0) / (t1 - t0)) * (right - left);
    this.geom = { left, right, t0, t1 };

    // Time axis.
    ctx.fillStyle = token('--muted');
    const span = t1 - t0;
    const tStep = TIME_STEPS.find((s) => span / s <= Math.max(2, (right - left) / 110)) || TIME_STEPS.at(-1);
    ctx.textAlign = 'center';
    for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) {
      ctx.fillText(formatTime(t).slice(0, tStep < 1000 ? 12 : 8), X(t), h - PAD.b / 2);
    }

    // Numeric area: grid, y labels, lines.
    let Y = null;
    if (hasNumeric && plotBottom - plotTop > 20) {
      const lo = Number.isFinite(this.axis.yMin) ? this.axis.yMin : min;
      const hi = Number.isFinite(this.axis.yMax) ? this.axis.yMax : max;
      const fixed = Number.isFinite(this.axis.yMin) && Number.isFinite(this.axis.yMax) && hi > lo;
      const y = fixed
        ? { ...niceTicks(lo, hi, Math.max(2, Math.floor((plotBottom - plotTop) / 50))), min: lo, max: hi }
        : niceTicks(Math.min(lo, hi), Math.max(lo, hi), Math.max(2, Math.floor((plotBottom - plotTop) / 50)));
      Y = (v) => plotTop + (1 - (v - y.min) / (y.max - y.min)) * (plotBottom - plotTop);
      ctx.strokeStyle = token('--grid');
      ctx.fillStyle = token('--muted');
      ctx.lineWidth = 1;
      ctx.textAlign = 'right';
      for (const v of y.ticks) {
        if (v < y.min - 1e-9 || v > y.max + 1e-9) continue;
        const yy = Math.round(Y(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(left, yy);
        ctx.lineTo(right, yy);
        ctx.stroke();
        ctx.fillText(formatValue(v), left - 8, yy);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, plotTop - 2, right - left, plotBottom - plotTop + 4);
      ctx.clip();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const s of numeric) {
        if (!s.points.length) continue;
        const color = seriesColor(s, token);
        ctx.strokeStyle = color;
        ctx.lineWidth = s.width || 2;
        ctx.beginPath();
        s.points.forEach((p, i) => {
          if (i === 0) return ctx.moveTo(X(p.t), Y(p.v));
          if (s.display === 'step') ctx.lineTo(X(p.t), Y(s.points[i - 1].v));
          ctx.lineTo(X(p.t), Y(p.v));
        });
        ctx.stroke();
        if (s.display === 'points' || s.points.length <= 60) {
          ctx.fillStyle = color;
          const r = s.display === 'points' ? 3.5 : 3;
          for (const p of s.points) {
            ctx.beginPath();
            ctx.arc(X(p.t), Y(p.v), r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    // State bars.
    states.forEach((s, i) => {
      const top = stateTop + i * (STATE_ROW + STATE_GAP);
      const color = seriesColor(s, token);
      ctx.fillStyle = token('--state-off');
      ctx.fillRect(left, top, right - left, STATE_ROW);
      for (const seg of stateSegments(s.points, t0, t1)) {
        if (!seg.on) continue;
        ctx.fillStyle = color;
        ctx.fillRect(X(seg.from), top, Math.max(1, X(seg.to) - X(seg.from)), STATE_ROW);
      }
      ctx.fillStyle = token('--muted');
      ctx.textAlign = 'right';
      ctx.fillText(fit(ctx, s.label, left - 10), left - 8, top + STATE_ROW / 2);
    });

    this.drawHover(ctx, { token, X, Y, numeric, states, t0, t1, left, right, plotTop, plotBottom, stateTop, stateH, w });
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
    ctx.moveTo(x, g.plotTop);
    ctx.lineTo(x, g.states.length ? g.stateTop + g.stateH : g.plotBottom);
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
      const seg = stateSegments(s.points, g.t0, g.t1).find((x) => x.from <= t && t <= x.to);
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
      sw.style.background = s.color || `var(--series-${((s.slot ?? 0) % MAX_SERIES) + 1})`;
      row.append(sw, el('span', 'chart-tip-label', s.label), el('span', 'chart-tip-value', value));
      this.tip.append(row);
    }
    this.tip.hidden = false;
    const pos = x + 14;
    this.tip.style.left = `${pos + this.tip.offsetWidth > g.w ? x - this.tip.offsetWidth - 14 : pos}px`;
    this.tip.style.top = `${g.plotTop}px`;
  }
}

// Shortens text with an ellipsis to fit `width` pixels.
function fit(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`…${s}`).width > width) s = s.slice(1);
  return `…${s}`;
}
