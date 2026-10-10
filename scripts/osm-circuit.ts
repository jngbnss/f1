/**
 * Circuit centerlines from an OpenStreetMap circuit relation: the ways are
 * stitched into one closed loop, resampled and lightly smoothed
 * (scripts/fetch-monaco.ts, scripts/fetch-albertpark.ts).
 */
import type { V2 } from './fetch-osm';

export const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Joins the ways into one loop. The relation is not a clean ordered chain
 * (it holds both carriageways in places and small connector ways), so the
 * ways become a graph (ends within SNAP metres are one junction) and the
 * simple cycle through the start/finish way whose length is closest to the
 * real lap is taken.
 */
const SNAP = 22;
export function stitch(ways: V2[][], startFinish: V2, realLength: number): V2[] {
  const junctions: V2[] = [];
  const junction = (p: V2) => {
    let i = junctions.findIndex((q) => dist(p, q) < SNAP);
    if (i < 0) i = junctions.push(p) - 1;
    return i;
  };
  const edges = ways.map((w) => {
    let len = 0;
    for (let i = 1; i < w.length; i++) len += dist(w[i - 1], w[i]);
    return { pts: w, a: junction(w[0]), b: junction(w[w.length - 1]), len };
  });
  // Duplicate carriageways between the same junctions: keep one.
  const seen = new Set<string>();
  const unique = edges.filter((e) => {
    const k = e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return e.a !== e.b;
  });
  // Dead ends (a few short connector ways are tagged on their own): bridge to the nearest junction.
  const degree = new Map<number, number>();
  for (const e of unique) for (const j of [e.a, e.b]) degree.set(j, (degree.get(j) ?? 0) + 1);
  for (const [j, d] of [...degree]) {
    if (d !== 1) continue;
    let near = -1;
    let nd = 60;
    for (const [k, dk] of degree) if (k !== j && dk === 1 && dist(junctions[j], junctions[k]) < nd) [nd, near] = [dist(junctions[j], junctions[k]), k];
    if (near < 0) continue;
    console.log(`  bridging a ${nd.toFixed(0)} m gap`);
    unique.push({ pts: [junctions[j], junctions[near]], a: j, b: near, len: nd });
    degree.set(j, 2);
    degree.set(near, 2);
  }
  if (process.env.DEBUG) unique.forEach((e, i) => console.log(i, e.a, '->', e.b, e.len.toFixed(0), JSON.stringify(e.pts[0].map(Math.round)), JSON.stringify(e.pts[e.pts.length - 1].map(Math.round))));
  // Edge nearest the start/finish line.
  let sfEdge = 0;
  let sfd = Infinity;
  unique.forEach((e, i) => {
    for (const p of e.pts) if (dist(p, startFinish) < sfd) [sfd, sfEdge] = [dist(p, startFinish), i];
  });
  let best: { path: number[]; dirs: boolean[]; len: number } | null = null;
  const used = new Set<number>([sfEdge]);
  const visited = new Set<number>([unique[sfEdge].a]);
  const path = [sfEdge];
  const dirs = [true];
  const walk = (at: number, len: number) => {
    if (at === unique[sfEdge].a) {
      if (!best || Math.abs(len - realLength) < Math.abs(best.len - realLength)) best = { path: [...path], dirs: [...dirs], len };
      return;
    }
    if (len > realLength * 1.4) return;
    unique.forEach((e, i) => {
      if (used.has(i) || (e.a !== at && e.b !== at)) return;
      const next = e.a === at ? e.b : e.a;
      if (visited.has(next) && next !== unique[sfEdge].a) return;
      used.add(i);
      visited.add(next);
      path.push(i);
      dirs.push(e.a === at);
      walk(next, len + e.len);
      path.pop();
      dirs.pop();
      visited.delete(next);
      used.delete(i);
    });
  };
  walk(unique[sfEdge].b, unique[sfEdge].len);
  if (!best) throw new Error('no closed loop through the start/finish way');
  const found = best as { path: number[]; dirs: boolean[]; len: number };
  console.log(`  loop of ${found.path.length} ways, ${found.len.toFixed(0)} m (${unique.length} distinct ways, ${junctions.length} junctions)`);
  const loop: V2[] = [];
  found.path.forEach((ei, k) => {
    const pts = found.dirs[k] ? unique[ei].pts : [...unique[ei].pts].reverse();
    loop.push(...(loop.length ? pts.slice(1) : pts));
  });
  if (dist(loop[0], loop[loop.length - 1]) < SNAP) loop.pop();
  return loop;
}

export function resample(loop: V2[], step: number): V2[] {
  const pts = [...loop, loop[0]];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  const n = Math.round(total / step);
  const out: V2[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (k * total) / n;
    while (cum[j + 1] < s) j++;
    const t = (s - cum[j]) / Math.max(cum[j + 1] - cum[j], 1e-9);
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t]);
  }
  return out;
}

/** Light smoothing (closed loop): OSM street geometry has small kinks at node joins. */
export function smooth(pts: V2[], passes: number): V2[] {
  let cur = pts;
  const n = pts.length;
  for (let p = 0; p < passes; p++) {
    cur = cur.map((_, i) => {
      const a = cur[(i - 1 + n) % n];
      const b = cur[i];
      const c = cur[(i + 1) % n];
      return [0.25 * a[0] + 0.5 * b[0] + 0.25 * c[0], 0.25 * a[1] + 0.5 * b[1] + 0.25 * c[1]] as V2;
    });
  }
  return cur;
}

export const loopLength = (pts: V2[]) => pts.reduce((s, p, i) => s + dist(p, pts[(i + 1) % pts.length]), 0);
