/**
 * Car performance numbers without a renderer, for tuning against real
 * figures: 0-100 / 0-200 km/h, top speed, 200-0 braking distance, and
 * steady-state lateral g at several speeds (skidpad).
 *
 *   npx tsx scripts/handling.ts [carId ...] [--json]
 */
import { Quaternion, Vector3 } from 'three';
import type { VehicleInput } from '../src/input/VehicleInput';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { CARS, type CarDefinition } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { ProceduralTrack } from '../src/world/Track';
import type { TrackLayout } from '../src/world/TrackLayout';

const dt = 1 / 60;
const G = 9.81;

/** 20 km straight with a huge road (skidpad circles fit on it). */
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

export interface HandlingResult {
  car: string;
  t100: number;
  t200: number | null;
  topKmh: number;
  brake200m: number | null;
  /** km/h -> lateral g */
  lateralG: Record<number, number>;
}

async function rig(car: CarDefinition) {
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, RUNWAY, { treesPerKm: 0 });
  // Start of the long straight, facing -Z (car forward).
  const pose = { position: new Vector3(-150, 1, 9800), quaternion: new Quaternion() };
  const v = new Vehicle(physics, car.physics, car.createVisual(), pose, car.gearbox);
  const tick = (input: Partial<VehicleInput>) => {
    v.fixedUpdate({ throttle: 0, brake: 0, steer: 0, handbrake: 0, ...input }, dt);
    physics.step();
    v.snapshot();
  };
  for (let i = 0; i < 60; i++) tick({});
  return { v, tick, track };
}

export async function measure(car: CarDefinition): Promise<HandlingResult> {
  // --- straight line ---------------------------------------------------
  const { v, tick } = await rig(car);
  let t = 0;
  let t100 = 0;
  let t200: number | null = null;
  let last = 0;
  let stall = 0;
  let topKmh = 0;
  // Until the speed stops rising or the 20 km straight runs out.
  while (t < 120 && stall < 4 && v.position.z > -9800) {
    tick({ throttle: 1 });
    topKmh = Math.max(topKmh, v.speedKmh);
    t += dt;
    if (!t100 && v.speedKmh >= 100) t100 = t;
    if (t200 === null && v.speedKmh >= 200) t200 = t;
    // Stop once speed stops rising (top speed reached).
    if (Math.round(t * 60) % 60 === 0) {
      stall = v.speedKmh - last < 0.3 ? stall + 1 : 0;
      last = v.speedKmh;
    }
  }

  // --- braking from 200 ------------------------------------------------
  let brake200m: number | null = null;
  if (topKmh > 205) {
    const b = await rig(car);
    while (b.v.speedKmh < 200) b.tick({ throttle: 1 });
    const p0 = b.v.position.clone();
    while (b.v.speedKmh > 1) b.tick({ brake: 1 });
    brake200m = b.v.position.distanceTo(p0);
  }

  // --- skidpad: hold speed, sweep steering, keep the best stable lateral g
  const lateralG: Record<number, number> = {};
  for (const kmh of [60, 100, 150, 200, 250, 300]) {
    if (kmh > topKmh - 8) continue;
    let best = 0;
    for (const steer of [0.15, 0.25, 0.35, 0.5, 0.7, 1]) {
      const c = await rig(car);
      c.v.teleport({ position: new Vector3(2000, 1, 0), quaternion: new Quaternion() });
      while (c.v.speedKmh < kmh) c.tick({ throttle: 1 });
      let g = 0;
      let n = 0;
      let lost = false;
      for (let i = 0; i < 300; i++) {
        const err = kmh - c.v.speedKmh;
        c.tick({ throttle: Math.min(Math.max(err * 0.3, 0), 1), brake: err < -4 ? 0.2 : 0, steer });
        if (i >= 180) {
          const lv = c.v.physics.body.linvel();
          const yaw = c.v.physics.body.angvel().y;
          g += (Math.abs(yaw) * Math.hypot(lv.x, lv.z)) / G;
          n++;
          if (c.v.speedKmh < kmh * 0.9 || c.v.isFlipped()) lost = true;
        }
      }
      if (!lost && n) best = Math.max(best, g / n);
    }
    lateralG[kmh] = Math.round(best * 100) / 100;
  }
  const r = (x: number) => Math.round(x * 10) / 10;
  return { car: car.id, t100: r(t100), t200: t200 === null ? null : r(t200), topKmh: Math.round(topKmh), brake200m: brake200m === null ? null : Math.round(brake200m), lateralG };
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  // Default: one car per class ('all' = the whole catalog, slow).
  const reps = ['f1-ferrari'];
  const cars = ids.includes('all') ? CARS : CARS.filter((c) => (ids.length ? ids : reps).includes(c.id));
  const json = process.argv.includes('--json');
  const results: HandlingResult[] = [];
  for (const car of cars) {
    const res = await measure(car);
    results.push(res);
    if (!json) {
      const lat = Object.entries(res.lateralG).map(([k, g]) => `${k}:${g}g`).join(' ');
      console.log(`${car.name.padEnd(22)} 0-100 ${res.t100}s  0-200 ${res.t200 ?? '-'}s  top ${res.topKmh} km/h  200-0 ${res.brake200m ?? '-'} m  lat ${lat}`);
    }
  }
  if (json) console.log(JSON.stringify(results, null, 2));
}

if (process.argv[1]?.includes('handling')) void main();
