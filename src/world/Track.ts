import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { BARRIER_GROUPS, type PhysicsWorld } from '../physics/PhysicsWorld';
import type { Pose } from '../vehicle/VehiclePhysics';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildCrowd, buildTribune, CrowdMaterial, type CrowdSeat, type TribuneSpec } from './Crowd';
import { buildOsmScenery, type OsmData } from './OsmScenery';
import { TiledInstances } from './TiledInstances';
import type { TrackLayout } from './TrackLayout';

export type Surface = 'asphalt' | 'kerb' | 'grass' | 'gravel';

/**
 * What the game needs from a track. ProceduralTrack implements it from a
 * TrackLayout; a future GltfTrack would implement it from a GLB
 * (visual mesh + trimesh collider + spawn/centerline empties).
 */
export interface Track {
  readonly name: string;
  readonly root: THREE.Object3D;
  /** World-space bounds of the drivable area (used for out-of-world checks). */
  readonly bounds: THREE.Box3;
  /** Materials that can be upgraded with textures once they have streamed in. */
  readonly materials: TrackMaterials;
  getSpawnPose(): Pose;
  /** Pose on the centerline closest to `near`, facing the driving direction. */
  getResetPose(near: THREE.Vector3): Pose;
  /** Closed centerline samples in driving order (AI racing line, lap timing, minimap). */
  getCenterline(): readonly THREE.Vector3[];
  getRights(): readonly THREE.Vector3[];
  /** Index of the centerline sample closest to `p`. */
  nearestIndex(p: THREE.Vector3): number;
  /** Centerline index the car spawns at. */
  readonly spawnIndex: number;
  /** Half of the asphalt width (m). */
  readonly halfWidth: number;
  /** Signed lateral distance from the centerline (+ = right of the driving direction). */
  lateral(p: THREE.Vector3, index?: number): number;
  /** True when `p` is clearly outside the barriers (escaped the circuit). */
  isOutOfBounds(p: THREE.Vector3): boolean;
  /** Tree positions inside real (OSM) forests, for the impostor forest. */
  readonly forestSpots: readonly [number, number][];
  /** Starting-grid slot pose (0 = pole position). */
  gridPose(slot: number): Pose;
  /** Ground type under a world position (grip / drag / sound). */
  surfaceAt(p: THREE.Vector3): Surface;
  /** Per-frame animation (crowd), `time` in seconds. */
  /** Per frame: animations + distance culling around the camera. */
  update(time: number, camera?: THREE.Vector3): void;
  dispose(): void;
}

/** Scenery pieces further than this from the camera are hidden (m). Haze makes them faint there anyway. */
const SCENERY_CULL_DISTANCE = 3200;

export interface TrackMaterials {
  asphalt: THREE.MeshStandardMaterial;
  grass: THREE.MeshStandardMaterial;
  gravel: THREE.MeshStandardMaterial;
}

const UP = new THREE.Vector3(0, 1, 0);
const SPAWN_HEIGHT = 1.2;
/** Corners tighter than this radius get kerbs / gravel traps. */
const KERB_RADIUS = 260;
const GRAVEL_RADIUS = 200;
const KERB_WIDTH = 1.2;
/** Top of the debris fence above the guardrails (m). */
const FENCE_TOP = 3.4;
/** Beyond barrier + this (m) a car has escaped the circuit and is put back. */
const OUT_OF_BOUNDS_MARGIN = 6;

/** Deterministic PRNG so scenery is identical across runs (fair perf comparisons). */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform grid over centerline samples for fast "nearest point on track" queries. */
class CenterlineGrid {
  private readonly cells = new Map<string, number[]>();

  constructor(
    private readonly points: readonly THREE.Vector3[],
    private readonly cellSize = 25,
  ) {
    points.forEach((p, i) => {
      const key = this.key(Math.floor(p.x / cellSize), Math.floor(p.z / cellSize));
      let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, (cell = []));
      cell.push(i);
    });
  }

  /** Index of the nearest sample within `radius` (or -1) and its squared distance. */
  nearest(x: number, z: number, radius = this.cellSize): { index: number; distSq: number } {
    const r = Math.ceil(radius / this.cellSize);
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    let index = -1;
    let distSq = Infinity;
    for (let gx = cx - r; gx <= cx + r; gx++)
      for (let gz = cz - r; gz <= cz + r; gz++) {
        const cell = this.cells.get(this.key(gx, gz));
        if (!cell) continue;
        for (const i of cell) {
          const p = this.points[i];
          const d = (p.x - x) ** 2 + (p.z - z) ** 2;
          if (d < distSq) {
            distSq = d;
            index = i;
          }
        }
      }
    return { index, distSq };
  }

  private key(gx: number, gz: number): string {
    return `${gx},${gz}`;
  }
}

export interface ProceduralTrackOptions {
  /** Scenery density; actual count scales with track length. */
  treesPerKm: number;
  /** Real-world surroundings (OpenStreetMap), already in track coordinates. */
  scenery?: OsmData;
}

