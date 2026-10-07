/**
 * Prints render cost per object of a circuit scene (no GPU needed):
 *   npx tsx scripts/scene-stats.ts monza
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import type { OsmData } from '../src/world/OsmScenery';
import { ProceduralTrack } from '../src/world/Track';
import { DEMO_TRACK, parseTumCsv } from '../src/world/TrackLayout';

const files: Record<string, [string, string]> = {
  spielberg: ['Red Bull Ring', 'Spielberg'],
  monza: ['Monza', 'Monza'],
  silverstone: ['Silverstone', 'Silverstone'],
  spa: ['Spa-Francorchamps', 'Spa'],
};
const id = process.argv[2] ?? 'monza';
const read = (f: string) => readFileSync(new URL(`../src/world/tracks/data/${f}`, import.meta.url), 'utf8');
let layout = DEMO_TRACK;
if (files[id]) {
  const [name, file] = files[id];
  layout = parseTumCsv(id, name, read(`${file}.csv`), read(`${file}_raceline.csv`));
  layout.scenery = JSON.parse(read(`${file}_osm.json`)) as OsmData;
}
const t0 = performance.now();
const physics = await PhysicsWorld.create(1 / 60);
const track = new ProceduralTrack(physics, layout, { treesPerKm: 300, scenery: layout.scenery });
console.log(`build ${(performance.now() - t0).toFixed(0)} ms, spectators ${track.spectatorCount}`);

const spawn = track.getSpawnPose().position;
const VIEW = 1100; // camera far / fog end
const SHADOW = 90; // shadow camera footprint around the car
let all = 0;
let view = 0;
let shadow = 0;
let drawsView = 0;
const sphere = new THREE.Sphere();
track.root.updateMatrixWorld(true);
const tris = (m: THREE.Mesh) => {
  const g = m.geometry as THREE.BufferGeometry;
  const per = (g.index ? g.index.count : g.attributes.position.count) / 3;
  return per * (m instanceof THREE.InstancedMesh ? m.count : 1);
};
const visit = (m: THREE.Mesh) => {
  const t = tris(m);
  all += t;
  if (m instanceof THREE.InstancedMesh) {
    m.computeBoundingSphere();
    sphere.copy(m.boundingSphere!).applyMatrix4(m.matrixWorld);
  } else {
    m.geometry.computeBoundingSphere();
    sphere.copy(m.geometry.boundingSphere!).applyMatrix4(m.matrixWorld);
  }
  const d = Math.max(0, sphere.center.distanceTo(spawn) - sphere.radius);
  if (d < VIEW) {
    view += t;
    drawsView++;
  }
  if (m.castShadow && d < SHADOW) shadow += t;
};
track.root.traverse((o) => {
  if (o instanceof THREE.LOD) {
    // pick the level the camera (≈ spawn) would use
    const d = o.getWorldPosition(new THREE.Vector3()).distanceTo(spawn);
    let level = o.levels[0];
    for (const l of o.levels) if (d >= l.distance) level = l;
    o.levels.forEach((l) => (l.object.userData.skip = l !== level));
  }
});
track.root.traverse((o) => {
  if (o instanceof THREE.Mesh && !o.userData.skip) visit(o);
});
console.log(`all geometry ${Math.round(all).toLocaleString()} tris`);
console.log(`within view distance: ${Math.round(view).toLocaleString()} tris in ${drawsView} draws (upper bound, before frustum culling)`);
console.log(`shadow pass near car: ${Math.round(shadow).toLocaleString()} tris`);
console.log(`colliders ${physics.world.colliders.len()}`);
