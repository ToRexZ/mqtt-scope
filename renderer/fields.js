// Flattens a message into rows for the plot picker: containers (objects and
// arrays) and leaves in document order, with depth and JSON path. Pure.

import { childPath } from './jsonPath.js';
import { decode, isDecimal } from './payload.js';

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isContainer = (r) => r.kind === 'object' || r.kind === 'array';

// A leaf can be plotted when extractNumber() would turn it into a number.
const plottable = (v) =>
  (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || isDecimal(v);

// Rows for one message. A numeric/text payload becomes a single "payload" row
// with segs []. Returns { rows, truncated }.
export function messageFields(msg, limit = 5000) {
  const d = decode(msg);
  if (d.kind === 'json') return flattenFields(d.value, limit);
  const value = d.kind === 'number' ? d.value : d.text;
  return {
    rows: [{ segs: [], path: '$', key: '(payload)', depth: 0, kind: kindOf(value ?? null), value: value ?? null, plottable: d.kind === 'number' }],
    truncated: false,
  };
}

export function flattenFields(value, limit = 5000) {
  const rows = [];
  let truncated = false;
  const walk = (v, segs, path, key, depth) => {
    if (rows.length >= limit) {
      truncated = true;
      return;
    }
    const kind = kindOf(v);
    const row = { segs, path, key, depth, kind, value: v, plottable: plottable(v) };
    rows.push(row);
    if (kind === 'object' || kind === 'array') {
      const entries = kind === 'array' ? v.map((c, i) => [i, c]) : Object.entries(v);
      row.size = entries.length;
      for (const [k, c] of entries) walk(c, [...segs, k], childPath(path, k), k, depth + 1);
    }
  };
  if (value !== null && typeof value === 'object') {
    // The root container itself is not shown; its children start at depth 0.
    const entries = Array.isArray(value) ? value.map((c, i) => [i, c]) : Object.entries(value);
    for (const [k, c] of entries) walk(c, [k], childPath('$', k), k, 0);
  } else {
    walk(value, [], '$', '(payload)', 0);
  }
  return { rows, truncated };
}

// Keeps leaves matching `query` (case-insensitive, on the path) and, with
// numbersOnly, only plottable ones; containers are kept when something below
// them is kept. `collapsed` (Set of paths) hides the rows below a container.
export function visibleFields(rows, { query = '', numbersOnly = false, collapsed = new Set() } = {}) {
  const q = query.trim().toLowerCase();
  const out = [];
  const stack = []; // stack[depth] = { row, added }
  for (const r of rows) {
    stack.length = r.depth;
    if (isContainer(r)) {
      stack[r.depth] = { row: r, added: false };
      continue;
    }
    if (numbersOnly && !r.plottable) continue;
    if (q && !r.path.toLowerCase().includes(q)) continue;
    for (const a of stack) {
      if (a && !a.added) {
        out.push(a.row);
        a.added = true;
      }
    }
    out.push(r);
  }
  if (!collapsed.size) return out;
  const shown = [];
  let skipBelow = Infinity;
  for (const r of out) {
    if (r.depth > skipBelow) continue;
    skipBelow = Infinity;
    shown.push(r);
    if (isContainer(r) && collapsed.has(r.path)) skipBelow = r.depth;
  }
  return shown;
}

// Whether the message holds anything plottable. Cached on the message.
export function hasNumbers(msg) {
  if (msg._hasNumbers !== undefined) return msg._hasNumbers;
  const d = decode(msg);
  let found = d.kind === 'number';
  if (d.kind === 'json') {
    const stack = [d.value];
    while (stack.length && !found) {
      const v = stack.pop();
      if (v !== null && typeof v === 'object') for (const c of Object.values(v)) stack.push(c);
      else if (plottable(v)) found = true;
    }
  }
  msg._hasNumbers = found;
  return found;
}
