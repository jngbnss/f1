/**
 * Downloads real-world surroundings of each circuit from OpenStreetMap
 * (Overpass API), aligns them to the TUMFTM centerline coordinate frame and
 * writes compact JSON next to the track data:
 *
 *   npx tsx scripts/fetch-osm.ts            # all circuits
 *   npx tsx scripts/fetch-osm.ts monza      # one circuit
 *
 * Output: src/world/tracks/data/<Name>_osm.json  (© OpenStreetMap contributors, ODbL)
 *
 * Alignment: the TUMFTM data is in local meters with an unknown origin
 * (≈ start line). We project OSM to local meters and find the rigid 2D
 * transform (rotation + translation) that best maps the TUM centerline onto
 * OSM highway=raceway geometry: coarse grid search, then trimmed ICP.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface Circuit {
  id: string;
  file: string;
  lat: number;
  lon: number;
}

export const CIRCUITS: Circuit[] = [
  { id: 'spielberg', file: 'Spielberg', lat: 47.2197, lon: 14.7647 },
  { id: 'monza', file: 'Monza', lat: 45.6156, lon: 9.2811 },
  { id: 'silverstone', file: 'Silverstone', lat: 52.0786, lon: -1.0169 },
  { id: 'spa', file: 'Spa', lat: 50.4372, lon: 5.9714 },
  { id: 'melbourne', file: 'Melbourne', lat: -37.8497, lon: 144.968 },
  { id: 'shanghai', file: 'Shanghai', lat: 31.3389, lon: 121.2197 },
  { id: 'suzuka', file: 'Suzuka', lat: 34.8431, lon: 136.541 },
  { id: 'sakhir', file: 'Sakhir', lat: 26.0325, lon: 50.5106 },
  { id: 'montreal', file: 'Montreal', lat: 45.5, lon: -73.5228 },
  { id: 'catalunya', file: 'Catalunya', lat: 41.57, lon: 2.2611 },
  { id: 'budapest', file: 'Budapest', lat: 47.5789, lon: 19.2486 },
  { id: 'zandvoort', file: 'Zandvoort', lat: 52.3888, lon: 4.5409 },
  { id: 'austin', file: 'Austin', lat: 30.1328, lon: -97.6411 },
  { id: 'mexicocity', file: 'MexicoCity', lat: 19.4042, lon: -99.0907 },
  { id: 'saopaulo', file: 'SaoPaulo', lat: -23.7036, lon: -46.6997 },
  { id: 'yasmarina', file: 'YasMarina', lat: 24.4672, lon: 54.6031 },
];

export const DATA_DIR = new URL('../src/world/tracks/data/', import.meta.url);
/** Public Overpass instances, tried in turn (the main one often answers 504 when busy). */
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const USER_AGENT = 'web-sim-lab/0.1 (https://github.com/jngbnss/f1; offline scenery build script)';
/** Extra margin around the circuit to include (m). */
const MARGIN = 600;

export type V2 = [number, number];

