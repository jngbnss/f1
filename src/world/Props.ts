import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Fills the land around a circuit so it reads as a lived-in place rather
 * than a lawn: woods where the satellite image shows canopy, street trees,
 * bushes along wood edges, parked cars in the car parks, lamp posts along
 * the roads. Small props are merged into plain meshes per tile (so they
 * follow the real terrain when the scenery is draped) and only drawn near
 * the camera (`userData.cullDistance`, honoured by the track's culling).
 */

/** Satellite canopy mask baked by scripts/bake-woods.ts. */
export interface WoodsMask {
  rect: [number, number, number, number];
  cell: number;
  w: number;
  h: number;
  /** base64 bitmask, row-major (z rows). */
  bits: string;
}

/** Coarse occupancy raster: buildings, roads, car parks, water. */
export class OccupancyGrid {
  readonly cell = 3;
  private readonly x0: number;
  private readonly z0: number;
  private readonly w: number;
  private readonly h: number;
  private readonly data: Uint8Array;

  constructor(x0: number, z0: number, x1: number, z1: number) {
    this.x0 = x0;
    this.z0 = z0;
    this.w = Math.ceil((x1 - x0) / this.cell);
    this.h = Math.ceil((z1 - z0) / this.cell);
    this.data = new Uint8Array(this.w * this.h);
  }

  private index(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((z - this.z0) / this.cell);
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? -1 : j * this.w + i;
  }

  blocked(x: number, z: number): boolean {
    const k = this.index(x, z);
    return k >= 0 && this.data[k] !== 0;
  }

  /** Marks a disc. */
  disc(x: number, z: number, r: number): void {
    for (let dz = -r; dz <= r; dz += this.cell)
      for (let dx = -r; dx <= r; dx += this.cell) {
        if (dx * dx + dz * dz > r * r + this.cell) continue;
        const k = this.index(x + dx, z + dz);
        if (k >= 0) this.data[k] = 1;
      }
  }

  /** Marks a thick polyline segment. */
  segment(x0: number, z0: number, x1: number, z1: number, r: number): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.ceil(len / this.cell));
    for (let k = 0; k <= n; k++) this.disc(x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n, r);
  }

  /** Marks a polygon (plus margin). */
  polygon(pts: [number, number][], margin: number): void {
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
    // Scanline fill: crossings of each cell-row centre line with the edges.
    const xs: number[] = [];
    for (let j = Math.max(0, Math.floor((z0 - this.z0) / this.cell)); j <= Math.min(this.h - 1, Math.floor((z1 - this.z0) / this.cell)); j++) {
      const z = this.z0 + (j + 0.5) * this.cell;
      xs.length = 0;
      for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
        const [xa, za] = pts[a];
        const [xb, zb] = pts[b];
        if (za > z !== zb > z) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.floor((xs[k] - this.x0) / this.cell));
        const i1 = Math.min(this.w - 1, Math.floor((xs[k + 1] - this.x0) / this.cell));
        this.data.fill(1, j * this.w + i0, j * this.w + i1 + 1);
      }
    }
    if (margin > 0) for (let i = 0; i < pts.length; i++) this.segment(pts[i][0], pts[i][1], pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1], margin);
  }
}

