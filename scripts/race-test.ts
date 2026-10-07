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
import { CARS } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { RacingLine } from '../src/world/RacingLine';
import { ProceduralTrack } from '../src/world/Track';
import { DEMO_TRACK, parseTumCsv, type TrackLayout } from '../src/world/TrackLayout';

const [trackId = 'test', carsArg = '20', lapsArg = '2', carId = 'gt'] = process.argv.slice(2);
const FILES: Record<string, [string, string]> = {
  spielberg: ['Red Bull Ring', 'Spielberg'],
  monza: ['Monza', 'Monza'],
  silverstone: ['Silverstone', 'Silverstone'],
  spa: ['Spa-Francorchamps', 'Spa'],
};
const read = (f: string) => readFileSync(new URL(`../src/world/tracks/data/${f}`, import.meta.url), 'utf8');
let layout: TrackLayout = DEMO_TRACK;
if (FILES[trackId]) layout = parseTumCsv(trackId, FILES[trackId][0], read(`${FILES[trackId][1]}.csv`), read(`${FILES[trackId][1]}_raceline.csv`));

const dt = 1 / 60;
const physics = await PhysicsWorld.create(dt);
const track = new ProceduralTrack(physics, layout, { treesPerKm: 0 });
const car = CARS.find((c) => c.id === carId) ?? CARS[1];
const line = new RacingLine(layout.raceline ?? layout.points, car.physics);
const total = Number(carsArg);
const racers: Racer[] = [];
const vehicles: Vehicle[] = [];
for (let slot = 0; slot < total; slot++) {
  const v = new Vehicle(physics, car.physics, car.createVisual(), track.gridPose(slot), car.gearbox);
  const r = Math.sin(slot * 12.9898) * 43758.5453;
  const rand = r - Math.floor(r);
  const ai = new AIDriver(v, line, track, { pace: 0.97 - (slot / total) * 0.07 + (rand - 0.5) * 0.04, lane: (rand - 0.5) * 2.4, aggression: rand });
  vehicles.push(v);
  racers.push({ name: `CAR${slot + 1}`, vehicle: v, ai, isPlayer: slot === 0, progress: 0, lastIndex: 0, finished: false, finishTime: 0, color: 0 });
}
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
  for (const r of racers) {
    const v = r.vehicle;
    if ((v.isFlipped() && v.physics.speed < 3) || v.position.y < -5 || r.ai!.unstuckCount >= 3) {
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
console.log(`CPU per physics step (all ${total} cars + AI): ${(stepMs / steps).toFixed(2)} ms`);
process.exit(finished.length >= total * 0.9 && resets <= total ? 0 : 1);
