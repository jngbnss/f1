import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { addBuilding, BuildingSoup, buildingMaterial } from './Buildings';
import type { TribuneSpec } from './Crowd';
import { buildProps, OccupancyGrid, woodsLookup, type WoodsMask } from './Props';

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
  /** Satellite canopy mask (optional, see scripts/bake-woods.ts). */
  woods?: WoodsMask;
}

export interface SceneryContext {
  /** Distance (m) from (x, z) to the nearest point of the circuit centerline. */
  clearance(x: number, z: number): number;
  /** Distance (m) to the circuit anywhere (coarse); falls back to `clearance`. */
  distance?(x: number, z: number): number;
  /** Nothing may be placed closer to the centerline than this (barrier line + margin). */
  minClearance: number;
  /** Footprints touching these points are left out (replaced by the game's own buildings). */
  exclude?(x: number, z: number): boolean;
  /** Nearest point on the circuit centerline. */
  nearestPoint(x: number, z: number): { x: number; z: number };
  /** Shared (texturable) asphalt material for car parks and roads. */
  asphalt: THREE.Material;
  rand: () => number;
}

export interface SceneryResult {
  group: THREE.Group;
  /** Tree positions inside OSM forests. */
  trees: [number, number][];
  /** Real grandstands (OSM building=grandstand), turned into seated tribunes by the track. */
  grandstands: TribuneSpec[];
  disposables: { dispose(): void }[];
  stats: { buildings: number; forests: number; roads: number };
}

/** One tree per this many m² of forest (capped): park woodland, impostor trees are cheap. */
const FOREST_DENSITY = 45;
const MAX_FOREST_TREES = 40000;

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

export function buildOsmScenery(data: OsmData, ctx: SceneryContext): SceneryResult {
  const group = new THREE.Group();
  group.name = 'OsmScenery';
  const disposables: { dispose(): void }[] = [];
  const clear = (pts: [number, number][], margin = 0) => pts.every(([x, z]) => ctx.clearance(x, z) > ctx.minClearance + margin);

  // --- buildings: real architecture (Buildings.ts) merged per 300 m tile ------
  // (one mesh per tile so the camera and shadow camera can cull them)
  const TILE = 300;
  const tiles = new Map<string, BuildingSoup>();
  let buildingCount = 0;
  const grandstands: TribuneSpec[] = [];
  const footprints: [number, number][][] = [];
  for (const b of data.buildings) {
    const h = b[0];
    const kind = b[1];
    const pts = pairs(b, 2);
    if (pts.length < 3 || !clear(pts, 2)) continue;
    if (ctx.exclude && pts.some(([x, z]) => ctx.exclude!(x, z))) continue;
    if (kind === 1) {
      const spec = tribuneFromFootprint(pts, h, ctx);
      if (spec) {
        grandstands.push(spec);
        continue;
      }
    }
    const key = `${Math.floor(pts[0][0] / TILE)},${Math.floor(pts[0][1] / TILE)}`;
    let soup = tiles.get(key);
    if (!soup) tiles.set(key, (soup = new BuildingSoup()));
    if (addBuilding(soup, pts, h, kind, ctx.rand)) {
      footprints.push(pts);
      buildingCount++;
    }
  }
  if (tiles.size) {
    const mat = buildingMaterial();
    disposables.push(mat);
    for (const [key, soup] of tiles) {
      if (soup.empty) continue;
      const geo = soup.build();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `OsmBuildings[${key}]`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      disposables.push(geo);
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
      if (!inside(pts, x, z) || ctx.clearance(x, z) < ctx.minClearance + 4 || ctx.exclude?.(x, z)) continue;
      trees.push([x, z]);
      placed++;
    }
  }

  // --- the rest of the land: satellite woods, street trees, cars, lamps, bushes ---
  let gx0 = Infinity;
  let gz0 = Infinity;
  let gx1 = -Infinity;
  let gz1 = -Infinity;
  const grow = (x: number, z: number) => {
    gx0 = Math.min(gx0, x);
    gx1 = Math.max(gx1, x);
    gz0 = Math.min(gz0, z);
    gz1 = Math.max(gz1, z);
  };
  for (const r of data.roads) for (const [x, z] of pairs(r, 1)) grow(x, z);
  for (const b of footprints) for (const [x, z] of b) grow(x, z);
  if (data.woods) {
    grow(data.woods.rect[0], data.woods.rect[1]);
    grow(data.woods.rect[2], data.woods.rect[3]);
  }
  if (Number.isFinite(gx0)) {
    const grid = new OccupancyGrid(gx0 - 10, gz0 - 10, gx1 + 10, gz1 + 10);
    for (const b of footprints) grid.polygon(b, 3);
    for (const ring of [...data.parking, ...data.water]) grid.polygon(pairs(ring), 2);
    for (const r of data.roads) {
      const pts = pairs(r, 1);
      for (let i = 0; i + 1 < pts.length; i++) grid.segment(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r[0] / 2 + 1.5);
    }
    // OSM forests already have their trees.
    for (const f of data.forests) grid.polygon(pairs(f), 0);
    const props = buildProps(
      {
        parking: data.parking.map((r) => pairs(r)),
        roads: data.roads.map((r) => ({ width: r[0], pts: pairs(r, 1) })),
        woods: data.woods ? woodsLookup(data.woods) : null,
        bounds: data.woods ? data.woods.rect : [gx0, gz0, gx1, gz1],
        grid,
      },
      { clearance: ctx.clearance, distance: ctx.distance ?? ctx.clearance, minClearance: ctx.minClearance, exclude: ctx.exclude, rand: ctx.rand },
    );
    group.add(props.group);
    disposables.push(...props.disposables);
    trees.push(...props.trees);
  }

  return { group, trees, grandstands, disposables, stats: { buildings: buildingCount, forests: data.forests.length, roads: roadCount } };
}

/** Oriented footprint of a grandstand -> tribune facing the nearest part of the circuit. */
function tribuneFromFootprint(pts: [number, number][], height: number, ctx: SceneryContext): TribuneSpec | null {
  // Long axis = longest edge.
  let ux = 1;
  let uz = 0;
  let longest = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    const l = Math.hypot(x1 - x0, z1 - z0);
    if (l > longest) {
      longest = l;
      ux = (x1 - x0) / l;
      uz = (z1 - z0) / l;
    }
  }
  const vx = -uz;
  const vz = ux;
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const [x, z] of pts) {
    const u = x * ux + z * uz;
    const v = x * vx + z * vz;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const length = u1 - u0;
  const depth = Math.min(40, Math.max(6, v1 - v0));
  if (length < 8) return null;
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  const cx = ux * cu + vx * cv;
  const cz = uz * cu + vz * cv;
  // Front (local -X) = the short-axis direction pointing at the track.
  const near = ctx.nearestPoint(cx, cz);
  const side = Math.sign((near.x - cx) * vx + (near.z - cz) * vz) || 1;
  const fx = vx * side;
  const fz = vz * side;
  return {
    x: cx,
    z: cz,
    yaw: Math.atan2(fz, -fx),
    length,
    depth,
    height: Math.min(Math.max(height, 6), depth * 0.7, 25),
  };
}
