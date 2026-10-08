/**
 * Headless physics smoke test: runs the real Vehicle/Track code in Node
 * (no renderer, no DOM, no audio) and checks that every car is drivable on
 * every circuit.
 *
 *   npm run sim:test            # all cars on the test track + bot laps everywhere
 *   npm run sim:test -- quick   # skip the long real-circuit laps
 *
 * 1. Scripted manoeuvres per car (settle, accelerate, straight-line, brake/reverse, steer).
 * 2. A pure-pursuit bot drives a full lap -> fails if it gets stuck, flips,
 *    leaves the world, or never finishes.
 */
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import type { VehicleInput } from '../src/input/VehicleInput';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { CARS, type CarDefinition } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import type { OsmData } from '../src/world/OsmScenery';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { RacingLine } from '../src/world/RacingLine';
import { ProceduralTrack } from '../src/world/Track';
import { DEMO_TRACK, parseTumCsv, type TrackLayout } from '../src/world/TrackLayout';

const dt = 1 / 60;
const quick = process.argv.includes('quick');
let failures = 0;

function check(ok: boolean, message: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures++;
}

const realTracks: TrackLayout[] = [
  ['spielberg', 'Red Bull Ring', 'Spielberg'],
  ['monza', 'Monza', 'Monza'],
  ['silverstone', 'Silverstone', 'Silverstone'],
  ['spa', 'Spa-Francorchamps', 'Spa'],
].map(([id, name, file]) =>
  {
    const read = (f: string) => readFileSync(new URL(`../src/world/tracks/data/${f}`, import.meta.url), 'utf8');
    const layout = parseTumCsv(id, name, read(`${file}.csv`), read(`${file}_raceline.csv`));
    layout.scenery = JSON.parse(read(`${file}_osm.json`)) as OsmData;
    return layout;
  },
);

async function setup(car: CarDefinition, layout: TrackLayout) {
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, layout, { treesPerKm: 0, scenery: layout.scenery });
  const vehicle = new Vehicle(physics, car.physics, car.createVisual(), track.getSpawnPose(), car.gearbox);
  const tick = (input: VehicleInput) => {
    vehicle.fixedUpdate(input, dt);
    physics.step();
    vehicle.snapshot();
  };
  return { physics, track, vehicle, tick };
}

const fwd = new Vector3();
function yawDeg(v: Vehicle): number {
  fwd.set(0, 0, -1).applyQuaternion(v.quaternion);
  return (Math.atan2(-fwd.x, -fwd.z) * 180) / Math.PI; // + = turned left
}

async function manoeuvres(car: CarDefinition): Promise<void> {
  console.log(`Manoeuvres: ${car.name}`);
  const { track, vehicle, tick } = await setup(car, DEMO_TRACK);
  const run = (seconds: number, input: Partial<VehicleInput>) => {
    const full: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0, ...input };
    for (let i = 0; i < Math.round(seconds / dt); i++) tick(full);
  };

  run(1.5, {});
  check(vehicle.physics.groundedWheels === 4 && Math.abs(vehicle.speedKmh) < 2, `settles on 4 wheels (y=${vehicle.position.y.toFixed(2)})`);
  const yaw0 = yawDeg(vehicle);
  run(3, { throttle: 1 });
  check(vehicle.speedKmh > 50, `accelerates: ${vehicle.speedKmh.toFixed(0)} km/h after 3s, gear ${vehicle.gearbox?.label}, ${vehicle.gearbox?.rpm.toFixed(0)} rpm`);
  check(Math.abs(yawDeg(vehicle) - yaw0) < 1, `drives straight without input (Δyaw ${(yawDeg(vehicle) - yaw0).toFixed(2)}°)`);
  run(3.5, { brake: 1 });
  check(vehicle.speedKmh < 0 && vehicle.gearbox?.label === 'R', `brake then reverse: ${vehicle.speedKmh.toFixed(0)} km/h, gear ${vehicle.gearbox?.label}`);

  vehicle.teleport(track.getSpawnPose());
  run(1, {});
  run(2, { throttle: 1 });
  const y0 = yawDeg(vehicle);
  run(0.5, { throttle: 0.5, steer: -1 });
  check(yawDeg(vehicle) - y0 > 5, `steer left turns left (+${(yawDeg(vehicle) - y0).toFixed(1)}°)`);
  const y1 = yawDeg(vehicle);
  run(0.8, { throttle: 0.5, steer: 1 });
  check(yawDeg(vehicle) - y1 < -5, `steer right turns right (${(yawDeg(vehicle) - y1).toFixed(1)}°)`);
}

