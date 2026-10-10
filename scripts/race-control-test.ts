/**
 * Race control check (yellow flags, VSC):
 *  1. a car stopped on the track: yellow after ~1.5 s, VSC after ~6 s; under the VSC
 *     the field slows to ~60 % and nobody passes; the car is cleared: "VSC ending",
 *     then green;
 *  2. a wing lying on the track brings the VSC out and the marshals clear it;
 *  3. overtaking a running car under the VSC costs 5 s.
 *
 *   npx tsx scripts/race-control-test.ts
 */
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { AIDriver } from '../src/race/AIDriver';
import { DebrisField } from '../src/race/Debris';
import { Penalties } from '../src/race/Penalties';
import { RaceControl, VSC_SPEED, type ControlMessage } from '../src/race/RaceControl';
import { RaceManager, type Racer } from '../src/race/RaceManager';
import { findCar } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { RacingLine } from '../src/world/RacingLine';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';

const dt = 1 / 60;
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
};

async function setup() {
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, loadLayout('monza'), { treesPerKm: 0 });
  const car = findCar('f1-haas');
  const path = racingLineFor(track);
  const line = new RacingLine(path, car.physics, { heights: track.heightsFor(path) });
  const racers: Racer[] = [];
  for (let slot = 0; slot < 6; slot++) {
    const v = new Vehicle(physics, car.physics, car.createVisual(), track.gridPose(slot), car.gearbox);
    const ai = new AIDriver(v, line, track, { pace: 0.97 - slot * 0.01, lane: 0, aggression: 0.5 });
    racers.push({ name: `CAR${slot + 1}`, vehicle: v, ai, isPlayer: false, progress: 0, lastIndex: 0, finished: false, finishTime: 0, color: 0 });
  }
  const race = new RaceManager(track, racers, 20);
  const rc = new RaceControl(track);
  const messages: ControlMessage[] = [];
  rc.onMessage = (m) => messages.push(m);
  const debris = new DebrisField(1);
  const vehicles = racers.map((r) => r.vehicle);
  const HOLD = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
  /** One fixed step of the race; `held` cars are kept stopped where they are. */
  const step = (held: Set<Racer>) => {
    for (const r of racers) {
      if (held.has(r)) {
        r.vehicle.physics.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        r.vehicle.fixedUpdate(HOLD, dt);
      } else r.vehicle.fixedUpdate(race.frozen ? HOLD : r.ai!.update(dt, vehicles), dt);
    }
    physics.step();
    for (const v of vehicles) v.snapshot();
    race.update(dt);
    if (!race.frozen) {
      rc.update(dt, racers, race.time, debris, () => false);
      const vsc = rc.flag !== 'green';
      for (const r of racers) {
        r.ai!.rules.speedFactor = vsc ? VSC_SPEED : rc.inYellow(r) ? 0.8 : 1;
        r.ai!.rules.noPassing = rc.noOvertaking(r);
      }
      debris.step(vehicles, dt);
    }
  };
  return { track, racers, race, rc, messages, debris, step, line };
}

// --- 1. a car stopped on the track ----------------------------------------------
{
  const { racers, race, rc, messages, step, line } = await setup();
  const none = new Set<Racer>();
  while (race.time < 25) step(none);
  const free = racers.slice(1);
  // Speed as a share of the racing line's speed where each car is (corners and straights alike).
  const avg = () => free.reduce((s, r) => s + r.vehicle.physics.speed / line.speeds[line.nearestFrom(r.vehicle.position, -1)], 0) / free.length;
  let green = 0;
  for (let t = 0; t < 4; t += dt) {
    step(none);
    green += avg() * dt;
  }
  green /= 4;
  const wreck = new Set([racers[0]]);
  let tYellow = -1;
  let tVsc = -1;
  const t0 = race.time;
  // Cleared within 15 s (longer brings the safety car out, see safety-car-test).
  while (race.time < t0 + 7) {
    step(wreck);
    if (tYellow < 0 && messages.includes('yellow')) tYellow = race.time - t0;
    if (tVsc < 0 && rc.flag === 'vsc') tVsc = race.time - t0;
  }
  check(tYellow > 1 && tYellow < 3, `stopped car: yellow after ${tYellow.toFixed(1)} s`);
  check(tVsc > 5 && tVsc < 8, `still stopped: VSC after ${tVsc.toFixed(1)} s`);
  // Let the field settle to VSC pace, then measure.
  for (let t = 0; t < 3; t += dt) step(wreck);
  let slow = 0;
  for (let t = 0; t < 3; t += dt) {
    step(wreck);
    slow += avg() * dt;
  }
  slow /= 3;
  check(slow < 0.75 && slow > 0.45 && green > 0.85, `VSC: field at ${(slow * 100).toFixed(0)} % of racing-line speed (racing: ${(green * 100).toFixed(0)} %)`);
  // The car is recovered (marshals push it away, here: it drives on).
  const tClear = race.time;
  let tEnding = -1;
  let tGreen = -1;
  while (race.time < tClear + 40 && tGreen < 0) {
    step(none);
    if (tEnding < 0 && rc.flag === 'vsc-ending') tEnding = race.time - tClear;
    if (rc.flag === 'green') tGreen = race.time - tClear;
  }
  check(tEnding >= 0, `cleared: "VSC ending" after ${tEnding.toFixed(1)} s`);
  check(tGreen >= 0, `then green after ${tGreen.toFixed(1)} s`);
}

// --- 2. a wing on the track ------------------------------------------------------------
{
  const { track, race, rc, debris, step } = await setup();
  const none = new Set<Racer>();
  while (race.time < 12) step(none);
  const p = track.getCenterline()[Math.round(track.getCenterline().length * 0.6)];
  debris.pieces.push({ kind: 'wing', position: p.clone(), velocity: new THREE.Vector3(), yaw: 0, spin: 0, age: 0, hitBy: new Set(), color: 0xffffff });
  for (let t = 0; t < 1; t += dt) step(none);
  check(rc.flag === 'vsc', 'wing on the track: VSC');
  for (let t = 0; t < 12; t += dt) step(none);
  check(!debris.pieces.some((x) => x.kind === 'wing'), 'marshals cleared the wing within 12 s');
}

// --- 3. overtaking under the VSC -----------------------------------------------------------
{
  const { track, racers, rc } = await setup();
  const penalties = new Penalties(track);
  rc.flag = 'vsc';
  const [a, b] = racers;
  for (const r of racers) r.vehicle.physics.body.setLinvel({ x: 0, y: 0, z: -30 }, true);
  racers.forEach((r, i) => (r.progress = 500 - i * 40));
  a.progress = 90;
  b.progress = 100;
  rc.overtakes(racers, () => false); // b a car length ahead of a
  a.progress = 101; // side by side: no pass yet
  check(rc.overtakes(racers, () => false).length === 0, 'side by side: not a pass');
  a.progress = 104; // a car length clear
  const offenders = rc.overtakes(racers, () => false);
  for (const r of offenders) penalties.overtake(r);
  check(offenders.length === 1 && offenders[0] === a && a.penalty === 5, 'a car length clear of a running car under the VSC: +5 s');
  b.progress = 108;
  rc.overtakes(racers, () => false);
  a.progress = 112;
  check(rc.overtakes(racers, () => false).length === 0, 'the same pass again: counted once');
}

console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
