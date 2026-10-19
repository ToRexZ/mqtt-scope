// JSON path helpers. Paths are rendered as `$.a.b[0]["odd key"]` and carried
// alongside an array of segments for lookups.

const IDENT = /^[A-Za-z_$][\w$]*$/;

export function childPath(parent, key) {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

export function pathFromSegments(segs) {
  let p = '$';
  for (const s of segs) p = childPath(p, s);
  return p;
}

export function getAt(value, segs) {
  let v = value;
  for (const s of segs) {
    if (v === null || typeof v !== 'object') return undefined;
    v = v[s];
  }
  return v;
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
