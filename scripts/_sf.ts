import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';
const physics = await PhysicsWorld.create(1 / 60);
const track = new ProceduralTrack(physics, loadLayout('spa'), { treesPerKm: 0 });
const c = track.getCenterline(); const r = track.getRights();
for (const i of [2470, 2480, 2490, 2500]) {
  const row: string[] = [];
  for (const lat of [-6, -7, -7.5, -8, -8.5, -9, -10]) {
    const p = c[i].clone().addScaledVector(r[i], lat);
    const hit = physics.world.castRay(new (physics as any).rapier.Ray({ x: p.x, y: p.y + 3, z: p.z }, { x: 0, y: -1, z: 0 }), 4, true);
    row.push(`${lat}:${track.surfaceAt(p)}${hit ? '@' + (3 - hit.timeOfImpact).toFixed(2) : ''}`);
  }
  console.log(i, row.join('  '));
}