export async function overpass(query: string): Promise<{ elements: OsmElement[] }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(180000),
      });
      if (res.ok) {
        const json = (await res.json()) as { elements: OsmElement[]; remark?: string };
        // Timeouts come back as 200 with a remark and partial/empty data.
        if (!json.remark || !/error|timed out/i.test(json.remark)) return json;
        console.warn(`  ${new URL(url).host}: ${json.remark}`);
      } else {
        console.warn(`  ${new URL(url).host}: HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn(`  ${new URL(url).host}: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  throw new Error('Overpass request failed');
}

interface OsmElement {
  type: 'way' | 'relation' | 'node';
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

export function projector(lat0: number, lon0: number) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110540;
  return (lat: number, lon: number): V2 => [(lon - lon0) * kx, (lat - lat0) * ky];
}

/** Spatial hash for nearest-point queries. */
class Hash {
  private readonly cells = new Map<string, V2[]>();
  constructor(
    pts: V2[],
    private readonly size: number,
  ) {
    for (const p of pts) {
      const k = this.key(p[0], p[1]);
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      c.push(p);
    }
  }
  private key(x: number, y: number) {
    return `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`;
  }
  nearest(x: number, y: number): { p: V2 | null; d: number } {
    const cx = Math.floor(x / this.size);
    const cy = Math.floor(y / this.size);
    let best: V2 | null = null;
    let bd = Infinity;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const c = this.cells.get(`${cx + i},${cy + j}`);
        if (!c) continue;
        for (const p of c) {
          const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
      }
    return { p: best, d: Math.sqrt(bd) };
  }
}

export function densify(line: V2[], step: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  if (line.length) out.push(line[line.length - 1]);
  return out;
}

/** Find R(θ), t with R·tum + t ≈ osm. */
export function align(tum: V2[], osm: V2[]): { theta: number; tx: number; ty: number; rms: number; inliers: number } {
  const hash = new Hash(osm, 25);
  const sample = tum.filter((_, i) => i % 4 === 0);
  const score = (theta: number, tx: number, ty: number, tol: number) => {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    let hits = 0;
    for (const [x, y] of sample) {
      const { d } = hash.nearest(c * x - s * y + tx, s * x + c * y + ty);
      if (d < tol) hits++;
    }
    return hits;
  };

  // Coarse search: OSM raceway bbox center vs TUM bbox center gives the start; search ±800 m.
  const bb = (pts: V2[]) => {
    // Loops, not Math.min(...xs): road networks have too many points for spread arguments.
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  };
  const [ox, oy] = bb(osm);
  const [mx, my] = bb(tum);
  let best = { theta: 0, tx: ox - mx, ty: oy - my, hits: -1 };
  for (const theta of [-0.04, -0.02, 0, 0.02, 0.04]) {
    for (let dx = -800; dx <= 800; dx += 20)
      for (let dy = -800; dy <= 800; dy += 20) {
        const tx = ox - mx + dx;
        const ty = oy - my + dy;
        const h = score(theta, tx, ty, 20);
        if (h > best.hits) best = { theta, tx, ty, hits: h };
      }
  }

  // Trimmed ICP (2D Kabsch) with shrinking inlier distance.
  let { theta, tx, ty } = best;
  for (const tol of [25, 15, 10, 6, 4, 4, 4]) {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const A: V2[] = [];
    const B: V2[] = [];
    for (const [x, y] of tum) {
      const px = c * x - s * y + tx;
      const py = s * x + c * y + ty;
      const { p, d } = hash.nearest(px, py);
      if (p && d < tol) {
        A.push([x, y]);
        B.push(p);
      }
    }
    if (A.length < 20) break;
    const ca = A.reduce((m, p) => [m[0] + p[0] / A.length, m[1] + p[1] / A.length], [0, 0]);
    const cb = B.reduce((m, p) => [m[0] + p[0] / B.length, m[1] + p[1] / B.length], [0, 0]);
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < A.length; i++) {
      const ax = A[i][0] - ca[0];
      const ay = A[i][1] - ca[1];
      const bx = B[i][0] - cb[0];
      const by = B[i][1] - cb[1];
      sxx += ax * bx + ay * by;
      sxy += ax * by - ay * bx;
    }
    theta = Math.atan2(sxy, sxx);
    const c2 = Math.cos(theta);
    const s2 = Math.sin(theta);
    tx = cb[0] - (c2 * ca[0] - s2 * ca[1]);
    ty = cb[1] - (s2 * ca[0] + c2 * ca[1]);
  }

  const c = Math.cos(theta);
  const s = Math.sin(theta);
  let sum = 0;
  let n = 0;
  for (const [x, y] of tum) {
    const { d } = hash.nearest(c * x - s * y + tx, s * x + c * y + ty);
    if (d < 15) {
      sum += d * d;
      n++;
    }
  }
  return { theta, tx, ty, rms: Math.sqrt(sum / Math.max(n, 1)), inliers: n / tum.length };
}

