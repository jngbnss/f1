/**
 * Lap-time sensitivity of each team trait: a neutral F1 car, then one trait at a
 * time changed by +5 % (power +5 %), alone on each circuit. Used to balance the
 * team characters (each team's strengths and weaknesses should add up to ~0).
 *
 *   npx tsx scripts/team-sensitivity.ts [circuit ...]
 */
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { AIDriver } from '../src/race/AIDriver';
import { buildGearbox, buildPhysics } from '../src/vehicle/catalog/build';
import type { CarSpec, CarTraits } from '../src/vehicle/catalog/specs';
import { CARS } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { RacingLine } from '../src/world/RacingLine';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';

const dt = 1 / 60;
const circuits = process.argv.slice(2).length ? process.argv.slice(2) : ['monza', 'suzuka', 'monaco'];
const base = CARS.find((c) => c.id === 'f1-haas')!;
const neutral: CarTraits = { downforce: 1, drag: 1, grip: 1, traction: 1, braking: 1, tyreWear: 1, label: '' };
const variants: [string, Partial<CarTraits>, number?][] = [
  ['neutral', {}],
  ['power +5%', {}, 760 * 1.05],
  ['drag -5%', { drag: 0.95 }],
  ['downforce +5%', { downforce: 1.05 }],
  ['mech grip +5%', { grip: 1.05 }],
  ['traction +5%', { traction: 1.05 }],
  ['braking +5%', { braking: 1.05 }],
];

async function lap(spec: CarSpec, id: string): Promise<number> {
  const cfg = buildPhysics(spec);
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, loadLayout(id), { treesPerKm: 0 });
  const path = racingLineFor(track);
  const line = new RacingLine(path, cfg, { heights: track.heightsFor(path) });
  const v = new Vehicle(physics, cfg, base.createVisual(), track.getSpawnPose(), buildGearbox(spec));
  v.physics.aeroInAir = track.elevated;
  v.physics.surfaceAt = (x, z, y = 0) => {
    const s = track.surfaceAt({ x, y, z } as never);
    return { grip: s === 'grass' ? 0.55 : s === 'gravel' ? 0.45 : 1, drag: s === 'grass' ? 1.2 : s === 'gravel' ? 6 : 0 };
  };
  const ai = new AIDriver(v, line, track, { pace: 1, lane: 0, aggression: 0.5 });
  const n = track.getCenterline().length;
  let last = track.nearestIndex(v.position);
  let progress = 0;
  let t = 0;
  let lapStart = 0;
  let laps = 0;
  while (t < 500) {
    v.fixedUpdate(ai.update(dt, [v]), dt);
    physics.step();
    v.snapshot();
    const i = track.nearestIndex(v.position);
    let d = i - last;
    if (d < -n / 2) d += n;
    if (d > n / 2) d -= n;
    progress += d;
    last = i;
    t += dt;
    if (progress >= n * (laps + 1)) {
      laps++;
      if (laps === 2) return t - lapStart;
      lapStart = t;
    }
  }
  return NaN;
}

const ref: number[] = [];
for (const [name, change, kw] of variants) {
  const row: string[] = [];
  for (const [c, id] of circuits.entries()) {
    const spec: CarSpec = { ...base.spec, kw: kw ?? 760, traits: { ...neutral, ...change } };
    const t = await lap(spec, id);
    if (name === 'neutral') ref[c] = t;
    row.push(name === 'neutral' ? `${t.toFixed(2)} s`.padStart(10) : `${(((t - ref[c]) / ref[c]) * 100).toFixed(2)}%`.padStart(10));
  }
  console.log(`${name.padEnd(15)} ${row.join('')}`);
}
console.log(`${''.padEnd(15)} ${circuits.map((c) => c.padStart(10)).join('')}`);
