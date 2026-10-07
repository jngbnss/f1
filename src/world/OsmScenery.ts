import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Real-world surroundings from OpenStreetMap, pre-aligned to the track frame
 * by scripts/fetch-osm.ts. All coordinates are world [x, z] pairs, flattened.
 */
export interface OsmData {
  attribution: string;
  /** [height, kind (0 generic, 1 grandstand, 2 house), x0, z0, x1, z1, ...] (open ring) */
  buildings: number[][];
  /** Open rings. */
  forests: number[][];
  water: number[][];
  parking: number[][];
  /** [width, x0, z0, x1, z1, ...] polyline */
  roads: number[][];
}

export interface SceneryContext {
  /** Distance (m) from (x, z) to the nearest point of the circuit centerline. */
  clearance(x: number, z: number): number;
  /** Nothing may be placed closer to the centerline than this (barrier line + margin). */
  minClearance: number;
  /** Shared (texturable) asphalt material for car parks and roads. */
  asphalt: THREE.Material;
  rand: () => number;
}

export interface SceneryResult {
  group: THREE.Group;
  /** Tree positions inside OSM forests. */
  trees: [number, number][];
  disposables: { dispose(): void }[];
  stats: { buildings: number; forests: number; roads: number };
}

const WALLS = [0xd8d2c4, 0xc9c2b5, 0xe6e1d6, 0xb9b5ad, 0xd4cbbb];
const HOUSE_WALLS = [0xe8dcc8, 0xd9c6a5, 0xf0e6d6];
const ROOF = 0x6b6e72;
const HOUSE_ROOF = 0x9c4a32;
const STAND_WALL = 0x9aa4ae;
const STAND_ROOF = 0xdadde0;
/** One tree per this many m² of forest (capped). */
const FOREST_DENSITY = 140;
const MAX_FOREST_TREES = 7000;

function pairs(flat: number[], start = 0): [number, number][] {
  const out: [number, number][] = [];
  for (let i = start; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

/** Shape in the XY plane with y = -z, so rotateX(-π/2) lays it on the ground. */
function shapeOf(pts: [number, number][]): THREE.Shape {
  return new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
}

function polygonArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    a += x0 * z1 - x1 * z0;
  }
  return Math.abs(a) / 2;
}

