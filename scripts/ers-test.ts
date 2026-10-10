/**
 * 2026 rules check: MGU-K taper, battery deployment and recovery, active aero
 * straight mode, overtake mode and the straight-mode zones of the circuits.
 *
 *   npx tsx scripts/ers-test.ts
 */
import { Quaternion, Vector3 } from 'three';
import type { VehicleInput } from '../src/input/VehicleInput';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { straightZones } from '../src/race/Rules2026';
import { findCar } from '../src/vehicle/cars';
import { ERS_CAPACITY, mgukTaper } from '../src/vehicle/Ers';
import { Vehicle } from '../src/vehicle/Vehicle';
import { ProceduralTrack } from '../src/world/Track';
import type { TrackLayout } from '../src/world/TrackLayout';
import { loadLayout } from './tracks-node';

const dt = 1 / 60;
const car = findCar('f1-ferrari');
const IDLE: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
let failures = 0;
function check(ok: boolean, message: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures++;
}

const RUNWAY: TrackLayout = { id: 'runway', name: 'Runway', roadWidth: 600, runoff: 20, sampleSpacing: 10, points: [[0, 10000], [0, -10000], [2000, -10300], [4000, -10000], [4000, 10000], [2000, 10300]] };

async function straight() {
  const physics = await PhysicsWorld.create(dt);
  new ProceduralTrack(physics, RUNWAY, { treesPerKm: 0 });
  const v = new Vehicle(physics, car.physics, car.createVisual(), { position: new Vector3(4000, 1, 9000), quaternion: new Quaternion() }, car.gearbox);
  v.ers.lapLength = 1e9;
  const tick = (input: Partial<VehicleInput>) => {
    v.fixedUpdate({ ...IDLE, ...input }, dt);
    physics.step();
    v.snapshot();
  };
  for (let i = 0; i < 60; i++) tick({});
  return { v, tick };
}

/** Top speed flat out over the runway. */
async function topSpeed(prepare: (v: Vehicle) => void): Promise<number> {
  const { v, tick } = await straight();
  prepare(v);
  let top = 0;
  for (let i = 0; i < 60 * 60 && v.position.z > -9800; i++) {
    tick({ throttle: 1 });
    top = Math.max(top, v.speedKmh);
  }
  return top;
}

/** Seconds from 200 to 300 km/h. */
async function time200to300(prepare: (v: Vehicle) => void): Promise<number> {
  const { v, tick } = await straight();
  v.straightZone = true;
  while (v.speedKmh < 200) tick({ throttle: 1 });
  prepare(v);
  let t = 0;
  while (v.speedKmh < 300 && t < 30) {
    tick({ throttle: 1 });
    t += dt;
  }
  return t;
}

console.log('MGU-K taper (FIA 2026)');
check(mgukTaper(250 / 3.6) === 1 && Math.abs(mgukTaper(322.5 / 3.6) - 0.5) < 0.01 && mgukTaper(355 / 3.6) === 0, 'full up to 290 km/h, half at 322.5, none at 355');
check(mgukTaper(330 / 3.6, true) === 1 && mgukTaper(346 / 3.6, true) > 0.4, 'overtake mode: full up to 337 km/h');

console.log('Battery');
{
  const { v, tick } = await straight();
  v.straightZone = true;
  for (let i = 0; i < 60 * 12; i++) tick({ throttle: 1 });
  const afterRun = v.ers.charge;
  const fast = v.speedKmh;
  for (let i = 0; i < 60 * 3; i++) tick({ brake: 1 });
  const afterBrake = v.ers.charge;
  check(afterRun < 0.75, `12 s flat out: battery down to ${(afterRun * 100).toFixed(0)} % (${fast.toFixed(0)} km/h)`);
  check(afterBrake > afterRun + 0.1, `3 s of braking recovers energy: ${(afterRun * 100).toFixed(0)} % -> ${(afterBrake * 100).toFixed(0)} %`);
  v.ers.harvestedThisLap = 8.5e6;
  const capped = v.ers.charge;
  while (v.speedKmh < 200) tick({ throttle: 1 });
  for (let i = 0; i < 60 * 2; i++) tick({ brake: 1 });
  check(v.ers.charge <= capped + 1e-6, 'no more recovery once 8.5 MJ were harvested on the lap');
  const flat = await time200to300((x) => (x.ers.energy = 0));
  const full = await time200to300((x) => (x.ers.energy = ERS_CAPACITY));
  check(flat > full * 1.1, `200-300 km/h: ${full.toFixed(1)} s with a full battery, ${flat.toFixed(1)} s with an empty one`);
}

console.log('Active aero');
{
  const corner = await topSpeed(() => {});
  const straightMode = await topSpeed((v) => (v.straightZone = true));
  check(straightMode > corner + 10, `top speed ${corner.toFixed(0)} km/h in corner mode, ${straightMode.toFixed(0)} km/h in straight mode (spec ${car.spec.top})`);
  const { v, tick } = await straight();
  v.straightZone = true;
  while (v.speedKmh < 250) tick({ throttle: 1 });
  const open = v.aeroMode;
  for (let i = 0; i < 12; i++) tick({ brake: 1 });
  check(open === 1 && v.aeroMode === 0, `flaps open on the straight (${open}) and closed 0.2 s into braking (${v.aeroMode.toFixed(2)})`);
}

console.log('Overtake mode');
{
  const run = async (overtake: boolean) => {
    const { v, tick } = await straight();
    v.straightZone = true;
    while (v.speedKmh < 280) tick({ throttle: 1 });
    if (overtake) {
      v.ers.overtakeAvailable = true;
      v.ers.activateOvertake();
    }
    const z0 = v.position.z;
    let t = 0;
    while (z0 - v.position.z < 1000) {
      tick({ throttle: 1 });
      t += dt;
    }
    return t;
  };
  const normal = await run(false);
  const boosted = await run(true);
  check(boosted < normal - 0.15, `1 km flat out from 280 km/h: ${normal.toFixed(2)} s normally, ${boosted.toFixed(2)} s in overtake mode`);
  const { v } = await straight();
  check(!v.ers.activateOvertake(), 'cannot arm overtake mode without a car within a second ahead');
  v.ers.overtakeAvailable = true;
  const first = v.ers.activateOvertake();
  v.ers.overtakeAvailable = true;
  check(first && !v.ers.activateOvertake(), 'once per lap');
}

console.log('Straight-mode zones');
for (const [id, lo, hi] of [
  ['monza', 0.3, 0.7],
  ['spa', 0.1, 0.6],
  ['monaco', 0, 0.2],
] as const) {
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, loadLayout(id), { treesPerKm: 0 });
  const zones = straightZones(track);
  const share = zones.reduce((a, b) => a + b, 0) / zones.length;
  check(share >= lo && share <= hi, `${id}: ${(share * 100).toFixed(0)} % of the lap in straight-mode zones`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
