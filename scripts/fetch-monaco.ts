/**
 * Circuit de Monaco is not in the TUMFTM dataset (it is a street circuit), so
 * its centerline is built from OpenStreetMap: relation 148194 "Circuit de
 * Monaco" lists the public-road ways of the Grand Prix route in order. They
 * are stitched into one closed loop, projected to local meters with the same
 * projector the other circuits use, smoothed, resampled every 2.5 m and
 * written in the TUMFTM CSV format, starting at the start/finish line:
 *
 *   npx tsx scripts/fetch-monaco.ts
 *
 * Output: src/world/tracks/data/Monaco.csv (x_m, y_m, w_tr_right_m, w_tr_left_m)
 *         src/world/tracks/data/Monaco_geo.json (exact georeference: the CSV IS
 *         the OSM projection, so the other scripts need no alignment search)
 * The Overpass answer is cached in .tmp/monaco_rel.json.
 *
 * Track data © OpenStreetMap contributors (ODbL).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR, overpass, projector, type V2 } from './fetch-osm';
import { dist, loopLength as length, resample, smooth, stitch } from './osm-circuit';

/** Projection origin (Port Hercule, roughly the middle of the lap). */
export const MONACO = { lat: 43.7365, lon: 7.4235 };
const RELATION = 148194;
const CACHE = new URL('../.tmp/monaco_rel.json', import.meta.url);
const SPACING = 2.5;
/** Real lap length (m), for the sanity check. */
const REAL_LENGTH = 3337;

interface Member {
  type: string;
  ref: number;
  role: string;
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
}

async function relation(): Promise<Member[]> {
  if (existsSync(CACHE)) return (JSON.parse(readFileSync(CACHE, 'utf8')).elements[0] as { members: Member[] }).members;
  const j = await overpass(`[out:json][timeout:90];relation(${RELATION});out geom;`);
  mkdirSync(new URL('../.tmp/', import.meta.url), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(j));
  return (j.elements[0] as unknown as { members: Member[] }).members;
}

async function main(): Promise<void> {
  const proj = projector(MONACO.lat, MONACO.lon);
  const members = await relation();
  const sf = members.find((m) => m.role === 'start-finish' && m.type === 'node')!;
  const ways = members.filter((m) => m.type === 'way' && m.role === '' && m.geometry).map((m) => m.geometry!.map((g) => proj(g.lat, g.lon)));
  console.log(`  ${ways.length} ways`);
  const s = proj(sf.lat!, sf.lon!);
  let loop = stitch(ways, s, REAL_LENGTH);
  console.log(`  raw length ${length(loop).toFixed(0)} m`);
  // ~5 m of smoothing: OSM street geometry has sharp kinks where ways meet (they would
  // read as impossible 5 m-radius flicks); real corners like the hairpin keep their shape.
  loop = smooth(resample(loop, 1), 50);
  let pts = resample(loop, SPACING);

  // Start at the start/finish line.
  let i0 = 0;
  pts.forEach((p, i) => {
    if (dist(p, s) < dist(pts[i0], s)) i0 = i;
  });
  pts = pts.slice(i0).concat(pts.slice(0, i0));
  // Race direction: from the line up Boulevard Albert 1er to Sainte Dévote (north-east).
  const devote = proj(43.7383, 7.4266);
  const ahead = pts[Math.round(150 / SPACING)];
  const behind = pts[pts.length - Math.round(150 / SPACING)];
  if (dist(behind, devote) < dist(ahead, devote)) pts = [pts[0], ...pts.slice(1).reverse()];

  const total = length(pts);
  const err = Math.abs(total - REAL_LENGTH) / REAL_LENGTH;
  console.log(`  length ${total.toFixed(0)} m (real ${REAL_LENGTH}, ${(err * 100).toFixed(1)}% off), ${pts.length} points`);
  if (err > 0.03) console.warn('  WARNING: length more than 3% off');

  // Half widths: the circuit is 8-10 m wide; the pit straight (Bd Albert 1er) is wider.
  const rows = pts.map(([x, y], i) => {
    const d = i * SPACING;
    const fromLine = Math.min(d, total - d);
    const half = fromLine < 260 ? 5.5 : 4.6;
    return `${x.toFixed(3)},${y.toFixed(3)},${half.toFixed(3)},${half.toFixed(3)}`;
  });
  const csv = `# x_m,y_m,w_tr_right_m,w_tr_left_m\n# Circuit de Monaco from OpenStreetMap relation ${RELATION} (© OpenStreetMap contributors, ODbL)\n${rows.join('\n')}\n`;
  writeFileSync(new URL('Monaco.csv', DATA_DIR), csv);
  // The CSV is in the projector's frame: identity georeference.
  writeFileSync(new URL('Monaco_geo.json', DATA_DIR), JSON.stringify({ lat0: MONACO.lat, lon0: MONACO.lon, theta: 0, tx: 0, ty: 0, rms: 0, inliers: 1, exact: true }, null, 2));
  console.log('  wrote Monaco.csv, Monaco_geo.json');
  await landmarks(proj);
}

