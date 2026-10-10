/**
 * Moves a circuit's already-fetched surroundings (OSM scenery, satellite /
 * DEM rectangles, georeference) when the centerline was fitted to the wrong
 * roads. Albert Park's public-road fit locked onto the street grid ~870 m
 * south-west of the park; the satellite image and OSM agree with each other,
 * only the track sat in the wrong place.
 *
 *   npx tsx scripts/realign-scenery.ts <terrainId> <DataName> <thetaRad> <tx> <tz>
 *   e.g. npx tsx scripts/realign-scenery.ts melbourne Melbourne -0.0016 840.4 -222
 *
 * (theta, tx, tz) is where the track belongs in the current scenery frame:
 * scenery = R(theta)·track + t. Every scenery point s becomes R(-theta)(s - t).
 * The axis-aligned image rectangles are only translated (theta is tiny).
 * Run bake-woods afterwards: the woods mask follows the near image rectangle.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [id, name, thetaArg, txArg, tzArg] = process.argv.slice(2);
if (!id || !name || tzArg === undefined) throw new Error('usage: realign-scenery.ts <terrainId> <DataName> <thetaRad> <tx> <tz>');
const theta = +thetaArg;
const tx = +txArg;
const tz = +tzArg;
const c = Math.cos(-theta);
const s = Math.sin(-theta);
const round = (v: number) => Math.round(v * 2) / 2;
const move = (x: number, z: number): [number, number] => {
  const dx = x - tx;
  const dz = z - tz;
  return [round(c * dx - s * dz), round(s * dx + c * dz)];
};
/** Flattened [x, z, ...] pairs starting at `from`. */
const movePairs = (a: number[], from: number) => {
  for (let i = from; i + 1 < a.length; i += 2) [a[i], a[i + 1]] = move(a[i], a[i + 1]);
};

const osmFile = `src/world/tracks/data/${name}_osm.json`;
const osm = JSON.parse(readFileSync(osmFile, 'utf8'));
for (const b of osm.buildings) movePairs(b, 2);
for (const key of ['forests', 'water', 'parking']) for (const r of osm[key]) movePairs(r, 0);
for (const r of osm.roads) movePairs(r, 1);
osm.alignment = { ...osm.alignment, corrected: { thetaRad: theta, tx, tz } };
writeFileSync(osmFile, JSON.stringify(osm));

const terrainFile = `public/terrain/${id}/terrain.json`;
const terrain = JSON.parse(readFileSync(terrainFile, 'utf8'));
for (const key of ['near', 'far', 'dem', 'demNear']) {
  const r = terrain[key]?.rect as number[] | undefined;
  if (r) terrain[key].rect = [Math.round(r[0] - tx), Math.round(r[1] - tz), Math.round(r[2] - tx), Math.round(r[3] - tz)];
}
writeFileSync(terrainFile, JSON.stringify(terrain, null, 2) + '\n');

// Georeference (OSM local metres, y north -> TUM frame, world z = -y): compose
// the old mapping with the scenery move and refit it as tum = Rᵀ(θ')·(osm - t').
const geoFile = `src/world/tracks/data/${name}_geo.json`;
const geo = JSON.parse(readFileSync(geoFile, 'utf8'));
const toTumOld = (ox: number, oy: number): [number, number] => {
  const cc = Math.cos(geo.theta);
  const ss = Math.sin(geo.theta);
  const dx = ox - geo.tx;
  const dy = oy - geo.ty;
  return [cc * dx + ss * dy, -ss * dx + cc * dy];
};
const toTumNew = (ox: number, oy: number): [number, number] => {
  const [x, y] = toTumOld(ox, oy);
  const [wx, wz] = move(x, -y);
  return [wx, -wz];
};
// Solve tum = Rᵀ(θ')(osm - t'): θ' from the image of a unit vector, t' from the origin.
const [ax, ay] = toTumNew(0, 0);
const [bx, by] = toTumNew(1000, 0);
const newTheta = -Math.atan2(by - ay, bx - ax);
const cn = Math.cos(newTheta);
const sn = Math.sin(newTheta);
// osm = R(θ')·tum + t'  at osm = 0: t' = -R(θ')·tum(0)
geo.theta = newTheta;
geo.tx = -(cn * ax - sn * ay);
geo.ty = -(sn * ax + cn * ay);
geo.corrected = 'scripts/realign-scenery.ts';
writeFileSync(geoFile, JSON.stringify(geo, null, 2) + '\n');
console.log(`${name}: scenery moved by (${(-tx).toFixed(1)}, ${(-tz).toFixed(1)}) m, ${((-theta * 180) / Math.PI).toFixed(3)}°; geo θ=${newTheta.toFixed(5)} t=(${geo.tx.toFixed(1)}, ${geo.ty.toFixed(1)})`);
