// Payload decoding and formatting helpers. No DOM access, so these run in
// Node for tests as well as in the renderer.

const utf8 = new TextDecoder('utf-8', { fatal: true });
const HIGHLIGHT_LIMIT = 1_500_000;

// Plain decimal numbers only; Number() would also accept 0x10, 0b1, Infinity.
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export const isDecimal = (s) => typeof s === 'string' && DECIMAL.test(s.trim());

// Control characters other than tab/newline/carriage return mark binary data.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const BINARY_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

// Returns { kind: 'empty'|'json'|'number'|'text'|'binary', text, value, size }.
// The result is cached on the message object.
export function decode(msg) {
  if (msg._decoded) return msg._decoded;
  msg._decoded = decodeBytes(msg.payload);
  return msg._decoded;
}

export function decodeBytes(bytes) {
  const size = bytes ? bytes.length : 0;
  if (!size) return { kind: 'empty', text: '', size: 0 };
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    return { kind: 'binary', text: null, size };
  }
  if (BINARY_CHARS.test(text.slice(0, 4096))) return { kind: 'binary', text: null, size };
  const first = text.trimStart()[0];
  if (first === '{' || first === '[') {
    try {
      return { kind: 'json', text, value: JSON.parse(text), size };
    } catch {
      return { kind: 'text', text, size };
    }
  }
  const trimmed = text.trim();
  if (DECIMAL.test(trimmed) && Number.isFinite(Number(trimmed))) {
    return { kind: 'number', text, value: Number(trimmed), size };
  }
  return { kind: 'text', text, size };
}

const PREVIEW_BYTES = 2048;
const PREVIEW_CHARS = 1000;

// Short one-line summary of a payload for lists. Only looks at the first few
// KB so huge payloads never get fully decoded or parsed just to draw a row.
export function preview(msg, max = 160) {
  if (msg._preview === undefined) msg._preview = makePreview(msg.payload);
  return msg._preview.length > max ? msg._preview.slice(0, max) : msg._preview;
}

function makePreview(bytes) {
  if (!bytes || !bytes.length) return '(empty)';
  let text;
  try {
    // stream: true tolerates a multi-byte character cut off at the slice end.
    const truncated = bytes.length > PREVIEW_BYTES;
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, PREVIEW_BYTES), { stream: truncated });
  } catch {
    return `<binary ${formatBytes(bytes.length)}>`;
  }
  if (BINARY_CHARS.test(text)) return `<binary ${formatBytes(bytes.length)}>`;
  return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
}

const SEARCH_CHARS = 1_000_000;

// Lower-cased payload text for searching (first 1M characters), cached.
export function searchableText(msg) {
  if (msg._search === undefined) {
    const d = decode(msg);
    msg._search = d.text ? d.text.slice(0, SEARCH_CHARS).toLowerCase() : '';
  }
  return msg._search;
}

// The message as received, without the caches above (and hasNumbers' in
// fields.js): what goes to another window.
export function plainMessage(m) {
  return { topic: m.topic, payload: m.payload, qos: m.qos, retain: m.retain, ts: m.ts, props: m.props };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1023.95) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatDateTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(ts)}`;
}

// True when JSON text holds integers beyond Number.MAX_SAFE_INTEGER (uint64
// ids, nanosecond timestamps): JSON.parse would silently round them.
const JSON_NUMBER_OR_STRING = /"(?:\\.|[^"\\])*"|(?<![\w.+-])(-?\d+)(?![\d.eE])/g;
export function hasUnsafeIntegers(text) {
  for (const m of text.matchAll(JSON_NUMBER_OR_STRING)) {
    if (m[1] !== undefined && m[1].replace('-', '').length > 15 && !Number.isSafeInteger(Number(m[1]))) return true;
  }
  return false;
}

// Unsafe-integer check for a decoded JSON payload, cached on it.
export function unsafeJson(d) {
  if (d.kind !== 'json') return false;
  if (d._unsafe === undefined) d._unsafe = hasUnsafeIntegers(d.text);
  return d._unsafe;
}

export function prettyText(d) {
  if (d.kind === 'json') {
    if (d._pretty === undefined) d._pretty = JSON.stringify(d.value, null, 2);
    return d._pretty;
  }
  return d.text ?? '';
}

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

// Syntax-highlights pretty-printed JSON into an HTML string. All payload text
// is escaped. Falls back to plain escaped text for very large inputs.
export function highlightJson(text) {
  if (text.length > HIGHLIGHT_LIMIT) return escapeHtml(text);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    out += escapeHtml(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const cls = m[2] !== undefined ? 'tk-key' : 'tk-str';
      out += `<span class="${cls}">${escapeHtml(m[1])}</span>${m[2] ?? ''}`;
    } else if (m[3] !== undefined) {
      out += `<span class="tk-bool">${m[3]}</span>`;
    } else if (m[4] !== undefined) {
      out += `<span class="tk-null">null</span>`;
    } else {
      out += `<span class="tk-num">${m[5]}</span>`;
    }
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

export function hexDump(bytes, maxBytes = 65536) {
  const n = Math.min(bytes.length, maxBytes);
  const lines = [];
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n));
    let hex = '';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      if (i < row.length) {
        hex += row[i].toString(16).padStart(2, '0') + ' ';
        ascii += row[i] >= 0x20 && row[i] < 0x7f ? String.fromCharCode(row[i]) : '.';
      } else {
        hex += '   ';
      }
      if (i === 7) hex += ' ';
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex} ${ascii}`);
  }
  if (bytes.length > n) lines.push(`… ${formatBytes(bytes.length - n)} more`);
  return lines.join('\n');
}

// Accepts hex digits separated by whitespace or , : ; - and optional 0x prefixes.
export function parseHex(str) {
  const stripped = str.replace(/0x/gi, '');
  const bad = /[^0-9a-f\s,:;-]/i.exec(stripped);
  if (bad) throw new Error(`Not a hex digit: "${bad[0]}"`);
  const clean = stripped.replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2) throw new Error('Odd number of hex digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// MQTT topic filter matching with + and # wildcards.
// Per the MQTT spec, filters starting with a wildcard do not match $-topics.
export function topicMatches(filter, topic) {
  if ((filter[0] === '#' || filter[0] === '+') && topic[0] === '$') return false;
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

// Numeric value of a message, or of the JSON field at `segs`. Booleans plot
// as 0/1 and numeric strings are accepted; anything else is undefined.
export function extractNumber(msg, segs) {
  const d = decode(msg);
  let v;
  if (segs && segs.length) {
    if (d.kind !== 'json') return undefined;
    v = d.value;
    for (const s of segs) {
      if (v === null || typeof v !== 'object') return undefined;
      v = v[s];
    }
  } else {
    v = d.kind === 'number' ? d.value : d.kind === 'json' ? d.value : undefined;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && DECIMAL.test(v.trim()) && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
