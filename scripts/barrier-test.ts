/**
 * Barrier crash test: fires an F1 car into the guardrails at 300 km/h from
 * several angles (and with a kerb-style hop) on every circuit and checks it
 * never ends up outside the barriers.
 *
 *   npx tsx scripts/barrier-test.ts
 */
import { Quaternion, Vector3 } from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { findCar } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout, REAL_CIRCUITS } from './tracks-node';

const dt = 1 / 60;
const car = findCar('f1-ferrari');
const IDLE = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
let shots = 0;
let escapes = 0;

for (const [id] of REAL_CIRCUITS.filter(([cid]) => !process.argv[2] || cid === process.argv[2])) {
  const layout = loadLayout(id);
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, layout, { treesPerKm: 0, scenery: layout.scenery });
  const vehicle = new Vehicle(physics, car.physics, car.createVisual(), track.getSpawnPose(), car.gearbox);
  vehicle.physics.aeroInAir = track.elevated;
  const n = track.getCenterline().length;
  let trackEscapes = 0;
  for (let k = 0; k < 6; k++) {
    const i = Math.floor(((k + 0.5) / 6) * n);
    for (const side of [-1, 1])
      for (const angle of [15, 45, 80])
        for (const hop of [0, 6]) {
          const pose = track.getResetPose(track.getCenterline()[i]);
          vehicle.teleport(pose);
          const fwd = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
          const dir = fwd.clone().applyAxisAngle(new Vector3(0, 1, 0), (-side * angle * Math.PI) / 180);
          vehicle.physics.body.setRotation(new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir), true);
          const v = dir.multiplyScalar(300 / 3.6);
          vehicle.physics.body.setLinvel({ x: v.x, y: hop, z: v.z }, true);
          let out = false;
          for (let s = 0; s < 180; s++) {
            vehicle.fixedUpdate(IDLE, dt);
            physics.step();
            vehicle.snapshot();
            if (track.isOutOfBounds(vehicle.position)) out = true;
          }
          shots++;
          if (out) {
            trackEscapes++;
            const p = track.getCenterline()[i];
            console.log(`    escape at sample ${i} (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) side ${side} angle ${angle} hop ${hop}, end y=${vehicle.position.y.toFixed(1)}`);
          }
        }
  }
  escapes += trackEscapes;
  console.log(`  ${trackEscapes ? 'FAIL' : 'ok  '} ${layout.name}: ${trackEscapes} escapes / 72 shots`);
}
console.log(`${escapes} escapes in ${shots} shots`);
process.exit(escapes ? 1 : 0);
