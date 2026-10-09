/**
 * Braking check (F1, Monza main straight into Turn 1): flat out to 300 km/h,
 * then full brake pedal until 80 km/h. Reports distance, time and the
 * deceleration at 300 / 200 / 100 km/h, with and without the brake assist
 * (no assist = wheels may lock: count of lock-up steps per axle).
 * Real 2026-ish F1 at Monza T1: ~110–130 m and ~1.9 s for 300 -> 80 km/h.
 *
 *   npx tsx scripts/brake-test.ts [car=f1-ferrari]
 */
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { AIDriver } from '../src/race/AIDriver';
import { BRAKE_GRIP } from '../src/vehicle/VehiclePhysics';
import { findCar } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { RacingLine } from '../src/world/RacingLine';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';

const [carId = 'f1-ferrari'] = process.argv.slice(2);
const dt = 1 / 120;
const G = 9.81;
const car = findCar(carId);
let failed = false;

for (const assist of [true, false]) {
  const layout = loadLayout('monza');
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, layout, { treesPerKm: 0 });
  const line = new RacingLine(racingLineFor(track), car.physics);
  // Start well back on the straight (spawn = just behind the line) so we reach 300.
  const v = new Vehicle(physics, car.physics, car.createVisual(), track.getSpawnPose(), car.gearbox);
  v.physics.surfaceAt = null;
  v.physics.brakeAssist = assist;
  v.tyres.fit('medium');
  // Warm tyres: braking is measured at racing temperature.
  v.tyres.temp.front = v.tyres.temp.rear = 100;
  const ai = new AIDriver(v, line, track, { pace: 1, lane: 0, aggression: 0 });
  // The AI only steers here; the pedal is a human foot (with its build-up).
  v.controller.brakeRamp = true;
  // Human braking (the AI constructor set the AI values).
  v.physics.brakeGrip = BRAKE_GRIP;
  v.physics.brakeForceScale = 1.5;
  // Start 600 m before the line at 250 km/h, so 300 km/h comes on the straight.
  const pts = track.getCenterline();
  const start0 = pts[(pts.length - Math.round(600 / layout.sampleSpacing)) % pts.length];
  const pose = track.getResetPose(start0);
  v.teleport(pose);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion).multiplyScalar(250 / 3.6);
  v.physics.body.setLinvel({ x: fwd.x, y: 0, z: fwd.z }, true);

  let t = 0;
  let phase: 'accel' | 'brake' | 'done' = 'accel';
  let start = { x: 0, z: 0, t: 0 };
  let dist = 0;
  let lastX = 0;
  let lastZ = 0;
  let prevV = 0;
  const gAt: Record<number, number> = {};
  const locks = { front: 0, rear: 0 };
  const lockBands = [0, 0, 0];
  let peak = 0;
  let brakeSteps = 0;
  while (phase !== 'done' && t < 60) {
    const inp = { ...ai.update(dt, [v]) };
    const kmh = v.physics.forwardSpeed * 3.6;
    if (phase === 'accel' && kmh >= 300) {
      phase = 'brake';
      start = { x: v.position.x, z: v.position.z, t };
      lastX = start.x;
      lastZ = start.z;
    }
    if (phase === 'accel') {
      inp.throttle = 1;
      inp.brake = 0;
    } else {
      inp.throttle = 0;
      inp.brake = 1;
    }
    v.fixedUpdate(inp, dt);
    physics.step();
    v.snapshot();
    t += dt;
    const speed = v.physics.forwardSpeed;
    if (phase === 'brake') {
      brakeSteps++;
      dist += Math.hypot(v.position.x - lastX, v.position.z - lastZ);
      lastX = v.position.x;
      lastZ = v.position.z;
      const decel = (prevV - speed) / dt / G;
      peak = Math.max(peak, decel);
      if (v.physics.wheels.slice(0, 2).some((w) => w.locked)) lockBands[speed * 3.6 > 200 ? 0 : speed * 3.6 > 120 ? 1 : 2]++;
      for (const mark of [300, 200, 100]) if (gAt[mark] === undefined && speed * 3.6 <= mark - 2) gAt[mark] = decel;
      v.physics.wheels.forEach((w, i) => {
        if (w.locked) locks[i < 2 ? 'front' : 'rear']++;
      });
      if (speed * 3.6 <= 80) phase = 'done';
    }
    prevV = speed;
    if (phase === 'accel' && t > 40) break;
  }
  const time = t - start.t;
  const label = assist ? 'assist on ' : 'assist off';
  if (phase !== 'done') {
    console.log(`${label}: never reached 300 km/h / 80 km/h (t=${t.toFixed(1)} s)`);
    failed = true;
    continue;
  }
  const g = (k: number) => (gAt[k] ?? NaN).toFixed(2);
  console.log(
    `${label}: 300->80 km/h in ${dist.toFixed(1)} m, ${time.toFixed(2)} s | peak ${peak.toFixed(2)} g, ${g(200)} g @200, ${g(100)} g @100 | front lock-up steps >200/120-200/<120 km/h: ${lockBands.join('/')}, rear wheel-steps ${locks.rear}, of ${brakeSteps} steps`,
  );
  if (assist) {
    // Stronger than the real ~110 m on purpose (players wanted harder braking); peak stays near 6.5 g.
    const ok = dist > 65 && dist < 120 && time > 1.3 && time < 2.2 && locks.front + locks.rear === 0;
    console.log(ok ? '  ok   within real-world range, no lock-up' : '  FAIL outside 65–120 m / 1.3–2.2 s or locked');
    if (!ok) failed = true;
  } else {
    // Stamping on the pedal without assist should lock the fronts at least at low speed.
    const ok = locks.front > 0;
    console.log(ok ? '  ok   full pedal without assist locks the fronts' : '  FAIL no lock-up without assist');
    if (!ok) failed = true;
  }
}
if (failed) process.exit(1);
console.log('BRAKE OK');
