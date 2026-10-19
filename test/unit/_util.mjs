// Shared helpers for unit tests (not a test file: no `.test.mjs` suffix).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));

// Deterministic PRNG (mulberry32) so property tests are reproducible.
export function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)); // inclusive
  const pick = (arr) => arr[Math.floor(next() * arr.length)];
  const bool = (p = 0.5) => next() < p;
  return { next, int, pick, bool };
}

export const enc = (s) => new TextEncoder().encode(s);
export const bytes = (...xs) => new Uint8Array(xs);
