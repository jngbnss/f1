/**
 * Pit stop check: an AI car requests a stop, laps the circuit and must enter the
 * pit lane, stop in its box, change tyres and rejoin (any circuit with a pit lane).
 *
 *   npx tsx scripts/pit-test.ts [monza|spa|suzuka]
 */
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { AIDriver } from '../src/race/AIDriver';
import { PitStops } from '../src/race/PitStops';
import { findCar } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { RacingLine } from '../src/world/RacingLine';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';

const dt = 1 / 60;
const trackId = process.argv[2] ?? 'monza';
const layout = loadLayout(trackId);
const physics = await PhysicsWorld.create(dt);
const track = new ProceduralTrack(physics, layout, { treesPerKm: 0, pitBoxColors: new Array(10).fill(0xffffff) });
if (!track.pit) throw new Error('no pit lane');
const car = findCar('f1-ferrari');
const v = new Vehicle(physics, car.physics, car.createVisual(), track.getSpawnPose(), car.gearbox);
v.physics.aeroInAir = track.elevated;
v.physics.surfaceAt = (x, z, y = 0) => {
  const s = track.surfaceAt({ x, y, z } as never);
  return { grip: s === 'grass' ? 0.55 : s === 'gravel' ? 0.45 : 1, drag: s === 'grass' ? 1.2 : s === 'gravel' ? 6 : 0 };
};
const linePath = racingLineFor(track);
const ai = new AIDriver(v, new RacingLine(linePath, car.physics, { heights: track.heightsFor(linePath) }), track, { pace: 0.97, lane: 0, aggression: 0.5 });
const events: string[] = [];
let stopped = 0;
const pits = new PitStops(track.pit, track, (veh, compound) => {
  veh.tyres.fit(compound);
  events.push(`service ${compound} at t=${t.toFixed(1)}s`);
  return 2.5;
});
pits.request(v, 'hard', 3);
let t = 0;
let last: string | null = 'requested';
let maxOff = 0;
while (t < 200) {
  const input = pits.update(v, dt) ?? ai.update(dt, [v]);
  v.fixedUpdate(input, dt);
  physics.step();
  v.snapshot();
  t += dt;
  const phase = pits.phase(v);
  if (phase !== last) {
    events.push(`${last} -> ${phase} at t=${t.toFixed(1)}s, ${(v.physics.forwardSpeed * 3.6).toFixed(0)} km/h`);
    last = phase;
  }
  if (phase === 'in' || phase === 'out') maxOff = Math.max(maxOff, v.physics.forwardSpeed * 3.6);
  if (phase === 'stopped') stopped += dt;
  if (last === null && t > 5) break;
  if (v.isFlipped() || track.isOutOfBounds(v.position)) {
    events.push(`FAIL: car left the circuit at t=${t.toFixed(1)}s`);
    break;
  }
}
console.log(events.join('\n'));
const box = track.pit.path[track.pit.boxes[3]];
console.log(`stationary ${stopped.toFixed(1)} s, compound ${v.tyres.compound}, max pit speed ${maxOff.toFixed(0)} km/h, box at (${box.x.toFixed(0)}, ${box.z.toFixed(0)})`);
const ok = events.some((e) => e.startsWith('service')) && last === null && !events.some((e) => e.startsWith('FAIL'));
console.log(ok ? 'PIT OK' : 'PIT FAIL');
process.exit(ok ? 0 : 1);
