/**
 * Slipstream check:
 *  1. wake at fixed gaps straight behind / offset to the side (drag cut, downforce loss);
 *  2. two equal AI cars nose to tail down Monza's main straight, with and without
 *     the wake: the follower must gain top speed and close up when towed.
 *
 *   npx tsx scripts/slip-test.ts
 */
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { AIDriver } from '../src/race/AIDriver';
import { updateSlipstream } from '../src/race/Slipstream';
import { findCar } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { RacingLine } from '../src/world/RacingLine';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';

const dt = 1 / 60;
const car = findCar('f1-ferrari');
let ok = true;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  ok &&= cond;
};

// --- 1. static wake table -------------------------------------------------
{
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, loadLayout('monza'), { treesPerKm: 0 });
  const pose = track.getSpawnPose();
  const leader = new Vehicle(physics, car.physics, car.createVisual(), pose, car.gearbox);
  const follower = new Vehicle(physics, car.physics, car.createVisual(), pose, car.gearbox);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  // Both at 250 km/h: set the leader's speed through its body.
  const v = 250 / 3.6;
  const rows: string[] = [];
  const at = (gap: number, side: number) => {
    const p = pose.position.clone().addScaledVector(fwd, -(gap + 5.4)).addScaledVector(right, side);
    follower.teleport({ position: p, quaternion: pose.quaternion.clone() });
    leader.teleport({ position: pose.position.clone(), quaternion: pose.quaternion.clone() });
    leader.physics.body.setLinvel({ x: fwd.x * v, y: 0, z: fwd.z * v }, true);
    leader.snapshot();
    follower.snapshot();
    updateSlipstream([leader, follower]);
    return follower.physics.wake;
  };
  for (const gap of [2, 10, 20, 40, 60]) {
    const w = at(gap, 0);
    rows.push(`gap ${String(gap).padStart(2)} m: drag x${w.drag.toFixed(2)}, downforce front x${w.front.toFixed(2)} rear x${w.rear.toFixed(2)}`);
  }
  console.log(rows.join('\n'));
  const w10 = at(10, 0);
  check(w10.drag < 0.8 && w10.drag > 0.6, `10 m behind: drag cut ${(100 - w10.drag * 100).toFixed(0)}% (20-40%)`);
  const avgLoss10 = 1 - (w10.front + w10.rear) / 2;
  check(avgLoss10 > 0.12 && avgLoss10 < 0.25, `10 m behind: downforce loss ${(avgLoss10 * 100).toFixed(0)}% (2022 target 18%)`);
  const side = at(10, 3.5);
  check(side.drag > 0.97, `10 m behind, 3.5 m to the side: clean air (drag x${side.drag.toFixed(2)})`);
  check(at(70, 0).drag === 1, '70 m behind: no wake');
}

// --- 2. tow down the straight ---------------------------------------------
async function tow(slip: boolean): Promise<{ leaderTop: number; followerTop: number; gapStart: number; gapEnd: number }> {
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, loadLayout('monza'), { treesPerKm: 0 });
  const line = new RacingLine(racingLineFor(track), car.physics);
  // Leader just out of the Parabolica, follower 25 m behind (bumper gap ~20 m): it closes in, never touches.
  const center = track.getCenterline();
  const n = center.length;
  const start = (track.spawnIndex - Math.round(500 / (track.length / n)) + n) % n;
  const back = Math.round(25 / (track.length / n));
  const mk = (i: number) => new Vehicle(physics, car.physics, car.createVisual(), track.getResetPose(center[i]), car.gearbox);
  const leader = mk(start);
  const follower = mk((start - back + n) % n);
  // Equal drivers on the same line; the follower ignores the leader (no lift for traffic) to isolate the tow.
  const aiL = new AIDriver(leader, line, track, { pace: 1, lane: 0, aggression: 1 });
  const aiF = new AIDriver(follower, line, track, { pace: 1, lane: 0, aggression: 1 });
  const cars = [leader, follower];
  const gap = () => leader.position.distanceTo(follower.position);
  let leaderTop = 0;
  let gapStart = -1;
  /** Follower's speed over the leader when it has caught up (gap < 9 m: time to pull out and pass). */
  let closing = 0;
  for (let t = 0; t < 30; t += dt) {
    if (slip) updateSlipstream(cars);
    leader.fixedUpdate(aiL.update(dt, [leader]), dt);
    follower.fixedUpdate(aiF.update(dt, [follower]), dt);
    physics.step();
    for (const c of cars) c.snapshot();
    // Measure down the main straight (from 3 s in, until the leader brakes for T1).
    if (t > 3) {
      if (gapStart < 0) gapStart = gap();
      if (leader.physics.forwardSpeed < leaderTop - 3) break;
      leaderTop = Math.max(leaderTop, leader.physics.forwardSpeed);
      closing = (follower.physics.forwardSpeed - leader.physics.forwardSpeed) * 3.6;
      if (gap() < 9) break;
    }
  }
  return { leaderTop: leaderTop * 3.6, closing, gapStart, gapEnd: gap() };
}
const off = await tow(false);
const on = await tow(true);
console.log(`no wake : leader ${off.leaderTop.toFixed(0)} km/h, follower ${off.closing >= 0 ? '+' : ''}${off.closing.toFixed(1)} km/h, gap ${off.gapStart.toFixed(1)} -> ${off.gapEnd.toFixed(1)} m`);
console.log(`with wake: leader ${on.leaderTop.toFixed(0)} km/h, follower ${on.closing >= 0 ? '+' : ''}${on.closing.toFixed(1)} km/h, gap ${on.gapStart.toFixed(1)} -> ${on.gapEnd.toFixed(1)} m`);
const gain = on.closing - off.closing;
check(gain > 5 && gain < 30, `towed car catches up +${gain.toFixed(0)} km/h faster than the leader (races: ~10-15)`);
check(on.gapEnd < on.gapStart - 3, 'the towed car closes up on the leader');
console.log(ok ? 'SLIPSTREAM OK' : 'SLIPSTREAM FAIL');
process.exit(ok ? 0 : 1);
