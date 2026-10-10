/**
 * Debris and damage effects:
 * 1. a head-on crash leaves the front wing and carbon shards on the track;
 * 2. a car driving through a field of shards skates on them, and some cut a tyre;
 * 3. a punctured tyre costs most of that wheel's grip (lower cornering g);
 * 4. a broken floor and wings cost downforce and top speed;
 * 5. running over a wing lying on the track damages the floor;
 * 6. an AI car steers round a wing lying on its line.
 *
 *   npx tsx scripts/debris-test.ts
 */
import { Group, Quaternion, Scene, Vector3, type Object3D } from 'three';
import type { VehicleInput } from '../src/input/VehicleInput';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { AIDriver } from '../src/race/AIDriver';
import { DebrisField } from '../src/race/Debris';
import { DebrisMesh } from '../src/render/DebrisMesh';
import { DETACH } from '../src/vehicle/Damage';
import { applyImpacts } from '../src/race/Impacts';
import { findCar } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { RacingLine } from '../src/world/RacingLine';
import { ProceduralTrack } from '../src/world/Track';
import type { TrackLayout } from '../src/world/TrackLayout';
import { loadLayout } from './tracks-node';

const dt = 1 / 60;
// Baseline team car: this checks the damage model, not a team's top speed (a 359 km/h car never tops out here).
const car = findCar('f1-haas');
const IDLE: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
let failures = 0;
function check(ok: boolean, message: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures++;
}

const RUNWAY: TrackLayout = { id: 'runway', name: 'Runway', roadWidth: 600, runoff: 20, sampleSpacing: 10, points: [[0, 10000], [0, -10000], [2000, -10300], [4000, -10000], [4000, 10000], [2000, 10300]] };

async function runway() {
  const physics = await PhysicsWorld.create(dt);
  new ProceduralTrack(physics, RUNWAY, { treesPerKm: 0 });
  const v = new Vehicle(physics, car.physics, car.createVisual(), { position: new Vector3(2000, 1, 0), quaternion: new Quaternion() }, car.gearbox);
  const tick = (input: Partial<VehicleInput>) => {
    v.fixedUpdate({ ...IDLE, ...input }, dt);
    physics.step();
    v.snapshot();
  };
  for (let i = 0; i < 60; i++) tick({});
  return { v, tick };
}

/** Steady-state lateral g at `kmh` with a fixed steering input. */
async function skidpad(prepare: (v: Vehicle) => void, kmh = 120, steer = 0.5): Promise<number> {
  const { v, tick } = await runway();
  prepare(v);
  while (v.speedKmh < kmh) tick({ throttle: 1 });
  let g = 0;
  let n = 0;
  for (let i = 0; i < 240; i++) {
    const err = kmh - v.speedKmh;
    tick({ throttle: Math.min(Math.max(err * 0.3, 0), 1), steer });
    if (i >= 120) {
      const lv = v.physics.body.linvel();
      g += (Math.abs(v.physics.body.angvel().y) * Math.hypot(lv.x, lv.z)) / 9.81;
      n++;
    }
  }
  return g / n;
}

async function topSpeed(prepare: (v: Vehicle) => void): Promise<number> {
  const { v, tick } = await runway();
  prepare(v);
  v.teleport({ position: new Vector3(-150, 1, 9800), quaternion: new Quaternion() });
  let top = 0;
  for (let i = 0; i < 60 * 60 && v.position.z > -9800; i++) {
    tick({ throttle: 1 });
    top = Math.max(top, v.speedKmh);
  }
  return top;
}

// --- 1. crash debris ----------------------------------------------------------
console.log('Crash debris');
{
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, loadLayout('monza'), { treesPerKm: 0 });
  const a = new Vehicle(physics, car.physics, car.createVisual(), track.getResetPose(track.getCenterline()[300]), car.gearbox);
  const pose = track.getResetPose(a.position);
  const dir = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion).applyAxisAngle(new Vector3(0, 1, 0), (-80 * Math.PI) / 180);
  a.physics.body.setRotation(new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir), true);
  const vel = dir.multiplyScalar(200 / 3.6);
  a.physics.body.setLinvel({ x: vel.x, y: 0, z: vel.z }, true);
  const debris = new DebrisField(1);
  const byCollider = new Map([[a.physics.collider.handle, a]]);
  // As in the game: the car is in a scene, its visual drops the wing and hands the mesh to the debris.
  // (The F1 model needs a browser canvas for its livery; this stand-in does what its wing code does.)
  const scene = new Scene();
  scene.add(a.object3D);
  let dropped: Object3D | null = null;
  a.visual.setDamage = (front) => {
    if (front >= DETACH && !dropped) scene.add((dropped = new Group()));
  };
  a.visual.takeDetachedWing = () => {
    const w = dropped;
    dropped = null;
    return w;
  };
  for (let k = 0; k < 240; k++) {
    a.fixedUpdate(IDLE, dt);
    physics.step();
    a.snapshot();
    applyImpacts(physics, byCollider, dt, (v, _hit, before) => {
      v.visual.setDamage?.(v.damage.front, v.damage.rear);
      for (const piece of debris.onDamage(v, before)) if (piece.kind === 'wing') piece.object = v.visual.takeDetachedWing?.() ?? undefined;
    });
    debris.step([a], dt);
  }
  const wings = debris.pieces.filter((p) => p.kind === 'wing').length;
  const shards = debris.pieces.filter((p) => p.kind === 'shard').length;
  check(wings === 1 && shards >= 1, `head-on at 200 km/h: front wing ${(a.damage.front * 100).toFixed(0)} %, ${wings} wing and ${shards} shards on the track`);
  const settled = debris.pieces.every((p) => Math.hypot(p.velocity.x, p.velocity.z) < 0.1);
  const near = debris.pieces.every((p) => p.position.distanceTo(a.position) < 60);
  check(settled && near, 'pieces skid to a stop near the crash');
  const wing = debris.pieces.find((p) => p.kind === 'wing');
  check(!!wing?.object && wing.object.parent === scene, 'the car model handed its broken wing mesh to the debris');
  const mesh = new DebrisMesh(debris);
  mesh.update();
  check(!!wing?.object && wing.object.position.distanceTo(wing.position) < 0.2, 'the wing mesh lies where the piece is');
  debris.clear();
  mesh.update();
  check(!wing?.object?.parent, 'cleared: the wing mesh is taken off the track');
}