export function pointInPolygon(pts: [number, number][], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** Decodes the canopy mask into a lookup. */
export function woodsLookup(mask: WoodsMask): (x: number, z: number) => boolean {
  const bin = atob(mask.bits);
  const bits = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bits[i] = bin.charCodeAt(i);
  const [x0, z0] = mask.rect;
  return (x, z) => {
    const i = Math.floor((x - x0) / mask.cell);
    const j = Math.floor((z - z0) / mask.cell);
    if (i < 0 || j < 0 || i >= mask.w || j >= mask.h) return false;
    const k = j * mask.w + i;
    return (bits[k >> 3] & (1 << (k & 7))) !== 0;
  };
}

/** Geometry pieces with a vertex colour, merged later. */
function colored(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Templates (unit placement: origin on the ground, +Z forward). */
function carTemplate(paint: number): THREE.BufferGeometry {
  const parts = [
    colored(new THREE.BoxGeometry(1.75, 0.62, 4.3).translate(0, 0.52, 0), paint),
    colored(new THREE.BoxGeometry(1.55, 0.5, 2.2).translate(0, 1.07, -0.25), 0x22282e),
    colored(new THREE.BoxGeometry(1.5, 0.06, 2.0).translate(0, 1.35, -0.25), paint),
    colored(new THREE.CylinderGeometry(0.32, 0.32, 1.8, 6, 1, true).rotateZ(Math.PI / 2).translate(0, 0.32, 1.35), 0x111111),
    colored(new THREE.CylinderGeometry(0.32, 0.32, 1.8, 6, 1, true).rotateZ(Math.PI / 2).translate(0, 0.32, -1.35), 0x111111),
  ];
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

function vanTemplate(paint: number): THREE.BufferGeometry {
  const parts = [
    colored(new THREE.BoxGeometry(2.0, 2.1, 5.4).translate(0, 1.35, 0), paint),
    colored(new THREE.BoxGeometry(1.9, 0.6, 0.1).translate(0, 1.85, 2.71), 0x22282e),
    colored(new THREE.CylinderGeometry(0.35, 0.35, 2.0, 6, 1, true).rotateZ(Math.PI / 2).translate(0, 0.35, 1.8), 0x111111),
    colored(new THREE.CylinderGeometry(0.35, 0.35, 2.0, 6, 1, true).rotateZ(Math.PI / 2).translate(0, 0.35, -1.8), 0x111111),
  ];
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

function lampTemplate(): THREE.BufferGeometry {
  const parts = [
    colored(new THREE.CylinderGeometry(0.07, 0.1, 8, 6).translate(0, 4, 0), 0x50565c),
    colored(new THREE.BoxGeometry(0.08, 0.08, 1.6).translate(0, 7.9, 0.75), 0x50565c),
    colored(new THREE.BoxGeometry(0.35, 0.12, 0.6).translate(0, 7.84, 1.5), 0xd8d8d0),
  ];
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

/** Shrub: three overlapping lumpy blobs (lumps keyed by position so faces stay closed). */
function bushTemplate(color: number, rand: () => number): THREE.BufferGeometry {
  const blobs = [
    [0, 0, 0, 1],
    [0.8, 0, 0.3, 0.75],
    [-0.6, 0, -0.5, 0.7],
  ].map(([ox, , oz, s]) => {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const seed = rand() * 100;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const k = 0.85 + 0.25 * Math.abs(Math.sin(x * 5.1 + y * 3.7 + z * 4.3 + seed));
      pos.setXYZ(i, x * k * s + ox, Math.max(-0.15, y) * k * s * 0.8 + 0.5 * s, z * k * s + oz);
    }
    return colored(g, color);
  });
  const g = mergeGeometries(blobs)!;
  blobs.forEach((b) => b.dispose());
  return g;
}

export interface PropsContext {
  clearance(x: number, z: number): number;
  /** Coarse distance to the circuit anywhere. */
  distance(x: number, z: number): number;
  minClearance: number;
  /** Areas reserved for the game's own buildings (paddock). */
  exclude?(x: number, z: number): boolean;
  rand: () => number;
}

/** Merged-per-tile collector for templated props. */
class TileMerger {
  private readonly tiles = new Map<string, THREE.BufferGeometry[]>();
  count = 0;
  constructor(private readonly tile: number) {}

  add(template: THREE.BufferGeometry, x: number, z: number, yaw: number, scale = 1): void {
    const g = template.clone();
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(scale, scale, scale));
    g.applyMatrix4(m);
    const key = `${Math.floor(x / this.tile)},${Math.floor(z / this.tile)}`;
    let list = this.tiles.get(key);
    if (!list) this.tiles.set(key, (list = []));
    list.push(g);
    this.count++;
  }

  build(group: THREE.Group, material: THREE.Material, name: string, cullDistance: number, castShadow: boolean, disposables: { dispose(): void }[]): void {
    for (const [key, geos] of this.tiles) {
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${name}[${key}]`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.userData.cullDistance = cullDistance;
      group.add(mesh);
      disposables.push(merged);
    }
  }
}

const CAR_PAINTS = [0xf2f2f2, 0x1c1c1e, 0x8a8f96, 0xb7bcc2, 0x2a4d8f, 0x9b1b1b, 0x3c5c3a, 0xd9d4c7, 0x5a6470, 0xe0e0e0, 0x23262b, 0x7b2d26];

export interface PropsInput {
  parking: [number, number][][];
  roads: { width: number; pts: [number, number][] }[];
  woods: ((x: number, z: number) => boolean) | null;
  /** Bounds for woods planting (world rect). */
  bounds: [number, number, number, number];
  grid: OccupancyGrid;
}

export function buildProps(input: PropsInput, ctx: PropsContext): { group: THREE.Group; trees: [number, number][]; disposables: { dispose(): void }[] } {
  const group = new THREE.Group();
  group.name = 'Props';
  const disposables: { dispose(): void }[] = [];
  const trees: [number, number][] = [];
  const rand = ctx.rand;
  const { grid } = input;
  const freeLand = (x: number, z: number, margin: number) =>
    !grid.blocked(x, z) && ctx.clearance(x, z) > ctx.minClearance + margin && !(ctx.exclude?.(x, z) ?? false);

  // --- woods from the satellite canopy mask ----------------------------------
  if (input.woods) {
    const [x0, z0, x1, z1] = input.bounds;
    const step = 6.5; // ~ one tree per 42 m²: closed canopy
    for (let z = z0; z < z1; z += step)
      for (let x = x0; x < x1; x += step) {
        const px = x + (rand() - 0.5) * step * 0.9;
        const pz = z + (rand() - 0.5) * step * 0.9;
        if (!input.woods(px, pz) || !freeLand(px, pz, 6)) continue;
        // Deep in the woods only the canopy mass reads: thin out away from the track (overdraw).
        const d = ctx.distance(px, pz);
        if (d > 220 && rand() > Math.max(0.3, 1 - (d - 220) / 400)) continue;
        trees.push([px, pz]);
      }
  }

  // --- parkland: lone trees and loose clumps in the open meadows -------------
  {
    const [x0, z0, x1, z1] = input.bounds;
    const clump = (x: number, z: number) => {
      const h = Math.sin(Math.floor(x / 110) * 127.1 + Math.floor(z / 110) * 311.7) * 43758.5453;
      return h - Math.floor(h);
    };
    for (let z = z0; z < z1; z += 14)
      for (let x = x0; x < x1; x += 14) {
        const px = x + rand() * 14;
        const pz = z + rand() * 14;
        const density = clump(px, pz);
        if (rand() > 0.02 + 0.35 * density ** 3) continue;
        if ((input.woods && input.woods(px, pz)) || ctx.distance(px, pz) > 1100 || !freeLand(px, pz, 10)) continue;
        trees.push([px, pz]);
      }
  }

  // --- street trees and lamp posts along roads -------------------------------
  const lamp = lampTemplate();
  const lamps = new TileMerger(150);
  for (const road of input.roads) {
    const half = road.width / 2;
    let carryTree = rand() * 12;
    let carryLamp = rand() * 30;
    const avenue = road.width >= 7 || rand() < 0.35;
    for (let i = 0; i + 1 < road.pts.length; i++) {
      const [ax, az] = road.pts[i];
      const [bx, bz] = road.pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.5) continue;
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      for (const side of [-1, 1]) {
        if (avenue)
          for (let s = carryTree; s < len; s += 11 + rand() * 4) {
            const off = half + 3.2;
            const x = ax + dx * s + dz * off * side;
            const z = az + dz * s - dx * off * side;
            if (freeLand(x, z, 6)) trees.push([x, z]);
          }
      }
      for (let s = carryLamp; s < len; s += 32) {
        const off = half + 1.0;
        const x = ax + dx * s + dz * off;
        const z = az + dz * s - dx * off;
        // Arm points over the road (template arm is +Z).
        if (ctx.clearance(x, z) > ctx.minClearance + 2) lamps.add(lamp, x, z, Math.atan2(-dz, dx));
      }
      carryTree = Math.max(0, carryTree - len);
      carryLamp = (carryLamp - len) % 32;
      if (carryLamp < 0) carryLamp += 32;
    }
  }

  // --- parked cars in rows in every car park ---------------------------------
  const carTemplates = CAR_PAINTS.map((c) => carTemplate(c));
  const vanTemplates = [vanTemplate(0xf0f0f0), vanTemplate(0x2a2f36), vanTemplate(0xb8bec4)];
  const cars = new TileMerger(150);
  const MAX_CARS = 4000;
  for (const pts of input.parking) {
    if (cars.count >= MAX_CARS) break;
    // Rows along the longest edge.
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
    const occupancy = 0.55 + rand() * 0.4;
    // Double rows of 5 m bays with a 6 m aisle: row pitch 16 m.
    for (let v = v0 + 2.6; v < v1 - 2.4; v += 16) {
      for (const [dv, face] of [
        [0, 1],
        [5.2, -1],
      ] as const) {
        for (let u = u0 + 1.5; u < u1 - 1.2; u += 2.6) {
          const vv = v + dv;
          const x = ux * u + vx * vv;
          const z = uz * u + vz * vv;
          if (!pointInPolygon(pts, x, z) || ctx.clearance(x, z) < ctx.minClearance + 3 || rand() > occupancy) continue;
          const yaw = Math.atan2(vx * face, vz * face) + (rand() - 0.5) * 0.08;
          const t = rand() < 0.1 ? vanTemplates[Math.floor(rand() * vanTemplates.length)] : carTemplates[Math.floor(rand() * carTemplates.length)];
          cars.add(t, x, z, yaw);
          if (cars.count >= MAX_CARS) break;
        }
      }
    }
  }

  // --- bushes and hedges along wood edges ------------------------------------
  const bushTemplates = [0x2c4a22, 0x3b5a2a, 0x24401f, 0x4a6332].map((c) => bushTemplate(c, rand));
  const bushes = new TileMerger(150);
  if (input.woods) {
    const [x0, z0, x1, z1] = input.bounds;
    for (let z = z0; z < z1; z += 5)
      for (let x = x0; x < x1; x += 5) {
        const px = x + rand() * 5;
        const pz = z + rand() * 5;
        if (input.woods(px, pz)) continue;
        // Edge: woods within 8 m (cheap mask tests first, track clearance last).
        const edge = input.woods(px + 8, pz) || input.woods(px - 8, pz) || input.woods(px, pz + 8) || input.woods(px, pz - 8);
        if (!edge || rand() > 0.3 || bushes.count >= 3000 || ctx.distance(px, pz) > 350 || !freeLand(px, pz, 4)) continue;
        bushes.add(bushTemplates[Math.floor(rand() * bushTemplates.length)], px, pz, rand() * 6.28, 0.8 + rand() * 1.4);
      }
  }

  const propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
  const bushMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
  disposables.push(propMat, bushMat, lamp, ...carTemplates, ...vanTemplates, ...bushTemplates);
  cars.build(group, propMat, 'ParkedCars', 700, true, disposables);
  lamps.build(group, propMat, 'LampPosts', 450, false, disposables);
  bushes.build(group, bushMat, 'Bushes', 600, false, disposables);
  return { group, trees, disposables };
}
