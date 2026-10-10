/**
 * Track limits check:
 *  1. all four wheels past the white line = off; kerbs and the asphalt edge = on;
 *  2. five excursions at speed: three warnings, then 5 s penalties (10 s in all);
 *     a slow trip off the track (a spin) and the pit lane do not count;
 *  3. the classification adds the penalty to the race time.
 *
 *   npx tsx scripts/penalty-test.ts
 */
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { Penalties, type PenaltyEvent } from '../src/race/Penalties';
import { RaceManager, type Racer } from '../src/race/RaceManager';
import { findCar } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
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
const v = new Vehicle(physics, car.physics, car.createVisual(), track.getSpawnPose(), car.gearbox);
const center = track.getCenterline();
const rights = track.getRights();
const n = center.length;
// A straight stretch away from the pit lane (half a lap from the start line).
const at = Math.round(n / 2);
const put = (lateral: number, speed: number, i = at) => {
  const pose = track.getResetPose(center[i]);
  pose.position.addScaledVector(rights[i], lateral);
  v.teleport(pose);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion).multiplyScalar(speed);
  v.physics.body.setLinvel({ x: fwd.x, y: 0, z: fwd.z }, true);
  physics.step();
  v.snapshot();
};

// --- 1. detection -----------------------------------------------------------------
const penalties = new Penalties(track);
const half = track.halfWidth;
put(0, 0);
check(!penalties.offTrack(v), 'centre of the track: on');
put(half - 0.5, 0);
check(!penalties.offTrack(v), 'two wheels over the white line: on');
put(half + 3.5, 0);
check(penalties.offTrack(v), `all four wheels ${(3.5 - 0.95).toFixed(1)} m past the line: off`);

// --- 2. excursions ---------------------------------------------------------------------
const racer: Racer = { name: 'TEST', vehicle: v, ai: null, isPlayer: true, progress: 0, lastIndex: at, finished: false, finishTime: 0, color: 0 };
const events: PenaltyEvent[] = [];
penalties.onEvent = (_r, e) => events.push(e);
const run = (lateral: number, speed: number, seconds: number, exempt = false) => {
  for (let t = 0; t < seconds; t += dt) {
    put(lateral, speed);
    penalties.update([racer], dt, () => exempt);
  }
};
run(half + 3.5, 5, 1); // a spin into the grass at walking pace
check(events.length === 0, 'slow trip off the track (a spin): not counted');
run(half + 3.5, 40, 1, true);
check(events.length === 0, 'pit lane: not counted');
for (let k = 0; k < 5; k++) {
  run(half + 3.5, 40, 0.6);
  run(0, 40, 1.2);
}
const warnings = events.filter((e) => e.kind === 'warning').length;
check(warnings === 3, `5 excursions: ${warnings} warnings`);
check(racer.penalty === 10, `then 5 s each: ${racer.penalty ?? 0} s in all`);
run(half + 3.5, 40, 0.6);
run(half + 3.5, 40, 0.6);
check(racer.penalty === 15, 'one long excursion counts once');

// --- 3. classification -------------------------------------------------------------------
const mk = (name: string, finishTime: number, penalty: number): Racer => ({ name, vehicle: v, ai: null, isPlayer: false, progress: 0, lastIndex: 0, finished: true, finishTime, color: 0, penalty });
const a = mk('A', 100, 5);
const b = mk('B', 103, 0);
const race = new RaceManager(track, [a, b], 1);
a.finished = b.finished = true;
check(race.standings()[0] === b, 'A 100 s + 5 s penalty finishes behind B 103 s');

console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
