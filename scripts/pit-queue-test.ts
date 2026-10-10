/**
 * Pit queue check: four AI cars nose to tail all pit on the same lap, three of
 * them for the same box (double stacking). Every car must be serviced in turn
 * and rejoin; nobody may get stuck behind a car in the box.
 *
 *   npx tsx scripts/pit-queue-test.ts [monza|spa|suzuka|monaco]
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
const pit = track.pit;
if (!pit) throw new Error('no pit lane');
const car = findCar('f1-ferrari');
const line = racingLineFor(track);
const racingLine = new RacingLine(line, car.physics, { heights: track.heightsFor(line) });
const center = track.getCenterline();
const n = center.length;
// Start a few hundred metres before the pit entry, 12 m apart.
const startIdx = (pit.entryIndex - 160 + n) % n;
const boxes = [3, 3, 5, 3];
const cars = boxes.map((box, j) => {
  const v = new Vehicle(physics, car.physics, car.createVisual(), track.getResetPose(center[(startIdx - j * 5 + n) % n]), car.gearbox);
  v.physics.aeroInAir = track.elevated;
  const ai = new AIDriver(v, racingLine, track, { pace: 0.9, lane: 0, aggression: 0.5 });
  return { v, ai, box, served: -1, done: -1 };
});
const all = cars.map((c) => c.v);
let t = 0;
const pits = new PitStops(pit, track, (veh, compound) => {
  veh.tyres.fit(compound);
  const c = cars.find((x) => x.v === veh)!;
  c.served = t;
  return 2.5;
});
for (const c of cars) pits.request(c.v, 'hard', c.box);
const seen = cars.map(() => false);
while (t < 150 && cars.some((c) => c.done < 0)) {
  for (const c of cars) c.v.fixedUpdate(pits.update(c.v, dt) ?? c.ai.update(dt, all), dt);
  physics.step();
  for (const c of cars) c.v.snapshot();
  t += dt;
  cars.forEach((c, j) => {
    const p = pits.phase(c.v);
    if (p) seen[j] = true;
    if (seen[j] && p === null && c.done < 0 && c.served >= 0) c.done = t;
  });
}
let ok = true;
cars.forEach((c, j) => {
  const fine = c.served >= 0 && c.done >= 0;
  ok &&= fine;
  console.log(`car ${j} box ${c.box}: ${c.served >= 0 ? `serviced t=${c.served.toFixed(1)}s` : 'NOT SERVICED'}, ${c.done >= 0 ? `rejoined t=${c.done.toFixed(1)}s` : `stuck in phase ${pits.phase(c.v)} at k=${pits.state(c.v)?.k}`}`);
});
// Double stacking: the box-3 cars are serviced one after another, not at once.
const box3 = cars.filter((c) => c.box === 3 && c.served >= 0).map((c) => c.served).sort((a, b) => a - b);
for (let i = 1; i < box3.length; i++) if (box3[i] - box3[i - 1] < 2.5) ok = false;
console.log(ok ? 'PIT QUEUE OK' : 'PIT QUEUE FAIL');
process.exit(ok ? 0 : 1);
