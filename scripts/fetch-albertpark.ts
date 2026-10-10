/**
 * Albert Park from OpenStreetMap (relation 280443 "Albert Park Circuit"),
 * replacing the TUMFTM centerline: that one predates the 2022 rebuild (T9-T10
 * chicane still there) and its polyline has sharp vertices (Turn 5, flat out
 * in reality, came out as a 40 m-radius kink).
 *
 *   npx tsx scripts/fetch-albertpark.ts
 *
 * The loop is written in the circuit's existing frame (Melbourne_geo.json),
 * so the OSM scenery and satellite terrain already fetched stay aligned.
 * Track widths and the race direction are taken from the previous centerline
 * (the TUMFTM one, `git show 42673cf:src/world/tracks/data/Melbourne.csv`).
 * Prints where the real pit lane (relation member "pit_lane") leaves and
 * rejoins the track, for PIT_LANE in TrackLayout.ts.
 * The Overpass answer is cached in .tmp/albertpark_rel.json.
 *
 * Track data © OpenStreetMap contributors (ODbL).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR, overpass, projector, type V2 } from './fetch-osm';
import { dist, loopLength, resample, smooth, stitch } from './osm-circuit';

const RELATION = 280443;
const CACHE = new URL('../.tmp/albertpark_rel.json', import.meta.url);
const SPACING = 5;
/**
 * Smoothing passes on the 1 m resample (~16 m Gaussian). The raceway is mapped
 * with few nodes, so Monaco's 50 passes leave 6-20 m-radius vertices (Turns 5
 * and 6); 500 brings the ideal lap to ~1.15x the real pole, like the other
 * circuits, at 0.8 % lap length lost.
 */
const SMOOTH_PASSES = +(process.env.SMOOTH ?? 500);
/** Real lap length since 2022 (m), for the stitch and the sanity check. */
const REAL_LENGTH = 5278;

interface Member {
  type: string;
  ref: number;
  role: string;
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
}

async function relation(): Promise<Member[]> {
  if (!existsSync(CACHE)) {
    const j = await overpass(`[out:json][timeout:90];relation(${RELATION});out geom;`);
    mkdirSync(new URL('../.tmp/', import.meta.url), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(j));
  }
  return (JSON.parse(readFileSync(CACHE, 'utf8')).elements[0] as { members: Member[] }).members;
}

/** Previous centerline (TUM frame) with its half widths. */
function previous(): { pts: V2[]; right: number[]; left: number[] } {
  const rows = readFileSync(new URL('Melbourne.csv', DATA_DIR), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split(',').map(Number));
  return { pts: rows.map((r) => [r[0], r[1]] as V2), right: rows.map((r) => r[2]), left: rows.map((r) => r[3]) };
}

const nearestIndex = (pts: V2[], p: V2) => {
  let best = 0;
  pts.forEach((q, i) => {
    if (dist(q, p) < dist(pts[best], p)) best = i;
  });
  return best;
};

async function main(): Promise<void> {
  const geo = JSON.parse(readFileSync(new URL('Melbourne_geo.json', DATA_DIR), 'utf8')) as { lat0: number; lon0: number; theta: number; tx: number; ty: number };
  const proj = projector(geo.lat0, geo.lon0);
  // OSM local -> TUM frame (as in fetch-osm.ts): tum = Rᵀ(θ)(osm - t)
  const c = Math.cos(geo.theta);
  const s = Math.sin(geo.theta);
  const toTum = ([x, y]: V2): V2 => [c * (x - geo.tx) + s * (y - geo.ty), -s * (x - geo.tx) + c * (y - geo.ty)];
  const at = (g: { lat: number; lon: number }) => toTum(proj(g.lat, g.lon));

  const members = await relation();
  const start = members.find((m) => m.type === 'node' && m.role === 'start')!;
  const ways = members.filter((m) => m.type === 'way' && (m.role === '' || m.role === 'forward') && m.geometry).map((m) => m.geometry!.map(at));
  const pitWay = members.find((m) => m.type === 'way' && m.role === 'pit_lane' && m.geometry)?.geometry?.map(at);
  console.log(`  ${ways.length} ways`);
  const sf = at({ lat: start.lat!, lon: start.lon! });

  let pts = resample(smooth(resample(stitch(ways, sf, REAL_LENGTH), 1), SMOOTH_PASSES), SPACING);
  const i0 = nearestIndex(pts, sf);
  pts = pts.slice(i0).concat(pts.slice(0, i0));
  // Race direction (clockwise) from the previous centerline: its point 150 m after the line.
  const old = previous();
  const oldAhead = old.pts[Math.round(150 / 5)];
  const k = Math.round(150 / SPACING);
  if (dist(pts[pts.length - k], oldAhead) < dist(pts[k], oldAhead)) pts = [pts[0], ...pts.slice(1).reverse()];

  const total = loopLength(pts);
  const err = Math.abs(total - REAL_LENGTH) / REAL_LENGTH;
  console.log(`  length ${total.toFixed(0)} m (real ${REAL_LENGTH}, ${(err * 100).toFixed(1)}% off), ${pts.length} points`);
  if (err > 0.03) console.warn('  WARNING: length more than 3% off');

  if (pitWay) {
    const along = (p: V2) => nearestIndex(pts, p) * (total / pts.length);
    const a = along(pitWay[0]);
    const b = along(pitWay[pitWay.length - 1]);
    const [entry, exit] = total - a < total - b ? [a, b] : [b, a];
    console.log(`  pit lane: leaves the track ${(total - entry).toFixed(0)} m before the line, rejoins ${exit.toFixed(0)} m after it`);
  }

  const rows = pts.map((p) => {
    const j = nearestIndex(old.pts, p);
    return `${p[0].toFixed(3)},${p[1].toFixed(3)},${old.right[j].toFixed(3)},${old.left[j].toFixed(3)}`;
  });
  const csv = `# x_m,y_m,w_tr_right_m,w_tr_left_m\n# Albert Park Circuit (2022 layout) from OpenStreetMap relation ${RELATION} (© OpenStreetMap contributors, ODbL); widths from TUMFTM racetrack-database (LGPL-3.0)\n${rows.join('\n')}\n`;
  writeFileSync(new URL('Melbourne.csv', DATA_DIR), csv);
  console.log('  wrote Melbourne.csv');
}

void main();
