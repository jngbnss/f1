/**
 * Headless 20-car race: every car is AI-driven (no renderer). Checks the
 * field can start from the grid, race wheel-to-wheel and finish.
 *
 *   npx tsx scripts/race-test.ts [track] [cars] [laps]
 */
import { readFileSync } from 'node:fs';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { AIDriver } from '../src/race/AIDriver';
import { RaceManager, type Racer } from '../src/race/RaceManager';
import { Penalties } from '../src/race/Penalties';
import { RaceControl, VSC_SPEED } from '../src/race/RaceControl';
import { CARS, findCar, type CarDefinition } from '../src/vehicle/cars';
import { teamLinePath } from '../src/world/TeamLines';
import { applyImpacts } from '../src/race/Impacts';
import { DebrisField } from '../src/race/Debris';
import { straightZones, updateRules2026 } from '../src/race/Rules2026';
import { updateSlipstream } from '../src/race/Slipstream';
import { Vehicle } from '../src/vehicle/Vehicle';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { RacingLine } from '../src/world/RacingLine';
import { loadLayout } from './tracks-node';
import { ProceduralTrack } from '../src/world/Track';
import { DEMO_TRACK, parseTumCsv, type TrackLayout } from '../src/world/TrackLayout';

const [trackId = 'test', carsArg = '20', lapsArg = '2', carId = 'f1-ferrari'] = process.argv.slice(2);
const layout: TrackLayout = loadLayout(trackId);