async function botLap(car: CarDefinition, layout: TrackLayout): Promise<void> {
  const { track, vehicle, tick } = await setup(car, layout);
  const line = track.getCenterline();
  const n = line.length;
  let progress = 0;
  let lastIndex = track.nearestIndex(vehicle.position);
  let t = 0;
  let maxSpeed = 0;
  let stuckTime = 0;
  let resets = 0;
  const target = new Vector3();
  const far = new Vector3();
  const limit = (track.length / 8) * 1.0 + 60; // generous: avg 8 m/s + margin

  while (progress < n && t < limit) {
    const idx = track.nearestIndex(vehicle.position);
    let delta = idx - lastIndex;
    if (delta < -n / 2) delta += n;
    if (delta > n / 2) delta -= n;
    progress += delta;
    lastIndex = idx;

    const speed = vehicle.physics.forwardSpeed;
    const look = Math.round((6 + speed * 0.6) / layout.sampleSpacing);
    target.copy(line[(idx + look) % n]).sub(vehicle.position).setY(0).normalize();
    fwd.set(0, 0, -1).applyQuaternion(vehicle.quaternion);
    const side = fwd.x * target.z - fwd.z * target.x; // + = target to the right
    // Corner severity from heading change over the next ~4 s of track.
    far.copy(line[(idx + Math.round((20 + speed * 2.2) / layout.sampleSpacing)) % n]).sub(vehicle.position).setY(0).normalize();
    const cornering = 1 - Math.max(0, fwd.x * far.x + fwd.z * far.z);
    const targetSpeed = Math.max(14, car.physics.maxSpeed * 0.8 - cornering * 160);
    tick({
      steer: Math.max(-1, Math.min(1, side * 4)),
      throttle: speed < targetSpeed ? 1 : 0,
      brake: speed > targetSpeed + 3 ? 1 : 0,
      handbrake: 0,
    });
    maxSpeed = Math.max(maxSpeed, vehicle.speedKmh);
    stuckTime = Math.abs(vehicle.physics.forwardSpeed) < 1 ? stuckTime + dt : 0;
    if (vehicle.position.y < -5 || vehicle.isFlipped() || stuckTime > 3) {
      // Same recovery a player gets (R key / auto reset), but count it.
      if (process.env.SIM_DEBUG) console.log(`    reset @ sample ${idx}/${n} (${((idx / n) * 100).toFixed(0)}%) pos=(${vehicle.position.x.toFixed(0)},${vehicle.position.z.toFixed(0)}) y=${vehicle.position.y.toFixed(1)} flipped=${vehicle.isFlipped()} stuck=${stuckTime.toFixed(1)} speed=${speed.toFixed(1)}`);
      resets++;
      vehicle.teleport(track.getResetPose(vehicle.position));
      stuckTime = 0;
      if (resets > 5) break;
    }
    t += dt;
  }
  const done = progress >= n;
  check(
    done && resets <= 2,
    `${car.name.padEnd(9)} @ ${layout.name.padEnd(17)} ${(track.length / 1000).toFixed(2)} km: ` +
      `${done ? `lap ${t.toFixed(1)}s` : `only ${((progress / n) * 100).toFixed(0)}%`}, top ${maxSpeed.toFixed(0)} km/h, resets ${resets}`,
  );
}

for (const car of CARS) await manoeuvres(car);

console.log('Bot laps');
const only = process.argv.slice(2).find((a) => a !== 'quick');
const layouts = (quick ? [DEMO_TRACK] : [DEMO_TRACK, ...realTracks]).filter((l) => !only || l.id === only);
for (const layout of layouts) for (const car of CARS) await botLap(car, layout);

// --- 3. dynamic racing line ------------------------------------------------
console.log('Racing line');
{
  const rbr = realTracks[0];
  const physics = await PhysicsWorld.create(dt);
  const rbrTrack = new ProceduralTrack(physics, rbr, { treesPerKm: 0 });
  const path = racingLineFor(rbrTrack);
  // Out-in-out: the line should use most of the road width somewhere.
  let widest = 0;
  for (const [x, z] of path) widest = Math.max(widest, Math.abs(rbrTrack.lateral(new Vector3(x, 0, z))));
  check(widest > rbrTrack.halfWidth - 2.5, `racing line uses the road width: max offset ${widest.toFixed(1)} m of ${rbrTrack.halfWidth.toFixed(1)} m`);
  const line = new RacingLine(path, CARS[1].physics);
  // Car ~60 m before the slowest point of the first 300 m (turn 1).
  let slow = 0;
  for (let i = 0; i < 150; i++) if (line.speeds[i] < line.speeds[slow]) slow = i;
  const at = line.points[Math.max(0, slow - 30)];
  const colorsAt = (kmh: number) => {
    line.update(new Vector3(at.x, 0, at.z), kmh / 3.6);
    const c = line.mesh.geometry.getAttribute('color').array as Float32Array;
    const n = { red: 0, yellow: 0, green: 0 };
    for (let i = 0; i < line.points.length; i++) {
      const o = i * 8;
      if (c[o + 3] < 0.05) continue;
      if (c[o] > 0.8 && c[o + 1] < 0.5) n.red++;
      else if (c[o] > 0.6 && c[o + 1] > 0.6) n.yellow++;
      else n.green++;
    }
    return n;
  };
  const fast = colorsAt(300);
  const slowCar = colorsAt(60);
  check(fast.red > 0, `too fast before turn 1 (target ${(line.speeds[slow] * 3.6).toFixed(0)} km/h) -> red ahead: ${JSON.stringify(fast)}`);
  check(slowCar.red === 0 && slowCar.green > 0, `slowed down -> line turns green: ${JSON.stringify(slowCar)}`);
  check(line.idealLapTime > 50 && line.idealLapTime < 200, `ideal lap ${line.idealLapTime.toFixed(1)} s`);
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
