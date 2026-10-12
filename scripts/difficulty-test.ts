/**
 * Driver aids per difficulty (keyboard-style, digital pedals and full lock):
 *  1. brake + steer: from 200 km/h, full brake and full right lock for 1.2 s:
 *     heading change (how much the car still turns) and speed lost.
 *  2. throttle + steer: from 110 km/h, full throttle and full lock for 2 s:
 *     the largest body slip angle (a spin shows as > 30°).
 * Beginner must turn clearly more under braking than expert and not spin.
 *
 *   npx tsx scripts/difficulty-test.ts [car=f1-ferrari]
 */
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { DIFFICULTIES, DIFFICULTY } from '../src/race/Difficulty';
import { findCar } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';

const [carId = 'f1-ferrari'] = process.argv.slice(2);
const dt = 1 / 120;
const car = findCar(carId);

async function run(diff: (typeof DIFFICULTIES)[number], kmh: number, input: { throttle: number; brake: number }, seconds: number) {
  const physics = await PhysicsWorld.create(dt);
  // Open flat tarmac: nothing to hit.
  const { rapier, world } = physics;
  world.createCollider(rapier.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0).setFriction(1), world.createRigidBody(rapier.RigidBodyDesc.fixed()));
  const pose = { position: new THREE.Vector3(0, 0.6, 0), quaternion: new THREE.Quaternion() };
  const v = new Vehicle(physics, car.physics, car.createVisual(), pose, car.gearbox);
  const d = DIFFICULTY[diff];
  v.physics.surfaceAt = null;
  v.physics.brakeAssist = true;
  v.physics.steerPriority = d.steerPriority;
  v.physics.tractionControl = d.tractionControl;
  v.physics.stability = d.stability;
  v.tyres.fit('medium');
  v.tyres.temp.fill(100);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
  const vel = fwd.clone().multiplyScalar(kmh / 3.6);
  v.physics.body.setLinvel({ x: vel.x, y: 0, z: vel.z }, true);
  // Settle the suspension at speed for a moment, straight.
  for (let i = 0; i < 30; i++) {
    v.physics.body.setLinvel({ x: vel.x, y: v.physics.body.linvel().y, z: vel.z }, true);
    v.fixedUpdate({ throttle: 0.5, brake: 0, steer: 0, handbrake: 0 }, dt);
    physics.step();
    v.snapshot();
  }
  const yaw0 = Math.atan2(-fwd.x, -fwd.z);
  let maxBeta = 0;
  for (let t = 0; t < seconds; t += dt) {
    v.fixedUpdate({ throttle: input.throttle, brake: input.brake, steer: 1, handbrake: 0 }, dt);
    physics.step();
    v.snapshot();
    const lv = v.physics.body.linvel();
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(v.quaternion);
    const sp = Math.hypot(lv.x, lv.z);
    if (sp > 5) maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(f.x * lv.z - f.z * lv.x, f.x * lv.x + f.z * lv.z)));
  }
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(v.quaternion);
  let turn = yaw0 - Math.atan2(-f.x, -f.z);
  turn = Math.atan2(Math.sin(turn), Math.cos(turn));
  return { turnDeg: Math.abs((turn * 180) / Math.PI), kmh: v.physics.speed * 3.6, betaDeg: (maxBeta * 180) / Math.PI };
}

let failed = false;
const brake: Record<string, number> = {};
console.log('difficulty     | brake+steer 200 km/h, 1.2 s: turn, speed | throttle+steer 110 km/h, 2 s: max slip angle');
for (const d of DIFFICULTIES) {
  const a = await run(d, 200, { throttle: 0, brake: 1 }, 1.2);
  const b = await run(d, 110, { throttle: 1, brake: 0 }, 2);
  brake[d] = a.turnDeg;
  console.log(`${d.padEnd(14)} | ${a.turnDeg.toFixed(1).padStart(5)}°  ${a.kmh.toFixed(0).padStart(4)} km/h | ${b.betaDeg.toFixed(1)}°`);
  if (d === 'beginner' && b.betaDeg > 30) failed = true;
}
if (brake.beginner < brake.expert * 1.3) failed = true;
console.log(failed ? 'DIFFICULTY FAIL' : 'DIFFICULTY OK');
process.exit(failed ? 1 : 0);