interface RibbonOptions {
  color?: (i: number) => THREE.Color;
  /** Only build segments for which this returns true. */
  include?: (i: number) => boolean;
}

/**
 * Builds a full circuit from a centerline: textured asphalt, kerbs and gravel
 * traps on corners, armco guardrails (instanced + box colliders), start
 * gantry, pit building, grandstand and instanced trees.
 * UVs are in meters, so any tiling texture can be applied with repeat = 1/tileSize.
 */
export class ProceduralTrack implements Track {
  readonly name: string;
  readonly root = new THREE.Group();
  readonly bounds = new THREE.Box3();
  /** Tree positions inside real (OSM) forests, for the impostor forest. */
  forestSpots: readonly [number, number][] = [];
  readonly materials: TrackMaterials;
  /** Centerline length in meters. */
  length = 0;

  /** Centerline samples + unit tangents/right vectors (y = 0). */
  private readonly points: THREE.Vector3[] = [];
  private readonly tangents: THREE.Vector3[] = [];
  private readonly rights: THREE.Vector3[] = [];
  /** Signed curvature per sample (1/m, + = turning left). */
  private curvature = new Float32Array(0);
  private kerb = new Uint8Array(0);
  /** Gravel trap side per sample: -1 left, +1 right, 0 none. */
  private gravelSide = new Int8Array(0);
  private readonly disposables: { dispose(): void }[] = [];
  private readonly bodies: RAPIER.RigidBody[] = [];
  private grid!: CenterlineGrid;
  private readonly half: number;
  private readonly barrierOffset: number;
  private readonly crowdSeats: CrowdSeat[] = [];
  private readonly crowdMaterial = new CrowdMaterial();
  private readonly cullables: { object: THREE.Object3D; center: THREE.Vector3; radius: number }[] = [];
  private standMaterials: { concrete: THREE.Material; seats: THREE.Material; roof: THREE.Material } | null = null;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly layout: TrackLayout,
    options: ProceduralTrackOptions,
  ) {
    this.name = layout.name;
    this.root.name = `Track:${layout.name}`;
    this.half = layout.roadWidth / 2;
    this.barrierOffset = this.half + layout.runoff;
    this.materials = {
      asphalt: this.own(new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.9 })),
      grass: this.own(new THREE.MeshStandardMaterial({ color: 0x4f7d3a, roughness: 1 })),
      gravel: this.own(new THREE.MeshStandardMaterial({ color: 0xc9b48a, roughness: 1 })),
    };

    this.sampleCenterline();
    this.classifyCorners();

    const pad = this.barrierOffset + 2;
    for (const p of this.points) this.bounds.expandByPoint(p);
    this.bounds.expandByVector(new THREE.Vector3(pad, 0, pad));
    this.bounds.max.y = 50;
    this.bounds.min.y = -1;

    this.buildGround();
    this.buildRoad();
    this.buildKerbsAndGravel();
    this.buildBarriers();
    this.buildStartLine();
    // Real circuits get their real buildings from OSM; generic ones only otherwise.
    let forestTrees: [number, number][] = [];
    if (options.scenery) forestTrees = this.buildScenery(options.scenery);
    else this.buildPitAndGrandstand();
    this.forestSpots = forestTrees;
    // With OSM data, trees come from real forests (random ones could land in lakes or buildings).
    // These low-poly trees are opt-in (treesPerKm > 0, instancing experiments): the game
    // itself plants impostor trees on forestSpots (see TreeImpostors).
    if (options.treesPerKm > 0) {
      const scatter = options.scenery ? 0 : Math.round((options.treesPerKm * this.length) / 1000);
      if (scatter + forestTrees.length > 0) this.buildTrees(scatter, forestTrees);
    }
    this.buildSpectatorBanks();
    if (this.crowdSeats.length) {
      const crowd = buildCrowd(this.crowdSeats, this.crowdMaterial);
      this.disposables.push(...crowd.disposables, this.crowdMaterial);
      this.root.add(crowd.group);
    }
    this.collectCullables();
  }

  get spawnIndex(): number {
    // A few meters behind the start line.
    const back = Math.round(8 / this.layout.sampleSpacing);
    return (this.points.length - back) % this.points.length;
  }

  getSpawnPose(): Pose {
    return this.poseAt(this.spawnIndex);
  }

  getResetPose(near: THREE.Vector3): Pose {
    return this.poseAt(this.nearestIndex(near));
  }

  nearestIndex(p: THREE.Vector3): number {
    const hit = this.grid.nearest(p.x, p.z, 60);
    if (hit.index >= 0) return hit.index;
    // Far away from the track: brute force.
    let best = 0;
    let bestDist = Infinity;
    this.points.forEach((c, i) => {
      const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  surfaceAt(p: THREE.Vector3): Surface {
    const hit = this.grid.nearest(p.x, p.z, this.barrierOffset + 5);
    if (hit.index < 0) return 'grass';
    const i = hit.index;
    const c = this.points[i];
    const r = this.rights[i];
    const lateral = (p.x - c.x) * r.x + (p.z - c.z) * r.z;
    const a = Math.abs(lateral);
    if (a <= this.half) return 'asphalt';
    if (this.kerb[i] && a <= this.half + KERB_WIDTH) return 'kerb';
    if (this.gravelSide[i] === Math.sign(lateral) && a <= this.barrierOffset) return 'gravel';
    return 'grass';
  }

  getCenterline(): readonly THREE.Vector3[] {
    return this.points;
  }

  /** Unit right vector per centerline sample. */
  getRights(): readonly THREE.Vector3[] {
    return this.rights;
  }

  /** Half of the asphalt width (m). */
  get halfWidth(): number {
    return this.half;
  }

  /** Signed lateral distance of `p` from the centerline sample `index` (+ = right). */
  lateral(p: THREE.Vector3, index = this.nearestIndex(p)): number {
    const c = this.points[index];
    const r = this.rights[index];
    return (p.x - c.x) * r.x + (p.z - c.z) * r.z;
  }

  /**
   * Starting-grid slot (0 = pole). Two staggered columns behind the start
   * line, 8 m between rows, like a real F1 grid.
   */
  gridPose(slot: number): Pose {
    const ds = this.layout.sampleSpacing;
    const n = this.points.length;
    const back = 10 + Math.floor(slot / 2) * 8 + (slot % 2) * 4;
    const i = (n - Math.round(back / ds)) % n;
    const pose = this.poseAt(i);
    const lane = Math.min(3.5, this.half * 0.45) * (slot % 2 === 0 ? -1 : 1);
    pose.position.addScaledVector(this.rights[i], lane);
    return pose;
  }

  update(time: number, camera?: THREE.Vector3): void {
    this.crowdMaterial.setTime(time);
    if (camera) {
      for (const c of this.cullables) c.object.visible = c.center.distanceTo(camera) - c.radius < SCENERY_CULL_DISTANCE;
    }
  }

  /** Number of spectators placed (stands + trackside). */
  get spectatorCount(): number {
    return this.crowdSeats.length;
  }

  dispose(): void {
    for (const b of this.bodies) this.physics.world.removeRigidBody(b);
    for (const d of this.disposables) d.dispose();
    this.root.removeFromParent();
  }

  // --------------------------------------------------------------------

  /**
   * Small scenery (building tiles, stands, rail tiles, LODs) gets a bounding
   * sphere for distance culling; long objects like the road stay always on.
   */
  private collectCullables(): void {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const sphere = new THREE.Sphere();
    const visit = (o: THREE.Object3D) => {
      const leaf = o instanceof THREE.Mesh || o instanceof THREE.LOD;
      if (leaf) {
        box.setFromObject(o).getBoundingSphere(sphere);
        if (!box.isEmpty() && sphere.radius < 900) this.cullables.push({ object: o, center: sphere.center.clone(), radius: sphere.radius });
        return; // LOD levels / mesh children follow their parent
      }
      for (const child of o.children) visit(child);
    };
    for (const child of this.root.children) visit(child);
  }

  private own<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  private poseAt(i: number): Pose {
    const t = this.tangents[i];
    // Car forward is -Z: yaw so that (-sin yaw, 0, -cos yaw) == tangent.
    const yaw = Math.atan2(-t.x, -t.z);
    return {
      position: this.points[i].clone().setY(SPAWN_HEIGHT),
      quaternion: new THREE.Quaternion().setFromAxisAngle(UP, yaw),
    };
  }

  private sampleCenterline(): void {
    const ctrl = this.layout.points.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal');
    // Default arc-length table (200) is far too coarse for real circuits with 1000+ points.
    curve.arcLengthDivisions = Math.max(200, ctrl.length * 10);
    const count = Math.max(16, Math.round(curve.getLength() / this.layout.sampleSpacing));
    const pts = curve.getSpacedPoints(count);
    pts.pop(); // closed curve: last == first
    this.points.push(...pts);
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const t = pts[(i + 1) % n].clone().sub(pts[(i - 1 + n) % n]).normalize();
      this.tangents.push(t);
      this.rights.push(new THREE.Vector3().crossVectors(t, UP).normalize());
      this.length += pts[i].distanceTo(pts[(i + 1) % n]);
    }
    this.grid = new CenterlineGrid(this.points);
  }

  /** Signed curvature -> where kerbs and (outside) gravel traps go. */
  private classifyCorners(): void {
    const n = this.points.length;
    const ds = this.layout.sampleSpacing;
    const k = 3;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = this.tangents[(i - k + n) % n];
      const b = this.tangents[(i + k) % n];
      const crossY = a.z * b.x - a.x * b.z; // >0 = turning left
      raw[i] = Math.asin(Math.max(-1, Math.min(1, crossY))) / (2 * k * ds);
    }
    this.curvature = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = -2; j <= 2; j++) s += raw[(i + j + n) % n];
      this.curvature[i] = s / 5;
    }

    this.kerb = new Uint8Array(n);
    this.gravelSide = new Int8Array(n);
    const before = Math.round(15 / ds);
    const after = Math.round(40 / ds); // cars run wide on corner exit
    for (let i = 0; i < n; i++) {
      const c = this.curvature[i];
      if (Math.abs(c) > 1 / KERB_RADIUS) {
        for (let j = -Math.round(6 / ds); j <= Math.round(6 / ds); j++) this.kerb[(i + j + n) % n] = 1;
      }
      if (Math.abs(c) > 1 / GRAVEL_RADIUS) {
        // Turning left (c > 0) -> outside of the corner is the right side (+1).
        const side = c > 0 ? 1 : -1;
        for (let j = -before; j <= after; j++) this.gravelSide[(i + j + n) % n] = side;
      }
    }
  }

  private fixedBody(): RAPIER.RigidBody {
    const { rapier, world } = this.physics;
    const body = world.createRigidBody(rapier.RigidBodyDesc.fixed());
    this.bodies.push(body);
    return body;
  }

  private addMesh(geometry: THREE.BufferGeometry, material: THREE.Material, receiveShadow = true): THREE.Mesh {
    this.own(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = receiveShadow;
    this.root.add(mesh);
    return mesh;
  }

  /** Grass plane + one big box collider. Beyond its edge the car falls and resets. */
  private buildGround(): void {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    this.bounds.getSize(size);
    this.bounds.getCenter(center);
    const w = size.x + 1600; // covers the OSM scenery margin
    const d = size.z + 1600;

    // Subdivided: a single huge quad loses depth precision and z-fights with the road.
    const geo = new THREE.PlaneGeometry(w, d, Math.ceil(w / 40), Math.ceil(d / 40));
    geo.rotateX(-Math.PI / 2);
    // UVs in meters.
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * d);
    const mesh = this.addMesh(geo, this.materials.grass);
    mesh.position.set(center.x, -0.04, center.z);
    mesh.name = 'Grass';

    const { rapier, world } = this.physics;
    world.createCollider(
      rapier.ColliderDesc.cuboid(w / 2, 1, d / 2).setTranslation(center.x, -1, center.z).setFriction(1.0),
      this.fixedBody(),
    );
  }

  /** Strip along the centerline between two lateral offsets. UVs: u = lateral m, v = distance m. */
  private ribbon(inner: number, outer: number, y: number, opts: RibbonOptions = {}): THREE.BufferGeometry {
    const n = this.points.length;
    const positions: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    let dist = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const seg = this.points[i].distanceTo(this.points[j]);
      if (!opts.include || opts.include(i)) {
        v[0].copy(this.points[i]).addScaledVector(this.rights[i], inner).setY(y);
        v[1].copy(this.points[i]).addScaledVector(this.rights[i], outer).setY(y);
        v[2].copy(this.points[j]).addScaledVector(this.rights[j], inner).setY(y);
        v[3].copy(this.points[j]).addScaledVector(this.rights[j], outer).setY(y);
        const c = opts.color?.(i);
        // two triangles, counter-clockwise seen from above (normals +Y)
        for (const k of [0, 1, 2, 1, 3, 2]) {
          positions.push(v[k].x, v[k].y, v[k].z);
          uvs.push(k % 2 === 0 ? inner : outer, dist + (k >= 2 ? seg : 0));
          if (c) colors.push(c.r, c.g, c.b);
        }
      }
      dist += seg;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    if (opts.color) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return geo;
  }

  private buildRoad(): void {
    const half = this.half;
    this.addMesh(this.ribbon(-half, half, 0.02), this.materials.asphalt).name = 'Asphalt';

    const lineMat = this.own(new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.7 }));
    this.addMesh(this.ribbon(-half + 0.25, -half + 0.45, 0.03), lineMat);
    this.addMesh(this.ribbon(half - 0.45, half - 0.25, 0.03), lineMat);
  }

  private buildKerbsAndGravel(): void {
    const half = this.half;
    const red = new THREE.Color(0xc8102e);
    const white = new THREE.Color(0xf4f4f4);
    // Real kerb blocks are ~1 m: alternate every sample (2.5 m) reads correctly at speed.
    const color = (i: number) => (i % 2 === 0 ? red : white);
    const kerbMat = this.own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
    const isKerb = (i: number) => this.kerb[i] === 1;
    this.addMesh(this.ribbon(-half - KERB_WIDTH, -half, 0.03, { color, include: isKerb }), kerbMat).name = 'Kerbs';
    this.addMesh(this.ribbon(half, half + KERB_WIDTH, 0.03, { color, include: isKerb }), kerbMat).name = 'Kerbs';

    const gravelIn = half + KERB_WIDTH + 1.0;
    const gravelOut = this.barrierOffset - 0.6;
    this.addMesh(
      this.ribbon(-gravelOut, -gravelIn, 0.012, { include: (i) => this.gravelSide[i] === -1 }),
      this.materials.gravel,
    ).name = 'Gravel';
    this.addMesh(
      this.ribbon(gravelIn, gravelOut, 0.012, { include: (i) => this.gravelSide[i] === 1 }),
      this.materials.gravel,
    ).name = 'Gravel';
  }

  /**
   * Armco guardrails + debris fence: tiled instancing (culled per 300 m tile,
   * also in the shadow pass) + one tall box collider per segment, so a car
   * that hits the barrier at speed cannot ride up and over it.
   */
  private buildBarriers(): void {
    const { rapier, world } = this.physics;
    const n = this.points.length;
    const offset = this.barrierOffset;
    // Collider reaches below the ground and above the fence; its inner face
    // stays at the rails, the extra thickness goes outward (no tunnelling).
    const colliderBottom = -1;
    const colliderTop = FENCE_TOP + 0.5;
    const colliderThickness = 1.5;

    // Three W-beam rails in one unit-length geometry (scaled along Z per segment).
    const railParts = [0.42, 0.68, 0.94].map((y) => new THREE.BoxGeometry(0.08, 0.22, 1).translate(0, y, 0));
    const railGeo = this.own(mergeGeometries(railParts)!);
    railParts.forEach((g) => g.dispose());
    const postGeo = this.own(new THREE.BoxGeometry(0.12, 1.06, 0.12).translate(0, 0.53, 0));
    const railMat = this.own(new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.85, roughness: 0.35 }));
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x7c838c, metalness: 0.6, roughness: 0.5 }));

    // Debris fence above the rails: a unit-length wire-mesh panel (alpha-tested,
    // no transparency sorting) and a steel pole every few segments.
    const fenceH = FENCE_TOP - 1.05;
    const fenceGeo = this.own(new THREE.PlaneGeometry(1, fenceH).rotateY(Math.PI / 2).translate(0, 1.05 + fenceH / 2, 0));
    const fenceMat = this.own(
      new THREE.MeshStandardMaterial({
        map: this.own(fenceTexture()),
        color: 0x8a9096,
        metalness: 0.5,
        roughness: 0.6,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
      }),
    );
    const poleGeo = this.own(new THREE.CylinderGeometry(0.05, 0.05, FENCE_TOP, 6).translate(0, FENCE_TOP / 2, 0));

    const body = this.fixedBody();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const c = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const railMatrices: THREE.Matrix4[] = [];
    const postMatrices: THREE.Matrix4[] = [];
    const fenceMatrices: THREE.Matrix4[] = [];
    const poleMatrices: THREE.Matrix4[] = [];

    for (const side of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        a.copy(this.points[i]).addScaledVector(this.rights[i], side * offset);
        b.copy(this.points[j]).addScaledVector(this.rights[j], side * offset);
        p.addVectors(a, b).multiplyScalar(0.5);
        // Skip pieces that would land on tarmac: inside of hairpins tighter than
        // the barrier offset, or where two parts of the circuit run close together.
        if (this.grid.nearest(p.x, p.z, offset).distSq < (offset - 1.5) ** 2) continue;
        const len = a.distanceTo(b) + 0.3; // small overlap closes gaps on curves
        q.setFromAxisAngle(UP, Math.atan2(b.x - a.x, b.z - a.z));
        p.y = 0;
        const scaled = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, len));
        railMatrices.push(scaled);
        fenceMatrices.push(scaled.clone());
        if (i % 2 === 0) postMatrices.push(new THREE.Matrix4().compose(p, q, one));
        if (i % 4 === 0) poleMatrices.push(new THREE.Matrix4().compose(p, q, one));

        c.addVectors(this.rights[i], this.rights[j])
          .setY(0)
          .normalize()
          .multiplyScalar(side * (colliderThickness / 2 - 0.25));
        world.createCollider(
          rapier.ColliderDesc.cuboid(colliderThickness / 2, (colliderTop - colliderBottom) / 2, len / 2)
            .setTranslation(p.x + c.x, (colliderTop + colliderBottom) / 2, p.z + c.z)
            .setRotation(q)
            .setFriction(0.05)
            .setRestitution(0.1)
            .setCollisionGroups(BARRIER_GROUPS),
          body,
        );
      }
    }
    const instances = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material, m: THREE.Matrix4[], castShadow: boolean) =>
      new TiledInstances([{ geometry, material, distance: 0 }], m, null, { name, castShadow, receiveShadow: true }).group;
    this.root.add(
      instances('GuardrailRails', railGeo, railMat, railMatrices, true),
      instances('GuardrailPosts', postGeo, postMat, postMatrices, true),
      instances('DebrisFence', fenceGeo, fenceMat, fenceMatrices, false),
      instances('DebrisFencePoles', poleGeo, postMat, poleMatrices, true),
    );
  }

  /** True when `p` is clearly outside the barriers (escaped the circuit). */
  isOutOfBounds(p: THREE.Vector3): boolean {
    return this.grid.nearest(p.x, p.z, this.barrierOffset + OUT_OF_BOUNDS_MARGIN).index < 0;
  }

  private buildStartLine(): void {
    const w = this.layout.roadWidth;
    const p = this.points[0];
    const yaw = Math.atan2(this.tangents[0].x, this.tangents[0].z);

    // Checkered strip via a tiny nearest-filtered texture.
    const cols = 16;
    const rows = 2;
    const data = new Uint8Array(cols * rows * 4);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const v = (x + y) % 2 === 0 ? 255 : 20;
        data.set([v, v, v, 255], (y * cols + x) * 4);
      }
    const tex = this.own(new THREE.DataTexture(data, cols, rows));
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    const geo = new THREE.PlaneGeometry(w, 1.6);
    geo.rotateX(-Math.PI / 2);
    const strip = this.addMesh(geo, this.own(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 })));
    strip.position.set(p.x, 0.035, p.z);
    strip.rotation.y = yaw;
    strip.name = 'StartLine';

    // Gantry over the start line.
    const gantry = new THREE.Group();
    const off = this.barrierOffset + 0.6;
    const postGeo = this.own(new THREE.BoxGeometry(0.5, 7, 0.5));
    const beamGeo = this.own(new THREE.BoxGeometry(off * 2, 1.4, 0.7));
    const lightGeo = this.own(new THREE.BoxGeometry(0.5, 0.5, 0.2));
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.4, metalness: 0.7 }));
    const beamMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.4, metalness: 0.5 }));
    const lightMat = this.own(new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff1a1a, emissiveIntensity: 2 }));
    for (const sx of [-off, off]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(sx, 3.5, 0);
      post.castShadow = true;
      gantry.add(post);
    }
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.set(0, 7, 0);
    beam.castShadow = true;
    gantry.add(beam);
    for (let k = -2; k <= 2; k++) {
      const l = new THREE.Mesh(lightGeo, lightMat);
      l.position.set(k * 0.8, 7, 0.4);
      gantry.add(l);
    }
    gantry.position.set(p.x, 0, p.z);
    gantry.rotation.y = yaw;
    gantry.name = 'StartGantry';
    this.root.add(gantry);
  }

  /** Distance from (x, z) to the nearest centerline sample (Infinity if far away). */
  clearance(x: number, z: number, searchRadius = 60): number {
    const hit = this.grid.nearest(x, z, searchRadius);
    return hit.index < 0 ? Infinity : Math.sqrt(hit.distSq);
  }

  /** Buildings, water, car parks and roads from OSM; returns forest tree positions. */
  private buildScenery(data: OsmData): [number, number][] {
    const result = buildOsmScenery(data, {
      clearance: (x, z) => this.clearance(x, z),
      nearestPoint: (x, z) => {
        const p = this.points[this.nearestIndex(new THREE.Vector3(x, 0, z))];
        return { x: p.x, z: p.z };
      },
      minClearance: this.barrierOffset + 2,
      asphalt: this.materials.asphalt,
      rand: mulberry32(4242),
    });
    this.disposables.push(...result.disposables);
    this.root.add(result.group);
    const rand = mulberry32(777);
    for (const spec of result.grandstands) this.addTribune(spec, rand);
    return result.trees;
  }

  /** True if a rectangle (center, along tangent t, across r) stays clear of every part of the circuit. */
  private isClear(center: THREE.Vector3, t: THREE.Vector3, r: THREE.Vector3, length: number, depth: number): boolean {
    const clearance = this.barrierOffset + 2;
    for (let a = -0.5; a <= 0.5; a += 0.125)
      for (const d of [-0.5, 0, 0.5]) {
        const x = center.x + t.x * a * length + r.x * d * depth;
        const z = center.z + t.z * a * length + r.z * d * depth;
        if (this.grid.nearest(x, z, clearance).distSq < clearance * clearance) return false;
      }
    return true;
  }

  /** Generic pit building and a grandstand full of fans along the start/finish straight. */
  private buildPitAndGrandstand(): void {
    const t = this.tangents[0];
    const r = this.rights[0];
    const start = this.points[0];
    const yaw = Math.atan2(t.x, t.z);
    const concrete = this.own(new THREE.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.85 }));
    const glass = this.own(new THREE.MeshStandardMaterial({ color: 0x1d2a36, roughness: 0.08, metalness: 0.8 }));
    const dark = this.own(new THREE.MeshStandardMaterial({ color: 0x2d3138, roughness: 0.7 }));
    const roofMat = this.own(new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.5, metalness: 0.3 }));

    const place = (group: THREE.Group, side: number, depth: number, length: number, gap: number): boolean => {
      const center = start
        .clone()
        .addScaledVector(t, length * 0.15)
        .addScaledVector(r, side * (this.barrierOffset + gap + depth / 2));
      if (!this.isClear(center, t, r, length, depth)) return false;
      group.position.copy(center);
      // Local +Z = along the track; local -X is the track-facing side (mirrored per side).
      group.rotation.y = yaw;
      group.scale.x = -side; // local +X faces the track on the right side
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      this.root.add(group);
      return true;
    };
    const box = (g: THREE.Group, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(this.own(new THREE.BoxGeometry(w, h, d)), mat);
      mesh.position.set(x, y, z);
      g.add(mesh);
      return mesh;
    };

    // --- pit building (right side when possible) -------------------------
    const pitLen = 150;
    const pitDepth = 16;
    const pit = new THREE.Group();
    pit.name = 'PitBuilding';
    // local x: 0 = track-facing facade side (-depth/2), +depth/2 = back
    box(pit, concrete, pitDepth, 10, pitLen, 0, 5, 0);
    box(pit, dark, 0.3, 4.2, pitLen - 4, -pitDepth / 2 - 0.1, 2.1, 0); // garage doors band
    box(pit, glass, 0.3, 2.6, pitLen - 2, -pitDepth / 2 - 0.1, 7.2, 0); // hospitality windows
    box(pit, roofMat, pitDepth + 3, 0.4, pitLen + 2, -1.5, 10.2, 0);
    for (let z = -pitLen / 2 + 6; z < pitLen / 2; z += 6) box(pit, concrete, 0.4, 4.4, 0.5, -pitDepth / 2 - 0.2, 2.2, z);
    // Pit wall between track and pit lane
    box(pit, concrete, 0.5, 1.2, pitLen, -pitDepth / 2 - 9, 0.6, 0);
    const pitSide = place(pit, 1, pitDepth + 10, pitLen, 4) ? 1 : place(pit, -1, pitDepth + 10, pitLen, 4) ? -1 : 0;

    // --- grandstand with fans (opposite side) -----------------------------
    const gsLen = 120;
    const gsDepth = 10;
    const gsSides = pitSide === 0 ? [-1, 1] : [-pitSide, pitSide];
    for (const side of gsSides) {
      const center = start.clone().addScaledVector(t, gsLen * 0.15).addScaledVector(r, side * (this.barrierOffset + 3 + gsDepth / 2));
      if (!this.isClear(center, t, r, gsLen, gsDepth)) continue;
      // Front (local -X) must point at the track: direction -side * r.
      const fx = -side * r.x;
      const fz = -side * r.z;
      this.addTribune({ x: center.x, z: center.z, yaw: Math.atan2(fz, -fx), length: gsLen, depth: gsDepth, height: 6 }, mulberry32(99));
      break;
    }
  }

  /** Stepped grandstand + its seated crowd. */
  private addTribune(spec: TribuneSpec, rand: () => number): void {
    if (!this.standMaterials) {
      this.standMaterials = {
        concrete: this.own(new THREE.MeshStandardMaterial({ color: 0xbdb8ae, roughness: 0.9 })),
        seats: this.own(new THREE.MeshStandardMaterial({ color: 0x2a5fb0, roughness: 0.7 })),
        roof: this.own(new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5, metalness: 0.3 })),
      };
    }
    const tribune = buildTribune(spec, this.standMaterials, rand);
    this.disposables.push(...tribune.disposables);
    this.root.add(tribune.group);
    this.crowdSeats.push(...tribune.seats);
  }

  /** Fans standing on the grass behind the guardrails at corners. */
  private buildSpectatorBanks(): void {
    const rand = mulberry32(31337);
    const n = this.points.length;
    const max = 6000;
    let placed = 0;
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const shirts = [0xe10600, 0xffffff, 0x1e5bc6, 0xffd700, 0xff8700, 0x111111, 0x00a19c];
    for (let i = 0; i < n && placed < max; i += 1) {
      if (!this.kerb[i]) continue;
      // Spectators stand on the side opposite the gravel trap when there is one.
      const sides = this.gravelSide[i] ? [-this.gravelSide[i]] : [-1, 1];
      for (const side of sides) {
        for (let row = 0; row < 4; row++) {
          if (rand() > 0.55) continue;
          const off = this.barrierOffset + 3.5 + row * 1.1 + rand() * 0.4;
          p.copy(this.points[i]).addScaledVector(this.rights[i], side * off).addScaledVector(this.tangents[i], (rand() - 0.5) * 2);
          if (this.clearance(p.x, p.z) < this.barrierOffset + 2.5) continue;
          // Face the track: -Z towards the centerline point.
          const dx = this.points[i].x - p.x;
          const dz = this.points[i].z - p.z;
          q.setFromAxisAngle(UP, Math.atan2(-dx, -dz) + (rand() - 0.5) * 0.5);
          const color = new THREE.Color(shirts[Math.floor(rand() * shirts.length)]);
          this.crowdSeats.push({ matrix: new THREE.Matrix4().compose(p.clone().setY(0.25), q, one), color });
          placed++;
        }
      }
    }
  }

  /** Instanced mixed forest (4 draw calls) outside the barriers. No colliders. */
  private buildTrees(scatterCount: number, fixed: [number, number][] = []): void {
    const count = scatterCount + fixed.length;
    const rand = mulberry32(1337);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    this.bounds.getSize(size);
    this.bounds.getCenter(center);
    const minDist = this.barrierOffset + 6;
    const minDistSq = minDist * minDist;
    const spreadX = size.x + 300;
    const spreadZ = size.z + 300;

    // Each tree type = one geometry with vertex colors (trunk + crown), in a
    // detailed and a cheap version; tiles switch to the cheap one with distance.
    const bark = new THREE.Color(0x5b4330);
    const pine = new THREE.Color(0x2e5a2c);
    const leaf = new THREE.Color(0x4a7a2e);
    const coniferHi = this.own(treeGeometry([[new THREE.CylinderGeometry(0.18, 0.3, 3, 6).translate(0, 1.5, 0), bark], [mergeCones(), pine]]));
    const coniferLo = this.own(treeGeometry([[new THREE.ConeGeometry(2.2, 8, 5).translate(0, 5, 0), pine]]));
    const broadHi = this.own(treeGeometry([[new THREE.CylinderGeometry(0.22, 0.35, 3.2, 6).translate(0, 1.6, 0), bark], [lumpySphere(2.6, rand, 1).translate(0, 5, 0), leaf]]));
    const broadLo = this.own(treeGeometry([[lumpySphere(2.6, rand, 0).translate(0, 4.6, 0), leaf]]));
    const material = this.own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));

    const conifers: THREE.Matrix4[] = [];
    const coniferColors: THREE.Color[] = [];
    const broads: THREE.Matrix4[] = [];
    const broadColors: THREE.Color[] = [];
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    // Trees grow in clusters: pick a cluster center, scatter a few around it.
    let clusterX = 0;
    let clusterZ = 0;
    for (let attempt = 0; attempt < count * 20 + fixed.length && conifers.length + broads.length < count; attempt++) {
      if (attempt % 6 === 0) {
        clusterX = center.x + (rand() - 0.5) * spreadX;
        clusterZ = center.z + (rand() - 0.5) * spreadZ;
      }
      if (attempt < fixed.length) p.set(fixed[attempt][0], 0, fixed[attempt][1]);
      else p.set(clusterX + (rand() - 0.5) * 40, 0, clusterZ + (rand() - 0.5) * 40);
      if (this.grid.nearest(p.x, p.z, minDist).distSq < minDistSq) continue;
      const scale = 0.75 + rand() * 0.7;
      q.setFromAxisAngle(UP, rand() * Math.PI * 2);
      s.set(scale * (0.9 + rand() * 0.2), scale, scale * (0.9 + rand() * 0.2));
      const m = new THREE.Matrix4().compose(p, q, s);
      // Per-tree tint around white (hue/brightness variation).
      const tint = new THREE.Color().setHSL(0.15 + rand() * 0.12, 0.35, 0.7 + rand() * 0.25);
      if (rand() < 0.45) {
        conifers.push(m);
        coniferColors.push(tint);
      } else {
        broads.push(m);
        broadColors.push(tint);
      }
    }
    const LOD_DISTANCE = 160;
    const opts = { castShadow: true };
    const c = new TiledInstances(
      [
        { geometry: coniferHi, material, distance: 0 },
        { geometry: coniferLo, material, distance: LOD_DISTANCE },
      ],
      conifers,
      coniferColors,
      { name: 'Conifers', ...opts },
    );
    const t = new TiledInstances(
      [
        { geometry: broadHi, material, distance: 0 },
        { geometry: broadLo, material, distance: LOD_DISTANCE },
      ],
      broads,
      broadColors,
      { name: 'BroadleafTrees', ...opts },
    );
    this.root.add(c.group, t.group);
  }
}

