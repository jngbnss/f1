/**
 * Headless 20-car race: every car is AI-driven (no renderer). Checks the
 * field can start from the grid, race wheel-to-wheel and finish.
 *
 *   npx tsx scripts/race-test.ts [track] [cars] [laps]
 */
import { readFileSync } from 'node:fs';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { AIDriver } from '../src/race/AIDriver';
import { RaceManager, type Racer } from '../src/race/RaceManager';
import { findCar } from '../src/vehicle/cars';
import { applyImpacts } from '../src/race/Impacts';
import { Vehicle } from '../src/vehicle/Vehicle';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { RacingLine } from '../src/world/RacingLine';
import { loadLayout } from './tracks-node';
import { ProceduralTrack } from '../src/world/Track';
import { DEMO_TRACK, parseTumCsv, type TrackLayout } from '../src/world/TrackLayout';

const [trackId = 'test', carsArg = '20', lapsArg = '2', carId = 'f1-ferrari'] = process.argv.slice(2);
const layout: TrackLayout = loadLayout(trackId);

const dt = 1 / 60;
const physics = await PhysicsWorld.create(dt);
const track = new ProceduralTrack(physics, layout, { treesPerKm: 0 });
const car = findCar(carId);
const linePath = racingLineFor(track);
const line = new RacingLine(linePath, car.physics, { heights: track.heightsFor(linePath) });
const total = Number(carsArg);
const racers: Racer[] = [];
const vehicles: Vehicle[] = [];
for (let slot = 0; slot < total; slot++) {
  const v = new Vehicle(physics, car.physics, car.createVisual(), track.gridPose(slot), car.gearbox);
  v.physics.aeroInAir = track.elevated;
  const r = Math.sin(slot * 12.9898) * 43758.5453;
  const rand = r - Math.floor(r);
  const ai = new AIDriver(v, line, track, { pace: 0.97 - (slot / total) * 0.07 + (rand - 0.5) * 0.04, lane: (rand - 0.5) * 2.4, aggression: rand });
  vehicles.push(v);
  racers.push({ name: `CAR${slot + 1}`, vehicle: v, ai, isPlayer: slot === 0, progress: 0, lastIndex: 0, finished: false, finishTime: 0, color: 0 });
}
const broken = new Set<Vehicle>();
const byCollider = new Map(vehicles.map((v) => [v.physics.collider.handle, v] as [number, Vehicle]));
const race = new RaceManager(track, racers, Number(lapsArg));
const HOLD = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
let resets = 0;
let stepMs = 0;
let steps = 0;
const limit = (track.length * Number(lapsArg)) / 12 + 60; // avg ≥ 12 m/s
let t = 0;
while (t < limit && !racers.every((r) => r.finished)) {
  const t0 = performance.now();
  for (const r of racers) r.vehicle.fixedUpdate(race.frozen ? HOLD : r.ai!.update(dt, vehicles), dt);
  physics.step();
  for (const v of vehicles) v.snapshot();
  applyImpacts(physics, byCollider, dt, (v, hit) => {
    if (process.env.RESET_LOG && (v.damage.front >= 0.6 || v.damage.rear >= 0.6) && !broken.has(v)) {
      broken.add(v);
      console.log(`  wing off (${hit}) ${racers.find((r) => r.vehicle === v)!.name} t=${t.toFixed(1)}s at sample ${track.nearestIndex(v.position)} front ${v.damage.front.toFixed(2)} rear ${v.damage.rear.toFixed(2)}, ${(v.physics.speed * 3.6).toFixed(0)} km/h, lateral ${track.lateral(v.position).toFixed(1)} m`);
    }
  });
  for (const r of racers) {
    const v = r.vehicle;
    if ((v.isFlipped() && v.physics.speed < 3) || v.position.y < track.bounds.min.y - 5 || track.isOutOfBounds(v.position) || r.ai!.unstuckCount >= 3) {
      if (process.env.RESET_LOG) console.log(`  reset ${r.name} t=${t.toFixed(1)}s at sample ${track.nearestIndex(v.position)} lateral ${track.lateral(v.position).toFixed(1)} m, flipped=${v.isFlipped()} unstuck=${r.ai!.unstuckCount}`);
      v.teleport(track.getResetPose(v.position));
      r.ai!.resetState();
      r.ai!.unstuckCount = 0;
      race.resync(r);
      resets++;
    }
  }
  race.update(dt);
  stepMs += performance.now() - t0;
  steps++;
  t += dt;
}
const finished = racers.filter((r) => r.finished);
const standings = race.standings();
console.log(`${layout.name} (${(track.length / 1000).toFixed(2)} km), ${total} cars, ${lapsArg} laps, car ${car.name}`);
console.log(`finished ${finished.length}/${total} in ${t.toFixed(0)} s sim time; resets ${resets}`);
console.log(`winner ${standings[0].name} ${standings[0].finishTime.toFixed(1)} s, last ${finished.length ? Math.max(...finished.map((r) => r.finishTime)).toFixed(1) : '-'} s`);
console.log(`wing damage: ${vehicles.filter((v) => v.damage.any).length} cars touched, ${vehicles.filter((v) => v.damage.front >= 0.6 || v.damage.rear >= 0.6).length} lost a wing`);
console.log(`CPU per physics step (all ${total} cars + AI): ${(stepMs / steps).toFixed(2)} ms`);
process.exit(finished.length >= total * 0.9 && resets <= total ? 0 : 1);
