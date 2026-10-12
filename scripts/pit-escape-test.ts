/**
 * Pit takeover check: the pit controller must only take a car that actually
 * turns into the pit entry, and must hand control back when the car ends up
 * well off the pit line (pushed off, spun into the grass), instead of steering
 * it into the walls with the driver locked out.
 *
 *   npx tsx scripts/pit-escape-test.ts [monza|spa|...]
 */
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { PitStops } from '../src/race/PitStops';
import { findCar } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';

const dt = 1 / 60;
const trackId = process.argv[2] ?? 'monza';
const physics = await PhysicsWorld.create(dt);
const track = new ProceduralTrack(physics, loadLayout(trackId), { treesPerKm: 0, pitBoxColors: new Array(10).fill(0xffffff) });
const pit = track.pit;
if (!pit) throw new Error('no pit lane');
const car = findCar('f1-ferrari');
const v = new Vehicle(physics, car.physics, car.createVisual(), track.getSpawnPose(), car.gearbox);
const C = track.getCenterline();
const R = track.getRights();
const UP = new THREE.Vector3(0, 1, 0);

/** Put the car at a centreline sample, `lateral` m to the pit side (negative: away), facing along the track. */
function place(i: number, lateral: number): void {
  const n = C.length;
  const t = C[(i + 1) % n].clone().sub(C[(i - 1 + n) % n]);
  const pos = C[i].clone().addScaledVector(R[i], pit!.side * lateral);
  v.teleport({ position: pos.setY(pos.y + 0.5), quaternion: new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(-t.x, -t.z)) });
  physics.step();
  v.snapshot();
}

const results: [string, boolean][] = [];
const entry = pit.pathIndex[4];

// A: far side of the track at the entry: taken in all the same (F1-game style), and not let go
// while the pit driver brings it across to the lane.
let pits = new PitStops(pit, track, () => 2);
pits.request(v, 'hard', 0);
place(entry, -(track.halfWidth - 1.5));
let held = true;
for (let n = 0; n < 240; n++) {
  const inp = pits.update(v, dt);
  if (!inp) held = false;
  v.fixedUpdate(inp ?? { throttle: 0, brake: 0, steer: 0, handbrake: 0 }, dt);
  physics.step();
  v.snapshot();
}
results.push(['far side of the track is taken in and steered across', held && pits.phase(v) === 'in']);

// B: in the grass on the far side: no takeover.
pits = new PitStops(pit, track, () => 2);
pits.request(v, 'hard', 0);
place(entry, -(track.halfWidth + 6));
pits.update(v, dt);
results.push(['grass on the far side is not taken into the pits', pits.phase(v) === 'requested']);

// C: on the pit side at the entry: taken in.
pits = new PitStops(pit, track, () => 2);
pits.request(v, 'hard', 0);
place(entry, 5.5);
pits.update(v, dt);
results.push(['pit side of the entry is taken into the pits', pits.phase(v) === 'in']);

// D: pushed 10 m off the pit line after the takeover: the driver gets the car back.
const k = 24;
const i = pit.pathIndex[k];
const off = pit.path[k].distanceTo(C[i]);
place(i, off - 10);
const input = pits.update(v, dt);
results.push(['10 m off the pit line hands control back', input === null && !pits.driving(v)]);
results.push(['…and the stop stays requested for the next lap', pits.phase(v) === 'requested']);

for (const [name, ok] of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
const ok = results.every(([, r]) => r);
console.log(ok ? 'PIT ESCAPE OK' : 'PIT ESCAPE FAIL');
process.exit(ok ? 0 : 1);
