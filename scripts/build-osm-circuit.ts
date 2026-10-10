/**
 * New circuits that are not in the TUMFTM dataset, built from OpenStreetMap
 * like Monaco (scripts/fetch-monaco.ts): the raceway ways (a circuit relation
 * or named raceway ways) are stitched into one loop, smoothed, resampled and
 * written in the TUMFTM CSV format in the projector's own frame, with an
 * exact georeference so fetch-osm.ts / fetch-terrain.ts need no alignment.
 *
 *   npx tsx scripts/build-osm-circuit.ts <id>
 *
 * Start line: OSM has none for most of these, so it is put level with the
 * middle of the pit lane (raceway ways named / tagged as pit lane, or any
 * raceway running beside the lap there), where the grid and the line are.
 * Direction: the circuit's known sense of travel (checked against oneway
 * raceway ways when OSM has them).
 *
 * Track data © OpenStreetMap contributors (ODbL).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR, overpass, projector, type V2 } from './fetch-osm';
import { dist, loopLength, resample, smooth } from './osm-circuit';

interface Spec {
  file: string;
  lat: number;
  lon: number;
  /** A circuit relation, or a name pattern for raceway ways around (lat, lon). */
  relation?: number;
  name?: string;
  /** Real lap length (m). */
  length: number;
  /** 'cw' or 'ccw' seen from above. */
  sense: 'cw' | 'ccw';
  /** Smoothing passes on the 1 m resample (see fetch-osm-circuit.ts). */
  smooth: number;
  /** Half width (m) when OSM has no width tag. */
  half: number;
  /** Longest gap bridged between dead ends (m, default 30): Las Vegas has unmapped stretches of the Strip. */
  gap?: number;
  note: string;
}

export const NEW_CIRCUITS: Record<string, Spec> = {
  jeddah: { file: 'Jeddah', lat: 21.6319, lon: 39.1044, name: 'كورنيش|Corniche|Jeddah', length: 6174, sense: 'ccw', smooth: 200, half: 6, note: 'Jeddah Corniche Circuit' },
  miami: { file: 'Miami', lat: 25.9581, lon: -80.2389, name: 'Miami International Autodrome', length: 5412, sense: 'ccw', smooth: 60, half: 7, note: 'Miami International Autodrome' },
  madrid: { file: 'Madrid', lat: 40.4637, lon: -3.6163, relation: 18813472, length: 5474, sense: 'cw', smooth: 200, half: 6.5, note: 'Madring' },
  baku: { file: 'Baku', lat: 40.3725, lon: 49.8533, relation: 11266687, length: 6003, sense: 'ccw', smooth: 60, half: 6, note: 'Baku City Circuit' },
  singapore: { file: 'Singapore', lat: 1.2914, lon: 103.864, relation: 421263, length: 4940, sense: 'ccw', smooth: 150, half: 6, note: 'Marina Bay Street Circuit' },
  lasvegas: { file: 'LasVegas', lat: 36.1147, lon: -115.1728, relation: 16696508, length: 6201, sense: 'ccw', smooth: 200, half: 7, gap: 400, note: 'Las Vegas Strip Circuit' },
  lusail: { file: 'Lusail', lat: 25.49, lon: 51.4542, relation: 21297662, length: 5419, sense: 'cw', smooth: 300, half: 6, note: 'Lusail International Circuit' },
};

interface Way {
  id: number;
  role: string;
  tags: Record<string, string>;
  pts: V2[];
}

async function fetchWays(id: string, s: Spec, proj: (lat: number, lon: number) => V2): Promise<Way[]> {
  const cache = new URL(`../.tmp/new_${id}.json`, import.meta.url);
  if (!existsSync(cache)) {
    const q = s.relation
      ? `[out:json][timeout:90];relation(${s.relation});out geom;way(r)["highway"="raceway"];out tags;way["highway"="raceway"](around:3000,${s.lat},${s.lon});out geom;`
      : `[out:json][timeout:90];way["highway"="raceway"](around:3000,${s.lat},${s.lon});out geom;`;
    const j = await overpass(q);
    mkdirSync(new URL('../.tmp/', import.meta.url), { recursive: true });
    writeFileSync(cache, JSON.stringify(j));
  }
  type El = { type: string; id: number; tags?: Record<string, string>; members?: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[]; geometry?: { lat: number; lon: number }[] };
  const els = (JSON.parse(readFileSync(cache, 'utf8')) as { elements: El[] }).elements;
  const tagsOf = new Map<number, Record<string, string>>();
  for (const e of els) if (e.type === 'way' && e.tags) tagsOf.set(e.id, e.tags);
  const ways = new Map<number, Way>();
  const rel = els.find((e) => e.type === 'relation');
  if (rel)
    for (const m of rel.members ?? [])
      if (m.type === 'way' && m.geometry) ways.set(m.ref, { id: m.ref, role: m.role || 'main', tags: tagsOf.get(m.ref) ?? {}, pts: m.geometry.map((g) => proj(g.lat, g.lon)) });
  for (const e of els)
    if (e.type === 'way' && e.geometry && !ways.has(e.id)) ways.set(e.id, { id: e.id, role: '', tags: e.tags ?? {}, pts: e.geometry.map((g) => proj(g.lat, g.lon)) });
  return [...ways.values()];
}