/** Merges parts into one non-indexed geometry with per-part vertex colors. */
function treeGeometry(parts: [THREE.BufferGeometry, THREE.Color][]): THREE.BufferGeometry {
  const prepared = parts.map(([g, color]) => {
    const ni = g.index ? g.toNonIndexed() : g.clone();
    ni.deleteAttribute('uv');
    const n = ni.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) color.toArray(colors, i * 3);
    ni.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.dispose();
    return ni;
  });
  const merged = mergeGeometries(prepared)!;
  for (const g of prepared) g.dispose();
  return merged;
}

/** Two stacked cones as one geometry (conifer crown). */
function mergeCones(): THREE.BufferGeometry {
  const lower = new THREE.ConeGeometry(2.2, 4.5, 8).translate(0, 4.2, 0);
  const upper = new THREE.ConeGeometry(1.6, 3.8, 8).translate(0, 6.6, 0);
  const merged = new THREE.BufferGeometry();
  const a = lower.toNonIndexed();
  const b = upper.toNonIndexed();
  const pos = new Float32Array(a.attributes.position.array.length + b.attributes.position.array.length);
  pos.set(a.attributes.position.array as Float32Array, 0);
  pos.set(b.attributes.position.array as Float32Array, a.attributes.position.array.length);
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.computeVertexNormals();
  for (const g of [lower, upper, a, b]) g.dispose();
  return merged;
}

/** Icosphere with randomly displaced vertices (organic crown). */
function lumpySphere(radius: number, rand: () => number, detail = 1): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  // Displace consistently per unique position so the mesh stays watertight.
  const offsets = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let o = offsets.get(key);
    if (o === undefined) offsets.set(key, (o = 0.8 + rand() * 0.35));
    v.multiplyScalar(o);
    v.y *= 0.85;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Chain-link diamond pattern for the debris fence (alpha-tested; no canvas, so it also runs in Node tests). */
function fenceTexture(): THREE.DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const wire = Math.min(Math.abs(x - y), Math.abs(x + y - size + 1)) <= 1;
      data.set([255, 255, 255, wire ? 255 : 0], (y * size + x) * 4);
    }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.repeat.set(12, 10);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