function inside(pts: [number, number][], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

function colorize(geo: THREE.BufferGeometry, wall: THREE.Color, roof: THREE.Color): void {
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  // ExtrudeGeometry groups: 0 = caps (roof/floor), 1 = side walls.
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count, materialIndex: 1 }];
  for (const g of groups) {
    const c = g.materialIndex === 0 ? roof : wall;
    for (let i = g.start; i < g.start + g.count; i++) {
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.clearGroups();
}

export function buildOsmScenery(data: OsmData, ctx: SceneryContext): SceneryResult {
  const group = new THREE.Group();
  group.name = 'OsmScenery';
  const disposables: { dispose(): void }[] = [];
  const clear = (pts: [number, number][], margin = 0) => pts.every(([x, z]) => ctx.clearance(x, z) > ctx.minClearance + margin);

  // --- buildings: extruded footprints merged into one draw call ----------
  const buildingGeos: THREE.BufferGeometry[] = [];
  const wall = new THREE.Color();
  const roof = new THREE.Color();
  for (const b of data.buildings) {
    const h = b[0];
    const kind = b[1];
    const pts = pairs(b, 2);
    if (pts.length < 3 || !clear(pts, 2)) continue;
    const geo = new THREE.ExtrudeGeometry(shapeOf(pts), { depth: h, bevelEnabled: false, curveSegments: 1 });
    geo.rotateX(-Math.PI / 2);
    geo.deleteAttribute('uv');
    const r = ctx.rand();
    if (kind === 1) {
      wall.set(STAND_WALL);
      roof.set(STAND_ROOF);
    } else if (kind === 2) {
      wall.set(HOUSE_WALLS[Math.floor(r * HOUSE_WALLS.length)]);
      roof.set(HOUSE_ROOF);
    } else {
      wall.set(WALLS[Math.floor(r * WALLS.length)]);
      roof.set(ROOF);
    }
    colorize(geo, wall, roof);
    buildingGeos.push(geo);
  }
  if (buildingGeos.length) {
    const merged = mergeGeometries(buildingGeos, false);
    for (const g of buildingGeos) g.dispose();
    if (merged) {
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = 'OsmBuildings';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      disposables.push(merged, mat);
    }
  }

  // --- flat areas: water, car parks ------------------------------------------
  const flatAreas = (rings: number[][], y: number, material: THREE.Material, name: string, margin: number) => {
    const geos: THREE.BufferGeometry[] = [];
    for (const ring of rings) {
      const pts = pairs(ring);
      if (pts.length < 3 || !clear(pts, margin)) continue;
      const geo = new THREE.ShapeGeometry(shapeOf(pts));
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, y, 0);
      // UVs in meters (x, z) for tiling textures.
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i));
      geos.push(geo);
    }
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(merged);
  };
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x2d5a78, roughness: 0.06, metalness: 0.2 });
  disposables.push(waterMat);
  flatAreas(data.water, 0.03, waterMat, 'OsmWater', 0);
  flatAreas(data.parking, 0.01, ctx.asphalt, 'OsmParking', 1);

  // --- roads: simple quads per segment, skipping parts near the circuit -----
  const positions: number[] = [];
  const uvs: number[] = [];
  let roadCount = 0;
  for (const r of data.roads) {
    const w = r[0] / 2;
    const pts = pairs(r, 1);
    let dist = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.01) continue;
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      if (
        ctx.clearance(x0, z0) < ctx.minClearance + w ||
        ctx.clearance(x1, z1) < ctx.minClearance + w ||
        ctx.clearance(mx, mz) < ctx.minClearance + w
      ) {
        dist += len;
        continue;
      }
      // Right vector on the ground plane (dz, -dx) / len.
      const rx = ((z1 - z0) / len) * w;
      const rz = (-(x1 - x0) / len) * w;
      const quad = [
        [x0 - rx, z0 - rz, -w, dist],
        [x0 + rx, z0 + rz, w, dist],
        [x1 - rx, z1 - rz, -w, dist + len],
        [x1 + rx, z1 + rz, w, dist + len],
      ];
      for (const k of [0, 2, 1, 1, 2, 3]) {
        positions.push(quad[k][0], 0.008, quad[k][1]);
        uvs.push(quad[k][2], quad[k][3]);
      }
      dist += len;
      roadCount++;
    }
  }
  if (positions.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    // Force upward normals (winding varies with segment direction).
    const normals = new Float32Array(positions.length);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    const mesh = new THREE.Mesh(geo, ctx.asphalt);
    mesh.name = 'OsmRoads';
    mesh.receiveShadow = true;
    // Roads are drawn as quads regardless of winding.
    (mesh.material as THREE.Material).side = THREE.DoubleSide;
    group.add(mesh);
    disposables.push(geo);
  }

  // --- forests: tree positions scattered inside polygons --------------------
  const trees: [number, number][] = [];
  const totalArea = data.forests.reduce((a, f) => a + polygonArea(pairs(f)), 0);
  const thin = Math.max(1, totalArea / FOREST_DENSITY / MAX_FOREST_TREES);
  for (const f of data.forests) {
    const pts = pairs(f);
    if (pts.length < 3) continue;
    const n = Math.round(polygonArea(pts) / FOREST_DENSITY / thin);
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const [x, z] of pts) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    for (let k = 0, placed = 0; k < n * 4 && placed < n; k++) {
      const x = x0 + ctx.rand() * (x1 - x0);
      const z = z0 + ctx.rand() * (z1 - z0);
      if (!inside(pts, x, z) || ctx.clearance(x, z) < ctx.minClearance + 4) continue;
      trees.push([x, z]);
      placed++;
    }
  }

  return { group, trees, disposables, stats: { buildings: buildingGeos.length, forests: data.forests.length, roads: roadCount } };
}