const isPit = (w: Way) => /pit/i.test(w.role) || /pit/i.test(w.tags.name ?? '') || /pit/i.test(w.tags.raceway ?? '') || /pit/i.test(w.tags.service ?? '');

/**
 * Closed loop through the raceway network: a graph on the ways' own nodes
 * (shared OSM nodes are junctions, no snapping, so close parallel carriageways
 * like Baku's castle section stay apart; dead ends within GAP metres are
 * bridged), chains of degree-2 nodes contracted, then the simple cycle through
 * the edge nearest the start whose length is closest to the real lap.
 */
function loopThrough(ways: V2[][], start: V2, realLength: number, GAP: number): V2[] {
  const key = (p: V2) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  const pos = new Map<string, V2>();
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const w of ways)
    for (let i = 0; i < w.length; i++) {
      pos.set(key(w[i]), w[i]);
      if (i) link(key(w[i - 1]), key(w[i]));
    }
  // Dead ends paired nearest-first: relation gaps (Singapore ~60 m) and stretches of public
  // road not mapped as raceway (Las Vegas, a few hundred metres of straight) are bridged.
  const ends = [...adj].filter(([, n]) => n.size === 1).map(([k]) => k);
  const pairs = ends.flatMap((a, i) => ends.slice(i + 1).map((b) => ({ a, b, d: dist(pos.get(a)!, pos.get(b)!) }))).sort((x, y) => x.d - y.d);
  const paired = new Set<string>();
  for (const { a, b, d } of pairs) {
    if (d > GAP || paired.has(a) || paired.has(b)) continue;
    console.log(`  bridging a ${d.toFixed(0)} m gap`);
    paired.add(a);
    paired.add(b);
    link(a, b);
  }
  // Contract chains: junctions are nodes of degree != 2 (one node stands in when
  // the network is a single ring).
  const ring = [...adj.values()].every((n) => n.size === 2) ? adj.keys().next().value : null;
  const isJ = (k: string) => adj.get(k)!.size !== 2 || k === ring;
  const edges: { a: string; b: string; keys: string[]; len: number }[] = [];
  const seen = new Set<string>();
  for (const [k] of adj) {
    if (!isJ(k)) continue;
    for (const n of adj.get(k)!) {
      if (seen.has(`${k}>${n}`)) continue;
      const keys = [k, n];
      let prev = k;
      let cur = n;
      while (!isJ(cur) && cur !== k) {
        const next = [...adj.get(cur)!].find((x) => x !== prev)!;
        prev = cur;
        cur = next;
        keys.push(cur);
      }
      seen.add(`${k}>${n}`);
      seen.add(`${cur}>${keys[keys.length - 2]}`);
      let len = 0;
      for (let i = 1; i < keys.length; i++) len += dist(pos.get(keys[i - 1])!, pos.get(keys[i])!);
      edges.push({ a: k, b: cur, keys, len });
    }
  }
  if (!edges.length) throw new Error('raceway network has no junctions');
  const near = (e: (typeof edges)[number]) => Math.min(...e.keys.map((k) => dist(pos.get(k)!, start)));
  // Edges nearest the start first; a spur (pit entry, run-off road) has no loop, try the next.
  const order = edges.map((_, i) => i).sort((x, y) => near(edges[x]) - near(edges[y]));
  let best: { path: number[]; dirs: boolean[]; len: number } | null = null;
  for (const sfEdge of order.slice(0, 12)) {
    const used = new Set<number>([sfEdge]);
    const visited = new Set<string>([edges[sfEdge].a]);
    const path = [sfEdge];
    const dirs = [true];
    const walk = (at: string, len: number) => {
      if (at === edges[sfEdge].a) {
        if (!best || Math.abs(len - realLength) < Math.abs(best.len - realLength)) best = { path: [...path], dirs: [...dirs], len };
        return;
      }
      if (len > realLength * 1.3) return;
      edges.forEach((e, i) => {
        if (used.has(i) || (e.a !== at && e.b !== at)) return;
        const next = e.a === at ? e.b : e.a;
        if (visited.has(next) && next !== edges[sfEdge].a) return;
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
    walk(edges[sfEdge].b, edges[sfEdge].len);
    if (best && Math.abs((best as { len: number }).len - realLength) < realLength * 0.05) break;
  }
  if (!best) throw new Error('no closed loop through the start');
  const found = best as { path: number[]; dirs: boolean[]; len: number };
  console.log(`  loop of ${found.path.length} edges, ${found.len.toFixed(0)} m (${edges.length} edges in the network)`);
  const loop: V2[] = [];
  found.path.forEach((ei, k) => {
    const keys = found.dirs[k] ? edges[ei].keys : [...edges[ei].keys].reverse();
    for (const kk of loop.length ? keys.slice(1) : keys) loop.push(pos.get(kk)!);
  });
  if (dist(loop[0], loop[loop.length - 1]) < 1) loop.pop();
  return loop;
}

function signedArea(pts: V2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

async function main(): Promise<void> {
  const id = process.argv[2];
  const s = NEW_CIRCUITS[id];
  if (!s) throw new Error(`usage: build-osm-circuit.ts <${Object.keys(NEW_CIRCUITS).join('|')}>`);
  const passes = +(process.env.SMOOTH ?? s.smooth);
  const gap = +(process.env.GAP ?? s.gap ?? 30);
  const proj = projector(s.lat, s.lon);
  const all = await fetchWays(id, s, proj);
  let pits = all.filter(isPit);
  // Relation members when there is a relation; otherwise every raceway around that
  // is not a pit lane (named or not): the loop closest to the real lap length wins.
  let lapWays = s.relation ? all.filter((w) => w.role === 'main' || w.role === 'forward' || w.role === 'backward') : all.filter((w) => !isPit(w));
  if (lapWays.length === 0) lapWays = all.filter((w) => !isPit(w));
  console.log(`  ${all.length} raceway ways, ${lapWays.length} for the lap, ${pits.length} pit lane`);

  // Rough loop first (any start), to find the pit lane beside it.
  const centre: V2 = [0, 0];
  const segments = lapWays.map((w) => w.pts);
  let rough = loopThrough(segments, lapWays[0].pts[0], s.length, gap);
  if (!pits.length) {
    // Unnamed pit lane: a raceway off the lap (mostly > 6 m away) running beside it (< 60 m).
    const off = (w: Way) => w.pts.map((p) => Math.min(...rough.map((q) => dist(p, q))));
    pits = all.filter((w) => {
      if (w.pts.slice(1).reduce((a, p, i) => a + dist(w.pts[i], p), 0) < 120) return false;
      const d = off(w);
      return d.filter((x) => x > 6).length > 0.7 * d.length && Math.max(...d) < 60;
    });
    if (pits.length) console.log(`  pit lane found as unnamed raceway (${pits.map((w) => w.id).join(', ')})`);
  }
  const pitPts = pits.flatMap((w) => w.pts);
  let sf: V2;
  if (pitPts.length) {
    // Middle (by length) of the longest pit way, projected onto the lap.
    const open = (w: Way) => w.pts.slice(1).reduce((a, p, i) => a + dist(w.pts[i], p), 0);
    // The longest pit road that runs beside the lap (paddock / service loops are further out).
    const beside = (w: Way) => {
      const d = w.pts.map((p) => Math.min(...rough.map((q) => dist(p, q)))).sort((a, b) => a - b);
      return d[Math.floor(d.length / 2)] < 60;
    };
    const candidates = pits.filter(beside).length ? pits.filter(beside) : pits;
    const longest = candidates.reduce((a, b) => (open(a) > open(b) ? a : b));
    // The longest run of lap points with the pit road beside them (< 40 m): its middle is
    // where the garages, the grid and the line are.
    const dense = resample(rough, 2);
    const pitDense = resample(longest.pts.concat([...longest.pts].reverse()), 4);
    const pitNear = dense.map((q) => pitDense.some((p) => dist(p, q) < 40));
    let bestRun = { from: 0, len: 0 };
    for (let i = 0; i < dense.length; i++) {
      if (!pitNear[i] || pitNear[(i - 1 + dense.length) % dense.length]) continue;
      let j = i;
      while (pitNear[(j + 1) % dense.length] && j - i < dense.length) j++;
      if (j - i + 1 > bestRun.len) bestRun = { from: i, len: j - i + 1 };
    }
    const mid = dense[(bestRun.from + Math.floor(bestRun.len / 2)) % dense.length];
    sf = mid;
    console.log(`  start line beside the pit lane (way ${longest.id}, ${bestRun.len * 2} m alongside)`);
  } else {
    sf = rough.reduce((a, b) => (dist(a, centre) < dist(b, centre) ? a : b));
    console.warn('  WARNING: no pit lane in OSM, start line placed arbitrarily');
  }
  rough = loopThrough(segments, sf, s.length, gap);

  let pts = resample(smooth(resample(rough, 1), passes), 5);
  let i0 = 0;
  pts.forEach((p, i) => {
    if (dist(p, sf) < dist(pts[i0], sf)) i0 = i;
  });
  pts = pts.slice(i0).concat(pts.slice(0, i0));
  // Sense of travel: positive area = counter-clockwise in (east, north).
  if ((signedArea(pts) > 0) !== (s.sense === 'ccw')) pts = [pts[0], ...pts.slice(1).reverse()];
  // Cross-check with the ways' own direction: oneway raceways, and a relation's
  // forward / backward roles. When they clearly disagree, they win.
  const nearestIdx = (p: V2) => {
    let bi = 0;
    pts.forEach((q, i) => {
      if (dist(q, p) < dist(pts[bi], p)) bi = i;
    });
    return bi;
  };
  let agree = 0;
  let disagree = 0;
  for (const w of lapWays) {
    const dir = w.role === 'forward' || w.tags.oneway === 'yes' ? 1 : w.role === 'backward' || w.tags.oneway === '-1' ? -1 : 0;
    if (!dir || w.pts.length < 2 || w.pts.slice(1).reduce((a, p, i) => a + dist(w.pts[i], p), 0) < 60) continue;
    const a = nearestIdx(w.pts[0]);
    const b = nearestIdx(w.pts[w.pts.length - 1]);
    const fwd = (b - a + pts.length) % pts.length < pts.length / 2;
    if (fwd === (dir > 0)) agree++;
    else disagree++;
  }
  console.log(`  sense ${s.sense}; directed ways agree ${agree}, disagree ${disagree}`);
  if (disagree >= 3 && disagree > 4 * agree) {
    console.warn('  directed ways say the other way round: reversing');
    pts = [pts[0], ...pts.slice(1).reverse()];
  }

  const total = loopLength(pts);
  const err = Math.abs(total - s.length) / s.length;
  console.log(`  length ${total.toFixed(0)} m (real ${s.length}, ${(err * 100).toFixed(1)}% off), ${pts.length} points`);
  if (err > 0.04) console.warn('  WARNING: length more than 4% off');

  if (pitPts.length) {
    const along = (p: V2) => {
      let bi = 0;
      pts.forEach((q, i) => {
        if (dist(q, p) < dist(pts[bi], p)) bi = i;
      });
      return bi * (total / pts.length);
    };
    const ends = pits.flatMap((w) => [w.pts[0], w.pts[w.pts.length - 1]]).map(along).map((a) => (a > total / 2 ? a - total : a));
    console.log(`  pit roads span ${(-Math.min(...ends)).toFixed(0)} m before the line to ${Math.max(...ends).toFixed(0)} m after`);
  }

  const width = (p: V2) => {
    let best: Way | null = null;
    let bd = Infinity;
    for (const w of lapWays)
      for (const q of w.pts)
        if (dist(p, q) < bd) [bd, best] = [dist(p, q), w];
    const wt = parseFloat((best as Way | null)?.tags.width ?? '');
    return Number.isFinite(wt) && wt > 6 && wt < 30 ? wt / 2 : s.half;
  };
  const rows = pts.map((p) => {
    const h = width(p);
    return `${p[0].toFixed(3)},${p[1].toFixed(3)},${h.toFixed(3)},${h.toFixed(3)}`;
  });
  writeFileSync(
    new URL(`${s.file}.csv`, DATA_DIR),
    `# x_m,y_m,w_tr_right_m,w_tr_left_m\n# ${s.note} from OpenStreetMap (© OpenStreetMap contributors, ODbL) by scripts/build-osm-circuit.ts\n${rows.join('\n')}\n`,
  );
  writeFileSync(new URL(`${s.file}_geo.json`, DATA_DIR), JSON.stringify({ lat0: s.lat, lon0: s.lon, theta: 0, tx: 0, ty: 0, rms: 0, inliers: 1, exact: true }, null, 2) + '\n');
  console.log(`  wrote ${s.file}.csv, ${s.file}_geo.json`);
}

void main();
