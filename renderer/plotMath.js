// Pure helpers for charts and plots (no DOM), shared by chart.js and plots.js.

export const seriesKey = (topic, segs) => `${topic}\u0000${JSON.stringify(segs || [])}`;

export function niceTicks(min, max, count = 5) {
  if (!(max > min)) {
    const c = Number.isFinite(min) ? min : 0;
    return { min: c - 1, max: c + 1, step: 0.5, ticks: [c - 1, c - 0.5, c, c + 0.5, c + 1] };
  }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  // Count steps instead of accumulating: avoids float drift (0 printed as
  // -1e-16) and endless loops when the step is below float resolution.
  const n = Math.max(1, Math.min(1000, Math.round((hi - lo) / step)));
  const ticks = [];
  for (let i = 0; i <= n; i++) ticks.push(Number((lo + i * step).toPrecision(12)) || 0);
  return { min: lo, max: hi, step, ticks };
}

export function formatValue(v) {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e7 || a < 1e-3)) return v.toExponential(2);
  return Number(v.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

// Point nearest to time `t` in a time-sorted array.
export function nearest(points, t) {
  if (!points.length) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1].t - t) <= Math.abs(points[lo].t - t)) lo--;
  return points[lo];
}

// The live time window ending at `now`. Until enough data has arrived to fill
// it, the window starts at the first point so the chart uses its full width.
export function windowRange(series, windowSec, now) {
  let first = Infinity;
  for (const s of series) if (s.points.length) first = Math.min(first, s.points[0].t);
  const full = now - windowSec * 1000;
  const t0 = Number.isFinite(first) ? Math.max(full, Math.min(first, now - 10000)) : full;
  return { t0, t1: now };
}
