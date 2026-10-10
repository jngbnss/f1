/**
 * Weight transfer check: in a corner the outside tyres carry more load, under
 * braking the fronts do, under acceleration the rears do. Also reports the roll
 * angle (an F1 car rolls ~1° at 4 g: stiff springs, low centre of mass).
 *
 *   npx tsx scripts/load-test.ts [carId]
 */
import { Quaternion, Vector3 } from 'three';
import type { VehicleInput } from '../src/input/VehicleInput';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { findCar } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { ProceduralTrack } from '../src/world/Track';
import type { TrackLayout } from '../src/world/TrackLayout';

const dt = 1 / 60;
const RUNWAY: TrackLayout = {
  id: 'runway',
  name: 'Runway',
  roadWidth: 600,
  runoff: 20,
  sampleSpacing: 10,
  points: [
    [0, 10000],
    [0, -10000],
    [2000, -10300],
    [4000, -10000],
    [4000, 10000],
    [2000, 10300],
  ],
};

let failures = 0;
function check(ok: boolean, message: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures++;
}

const car = findCar(process.argv[2] ?? 'f1-ferrari');

async function rig() {
  const physics = await PhysicsWorld.create(dt);
  new ProceduralTrack(physics, RUNWAY, { treesPerKm: 0 });
  const v = new Vehicle(physics, car.physics, car.createVisual(), { position: new Vector3(2000, 1, 0), quaternion: new Quaternion() }, car.gearbox);
  const tick = (input: Partial<VehicleInput>) => {
    v.fixedUpdate({ throttle: 0, brake: 0, steer: 0, handbrake: 0, ...input }, dt);
    physics.step();
    v.snapshot();
  };
  for (let i = 0; i < 60; i++) tick({});
  return { v, tick };
}

const loads = (v: Vehicle) => v.physics.wheels.map((w) => w.load);
const fmt = (l: number[]) => l.map((x) => (x / 1000).toFixed(1).padStart(5)).join(' ') + ' kN';
/** Roll angle (deg, + = leaning to the left side, i.e. outward in a right-hander). */
function roll(v: Vehicle): number {
  const right = new Vector3(1, 0, 0).applyQuaternion(v.quaternion);
  return (Math.asin(right.y) * 180) / Math.PI;
}
/** Average over the last half of a phase. */
function average(samples: number[][]): number[] {
  const tail = samples.slice(Math.floor(samples.length / 2));
  return tail[0].map((_, i) => tail.reduce((s, x) => s + x[i], 0) / tail.length);
}

console.log(`Load transfer: ${car.name}   (FL FR RL RR)`);

// --- static -----------------------------------------------------------------
{
  const { v, tick } = await rig();
  for (let i = 0; i < 60; i++) tick({});
  const l = loads(v);
  const front = (l[0] + l[1]) / l.reduce((a, b) => a + b, 0);
  console.log(`  static           ${fmt(l)}  front ${(front * 100).toFixed(0)} %`);
  check(Math.abs(l[0] - l[1]) < 100 && Math.abs(l[2] - l[3]) < 100, 'static: left and right equal');
}

// --- steady corners (right-hander: outside = left wheels) -----------------------
for (const [kmh, steer] of [
  [80, 0.6],
  [150, 0.35],
  [230, 0.3],
] as const) {
  const { v, tick } = await rig();
  while (v.speedKmh < kmh) tick({ throttle: 1 });
  const samples: number[][] = [];
  const rolls: number[] = [];
  let g = 0;
  let n = 0;
  for (let i = 0; i < 240; i++) {
    const err = kmh - v.speedKmh;
    tick({ throttle: Math.min(Math.max(err * 0.3, 0), 1), steer });
    if (i >= 120) {
      samples.push(loads(v));
      rolls.push(roll(v));
      const lv = v.physics.body.linvel();
      g += (Math.abs(v.physics.body.angvel().y) * Math.hypot(lv.x, lv.z)) / 9.81;
      n++;
    }
  }
  const l = average(samples);
  const r = rolls.reduce((a, b) => a + b, 0) / rolls.length;
  const outer = l[0] + l[2];
  const inner = l[1] + l[3];
  console.log(`  ${String(kmh).padStart(3)} km/h ${(g / n).toFixed(2)} g  ${fmt(l)}  outside ${((outer / (outer + inner)) * 100).toFixed(0)} %  roll ${r.toFixed(2)}°`);
  check(outer > inner * 1.1, `${kmh} km/h right-hander: outside wheels carry more load`);
  check(r > 0 && r < 3, `${kmh} km/h: body rolls outward, under 3° (${r.toFixed(2)}°)`);
}

// --- braking and acceleration -------------------------------------------------
{
  const { v, tick } = await rig();
  while (v.speedKmh < 200) tick({ throttle: 1 });
  const samples: number[][] = [];
  for (let i = 0; i < 40; i++) {
    tick({ brake: 1 });
    if (i >= 10) samples.push(loads(v));
  }
  const l = average(samples);
  const front = (l[0] + l[1]) / l.reduce((a, b) => a + b, 0);
  console.log(`  braking @200     ${fmt(l)}  front ${(front * 100).toFixed(0)} %`);
  check(front > 0.5, 'braking: front axle carries more load');
}
{
  const { v, tick } = await rig();
  const samples: number[][] = [];
  for (let i = 0; i < 60; i++) {
    tick({ throttle: 1 });
    if (i >= 20) samples.push(loads(v));
  }
  const l = average(samples);
  const rear = (l[2] + l[3]) / l.reduce((a, b) => a + b, 0);
  console.log(`  launch           ${fmt(l)}  rear ${(rear * 100).toFixed(0)} %`);
  check(rear > 0.55, 'launch: rear axle carries more load');
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
