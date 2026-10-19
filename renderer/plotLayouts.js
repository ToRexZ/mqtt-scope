// Plot definitions and saved layouts: validation, defaults and the file
// format used to share layouts. Pure (no DOM).

export const LAYOUT_FORMAT = 'mqtt-scope-plot-layout';
export const WINDOWS = [60, 300, 900, 3600, 0];
const DISPLAYS = new Set(['line', 'points', 'step', 'state']);
const MAX_SERIES = 8;
const HEX = /^#[0-9a-f]{6}$/i;

const newId = () => Math.random().toString(36).slice(2, 10);
const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A series with every field present and valid; null when unusable.
export function sanitizeSeries(s, slotFallback = 0) {
  if (!s || typeof s !== 'object' || typeof s.topic !== 'string' || !s.topic) return null;
  const segs = Array.isArray(s.segs) && s.segs.length ? s.segs.filter((x) => typeof x === 'string' || (Number.isInteger(x) && x >= 0)) : null;
  if (Array.isArray(s.segs) && segs && segs.length !== s.segs.length) return null;
  const out = {
    id: typeof s.id === 'string' && s.id ? s.id : newId(),
    topic: s.topic,
    segs: segs && segs.length ? segs : null,
    slot: Number.isInteger(s.slot) && s.slot >= 0 ? s.slot % MAX_SERIES : slotFallback % MAX_SERIES,
    display: DISPLAYS.has(s.display) ? s.display : 'line',
    width: Number.isInteger(s.width) && s.width >= 1 && s.width <= 6 ? s.width : 2,
    visible: s.visible !== false,
  };
  if (typeof s.alias === 'string' && s.alias.trim()) out.alias = s.alias.trim().slice(0, 120);
  if (typeof s.color === 'string' && HEX.test(s.color)) out.color = s.color.toLowerCase();
  return out;
}

export function sanitizePlot(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.series)) return null;
  const series = p.series
    .map((s, i) => sanitizeSeries(s, i))
    .filter(Boolean)
    .slice(0, MAX_SERIES);
  return {
    id: typeof p.id === 'string' && p.id ? p.id : newId(),
    title: typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 120) : series[0]?.topic || 'Plot',
    windowSec: WINDOWS.includes(p.windowSec) ? p.windowSec : 300,
    legend: p.legend !== false,
    legendValues: p.legendValues !== false,
    yMin: finiteOrNull(p.yMin),
    yMax: finiteOrNull(p.yMax),
    series,
  };
}

export const sanitizePlots = (list) => (Array.isArray(list) ? list.map(sanitizePlot).filter(Boolean) : []);

export function sanitizeLayouts(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((l) => l && typeof l === 'object' && typeof l.name === 'string' && l.name.trim())
    .map((l) => ({ id: typeof l.id === 'string' && l.id ? l.id : newId(), name: l.name.trim().slice(0, 80), plots: sanitizePlots(l.plots) }));
}

// Deep copy with fresh ids, so a loaded layout never shares objects with
// the saved one.
export function clonePlots(plots) {
  return sanitizePlots(JSON.parse(JSON.stringify(plots)));
}

// Whether two plot lists describe the same plots (ids ignored).
export function samePlots(a, b) {
  const strip = (list) => JSON.stringify(sanitizePlots(list).map(({ id, series, ...p }) => ({ ...p, series: series.map(({ id: _id, ...s }) => s) })));
  return strip(a) === strip(b);
}

export function layoutFile(name, plots) {
  return JSON.stringify({ format: LAYOUT_FORMAT, version: 1, name, plots: sanitizePlots(plots) }, null, 2);
}

// Parses a shared layout file; throws with a readable message when invalid.
export function parseLayoutFile(text, fallbackName = 'Imported layout') {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('Not a JSON file');
  }
  if (!doc || doc.format !== LAYOUT_FORMAT) throw new Error('Not an MQTT Scope plot layout');
  if (doc.version !== 1) throw new Error(`Unsupported layout version ${doc.version}`);
  const plots = sanitizePlots(doc.plots);
  if (!plots.length) throw new Error('The layout has no plots');
  const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim().slice(0, 80) : fallbackName;
  return { name, plots };
}
