import * as THREE from 'three';
import type { Ground, RealTerrain } from './RealTerrain';

/**
 * Ground around a circuit whose road has real heights (Spa, Suzuka).
 *
 * - Inside a road's corridor (road + run-off up to just behind the barrier)
 *   the ground is exactly that road's height: the run-off is level with the
 *   road, like a real circuit (flat cross-section, no banking).
 * - Outside the corridors the height blends from the nearby corridors
 *   (inverse distance) into the real landscape (Copernicus DEM) over
 *   BLEND meters, so the land rises / falls to the circuit like embankments
 *   and cuttings.
 * - Bridge decks (`excluded` samples, Suzuka's crossover) don't shape the
 *   ground: below them the land belongs to the road underneath.
 *
 * Precomputed on a raster near the track; plain DEM further out.
 */

/** Width of the blend from the corridors into the real landscape (m). */
const BLEND = 120;
/** Corridors further away than this don't influence a point (m). */
const REACH = 170;
const CELL = 4;
const COARSE_STEP = 4;

const smoothstep = (e0: number, e1: number, x: number) => {
  const k = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return k * k * (3 - 2 * k);
};

type Rect = [number, number, number, number];

function sampleGrid(values: ArrayLike<number>, rect: Rect, n: number, x: number, z: number): number {
  const [x0, z0, x1, z1] = rect;
  const fx = Math.min(Math.max(((x - x0) / (x1 - x0)) * (n - 1), 0), n - 1.001);
  const fz = Math.min(Math.max(((z - z0) / (z1 - z0)) * (n - 1), 0), n - 1.001);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  return (values[j * n + i] * (1 - u) + values[j * n + i + 1] * u) * (1 - v) + (values[(j + 1) * n + i] * (1 - u) + values[(j + 1) * n + i + 1] * u) * v;
}

/**
 * Lays scenery built on flat ground (y = 0) onto `height`: plain meshes per
 * vertex (merged building tiles, roads, tents), instanced meshes per instance
 * (cars, lamps, crowd) — shared instance buffers (LOD levels) only once.
 * Parents must be translations only (true for scenery groups).
 */
export function drapeObject(root: THREE.Object3D, height: (x: number, z: number) => number): void {
  root.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const done = new Set<THREE.BufferAttribute>();
  root.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) {
      const attr = o.instanceMatrix;
      if (done.has(attr)) return;
      done.add(attr);
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        p.setFromMatrixPosition(m).applyMatrix4(o.matrixWorld);
        m.elements[13] += height(p.x, p.z);
        o.setMatrixAt(i, m);
      }
      attr.needsUpdate = true;
      o.computeBoundingSphere();
      o.computeBoundingBox();
      return;
    }
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.attributes.position as THREE.BufferAttribute;
    if (done.has(pos)) return;
    done.add(pos);
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      pos.setY(i, pos.getY(i) + height(p.x, p.z));
    }
    pos.needsUpdate = true;
    o.geometry.computeVertexNormals();
    o.geometry.computeBoundingSphere();
    o.geometry.computeBoundingBox();
  });
  // Re-centre LOD tiles on their (now raised) contents.
  root.traverse((o) => {
    if (!(o instanceof THREE.LOD)) return;
    const first = o.levels.find((l) => l.object instanceof THREE.InstancedMesh)?.object as THREE.InstancedMesh | undefined;
    if (!first?.boundingSphere) return;
    const dy = first.boundingSphere.center.y + first.position.y;
    o.position.y += dy;
    for (const l of o.levels) l.object.position.y -= dy;
  });
}

export interface ElevatedGroundInput {
  points: readonly THREE.Vector3[];
  rights: readonly THREE.Vector3[];
  /** Outer edge of the level corridor at sample i on `side` (m from the centerline). */
  corridor(i: number, side: number): number;
  /** Samples that don't shape the ground (bridge deck). */
  excluded: Uint8Array;
  real: RealTerrain | null;
  bounds: THREE.Box3;
}

export interface ElevatedGround extends Ground {
  /** Height of the corridor-only field (no landscape blend). */
  readonly kind: 'elevated';
}