// --- 2. driving through shards ---------------------------------------------------
console.log('Running over shards');
{
  let slides = 0;
  let punctures = 0;
  for (let run = 0; run < 20; run++) {
    const { v, tick } = await runway();
    const debris = new DebrisField(100 + run);
    while (v.speedKmh < 150) tick({ throttle: 1 });
    // A spray of shards across the car's path 40-80 m ahead.
    for (let k = 0; k < 12; k++) {
      debris.pieces.push({ kind: 'shard', position: new Vector3(v.position.x - 1.6 + (k % 6) * 0.65, v.position.y - 0.6, v.position.z - 40 - k * 3.5), velocity: new Vector3(), yaw: 0, spin: 0, age: 0, hitBy: new Set(), color: 0x222222 });
    }
    for (let i = 0; i < 120; i++) {
      tick({ throttle: 1 });
      debris.step([v], dt, (e) => {
        if (e.kind === 'slide') slides++;
        if (e.kind === 'puncture') punctures++;
      });
    }
  }
  check(slides > 20, `20 runs through 12 shards at 150 km/h: ${slides} tyre slides`);
  check(punctures >= 1 && punctures <= 12, `${punctures} punctures (a cut now and then, not every time)`);
}

// --- 3. puncture ------------------------------------------------------------------
console.log('Puncture');
{
  const healthy = await skidpad(() => {});
  const flat = await skidpad((v) => v.tyres.puncture(0));
  check(flat < healthy * 0.9, `120 km/h corner: ${healthy.toFixed(2)} g healthy, ${flat.toFixed(2)} g with a punctured front-left`);
}

// --- 4. bodywork damage: downforce and top speed -------------------------------------
console.log('Bodywork damage');
{
  const intact = await skidpad(() => {}, 230, 0.4);
  const floor = await skidpad((v) => (v.damage.floor = 1), 230, 0.4);
  check(floor < intact * 0.92, `230 km/h corner: ${intact.toFixed(2)} g intact, ${floor.toFixed(2)} g with a broken floor`);
  const top0 = await topSpeed(() => {});
  const top1 = await topSpeed((v) => {
    v.damage.front = 0.5;
    v.damage.floor = 0.6;
  });
  // A ratio, not km/h: floor damage also takes downforce, and with it some rolling resistance.
  check(top1 < top0 * 0.99, `top speed ${top0.toFixed(0)} km/h intact, ${top1.toFixed(0)} km/h with a bent wing and torn floor`);
}

// --- 5. running over a wing ----------------------------------------------------------
console.log('Running over a wing');
{
  const { v, tick } = await runway();
  const debris = new DebrisField(7);
  while (v.speedKmh < 120) tick({ throttle: 1 });
  debris.pieces.push({ kind: 'wing', position: new Vector3(v.position.x, v.position.y - 0.6, v.position.z - 50), velocity: new Vector3(), yaw: 0, spin: 0, age: 0, hitBy: new Set(), color: 0xd40000 });
  for (let i = 0; i < 120; i++) {
    tick({ throttle: 1 });
    debris.step([v], dt);
  }
  check(v.damage.floor > 0.1, `floor damage ${(v.damage.floor * 100).toFixed(0)} % after driving over a front wing`);
}

// --- 6. AI avoids a wing on its line --------------------------------------------------
console.log('AI avoids debris');
{
  const physics = await PhysicsWorld.create(dt);
  const track = new ProceduralTrack(physics, loadLayout('monza'), { treesPerKm: 0 });
  const path = racingLineFor(track);
  const line = new RacingLine(path, car.physics);
  const start = 40;
  const v = new Vehicle(physics, car.physics, car.createVisual(), track.getResetPose(line.points[start]), car.gearbox);
  const ai = new AIDriver(v, line, track, { pace: 0.95, lane: 0, aggression: 0.5 });
  const debris = new DebrisField(3);
  ai.debris = debris;
  // A wing on the racing line ~250 m ahead (on the main straight).
  let d = 0;
  let j = start;
  while (d < 250) d += line.segmentLength(j++);
  const at = line.points[j];
  debris.pieces.push({ kind: 'wing', position: new Vector3(at.x, at.y, at.z), velocity: new Vector3(), yaw: 0, spin: 0, age: 0, hitBy: new Set(), color: 0x1e2a5a });
  const others = [v];
  let passed = false;
  for (let i = 0; i < 60 * 20 && !passed; i++) {
    v.fixedUpdate(ai.update(dt, others), dt);
    physics.step();
    v.snapshot();
    debris.step(others, dt);
    passed = v.position.distanceTo(at) > 60 && line.nearestFrom(v.position, j) > j && line.nearestFrom(v.position, j) < j + 200;
  }
  check(passed && !debris.pieces[0].hitBy.has(v), `AI car ${passed ? 'passed' : 'did not pass'} the wing ${debris.pieces[0].hitBy.has(v) ? 'and hit it' : 'without touching it'}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
