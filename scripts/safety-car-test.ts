/**
 * Safety car check: two cars stop on the track at Monza.
 *  1. the safety car comes out, ahead of the leader;
 *  2. the field closes up behind it and nobody passes it;
 *  3. the stopped cars are cleared: "safety car in this lap", it leaves at the pit
 *     entry, and the race goes green as the leader crosses the line;
 *  4. nobody crashes into it (it passes through the cars) and no wings are lost.
 *
 *   npx tsx scripts/safety-car-test.ts
 */
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { AIDriver } from '../src/race/AIDriver';
import { applyImpacts } from '../src/race/Impacts';
import { RaceControl, VSC_SPEED, type ControlMessage } from '../src/race/RaceControl';
import { RaceManager, type Racer } from '../src/race/RaceManager';
import { SafetyCar } from '../src/race/SafetyCar';
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

const physics = await PhysicsWorld.create(dt);
const track = new ProceduralTrack(physics, loadLayout('monza'), { treesPerKm: 0 });
const car = findCar('f1-haas');
const path = racingLineFor(track);
const line = new RacingLine(path, car.physics, { heights: track.heightsFor(path) });
const racers: Racer[] = [];
for (let slot = 0; slot < 8; slot++) {
  const v = new Vehicle(physics, car.physics, car.createVisual(), track.gridPose(slot), car.gearbox);
  const ai = new AIDriver(v, line, track, { pace: 0.97 - slot * 0.008, lane: 0, aggression: 0.5 });
  racers.push({ name: `CAR${slot + 1}`, vehicle: v, ai, isPlayer: false, progress: 0, lastIndex: 0, finished: false, finishTime: 0, color: 0 });
}
const race = new RaceManager(track, racers, 30);
const rc = new RaceControl(track);
const messages: ControlMessage[] = [];
rc.onMessage = (m) => messages.push(m);
const scene = new THREE.Scene();
const sc = new SafetyCar(physics, track, scene);
const vehicles = racers.map((r) => r.vehicle);
const byCollider = new Map(vehicles.map((v) => [v.physics.collider.handle, v] as [number, Vehicle]));
const HOLD = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
const n = track.getCenterline().length;
let scGone = false;
let leaderLap = 0;
let wingsLost = 0;

const step = (held: Set<Racer>) => {
  const traffic = sc.vehicle ? [...vehicles, sc.vehicle] : vehicles;
  for (const r of racers) {
    if (held.has(r)) {
      r.vehicle.physics.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      r.vehicle.fixedUpdate(HOLD, dt);
    } else r.vehicle.fixedUpdate(race.frozen ? HOLD : r.ai!.update(dt, traffic), dt);
  }
  if (!race.frozen && sc.fixedUpdate(dt)) scGone = true;
  physics.step();
  for (const v of vehicles) v.snapshot();
  sc.afterStep();
  applyImpacts(physics, byCollider, dt, (v) => {
    if (v.damage.front >= 0.6 || v.damage.rear >= 0.6) wingsLost++;
  });
  race.update(dt);
  if (race.frozen) return;
  rc.update(dt, racers, race.time, null, () => false);
  const leader = race.standings().find((r) => !held.has(r))!;
  if (rc.flag === 'sc' && !sc.out && !scGone) sc.deploy(leader.vehicle.position);
  if (rc.flag === 'sc-in') sc.callIn();
  const lap = Math.floor(leader.progress / n);
  if (rc.flag === 'sc-in' && !sc.out && lap > leaderLap) rc.restart();
  leaderLap = lap;
  for (const r of racers) {
    r.ai!.rules.speedFactor = rc.flag === 'vsc' || rc.flag === 'vsc-ending' ? VSC_SPEED : rc.flag === 'sc-in' && !sc.out && r === leader ? VSC_SPEED : 1;
    r.ai!.rules.noPassing = rc.noOvertaking(r);
  }
};
const scProgress = () => {
  // Safety car's distance along the track, unwrapped next to the leader's lap.
  const i = track.nearestIndex(sc.vehicle!.position);
  const leader = race.standings()[0];
  const base = Math.floor(leader.progress / n) * n;
  let p = base + i;
  if (p < leader.progress - n / 2) p += n;
  return p;
};

const none = new Set<Racer>();
while (race.time < 30) step(none);
const wreck = new Set([racers[6], racers[7]]);
const running = racers.filter((r) => !wreck.has(r));
const spread = () => {
  const ps = running.map((r) => r.progress);
  return ((Math.max(...ps) - Math.min(...ps)) / n) * track.length;
};
const t0 = race.time;
while (rc.flag !== 'sc' && race.time < t0 + 20) step(wreck);
check(rc.flag === 'sc' && sc.out, `two cars stopped: safety car out after ${(race.time - t0).toFixed(1)} s`);
step(wreck);
const leader0 = race.standings().find((r) => !wreck.has(r))!;
const ahead = ((scProgress() - leader0.progress) / n) * track.length;
check(ahead > 60 && ahead < 300, `it joins ${ahead.toFixed(0)} m ahead of the leader`);
const spread0 = spread();
let passed = false;
for (let t = 0; t < 30; t += dt) {
  step(wreck);
  const lead = race.standings().find((r) => !wreck.has(r))!;
  if (sc.out && lead.progress > scProgress() + 3) passed = true;
}
check(!passed, 'nobody passes the safety car');
const spread1 = spread();
check(spread1 < spread0 * 0.6, `field closes up behind it: ${spread0.toFixed(0)} m -> ${spread1.toFixed(0)} m`);
// Cleared: the stopped cars drive on.
const tClear = race.time;
while (rc.flag !== 'green' && race.time < tClear + 150) step(none);
check(messages.includes('sc-in'), '"safety car in this lap" called');
check(scGone && !sc.out, 'it left at the pit entry');
check(rc.flag === 'green', `green as the leader crossed the line (${(race.time - tClear).toFixed(0)} s after clearing)`);
check(wingsLost === 0, `no wings lost (${wingsLost})`);
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
