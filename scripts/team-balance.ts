/**
 * Team balance: every F1 team laps five circuits alone (AI at full pace, second
 * lap timed). Teams should differ a lot per circuit (power tracks vs twisty
 * ones) but end up close on average.
 *
 *   npx tsx scripts/team-balance.ts [circuit ...]
 */
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { AIDriver } from '../src/race/AIDriver';
import { CARS } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { RacingLine } from '../src/world/RacingLine';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';

const dt = 1 / 60;
const circuits = process.argv.slice(2).length ? process.argv.slice(2) : ['monza', 'monaco', 'suzuka', 'spa', 'shanghai'];
const teams = CARS.filter((c) => c.cls === 'formula');
const times = new Map<string, number[]>(teams.map((t) => [t.id, []]));

for (const id of circuits) {
  for (const car of teams) {
    const physics = await PhysicsWorld.create(dt);
    const track = new ProceduralTrack(physics, loadLayout(id), { treesPerKm: 0 });
    const path = racingLineFor(track);
    const line = new RacingLine(path, car.physics, { heights: track.heightsFor(path) });
    const v = new Vehicle(physics, car.physics, car.createVisual(), track.getSpawnPose(), car.gearbox);
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
    let lap2 = NaN;
    while (laps < 2 && t < 500) {
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
        if (laps === 2) lap2 = t - lapStart;
        lapStart = t;
      }
      if (v.isFlipped() || track.isOutOfBounds(v.position)) break;
    }
    times.get(car.id)!.push(lap2);
  }
}

// Table: lap time per circuit (gap to the fastest there) and the average gap.
const best = circuits.map((_, c) => Math.min(...teams.map((t) => times.get(t.id)![c]).filter((x) => !Number.isNaN(x))));
console.log(`${'team'.padEnd(15)} ${circuits.map((c) => c.padStart(14)).join('')}   avg gap`);
const rows = teams.map((t) => {
  const ts = times.get(t.id)!;
  const gaps = ts.map((x, c) => (x / best[c] - 1) * 100);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return { t, ts, gaps, avg };
});
rows.sort((a, b) => a.avg - b.avg);
for (const r of rows) {
  console.log(
    `${r.t.id.replace('f1-', '').padEnd(15)} ${r.ts.map((x, c) => (Number.isNaN(x) ? 'DNF' : `${x.toFixed(2)} +${r.gaps[c].toFixed(1)}%`).padStart(14)).join('')}   +${r.avg.toFixed(2)}%`,
  );
}
const winners = circuits.map((c, i) => `${c}: ${rows.reduce((a, b) => (a.ts[i] < b.ts[i] ? a : b)).t.id.replace('f1-', '')}`);
console.log(`fastest per circuit -> ${winners.join(', ')}`);
const spread = rows[rows.length - 1].avg - rows[0].avg;
console.log(`average spread ${spread.toFixed(2)}% (target < 0.6%)`);
