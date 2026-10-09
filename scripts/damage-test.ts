/**
 * Damage check: an F1 car hits the Monza barrier head-on and at a glancing
 * angle, and is rear-ended by another car. Prints the resulting damage.
 *
 *   npx tsx scripts/damage-test.ts
 */
import { Quaternion, Vector3 } from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { applyImpacts } from '../src/race/Impacts';
import { findCar } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';

const dt = 1 / 60;
const car = findCar('f1-ferrari');
const IDLE = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
let failures = 0;

async function scenario(name: string, setup: (track: ProceduralTrack, a: Vehicle, b: Vehicle) => void, expect: (a: Vehicle, b: Vehicle) => boolean) {
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, loadLayout('monza'), { treesPerKm: 0 });
  const far = track.getCenterline()[600];
  const a = new Vehicle(physics, car.physics, car.createVisual(), track.getResetPose(track.getCenterline()[300]), car.gearbox);
  const b = new Vehicle(physics, car.physics, car.createVisual(), track.getResetPose(far), car.gearbox);
  setup(track, a, b);
  const byCollider = new Map([[a.physics.collider.handle, a], [b.physics.collider.handle, b]]);
  for (let k = 0; k < 150; k++) {
    a.fixedUpdate(IDLE, dt);
    b.fixedUpdate(IDLE, dt);
    physics.step();
    a.snapshot();
    b.snapshot();
    applyImpacts(physics, byCollider, dt, () => {});
  }
  const ok = expect(a, b);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: A front ${(a.damage.front * 100).toFixed(0)}% rear ${(a.damage.rear * 100).toFixed(0)}% · B front ${(b.damage.front * 100).toFixed(0)}% rear ${(b.damage.rear * 100).toFixed(0)}%`);
}

/** Points car `v` at angle `deg` from the track direction towards the right barrier and launches it. */
function launch(track: ProceduralTrack, v: Vehicle, deg: number, kmh: number) {
  const pose = track.getResetPose(v.position);
  const fwd = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
  const dir = fwd.applyAxisAngle(new Vector3(0, 1, 0), (-deg * Math.PI) / 180);
  v.physics.body.setRotation(new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir), true);
  const vel = dir.multiplyScalar(kmh / 3.6);
  v.physics.body.setLinvel({ x: vel.x, y: 0, z: vel.z }, true);
}

await scenario('head-on into the barrier at 200 km/h', (t, a) => launch(t, a, 80, 200), (a) => a.damage.front >= 0.6 && a.damage.rear < 0.1);
await scenario('glancing barrier hit at 200 km/h (12 deg)', (t, a) => launch(t, a, 12, 200), (a) => a.damage.front < 0.6);
await scenario('rear-ended at 120 km/h closing speed', (t, a, b) => {
  const pose = t.getResetPose(a.position);
  const fwd = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
  b.teleport({ position: a.position.clone().addScaledVector(fwd, -8).setY(a.position.y), quaternion: a.quaternion.clone() });
  const v = fwd.clone().multiplyScalar(120 / 3.6);
  b.physics.body.setLinvel({ x: v.x, y: 0, z: v.z }, true);
}, (a, b) => a.damage.rear > 0.1 && b.damage.front > 0.1);
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