export function elevatedGround(input: ElevatedGroundInput): ElevatedGround {
  const { points, rights, excluded, real, bounds } = input;
  const n = points.length;

  // --- landscape outside the corridors --------------------------------------
  // Real DEM when baked; otherwise a smooth inverse-distance field of the road heights.
  let landscape: (x: number, z: number) => number;
  if (real) {
    const far = real.meta.dem;
    const near = real.meta.demNear && real.nearHeights ? real.meta.demNear : null;
    landscape = (x, z) => {
      if (near) {
        const [x0, z0, x1, z1] = near.rect;
        if (x > x0 && x < x1 && z > z0 && z < z1) return sampleGrid(real.nearHeights!, near.rect, near.size, x, z) * near.scale;
      }
      return sampleGrid(real.heights, far.rect, far.size, x, z) * far.scale;
    };
  } else {
    const samples = points.filter((_, i) => i % 16 === 0);
    landscape = (x, z) => {
      let sw = 0;
      let sh = 0;
      for (const s of samples) {
        const w = 1 / ((s.x - x) ** 2 + (s.z - z) ** 2 + 200 * 200);
        sw += w;
        sh += w * s.y;
      }
      return sh / sw;
    };
  }

  // --- coarse sample grid for section queries ---------------------------------
  const coarse: number[] = [];
  for (let i = 0; i < n; i += COARSE_STEP) if (!excluded[i]) coarse.push(i);
  const gridCell = 50;
  const cells = new Map<number, number[]>();
  const key = (gx: number, gz: number) => gx * 100003 + gz;
  for (const i of coarse) {
    const p = points[i];
    const k = key(Math.floor(p.x / gridCell), Math.floor(p.z / gridCell));
    let c = cells.get(k);
    if (!c) cells.set(k, (c = []));
    c.push(i);
  }
  const reachCells = Math.ceil(REACH / gridCell);

  /** Distance to segment (i, i+1) of the centerline and the height there. */
  const project = (i: number, x: number, z: number): [number, number, number] => {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.min(Math.max(((x - a.x) * dx + (z - a.z) * dz) / len2, 0), 1);
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const lateral = (x - a.x) * rights[i].x + (z - a.z) * rights[i].z;
    return [Math.hypot(x - px, z - pz), a.y + (b.y - a.y) * t, lateral];
  };

  const candidate: number[] = [];
  const candD = new Map<number, number>();
  /** Full evaluation (used to fill the raster). Returns [height, distance to centerline]. */
  const evaluate = (x: number, z: number): [number, number] => {
    const gx = Math.floor(x / gridCell);
    const gz = Math.floor(z / gridCell);
    candidate.length = 0;
    candD.clear();
    for (let a = gx - reachCells; a <= gx + reachCells; a++)
      for (let b = gz - reachCells; b <= gz + reachCells; b++) {
        const c = cells.get(key(a, b));
        if (!c) continue;
        for (const i of c) {
          const p = points[i];
          const d = Math.hypot(p.x - x, p.z - z);
          if (d > REACH + 20) continue;
          candidate.push(i);
          candD.set(i, d);
        }
      }
    if (!candidate.length) return [landscape(x, z), Infinity];
    // One representative per section: local minima of the distance along the loop.
    let bestE = Infinity;
    let bestH = 0;
    let bestD = Infinity;
    let sw = 0;
    let sh = 0;
    for (const c of candidate) {
      const d = candD.get(c)!;
      const prev = candD.get((c - COARSE_STEP + n) % n) ?? Infinity;
      const next = candD.get((c + COARSE_STEP) % n) ?? Infinity;
      if (d > prev || d > next) continue;
      // Refine on the fine samples around it.
      let fd = Infinity;
      let fh = 0;
      let fl = 0;
      let fi = c;
      for (let k = -COARSE_STEP; k < COARSE_STEP; k++) {
        const i = (c + k + n) % n;
        if (excluded[i]) continue;
        const [dd, hh, ll] = project(i, x, z);
        if (dd < fd) {
          fd = dd;
          fh = hh;
          fl = ll;
          fi = i;
        }
      }
      if (fd === Infinity) continue;
      const e = fd - input.corridor(fi, fl >= 0 ? 1 : -1);
      if (fd < bestD) bestD = fd;
      if (e < bestE) {
        bestE = e;
        bestH = fh;
      }
      if (e > 0) {
        const w = 1 / Math.max(e, 0.5) ** 3;
        sw += w;
        sh += w * fh;
      }
    }
    if (bestE === Infinity) return [landscape(x, z), Infinity];
    // Inside a corridor: that road's height, exactly.
    if (bestE <= 0) return [bestH, bestD];
    const road = sh / sw;
    return [road + (landscape(x, z) - road) * smoothstep(0, BLEND, bestE), bestD];
  };

  // --- raster near the circuit ----------------------------------------------
  const margin = REACH + 40;
  const x0 = bounds.min.x - margin;
  const z0 = bounds.min.z - margin;
  const w = Math.ceil((bounds.max.x - bounds.min.x + 2 * margin) / CELL) + 1;
  const h = Math.ceil((bounds.max.z - bounds.min.z + 2 * margin) / CELL) + 1;
  const heights = new Float32Array(w * h);
  const dist = new Float32Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const [hh, dd] = evaluate(x0 + i * CELL, z0 + j * CELL);
      heights[j * w + i] = hh;
      dist[j * w + i] = Math.min(dd, 1e4);
    }
  const sampleRaster = (values: Float32Array, x: number, z: number) => {
    const fx = (x - x0) / CELL;
    const fz = (z - z0) / CELL;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const k = j * w + i;
    return (values[k] * (1 - u) + values[k + 1] * u) * (1 - v) + (values[k + w] * (1 - u) + values[k + w + 1] * u) * v;
  };
  const inRaster = (x: number, z: number) => x >= x0 && z >= z0 && x < x0 + (w - 1) * CELL && z < z0 + (h - 1) * CELL;

  return {
    kind: 'elevated',
    height: (x, z) => (inRaster(x, z) ? sampleRaster(heights, x, z) : landscape(x, z)),
    distance: (x, z) => (inRaster(x, z) ? sampleRaster(dist, x, z) : 1e4),
  };
}
