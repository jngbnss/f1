/**
 * Current circuit layouts from OpenStreetMap circuit relations, for circuits
 * whose TUMFTM centerline predates a rebuild:
 *   - melbourne: 2022 Albert Park (T9-T10 chicane gone); the TUMFTM polyline
 *     also had sharp vertices (Turn 5, flat out in reality, a 40 m-radius kink)
 *   - catalunya: final chicane gone (2023)
 *   - yasmarina: 2021 Yas Marina (T5-T6 chicane and T11-T14 rebuilt)
 *
 *   npx tsx scripts/fetch-osm-circuit.ts <id>
 *
 * The loop is written in the circuit's existing frame (<Name>_geo.json), so
 * the OSM scenery and satellite terrain already fetched stay aligned. Track
 * widths, the race direction and (when OSM has no start node) the start line
 * come from the original TUMFTM centerline (git 42673cf). Prints where the
 * real pit lane (member "pit_lane", when mapped) leaves and rejoins the track,
 * for PIT_LANE in TrackLayout.ts. Overpass answers are cached in .tmp/.
 *
 * Track data © OpenStreetMap contributors (ODbL).
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR, overpass, projector, type V2 } from './fetch-osm';
import { dist, loopLength, resample, smooth, stitch } from './osm-circuit';

interface Spec {
  file: string;
  relation: number;
  /** Real lap length (m), for the stitch and the sanity check. */
  length: number;
  /**
   * Smoothing passes on the 1 m resample (500 ≈ 16 m Gaussian). Raceways
   * mapped with few nodes keep 6-20 m-radius vertices with Monaco's 50;
   * 500 brings Albert Park's ideal lap to ~1.15x the real pole like the other
   * circuits, at 0.8 % lap length lost.
   */
  smooth: number;
  note: string;
}

const SPECS: Record<string, Spec> = {
  melbourne: { file: 'Melbourne', relation: 280443, length: 5278, smooth: 500, note: 'Albert Park Circuit (2022 layout)' },
  catalunya: { file: 'Catalunya', relation: 284540, length: 4657, smooth: 300, note: 'Circuit de Barcelona-Catalunya (2023 layout, no final chicane)' },
  yasmarina: { file: 'YasMarina', relation: 11378665, length: 5281, smooth: 300, note: 'Yas Marina Circuit (2021 layout)' },
};

const SPACING = 5;
/** Last commit with the unmodified TUMFTM files. */
const TUM_COMMIT = '42673cf';

interface Member {
  type: string;
  ref: number;
  role: string;
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
}

async function relation(id: number): Promise<Member[]> {
  const cache = new URL(`../.tmp/relation_${id}.json`, import.meta.url);
  if (!existsSync(cache)) {
    const j = await overpass(`[out:json][timeout:90];relation(${id});out geom;`);
    mkdirSync(new URL('../.tmp/', import.meta.url), { recursive: true });
    writeFileSync(cache, JSON.stringify(j));
  }
  return (JSON.parse(readFileSync(cache, 'utf8')).elements[0] as { members: Member[] }).members;
}

/** Original TUMFTM centerline (TUM frame) with its half widths. */
function tumftm(file: string): { pts: V2[]; right: number[]; left: number[] } {
  const rows = execSync(`git show ${TUM_COMMIT}:src/world/tracks/data/${file}.csv`, { encoding: 'utf8', maxBuffer: 1 << 24 })
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
  const id = process.argv[2];
  const spec = SPECS[id];
  if (!spec) throw new Error(`usage: fetch-osm-circuit.ts <${Object.keys(SPECS).join('|')}>`);
  const passes = +(process.env.SMOOTH ?? spec.smooth);
  const geo = JSON.parse(readFileSync(new URL(`${spec.file}_geo.json`, DATA_DIR), 'utf8')) as { lat0: number; lon0: number; theta: number; tx: number; ty: number };
  const proj = projector(geo.lat0, geo.lon0);
  // OSM local -> TUM frame (as in fetch-osm.ts): tum = Rᵀ(θ)(osm - t)
  const c = Math.cos(geo.theta);
  const s = Math.sin(geo.theta);
  const toTum = ([x, y]: V2): V2 => [c * (x - geo.tx) + s * (y - geo.ty), -s * (x - geo.tx) + c * (y - geo.ty)];
  const at = (g: { lat: number; lon: number }) => toTum(proj(g.lat, g.lon));

  const old = tumftm(spec.file);
  const members = await relation(spec.relation);
  const start = members.find((m) => m.type === 'node' && /start/.test(m.role));
  const ways = members.filter((m) => m.type === 'way' && (m.role === '' || m.role === 'forward') && m.geometry).map((m) => m.geometry!.map(at));
  const pitWay = members.find((m) => m.type === 'way' && /pit/.test(m.role) && m.geometry)?.geometry?.map(at);
  const sf = start ? at({ lat: start.lat!, lon: start.lon! }) : old.pts[0];
  console.log(`  ${ways.length} ways, start ${start ? 'from OSM' : 'from TUMFTM'}`);

  let pts = resample(smooth(resample(stitch(ways, sf, spec.length), 1), passes), SPACING);
  const i0 = nearestIndex(pts, sf);
  pts = pts.slice(i0).concat(pts.slice(0, i0));
  // Race direction from the TUMFTM centerline: its point 150 m after the line.
  const oldAhead = old.pts[Math.round(150 / dist(old.pts[0], old.pts[1]))];
  const k = Math.round(150 / SPACING);
  if (dist(pts[pts.length - k], oldAhead) < dist(pts[k], oldAhead)) pts = [pts[0], ...pts.slice(1).reverse()];

  const total = loopLength(pts);
  const err = Math.abs(total - spec.length) / spec.length;
  console.log(`  length ${total.toFixed(0)} m (real ${spec.length}, ${(err * 100).toFixed(1)}% off), ${pts.length} points, start ${dist(pts[0], old.pts[0]).toFixed(0)} m from TUMFTM's`);
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
  const csv = `# x_m,y_m,w_tr_right_m,w_tr_left_m\n# ${spec.note} from OpenStreetMap relation ${spec.relation} (© OpenStreetMap contributors, ODbL); widths from TUMFTM racetrack-database (LGPL-3.0)\n${rows.join('\n')}\n`;
  writeFileSync(new URL(`${spec.file}.csv`, DATA_DIR), csv);
  console.log(`  wrote ${spec.file}.csv`);
}

void main();
