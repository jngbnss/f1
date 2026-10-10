/**
 * Tyre model check: an AI-driven F1 car laps a circuit on each compound and
 * reports wear, temperatures, grip and lap time per lap.
 *
 *   npx tsx scripts/tyre-test.ts [track=monza] [laps=3] [wet|damp]
 */
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { AIDriver } from '../src/race/AIDriver';
import { findCar } from '../src/vehicle/cars';
import { COMPOUNDS, CORNERS, TRACK_GRIP, type Compound } from '../src/vehicle/Tyres';
import { Vehicle } from '../src/vehicle/Vehicle';
import { RacingLine } from '../src/world/RacingLine';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';

const [trackId = 'monza', lapsArg = '3', wetArg] = process.argv.slice(2);
// `wet`: the rain's track grip (as Weather sets it).
if (wetArg === 'wet') TRACK_GRIP.value = 0.78;
// `damp`: light rain (wetness 0.55).
if (wetArg === 'damp') TRACK_GRIP.value = 1 - 0.22 * 0.55;
const dt = 1 / 60;
const car = findCar('f1-ferrari');
for (const compound of Object.keys(COMPOUNDS) as Compound[]) {
  const layout = loadLayout(trackId);
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, layout, { treesPerKm: 0 });
  const line = new RacingLine(racingLineFor(track), car.physics);
  const v = new Vehicle(physics, car.physics, car.createVisual(), track.getSpawnPose(), car.gearbox);
  v.physics.surfaceAt = null;
  v.tyres.fit(compound);
  const ai = new AIDriver(v, line, track, { pace: 0.97, lane: 0, aggression: 0.5 });
  const n = track.getCenterline().length;
  let last = track.nearestIndex(v.position);
  let progress = 0;
  let t = 0;
  let lapStart = 0;
  const out: string[] = [];
  while (out.length < Number(lapsArg) && t < 600) {
    v.fixedUpdate(ai.update(dt, [v]), dt);
    physics.step();
    v.snapshot();
    const i = track.nearestIndex(v.position);
    let d = i - last;
    if (d < -n / 2) d += n;
    if (d > n / 2) d -= n;
    progress += d;
    last = i;
    t += dt;
    if (progress >= n * (out.length + 1)) {
      const ty = v.tyres;
      out.push(`lap ${out.length + 1}: ${(t - lapStart).toFixed(2)} s, wear ${CORNERS.map((c, i) => `${c} ${(ty.wear[i] * 100).toFixed(0)}%`).join(' ')}, temp ${ty.temp.map((x) => x.toFixed(0)).join('/')} °C, grip ${ty.wear.map((_, i) => ty.grip(i).toFixed(3)).join('/')}`);
      lapStart = t;
    }
  }
  console.log(`${compound}:\n  ${out.join('\n  ')}`);
}
