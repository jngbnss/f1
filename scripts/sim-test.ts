/**
 * Headless physics smoke test: runs the real Vehicle/Track code in Node
 * (no renderer, no DOM) and checks that the car behaves.
 *
 *   npm run sim:test
 *
 * 1. Scripted manoeuvres (accelerate, brake, reverse, steer, handbrake).
 * 2. A pure-pursuit bot drives a full lap of the circuit -> fails if the car
 *    gets stuck, flips, leaves the world, or the lap takes too long.
 */
import { Vector3 } from 'three';
import type { VehicleInput } from '../src/input/VehicleInput';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { Vehicle } from '../src/vehicle/Vehicle';
import { DEFAULT_CAR } from '../src/vehicle/VehicleConfig';
import { ProceduralCarVisual } from '../src/vehicle/VehicleVisual';
import { ProceduralTrack } from '../src/world/Track';
import { DEMO_TRACK } from '../src/world/TrackLayout';

const dt = 1 / 60;
const physics = await PhysicsWorld.create(dt);
const track = new ProceduralTrack(physics, DEMO_TRACK, { treeCount: 0 });
const car = new Vehicle(physics, DEFAULT_CAR, new ProceduralCarVisual(DEFAULT_CAR), track.getSpawnPose());
const fwd = new Vector3();

const yawDeg = () => {
  fwd.set(0, 0, -1).applyQuaternion(car.quaternion);
  return (Math.atan2(-fwd.x, -fwd.z) * 180) / Math.PI; // + = turned left
};

function tick(input: VehicleInput): void {
  car.fixedUpdate(input, dt);
  physics.step();
  car.snapshot();
}

let failures = 0;
function check(ok: boolean, message: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures++;
}

function run(seconds: number, input: Partial<VehicleInput>): void {
  const full: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0, ...input };
  for (let i = 0; i < Math.round(seconds / dt); i++) tick(full);
}

// --- 1. manoeuvres --------------------------------------------------------
console.log('Manoeuvres');
run(1.5, {});
check(car.physics.groundedWheels === 4 && Math.abs(car.speedKmh) < 2, `settles on 4 wheels (y=${car.position.y.toFixed(2)})`);

run(3, { throttle: 1 });
check(car.speedKmh > 60, `accelerates: ${car.speedKmh.toFixed(0)} km/h after 3s`);
check(Math.abs(yawDeg()) < 1, `drives straight without input (yaw ${yawDeg().toFixed(2)}°)`);

run(3, { brake: 1 });
check(car.speedKmh < 0, `brake then reverse: ${car.speedKmh.toFixed(0)} km/h`);

car.teleport(track.getSpawnPose());
run(1, {});
run(2, { throttle: 1 });
const y0 = yawDeg();
run(0.5, { throttle: 0.5, steer: -1 });
check(yawDeg() - y0 > 5, `steer left turns left (+${(yawDeg() - y0).toFixed(1)}°)`);
const y1 = yawDeg();
run(0.8, { throttle: 0.5, steer: 1 });
check(yawDeg() - y1 < -5, `steer right turns right (${(yawDeg() - y1).toFixed(1)}°)`);

// --- 2. bot lap -----------------------------------------------------------
console.log('Bot lap');
const line = track.getCenterline();
car.teleport(track.getSpawnPose());
const nearest = (p: Vector3) => {
  let best = 0;
  let bestD = Infinity;
  line.forEach((c, i) => {
    const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
};

let progress = 0; // samples passed
let lastIndex = nearest(car.position);
let t = 0;
let maxSpeed = 0;
let stuckTime = 0;
const target = new Vector3();
while (progress < line.length && t < 180) {
  const idx = nearest(car.position);
  let delta = idx - lastIndex;
  if (delta < -line.length / 2) delta += line.length;
  if (delta > line.length / 2) delta -= line.length;
  progress += delta;
  lastIndex = idx;

  const speed = car.physics.forwardSpeed;
  const look = Math.round((8 + speed * 0.8) / DEMO_TRACK.sampleSpacing);
  target.copy(line[(idx + look) % line.length]);
  fwd.set(0, 0, -1).applyQuaternion(car.quaternion);
  const toTarget = target.sub(car.position).setY(0).normalize();
  // + = target is to the right
  const side = fwd.x * toTarget.z - fwd.z * toTarget.x;
  const err = side;
  // Look further ahead to estimate the corner and slow down for it.
  const far = line[(idx + look * 3) % line.length].clone().sub(car.position).setY(0).normalize();
  const cornering = 1 - Math.max(0, fwd.x * far.x + fwd.z * far.z);
  const targetSpeed = 50 - cornering * 140;
  tick({
    steer: Math.max(-1, Math.min(1, err * 4)),
    throttle: speed < targetSpeed ? 1 : 0,
    brake: speed > targetSpeed + 4 ? 1 : 0,
    handbrake: 0,
  });
  maxSpeed = Math.max(maxSpeed, car.speedKmh);
  stuckTime = Math.abs(car.physics.forwardSpeed) < 1 ? stuckTime + dt : 0;
  if (stuckTime > 3 || car.isFlipped() || car.position.y < -5) break;
  t += dt;
}
check(progress >= line.length, `completes a lap: ${((progress / line.length) * 100).toFixed(0)}% in ${t.toFixed(1)}s, top speed ${maxSpeed.toFixed(0)} km/h`);
check(stuckTime <= 3 && !car.isFlipped(), 'never stuck or flipped');

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
