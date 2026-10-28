// The points collected for plotted series (a topic, optionally a JSON path
// in its messages). No DOM, so it runs in Node for tests.
//
//   const data = new PlotData();
//   data.track(allSeries, (series) => pointsFromMessages(history(series.topic), series.segs));
//   data.ingest(message);              // for every received message
//   data.points('robot/state', ['battery']);  // [{ t, v }], oldest first
//
// Points of a series are kept in time order (late messages are ignored).
// Each series keeps at most `maxPoints`, and all series together share a
// `budget` (more series, fewer points each); the oldest points go first.
// Trimming happens in chunks (up to 10% over the cap) so a series at its cap
// does not shift its whole array on every message.

import { extractNumber } from './payload.js';
import { seriesKey } from './plotMath.js';

export const MAX_POINTS = 100000; // per series: 1 h at ~25 Hz
export const POINT_BUDGET = 2000000; // all series together: roughly 150 MB (~77 bytes a point)
const MIN_CAP = 1000;

// The numeric points in `messages` for the value at `segs` (null: the payload).
export function pointsFromMessages(messages, segs) {
  const out = [];
  for (const m of messages || []) {
    const v = extractNumber(m, segs);
    if (v !== undefined && (!out.length || m.ts >= out[out.length - 1].t)) out.push({ t: m.ts, v });
  }
  return out;
}

export class PlotData {
  constructor({ maxPoints = MAX_POINTS, budget = POINT_BUDGET } = {}) {
    this.maxPoints = maxPoints;
    this.budget = budget;
    this.limit = maxPoints; // points kept per series (see track)
    this.series = new Map(); // seriesKey -> { segs, points }
    this.byTopic = new Map(); // topic -> [seriesKey]
  }

  // Collects points for exactly these series ({ topic, segs }); points of
  // series no longer listed are freed. A series seen for the first time
  // starts with initial(series) (e.g. points from the kept message history).
  track(seriesList, initial = () => []) {
    const next = new Map();
    for (const s of seriesList) {
      const key = seriesKey(s.topic, s.segs);
      if (next.has(key)) continue;
      const known = this.series.get(key);
      next.set(key, { topic: s.topic, segs: s.segs && s.segs.length ? s.segs : null, points: known ? known.points : tail(initial(s) || [], this.limit) });
    }
    this.series = next;
    this.limit = Math.min(this.maxPoints, Math.max(Math.min(MIN_CAP, this.maxPoints), Math.floor(this.budget / Math.max(1, next.size))));
    for (const s of next.values()) if (s.points.length > this.limit + slack(this.limit)) s.points.splice(0, s.points.length - this.limit);
    this.byTopic = new Map();
    for (const [key, s] of next) {
      if (!this.byTopic.has(s.topic)) this.byTopic.set(s.topic, []);
      this.byTopic.get(s.topic).push(key);
    }
  }

  // Adds the message's values to its topic's series. Returns whether any
  // point was added.
  ingest(msg) {
    const keys = this.byTopic.get(msg.topic);
    if (!keys) return false;
    let added = false;
    for (const key of keys) {
      const s = this.series.get(key);
      const v = extractNumber(msg, s.segs);
      if (v === undefined) continue;
      const pts = s.points;
      if (pts.length && msg.ts < pts[pts.length - 1].t) continue; // keep points in time order
      pts.push({ t: msg.ts, v });
      if (pts.length > this.limit + slack(this.limit)) pts.splice(0, pts.length - this.limit);
      added = true;
    }
    return added;
  }

  // The points of a series, oldest first ([] when it is not tracked). The
  // array is live: it grows as messages arrive. Do not modify it.
  points(topic, segs) {
    return this.series.get(seriesKey(topic, segs))?.points || EMPTY;
  }

  // Forgets every point; the same series stay tracked.
  clear() {
    for (const s of this.series.values()) s.points.length = 0;
  }

  // The tracked series and their points, for restore() (structured-clone
  // friendly; later points are not added to it).
  snapshot() {
    return [...this.series.values()].map((s) => ({ topic: s.topic, segs: s.segs, points: s.points.slice() }));
  }

  // Tracks exactly the series of a snapshot, with all of its points: none is
  // cut on the way in, so trimming then goes as it would have without the
  // move (only a series over its limit and slack is cut back to its limit).
  restore(snapshot) {
    this.series = new Map();
    this.limit = Infinity;
    this.track(snapshot, (s) => s.points);
  }
}

const EMPTY = Object.freeze([]);

// How far a series may grow past its limit before it is trimmed.
const slack = (limit) => Math.ceil(limit / 10);

// A copy of the last n points.
const tail = (points, n) => (points.length > n ? points.slice(points.length - n) : points.slice());
