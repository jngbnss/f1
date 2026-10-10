/**
 * Smooths a TUMFTM centerline in place: some files carry local curvature
 * spikes that the racing line cannot straighten (Silverstone's Abbey, flat out
 * in reality, came out as a 41 m-radius line taken at 100 km/h). Same filter
 * as the OSM-built circuits (scripts/osm-circuit.ts): resample every 1 m,
 * repeated [1/4, 1/2, 1/4] passes (n passes ≈ sqrt(n/2) m Gaussian), back to
 * the original spacing. Half widths are kept from the nearest original point.
 *
 *   npx tsx scripts/smooth-centerline.ts <DataName> <passes>
 *
 * Always starts from the original TUMFTM file (git 42673cf), so reruns don't
 * compound.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { DATA_DIR, type V2 } from './fetch-osm';
import { dist, loopLength, resample, smooth } from './osm-circuit';

const [name, passArg] = process.argv.slice(2);
if (!name || !passArg) throw new Error('usage: smooth-centerline.ts <DataName> <passes>');
const passes = +passArg;

const text = execSync(`git show 42673cf:src/world/tracks/data/${name}.csv`, { encoding: 'utf8', maxBuffer: 1 << 24 });
const rows = text
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => l.split(',').map(Number));
const orig: V2[] = rows.map((r) => [r[0], r[1]]);
const spacing = loopLength(orig) / orig.length;

let pts = resample(smooth(resample(orig, 1), passes), spacing);
// Keep the start line where it was.
let i0 = 0;
pts.forEach((p, i) => {
  if (dist(p, orig[0]) < dist(pts[i0], orig[0])) i0 = i;
});
pts = pts.slice(i0).concat(pts.slice(0, i0));

const nearest = (p: V2) => {
  let best = 0;
  orig.forEach((q, i) => {
    if (dist(q, p) < dist(orig[best], p)) best = i;
  });
  return best;
};
let shift = 0;
const out = pts.map((p) => {
  const j = nearest(p);
  shift = Math.max(shift, dist(p, orig[j]));
  return `${p[0].toFixed(3)},${p[1].toFixed(3)},${rows[j][2].toFixed(3)},${rows[j][3].toFixed(3)}`;
});
writeFileSync(
  new URL(`${name}.csv`, DATA_DIR),
  `# x_m,y_m,w_tr_right_m,w_tr_left_m\n# TUMFTM racetrack-database (LGPL-3.0), smoothed by scripts/smooth-centerline.ts (${passes} passes)\n${out.join('\n')}\n`,
);
console.log(`${name}: ${passes} passes, length ${loopLength(orig).toFixed(0)} -> ${loopLength(pts).toFixed(0)} m, max shift ${shift.toFixed(1)} m`);