/** Joins open ways into closed rings (for multipolygon outers). */
function stitchRings(parts: V2[][]): V2[][] {
  const rings: V2[][] = [];
  const open = parts.filter((p) => p.length > 1).map((p) => [...p]);
  const same = (a: V2, b: V2) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
  while (open.length) {
    let ring = open.shift()!;
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const p = open[i];
        const end = ring[ring.length - 1];
        if (same(end, p[0])) ring = ring.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) ring = ring.concat([...p].reverse().slice(1));
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function buildingHeight(tags: Record<string, string>): number {
  const h = parseFloat(tags.height ?? '');
  if (Number.isFinite(h) && h > 2 && h < 150) return h;
  const levels = parseFloat(tags['building:levels'] ?? '');
  if (Number.isFinite(levels) && levels > 0) return Math.min(levels * 3.2 + 1, 120);
  switch (tags.building) {
    case 'grandstand':
      return 12;
    case 'house':
    case 'detached':
    case 'garage':
    case 'shed':
      return 6;
    case 'industrial':
    case 'warehouse':
    case 'hangar':
      return 9;
    default:
      return 8;
  }
}

const BUILDING_KIND: Record<string, number> = { grandstand: 1, house: 2, detached: 2, residential: 2, apartments: 2 };
const ROAD_WIDTH: Record<string, number> = {
  motorway: 14,
  trunk: 11,
  primary: 9,
  secondary: 8,
  tertiary: 7,
  unclassified: 5.5,
  residential: 5.5,
  service: 4,
};

const round = (v: number) => Math.round(v * 2) / 2; // 0.5 m precision keeps files small

async function processCircuit(c: Circuit): Promise<void> {
  console.log(`\n${c.id}`);
  const proj = projector(c.lat, c.lon);
  const tum = readCenterline(c);
  const ext = Math.max(...tum.map((p) => Math.hypot(p[0], p[1])));
  const radius = Math.round(Math.max(2500, ext + 400));

  const race = await overpass(`[out:json][timeout:90];way["highway"="raceway"](around:${radius},${c.lat},${c.lon});out geom;`);
  const raceLines = race.elements.filter((e) => e.geometry).map((e) => densify(e.geometry!.map((g) => proj(g.lat, g.lon)), 2));
  let t = align(tum, raceLines.flat());
  if (t.inliers < 0.8) {
    // Street / park circuits (Albert Park, parts of Montréal) are public roads, not raceways.
    console.log(`  raceway fit ${(t.inliers * 100).toFixed(0)}% -> trying public roads`);
    const roads = await overpass(`[out:json][timeout:120];way["highway"~"^(primary|secondary|tertiary|unclassified|residential|service|raceway)$"](around:${radius},${c.lat},${c.lon});out geom;`);
    const roadLines = roads.elements.filter((e) => e.geometry).map((e) => densify(e.geometry!.map((g) => proj(g.lat, g.lon)), 2));
    const t2 = align(tum, roadLines.flat());
    if (t2.inliers > t.inliers) t = t2;
  }
  console.log(`  aligned: θ=${((t.theta * 180) / Math.PI).toFixed(2)}°, rms ${t.rms.toFixed(2)} m, inliers ${(t.inliers * 100).toFixed(0)}%`);
  if (t.inliers < 0.6) {
    console.warn('  SKIPPED: alignment too weak, not writing scenery');
    return;
  }
  if (t.inliers < 0.8) console.warn('  WARNING: weak alignment');

  // OSM local -> TUM frame: tum = Rᵀ (osm - t); world = (x, -y)
  const cos = Math.cos(t.theta);
  const sin = Math.sin(t.theta);
  const toWorld = (lat: number, lon: number): V2 => {
    const [ox, oy] = proj(lat, lon);
    const dx = ox - t.tx;
    const dy = oy - t.ty;
    const x = cos * dx + sin * dy;
    const y = -sin * dx + cos * dy;
    return [round(x), round(-y)];
  };

  // Feature area = TUM bbox + margin (in TUM/world frame).
  const xs = tum.map((p) => p[0]);
  const zs = tum.map((p) => -p[1]);
  const box = { x0: Math.min(...xs) - MARGIN, x1: Math.max(...xs) + MARGIN, z0: Math.min(...zs) - MARGIN, z1: Math.max(...zs) + MARGIN };
  const inBox = (pts: V2[]) => pts.some(([x, z]) => x > box.x0 && x < box.x1 && z > box.z0 && z < box.z1);

  const fr = radius + MARGIN;
  const q = `[out:json][timeout:180];
(
  way["building"](around:${fr},${c.lat},${c.lon});
  way["landuse"~"^(forest)$"](around:${fr},${c.lat},${c.lon});
  way["natural"~"^(wood|water|scrub)$"](around:${fr},${c.lat},${c.lon});
  relation["landuse"="forest"](around:${fr},${c.lat},${c.lon});
  relation["natural"~"^(wood|water)$"](around:${fr},${c.lat},${c.lon});
  way["amenity"="parking"](around:${fr},${c.lat},${c.lon});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service)$"](around:${fr},${c.lat},${c.lon});
);
out geom;`;
  const res = await overpass(q);

  const buildings: number[][] = [];
  const forests: number[][] = [];
  const water: number[][] = [];
  const parking: number[][] = [];
  const roads: number[][] = [];
  const flat = (pts: V2[]) => pts.flat();

  for (const e of res.elements) {
    const tags = e.tags ?? {};
    let rings: V2[][] = [];
    if (e.type === 'way' && e.geometry) rings = [e.geometry.map((g) => toWorld(g.lat, g.lon))];
    else if (e.type === 'relation' && e.members)
      rings = stitchRings(e.members.filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry!.map((g) => toWorld(g.lat, g.lon))));

    for (const pts of rings) {
      if (pts.length < 2 || !inBox(pts)) continue;
      const closed = pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
      if (tags.highway) {
        if (tags.bridge || tags.tunnel || tags.area === 'yes') continue;
        roads.push([ROAD_WIDTH[tags.highway] ?? 5, ...flat(pts)]);
      } else if (!closed) {
        continue;
      } else if (tags.building) {
        buildings.push([round(buildingHeight(tags)), BUILDING_KIND[tags.building] ?? 0, ...flat(pts.slice(0, -1))]);
      } else if (tags.landuse === 'forest' || tags.natural === 'wood' || tags.natural === 'scrub') {
        forests.push(flat(pts.slice(0, -1)));
      } else if (tags.natural === 'water') {
        water.push(flat(pts.slice(0, -1)));
      } else if (tags.amenity === 'parking') {
        parking.push(flat(pts.slice(0, -1)));
      }
    }
  }

  const out = {
    attribution: '© OpenStreetMap contributors (ODbL)',
    source: 'Overpass API',
    fetched: new Date().toISOString().slice(0, 10),
    alignment: { thetaDeg: +((t.theta * 180) / Math.PI).toFixed(3), rmsMeters: +t.rms.toFixed(2), inlierRatio: +t.inliers.toFixed(3) },
    buildings,
    forests,
    water,
    parking,
    roads,
  };
  const json = JSON.stringify(out);
  writeFileSync(new URL(`${c.file}_osm.json`, DATA_DIR), json);
  console.log(
    `  buildings ${buildings.length}, forests ${forests.length}, water ${water.length}, parking ${parking.length}, roads ${roads.length} -> ${(json.length / 1024).toFixed(0)} KB`,
  );
}

/** TUM centerline of a circuit (local meters, y = north-ish; world z = -y). */
export function readCenterline(c: Circuit): V2[] {
  return readFileSync(new URL(`${c.file}.csv`, DATA_DIR), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').map(Number))
    .map(([x, y]) => [x, y] as V2);
}

// Run only when executed directly (scripts/fetch-terrain.ts imports the helpers).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const only = process.argv[2];
  for (const c of CIRCUITS.filter((c) => !only || c.id === only)) {
    await processCircuit(c);
    await new Promise((r) => setTimeout(r, 5000)); // be polite to the public Overpass server
  }
}
