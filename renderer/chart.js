// Canvas line chart for numeric values over time. One shared y-axis, 2px
// lines, recessive grid, crosshair + tooltip on hover. Series colours come
// from the --series-N CSS tokens and follow the series (its `slot`), never
// its position in the list.

import { el } from './ui.js';
import { formatTime } from './payload.js';
import { niceTicks, formatValue, nearest } from './plotMath.js';

export { niceTicks, formatValue };

export const MAX_SERIES = 8;
const PAD = { l: 64, r: 16, t: 14, b: 26 };
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400].map((s) => s * 1000);

export class LineChart {
  constructor(container) {
    this.root = el('div', 'chart-box');
    this.canvas = el('canvas', 'chart');
    this.tip = el('div', 'chart-tip');
    this.tip.hidden = true;
    this.root.append(this.canvas, this.tip);
    container.append(this.root);
    this.series = [];
    this.range = null;
    this.hoverX = null;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.canvas);
    this.canvas.addEventListener('mousemove', (e) => {
      this.hoverX = e.clientX - this.canvas.getBoundingClientRect().left;
      this.draw();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverX = null;
      this.tip.hidden = true;
      this.draw();
    });
  }

  // series: [{ label, slot, points: [{t, v}] }]; range: { t0, t1 } or null for the data extent.
  setData(series, range = null) {
    this.series = series;
    this.range = range;
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
    const visible = this.series.map((s) => ({ ...s, points: s.points.filter((p) => p.t >= t0 && p.t <= t1) }));
    let min = Infinity;
    let max = -Infinity;
    for (const s of visible) for (const p of s.points) (min = Math.min(min, p.v)), (max = Math.max(max, p.v));

    ctx.font = '11px ui-monospace, "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    if (!Number.isFinite(min) || !Number.isFinite(t0) || t1 <= t0) {
      ctx.fillStyle = token('--muted');
      ctx.textAlign = 'center';
      ctx.fillText('No data in this time window', w / 2, h / 2);
      return;
    }
    const y = niceTicks(min, max, Math.max(2, Math.floor((h - PAD.t - PAD.b) / 50)));
    const X = (t) => PAD.l + ((t - t0) / (t1 - t0)) * (w - PAD.l - PAD.r);
    const Y = (v) => PAD.t + (1 - (v - y.min) / (y.max - y.min)) * (h - PAD.t - PAD.b);

    // Grid and axis labels.
    ctx.strokeStyle = token('--grid');
    ctx.fillStyle = token('--muted');
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (const v of y.ticks) {
      const yy = Math.round(Y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, yy);
      ctx.lineTo(w - PAD.r, yy);
      ctx.stroke();
      ctx.fillText(formatValue(v), PAD.l - 8, yy);
    }
    const span = t1 - t0;
    const tStep = TIME_STEPS.find((s) => span / s <= Math.max(2, (w - PAD.l - PAD.r) / 110)) || TIME_STEPS.at(-1);
    ctx.textAlign = 'center';
    for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) {
      const label = formatTime(t).slice(0, tStep < 1000 ? 12 : 8);
      ctx.fillText(label, X(t), h - PAD.b / 2);
    }

    // Lines.
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of visible) {
      if (!s.points.length) continue;
      const color = token(`--series-${(s.slot % MAX_SERIES) + 1}`);
      ctx.strokeStyle = color;
      ctx.beginPath();
      s.points.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v))));
      ctx.stroke();
      if (s.points.length <= 60) {
        ctx.fillStyle = color;
        for (const p of s.points) {
          ctx.beginPath();
          ctx.arc(X(p.t), Y(p.v), 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Crosshair and tooltip.
    if (this.hoverX === null || this.hoverX < PAD.l || this.hoverX > w - PAD.r) {
      this.tip.hidden = true;
      return;
    }
    const tHover = t0 + ((this.hoverX - PAD.l) / (w - PAD.l - PAD.r)) * span;
    ctx.strokeStyle = token('--muted');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(this.hoverX) + 0.5, PAD.t);
    ctx.lineTo(Math.round(this.hoverX) + 0.5, h - PAD.b);
    ctx.stroke();
    this.tip.textContent = '';
    this.tip.append(el('div', 'chart-tip-time', formatTime(tHover)));
    for (const s of visible) {
      const p = nearest(s.points, tHover);
      if (!p) continue;
      ctx.fillStyle = token(`--series-${(s.slot % MAX_SERIES) + 1}`);
      ctx.strokeStyle = token('--panel');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(p.t), Y(p.v), 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const row = el('div', 'chart-tip-row');
      const sw = el('span', 'swatch');
      sw.style.background = `var(--series-${(s.slot % MAX_SERIES) + 1})`;
      row.append(sw, el('span', 'chart-tip-label', s.label), el('span', 'chart-tip-value', formatValue(p.v)));
      this.tip.append(row);
    }
    this.tip.hidden = false;
    const left = this.hoverX + 14;
    this.tip.style.left = `${left + this.tip.offsetWidth > w ? this.hoverX - this.tip.offsetWidth - 14 : left}px`;
    this.tip.style.top = `${PAD.t}px`;
  }
}
