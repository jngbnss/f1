/**
 * Monza landmarks from OpenStreetMap, baked into the track frame:
 *  - the old high-speed oval's bankings (Sopraelevata Nord / Sud, 1955),
 *  - the podium overhanging the main straight,
 *  - named corners (for corner signs).
 *
 *   npx tsx scripts/fetch-landmarks.ts
 *
 * Output: src/world/tracks/data/Monza_landmarks.json (© OpenStreetMap contributors, ODbL).
 * Uses the OSM->track alignment cached in Monza_geo.json by fetch-terrain.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR, overpass, projector, type V2 } from './fetch-osm';

interface Geo {
  lat0: number;
  lon0: number;
  theta: number;
  tx: number;
  ty: number;
}

const geo = JSON.parse(readFileSync(new URL('Monza_geo.json', DATA_DIR), 'utf8')) as Geo;
const proj = projector(geo.lat0, geo.lon0);
const cos = Math.cos(geo.theta);
const sin = Math.sin(geo.theta);
const round = (v: number) => Math.round(v * 10) / 10;
/** Same transform as fetch-osm.ts: tum = Rᵀ (osm - t); world = (x, -y). */
const toWorld = (lat: number, lon: number): V2 => {
  const [ox, oy] = proj(lat, lon);
  const dx = ox - geo.tx;
  const dy = oy - geo.ty;
  return [round(cos * dx + sin * dy), round(-(-sin * dx + cos * dy))];
};

const res = await overpass(
  `[out:json][timeout:90];(way["highway"="raceway"](around:2500,${geo.lat0},${geo.lon0});way["name"="Podio"](around:2500,${geo.lat0},${geo.lon0}););out tags geom;`,
);

const banking: number[][] = [];
const corners: { name: string; points: number[] }[] = [];
let podium: number[] = [];
for (const e of res.elements) {
  const pts = (e.geometry ?? []).map((g) => toWorld(g.lat, g.lon));
  if (pts.length < 2) continue;
  const name = e.tags?.name ?? '';
  if (/Sopraelevata/i.test(name)) banking.push(pts.flat());
  else if (name === 'Podio') podium = pts.slice(0, -1).flat();
  else if (/Curva|Lesmo|Variante|Parabolica/i.test(name) && e.tags?.importance === 'international') corners.push({ name, points: pts.flat() });
}

const out = {
  attribution: '© OpenStreetMap contributors (ODbL)',
  banking,
  podium,
  corners,
};
writeFileSync(new URL('Monza_landmarks.json', DATA_DIR), JSON.stringify(out));
console.log(`banking ${banking.length} pieces, podium ${podium.length / 2} pts, corners ${corners.map((c) => c.name).join(', ')}`);