const dt = 1 / 60;
const physics = await PhysicsWorld.create(dt);
const track = new ProceduralTrack(physics, layout, { treesPerKm: 0 });
const car = findCar(carId);
// GRID=teams: the real field, two cars per team, each on its team's line (as in the game:
// the baked min-time line refined per team; TEAM_LINES=0 puts every team on the shared line).
const teamGrid = process.env.GRID === 'teams';
// Quicker cars further up the grid, as the game orders it.
const teams = CARS.filter((c) => c.spec.cls === 'formula').sort((a, b) => b.stats.pi - a.stats.pi);
// LINE=mintime: the baked min-time line the game drives (default: the min-curvature line).
const sharedPath = teamGrid || process.env.LINE === 'mintime' ? (layout.minTimeLine ?? racingLineFor(track)) : racingLineFor(track);
const lines = new Map<string, RacingLine>();
const lineFor = (def: CarDefinition) => {
  let l = lines.get(def.id);
  if (!l) {
    const path = (teamGrid && process.env.TEAM_LINES !== '0' && teamLinePath(layout.teamLines, def.id, track, sharedPath)) || sharedPath;
    lines.set(def.id, (l = new RacingLine(path, def.physics, { heights: track.heightsFor(path) })));
  }
  return l;
};
const total = Number(carsArg);
const racers: Racer[] = [];
const vehicles: Vehicle[] = [];
for (let slot = 0; slot < total; slot++) {
  const def = teamGrid ? teams[Math.floor(slot / 2) % teams.length] : car;
  const line = lineFor(def);
  const v = new Vehicle(physics, def.physics, def.createVisual(), track.gridPose(slot), def.gearbox);
  v.physics.aeroInAir = track.elevated;
  // SEED=n reshuffles the drivers (race outcomes are chaotic: compare several seeds).
  const r = Math.sin((slot + Number(process.env.SEED ?? 0) * 7.31) * 12.9898) * 43758.5453;
  const rand = r - Math.floor(r);
  const ai = new AIDriver(v, line, track, { pace: 0.97 - (slot / total) * 0.07 + (rand - 0.5) * 0.04, lane: (rand - 0.5) * 2.4, aggression: rand });
  vehicles.push(v);
  racers.push({ name: teamGrid ? `${def.spec.brand.replace(/ /g, '')}${(slot % 2) + 1}` : `CAR${slot + 1}`, vehicle: v, ai, isPlayer: slot === 0, progress: 0, lastIndex: 0, finished: false, finishTime: 0, color: 0 });
}
const broken = new Set<Vehicle>();
const zones = straightZones(track);
let straightSteps = 0;
let carSteps = 0;
let minCharge = 1;
const debris = process.env.NO_DEBRIS ? null : new DebrisField(1 + Number(process.env.SEED ?? 0));
let debrisSlides = 0;
let maxDebris = 0;
// Track limits: all four wheels past the asphalt edge (car centre > half width + ~1 m).
const offTrack = new Set<Vehicle>();
const offAt: number[] = [];
const offSide = { inside: 0, outside: 0 };
const samples = track.getCenterline().length;
const byCollider = new Map(vehicles.map((v) => [v.physics.collider.handle, v] as [number, Vehicle]));
const race = new RaceManager(track, racers, Number(lapsArg));
const penalties = new Penalties(track);
const control = new RaceControl(track);
const flags: string[] = [];
control.onMessage = (m) => flags.push(`${m}@${race.time.toFixed(0)}s`);
let overtakePenalties = 0;
const HOLD = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
let resets = 0;
let stepMs = 0;
let steps = 0;
const limit = (track.length * Number(lapsArg)) / 12 + 60; // avg ≥ 12 m/s
let t = 0;
while (t < limit && !racers.every((r) => r.finished)) {
  const t0 = performance.now();
  if (!process.env.NO_SLIP) updateSlipstream(vehicles);
  if (!process.env.NO_2026) updateRules2026(track, zones, vehicles, race);
  for (const r of racers) r.vehicle.fixedUpdate(race.frozen ? HOLD : r.ai!.update(dt, vehicles), dt);
  physics.step();
  for (const v of vehicles) v.snapshot();
  applyImpacts(physics, byCollider, dt, (v, hit, before) => {
    debris?.onDamage(v, before);
    if (process.env.RESET_LOG && (v.damage.front >= 0.6 || v.damage.rear >= 0.6) && !broken.has(v)) {
      broken.add(v);
      console.log(`  wing off (${hit}) ${racers.find((r) => r.vehicle === v)!.name} t=${t.toFixed(1)}s at sample ${track.nearestIndex(v.position)} front ${v.damage.front.toFixed(2)} rear ${v.damage.rear.toFixed(2)}, ${(v.physics.speed * 3.6).toFixed(0)} km/h, lateral ${track.lateral(v.position).toFixed(1)} m`);
    }
  });
  for (const r of racers) {
    const v = r.vehicle;
    if ((v.isFlipped() && v.physics.speed < 3) || v.position.y < track.bounds.min.y - 5 || track.isOutOfBounds(v.position) || r.ai!.unstuckCount >= 3) {
      if (process.env.RESET_LOG) console.log(`  reset ${r.name} t=${t.toFixed(1)}s at sample ${track.nearestIndex(v.position)} lateral ${track.lateral(v.position).toFixed(1)} m, flipped=${v.isFlipped()} unstuck=${r.ai!.unstuckCount}`);
      v.teleport(track.getResetPose(v.position));
      r.ai!.resetState();
      r.ai!.unstuckCount = 0;
      race.resync(r);
      resets++;
    }
  }
  if (!race.frozen) {
    for (const v of vehicles) {
      const off = Math.abs(track.lateral(v.position)) > track.halfWidth + 1;
      if (off && !offTrack.has(v)) {
        const i = track.nearestIndex(v.position);
        offAt.push(Math.round((i / samples) * track.length));
        // Inside of the bend (cutting) or outside (running wide)? Turn direction from the centreline.
        const c = track.getCenterline();
        const p0 = c[(i - 8 + samples) % samples], p1 = c[i], p2 = c[(i + 8) % samples];
        const turn = (p1.x - p0.x) * (p2.z - p1.z) - (p1.z - p0.z) * (p2.x - p1.x); // + = turning right
        const lat = track.lateral(v.position); // + = right of centre
        if (Math.abs(turn) > 1) offSide[Math.sign(turn) === Math.sign(lat) ? 'inside' : 'outside']++;
        if (process.env.OFF_LOG) console.log(`  off ${racers.find((r) => r.vehicle === v)!.name} t=${t.toFixed(1)}s @${Math.round((i / samples) * track.length)} m lat ${lat.toFixed(1)} ${(v.physics.speed * 3.6).toFixed(0)} km/h`);
      }
      if (off) offTrack.add(v);
      else offTrack.delete(v);
    }
  }
  debris?.step(vehicles, dt, (e) => {
    if (e.kind === 'slide') debrisSlides++;
    if (process.env.RESET_LOG && e.kind === 'puncture') console.log(`  puncture ${racers.find((r) => r.vehicle === e.car)!.name} wheel ${e.wheel} t=${t.toFixed(1)}s`);
  });
  if (debris) maxDebris = Math.max(maxDebris, debris.pieces.length);
  if (!race.frozen) {
    for (const v of vehicles) {
      carSteps++;
      if (v.aeroMode > 0.5) straightSteps++;
      minCharge = Math.min(minCharge, v.ers.charge);
    }
  }
  race.update(dt);
  if (!race.frozen) {
    penalties.update(racers, dt, () => false);
    control.update(dt, racers, race.time, debris, () => false);
    for (const r of racers) {
      r.ai!.rules.speedFactor = control.flag !== 'green' ? VSC_SPEED : control.inYellow(r) ? 0.8 : 1;
      r.ai!.rules.noPassing = control.noOvertaking(r);
    }
    for (const r of control.overtakes(racers, () => false)) {
      penalties.overtake(r);
      overtakePenalties++;
    }
  }
  stepMs += performance.now() - t0;
  steps++;
  t += dt;
}
const finished = racers.filter((r) => r.finished);
const standings = race.standings();
console.log(`${layout.name} (${(track.length / 1000).toFixed(2)} km), ${total} cars, ${lapsArg} laps, car ${car.name}`);
console.log(`finished ${finished.length}/${total} in ${t.toFixed(0)} s sim time; resets ${resets}`);
console.log(`winner ${standings[0].name} ${standings[0].finishTime.toFixed(1)} s, last ${finished.length ? Math.max(...finished.map((r) => r.finishTime)).toFixed(1) : '-'} s`);
if (process.env.FINISH_LOG) console.log('finish times', standings.map((r) => `${r.name}:${r.finished ? r.finishTime.toFixed(1) : 'DNF'}${r.vehicle.damage.any ? '*' : ''}`).join(' '));
console.log(`wing damage: ${vehicles.filter((v) => v.damage.any).length} cars touched, ${vehicles.filter((v) => v.damage.front >= 0.6 || v.damage.rear >= 0.6).length} lost a wing`);
const spots = new Map<number, number>();
for (const m of offAt) spots.set(Math.round(m / 100) * 100, (spots.get(Math.round(m / 100) * 100) ?? 0) + 1);
const worst = [...spots].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([m, k]) => `${k}x @${m} m`);
console.log(`track limits: ${offAt.length} times off with all four wheels, ${offSide.inside} inside / ${offSide.outside} outside of a bend${worst.length ? ` (${worst.join(', ')})` : ''}`);
const zoneShare = zones.reduce((a, b) => a + b, 0) / zones.length;
const charge = vehicles.reduce((a, v) => a + v.ers.charge, 0) / vehicles.length;
console.log(`2026: straight-mode zones ${(zoneShare * 100).toFixed(0)} % of the lap, cars in straight mode ${((straightSteps / Math.max(carSteps, 1)) * 100).toFixed(0)} % of the time, battery at the end ${(charge * 100).toFixed(0)} % (lowest ${(minCharge * 100).toFixed(0)} %), overtake mode used ${vehicles.reduce((a, v) => a + v.ers.overtakeUses, 0)} times`);
if (debris) console.log(`debris: up to ${maxDebris} pieces on track, ${debrisSlides} tyre slides on it, ${debris.punctures} punctures`);
console.log(`race control: ${flags.join(', ') || 'green all race'}; ${overtakePenalties} overtaking penalties`);
const strikes = [...penalties.state.values()].reduce((s, p) => s + p.strikes, 0);
console.log(`track limits: ${strikes} excursions, ${racers.filter((r) => r.penalty).length} cars penalised`);
console.log(`CPU per physics step (all ${total} cars + AI): ${(stepMs / steps).toFixed(2)} ms`);
process.exit(finished.length >= total * 0.9 && resets <= total ? 0 : 1);
