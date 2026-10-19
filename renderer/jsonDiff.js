// Structural JSON diff and a line diff for non-JSON text.

import { childPath } from './jsonPath.js';

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// Returns [{ path, segs, type: 'added'|'removed'|'changed', from, to }].
export function diffJson(a, b, path = '$', segs = [], out = []) {
  if (Object.is(a, b)) return out;
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb || (ka !== 'object' && ka !== 'array')) {
    const type = a === undefined ? 'added' : b === undefined ? 'removed' : 'changed';
    out.push({ path, segs, type, from: a, to: b });
    return out;
  }
  if (ka === 'array') {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      diffJson(i < a.length ? a[i] : undefined, i < b.length ? b[i] : undefined, childPath(path, i), [...segs, i], out);
    }
  } else {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const av = Object.hasOwn(a, k) ? a[k] : undefined;
      const bv = Object.hasOwn(b, k) ? b[k] : undefined;
      diffJson(av, bv, childPath(path, k), [...segs, k], out);
    }
  }
  return out;
}

const MAX_LINES = 4000;
const MAX_CELLS = 4_000_000; // LCS table size cap (8 MB as Uint16)

// LCS line diff. Returns [{ op: ' '|'+'|'-', text }] or null when too large.
export function diffLines(aText, bText) {
  const a = aText.split('\n');
  const b = bText.split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;
  // Trim the common prefix and suffix so the DP table only covers the changed middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  // LCS lengths fit 16 bits because both sides are capped at MAX_LINES.
  const dp = new Uint16Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[start + i] === b[start + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out = a.slice(0, start).map((text) => ({ op: ' ', text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      out.push({ op: ' ', text: a[start + i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push({ op: '-', text: a[start + i++] });
    } else {
      out.push({ op: '+', text: b[start + j++] });
    }
  }
  while (i < n) out.push({ op: '-', text: a[start + i++] });
  while (j < m) out.push({ op: '+', text: b[start + j++] });
  for (let k = endA; k < a.length; k++) out.push({ op: ' ', text: a[k] });
  return out;
}
