/**
 * Real track elevation from the Copernicus DEM already baked by
 * fetch-terrain.ts (public/terrain/<id>/dem_near.bin):
 *
 *   npx tsx scripts/bake-elevation.ts spa Spa
 *   npx tsx scripts/bake-elevation.ts suzuka Suzuka
 *
 * Writes src/world/tracks/data/<Name>_elev.json: one height (m, relative to
 * the terrain's base height, same datum as the landscape) per centerline
 * point of <Name>.csv.
 *
 * GLO-30 is a surface model (tree canopy included, 30 m pixels), so along a
 * forest road it reads high. Per point the lowest of a few samples across the
 * road is taken, then the profile is smoothed along the track and its
 * gradient limited to what real circuits have (Eau Rouge ~18 %). Where the
 * track crosses itself (Suzuka) the upper road is lifted / the lower one
 * lowered until there is room for a bridge.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { findCrossings } from '../src/world/Elevation';
import { parseTumCsv } from '../src/world/TrackLayout';

const [id, name] = process.argv.slice(2);
if (!id || !name) throw new Error('usage: bake-elevation.ts <terrainId> <DataName>');

/** Max gradient kept after smoothing (Eau Rouge / Raidillon is ~17-18 %). */
const MAX_GRADE = 0.185;
/** Smoothing along the track (Gaussian sigma, m). */
const SIGMA = 28;
/** Road-to-road height at a crossing (deck + clearance), m. */
const BRIDGE_CLEARANCE = 8.5;
/** Half-length of the ramps that make room for a bridge (m). */
const BRIDGE_RAMP = 260;

type Rect = [number, number, number, number];
const meta = JSON.parse(readFileSync(`public/terrain/${id}/terrain.json`, 'utf8')) as {
  baseHeight: number;
  demNear: { rect: Rect; size: number; scale: number };
};
const grid = meta.demNear;
const buf = readFileSync(`public/terrain/${id}/dem_near.bin`);
const dem = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);

function sample(x: number, z: number): number {
  const [x0, z0, x1, z1] = grid.rect;
  const n = grid.size;
  const fx = Math.min(Math.max(((x - x0) / (x1 - x0)) * (n - 1), 0), n - 1.001);
  const fz = Math.min(Math.max(((z - z0) / (z1 - z0)) * (n - 1), 0), n - 1.001);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const h =
    (dem[j * n + i] * (1 - u) + dem[j * n + i + 1] * u) * (1 - v) + (dem[(j + 1) * n + i] * (1 - u) + dem[(j + 1) * n + i + 1] * u) * v;
  return h * grid.scale;
}

const layout = parseTumCsv(id, name, readFileSync(`src/world/tracks/data/${name}.csv`, 'utf8'));
const pts = layout.points;
const n = pts.length;

// Arc length per point.
const s = new Float64Array(n + 1);
for (let i = 0; i < n; i++) {
  const [ax, az] = pts[i];
  const [bx, bz] = pts[(i + 1) % n];
  s[i + 1] = s[i] + Math.hypot(bx - ax, bz - az);
}
const length = s[n];

// Lowest of a few samples across the road (canopy beside the road reads high).
const raw = new Float64Array(n);
for (let i = 0; i < n; i++) {
  const [px, pz] = pts[i];
  const [qx, qz] = pts[(i + 1) % n];
  const [ox, oz] = pts[(i - 1 + n) % n];
  let tx = qx - ox;
  let tz = qz - oz;
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl;
  tz /= tl;
  const rx = -tz;
  const rz = tx;
  let best = Infinity;
  for (const off of [-10, -5, 0, 5, 10]) best = Math.min(best, sample(px + rx * off, pz + rz * off));
  raw[i] = best;
}