const LANDMARK_CACHE = new URL('../.tmp/monaco_landmarks_osm.json', import.meta.url);

/**
 * Monaco_landmarks.json (world x/z): the sea polygon (OSM coastline, land on
 * its left, closed far out at sea), the sea level in the track's height datum
 * (needs public/terrain/monaco/terrain.json from fetch-terrain.ts) and the
 * Casino de Monte-Carlo position.
 */
async function landmarks(proj: (lat: number, lon: number) => V2): Promise<void> {
  type El = { tags?: Record<string, string>; geometry?: { lat: number; lon: number }[]; lat?: number; lon?: number };
  let els: El[];
  if (existsSync(LANDMARK_CACHE)) els = JSON.parse(readFileSync(LANDMARK_CACHE, 'utf8')) as El[];
  else {
    const r = await overpass(`[out:json][timeout:90];(way["natural"="coastline"](43.70,7.38,43.77,7.47);node["amenity"="casino"]["name"~"Monte",i](43.73,7.41,43.75,7.44););out geom;`);
    els = r.elements as unknown as El[];
    writeFileSync(LANDMARK_CACHE, JSON.stringify(els));
  }
  const key = (p: V2) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const rest = els.filter((e) => e.tags?.natural === 'coastline' && e.geometry).map((e) => e.geometry!.map((g) => proj(g.lat, g.lon)));
  const chains: V2[][] = [];
  while (rest.length) {
    let c = rest.shift()!;
    for (let grew = true; grew; ) {
      grew = false;
      for (let i = 0; i < rest.length; i++) {
        const w = rest[i];
        if (key(c[c.length - 1]) === key(w[0])) c = c.concat(w.slice(1));
        else if (key(w[w.length - 1]) === key(c[0])) c = w.concat(c.slice(1));
        else continue;
        rest.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (key(c[0]) !== key(c[c.length - 1])) chains.push(c); // islands / closed rings skipped
  }
  // Coastline runs south-west -> north-east with the land on its left: join the open
  // chains in that order, then close the polygon far out over the sea (south-east).
  chains.sort((a, b) => a[0][0] + a[0][1] - (b[0][0] + b[0][1]));
  const coast = chains.flat();
  const first = coast[0];
  const last = coast[coast.length - 1];
  const far = 6000;
  const sea: V2[] = [...coast, [last[0] + far, last[1]], [last[0] + far, first[1] - far], [first[0], first[1] - far]];
  const casino = els.find((e) => e.tags?.amenity === 'casino');
  const c = casino ? proj(casino.lat!, casino.lon!) : null;
  const terrainMeta = new URL('../public/terrain/monaco/terrain.json', import.meta.url);
  const seaLevel = existsSync(terrainMeta) ? -(JSON.parse(readFileSync(terrainMeta, 'utf8')) as { baseHeight: number }).baseHeight : null;
  const round = (v: number) => Math.round(v * 10) / 10;
  const out = {
    attribution: '© OpenStreetMap contributors (ODbL)',
    seaLevel,
    sea: sea.flatMap(([x, y]) => [round(x), round(-y)]),
    casino: c ? [round(c[0]), round(-c[1])] : null,
  };
  writeFileSync(new URL('Monaco_landmarks.json', DATA_DIR), JSON.stringify(out));
  console.log(`  wrote Monaco_landmarks.json: sea polygon ${sea.length} points, sea level ${seaLevel}, casino ${out.casino}`);
}

void main();
