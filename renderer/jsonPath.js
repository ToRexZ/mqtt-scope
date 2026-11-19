// JSON path helpers. Paths are rendered as `$.a.b[0]["odd key"]` and carried
// alongside an array of segments for lookups. A segment is a key, an index,
// or a selector { field, equals }: the first entry of an array whose `key` or
// `name` field equals that text, printed as `[?(@.key=="BRAKE_MODE")]`.

const IDENT = /^[A-Za-z_$][\w$]*$/;
const NAME_FIELDS = ['key', 'name']; // fields that name an array entry, preferred first

export const isSelector = (s) =>
  s !== null && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length === 2 && NAME_FIELDS.includes(s.field) && typeof s.equals === 'string' && s.equals !== '';

const isEntry = (e) => e !== null && typeof e === 'object' && !Array.isArray(e);

export function childPath(parent, key) {
  if (isSelector(key)) return `${parent}[?(@.${key.field}==${JSON.stringify(key.equals)})]`;
  if (typeof key === 'number') return `${parent}[${key}]`;
  return IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

export function pathFromSegments(segs) {
  let p = '$';
  for (const s of segs) p = childPath(p, s);
  return p;
}

// One step into a value: a key, an index, or the first entry with that name.
function step(v, s) {
  if (v === null || typeof v !== 'object') return undefined;
  if (s !== null && typeof s === 'object') return Array.isArray(v) && isSelector(s) ? v.find((e) => isEntry(e) && e[s.field] === s.equals) : undefined;
  return v[s];
}

export function getAt(value, segs) {
  let v = value;
  for (const s of segs) {
    v = step(v, s);
    if (v === undefined) return undefined;
  }
  return v;
}

// The names in an array, per field: name -> { count, index of the first },
// built once per array (picking among thousands of rows stays fast).
const nameIndexes = new WeakMap();
function namesIn(arr, field) {
  let byField = nameIndexes.get(arr);
  if (!byField) nameIndexes.set(arr, (byField = {}));
  if (!byField[field]) {
    const names = new Map();
    arr.forEach((e, index) => {
      const name = isEntry(e) ? e[field] : undefined;
      if (typeof name !== 'string') return;
      const seen = names.get(name);
      if (seen) seen.count++;
      else names.set(name, { count: 1, index });
    });
    byField[field] = names;
  }
  return byField[field];
}

// The index of a selector's entry in v; -1 when v isn't an array or has none.
const indexOf = (v, sel) => (Array.isArray(v) ? (namesIn(v, sel.field).get(sel.equals)?.index ?? -1) : -1);

// The selector for arr[i]: its `key` (else `name`) when that is a non-empty
// text no other entry of the array has; null otherwise.
function selectorFor(arr, i) {
  const e = arr[i];
  if (!isEntry(e)) return null;
  for (const field of NAME_FIELDS) {
    const name = e[field];
    if (typeof name === 'string' && name && namesIn(arr, field).get(name).count === 1) return { field, equals: name };
  }
  return null;
}


// `segs` as picked in `value`, with every array index that has a name turned
// into a selector, so the path keeps following that entry when it moves.
export function namedSegs(value, segs) {
  if (!segs) return segs;
  const out = [];
  let v = value;
  for (const s of segs) {
    out.push((Number.isInteger(s) && Array.isArray(v) && selectorFor(v, s)) || s);
    v = step(v, s);
  }
  return out;
}

// Where `segs` points in `value`: every selector replaced by the index of its
// entry there; null when an entry is missing.
export function positionalSegs(value, segs) {
  const out = [];
  let v = value;
  for (const s of segs) {
    const i = isSelector(s) ? indexOf(v, s) : s;
    if (i === -1) return null;
    out.push(i);
    v = step(v, i);
  }
  return out;
}

// The parts of a label for a path with selectors: each name, and the fields
// after it, leaving out the array a name picks from and a key/value pair's
// final `value`. Null for a path without selectors.
export function nameParts(segs) {
  if (!segs || !segs.some(isSelector)) return null;
  const parts = [];
  segs.forEach((s, i) => {
    if (isSelector(s)) parts.push(s.equals);
    else if (isSelector(segs[i + 1])) return;
    else if (s === 'value' && i === segs.length - 1 && isSelector(segs[i - 1])) return;
    else parts.push(typeof s === 'number' ? `[${s}]` : s);
  });
  return parts;
}

// Every ancestor path of `segs`, including the root `$` but not the path itself.
export function ancestorPaths(segs) {
  const out = ['$'];
  let p = '$';
  for (let i = 0; i < segs.length - 1; i++) {
    p = childPath(p, segs[i]);
    out.push(p);
  }
  return out;
}

// Parses `$.a.b[0]["odd key"]` (leading `$` optional) back into segments.
export function parsePath(path) {
  const s = path.trim();
  const segs = [];
  let i = s.startsWith('$') ? 1 : 0;
  while (i < s.length) {
    if (s[i] === '.') {
      const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i + 1));
      if (!m) throw new Error(`Invalid path near "${s.slice(i)}"`);
      segs.push(m[0]);
      i += 1 + m[0].length;
    } else if (s[i] === '[') {
      const rest = s.slice(i + 1);
      const num = /^(\d+)\]/.exec(rest);
      if (num) {
        segs.push(Number(num[1]));
        i += 1 + num[0].length;
        continue;
      }
      const filter = /^\?\(@\.(key|name)==("(?:\\.|[^"\\])*")\)\]/.exec(rest);
      if (filter) {
        const sel = { field: filter[1], equals: JSON.parse(filter[2]) };
        if (!isSelector(sel)) throw new Error(`Invalid path near "${s.slice(i)}"`);
        segs.push(sel);
        i += 1 + filter[0].length;
        continue;
      }
      const str = /^("(?:\\.|[^"\\])*")\]/.exec(rest);
      if (!str) throw new Error(`Invalid path near "${s.slice(i)}"`);
      segs.push(JSON.parse(str[1]));
      i += 1 + str[0].length;
    } else if (i === 0) {
      // Allow a bare leading key: "a.b" means "$.a.b".
      const m = /^[A-Za-z_$][\w$]*/.exec(s);
      if (!m) throw new Error(`Invalid path "${s}"`);
      segs.push(m[0]);
      i = m[0].length;
    } else {
      throw new Error(`Invalid path near "${s.slice(i)}"`);
    }
  }
  return segs;
}