/** Gaussian smoothing over arc length on the closed loop. */
function smooth(values: Float64Array, sigma: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sw = 0;
    let sv = 0;
    const half = Math.floor(n / 2);
    for (let k = -half; k < n - half; k++) {
      const j = (i + k + n) % n;
      let d = Math.abs(s[j] - s[i]);
      d = Math.min(d, length - d);
      if (d > sigma * 3) {
        if (k > 0) break;
        continue;
      }
      const w = Math.exp(-(d * d) / (2 * sigma * sigma));
      sw += w;
      sv += w * values[j];
    }
    out[i] = sv / sw;
  }
  return out;
}

let h = smooth(raw, SIGMA);

// Limit the gradient: relax steps that exceed MAX_GRADE (both directions, a few passes).
for (let pass = 0; pass < 60; pass++) {
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ds = s[i + 1] - s[i];
    const dh = h[j] - h[i];
    const max = MAX_GRADE * ds;
    if (Math.abs(dh) > max) {
      const excess = (Math.abs(dh) - max) / 2;
      h[i] += Math.sign(dh) * excess;
      h[j] -= Math.sign(dh) * excess;
      changed++;
    }
  }
  if (!changed) break;
}
// Harbour-front roads (Monaco): 30 m DEM pixels mix quay and sea, so the road would sit
// at the waterline. Real quays stand ~2.5 m above the sea (datum: -baseHeight).
const quay = -meta.baseHeight + 2.5;
if (id === 'monaco') for (let i = 0; i < n; i++) h[i] = Math.max(h[i], quay);
h = smooth(h, 8);

// Self-crossings: make room for a bridge.
const crossings = findCrossings(pts, Array.from(h));
for (const c of crossings) {
  const gap = h[c.upper] - h[c.lower];
  const need = BRIDGE_CLEARANCE - gap;
  console.log(`crossing at (${c.x.toFixed(0)}, ${c.z.toFixed(0)}): lower #${c.lower} ${h[c.lower].toFixed(1)} m, upper #${c.upper} ${h[c.upper].toFixed(1)} m, gap ${gap.toFixed(1)} m`);
  if (need <= 0) continue;
  // Lift the upper road 60 %, lower the lower one 40 %, with cosine ramps.
  for (const [center, amount] of [
    [c.upper, need * 0.6],
    [c.lower, -need * 0.4],
  ] as const) {
    for (let i = 0; i < n; i++) {
      let d = Math.abs(s[i] - s[center]);
      d = Math.min(d, length - d);
      if (d < BRIDGE_RAMP) h[i] += amount * 0.5 * (1 + Math.cos((Math.PI * d) / BRIDGE_RAMP));
    }
  }
  console.log(`  -> gap now ${(h[c.upper] - h[c.lower]).toFixed(1)} m`);
}

// Report: range, max gradient, profile every ~250 m.
let maxGrade = 0;
let maxAt = 0;
for (let i = 0; i < n; i++) {
  const j = (i + 1) % n;
  const g = (h[j] - h[i]) / (s[i + 1] - s[i]);
  if (Math.abs(g) > Math.abs(maxGrade)) {
    maxGrade = g;
    maxAt = s[i];
  }
}
const min = Math.min(...h);
const max = Math.max(...h);
console.log(`${name}: ${n} points, ${(length / 1000).toFixed(2)} km, height ${min.toFixed(1)}..${max.toFixed(1)} m (span ${(max - min).toFixed(1)}), max grade ${(maxGrade * 100).toFixed(1)} % at ${maxAt.toFixed(0)} m`);
const profile: string[] = [];
for (let d = 0; d < length; d += 250) {
  const i = s.findIndex((v) => v >= d);
  profile.push(`${(d / 1000).toFixed(2)}:${h[Math.min(i, n - 1)].toFixed(0)}`);
}
console.log(profile.join(' '));

writeFileSync(
  `src/world/tracks/data/${name}_elev.json`,
  JSON.stringify({
    source: 'Copernicus DEM GLO-30 (© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the EU and ESA), smoothed along the centerline',
    datum: `m above ${meta.baseHeight} m (terrain base height)`,
    heights: Array.from(h, (v) => Math.round(v * 100) / 100),
  }),
);
