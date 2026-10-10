import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { BARRIER_GROUPS, type PhysicsWorld } from '../physics/PhysicsWorld';
import type { Pose } from '../vehicle/VehiclePhysics';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildCrowd, buildTribune, CrowdMaterial, dressFans, type CrowdSeat, type TribuneSpec } from './Crowd';
import { shadeAsphalt, shadeGrass, shadeGravel } from './GroundShading';
import { buildOsmScenery, type OsmData } from './OsmScenery';
import { buildPitLaneData, buildPitLaneMeshes, PIT_LANE_WIDTH, type PitLaneData } from './PitLane';
import { TiledInstances } from './TiledInstances';
import { buildTrackside } from './Trackside';
import { buildPaddock, PADDOCK_DEPTH } from './Paddock';
import { buildPitBuilding, PIT_BUILDING_DEPTH, PIT_BUILDING_FRONT } from './PitBuilding';
import type { StandSpec, TrackLayout } from './TrackLayout';
import { buildFerrisWheel } from './FerrisWheel';
import { findCrossings, loopGap } from './Elevation';
import type { Ground, RealTerrain } from './RealTerrain';
import { drapeObject, elevatedGround } from './TrackGround';
import { QUALITY } from '../performance/Quality';

export type Surface = 'asphalt' | 'kerb' | 'grass' | 'gravel';

/**
 * What the game needs from a track. ProceduralTrack implements it from a
 * TrackLayout; a future GltfTrack would implement it from a GLB
 * (visual mesh + trimesh collider + spawn/centerline empties).
 */
export interface Track {
  readonly name: string;
  /** Street circuit (Monaco): paved surroundings instead of grass. */
  readonly street: boolean;
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
  /** Centreline length (m). */
  readonly length: number;
  /** Signed lateral distance from the centerline (+ = right of the driving direction). */
  lateral(p: THREE.Vector3, index?: number): number;
  /** True when `p` is clearly outside the barriers (escaped the circuit). */
  isOutOfBounds(p: THREE.Vector3): boolean;
  /** Tree positions inside real (OSM) forests, for the impostor forest. */
  readonly forestSpots: readonly [number, number][];
  /** Pit lane along the start/finish straight, if the circuit has one. */
  readonly pit: PitLaneData | null;
  /** Starting-grid slot pose (0 = pole position). */
  gridPose(slot: number): Pose;
  /** Ground type under a world position (grip / drag / sound). */
  surfaceAt(p: THREE.Vector3): Surface;
  /** The road has real heights (Spa, Suzuka). */
  readonly elevated: boolean;
  /** Ground around a circuit with real road heights (null: flat circuit). */
  readonly ground: Ground | null;
  /** Road heights for a racing line (undefined: flat circuit). */
  heightsFor(path: readonly [number, number][]): number[] | undefined;
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
const X_AXIS = new THREE.Vector3(1, 0, 0);
const pitchQ = new THREE.Quaternion();
const xz = (v: THREE.Vector3): [number, number] => [v.x, v.z];
const SPAWN_HEIGHT = 1.2;
/** Corners tighter than this radius get kerbs / gravel traps. */
const KERB_RADIUS = 260;
const GRAVEL_RADIUS = 200;
const KERB_WIDTH = 1.2;
/** Top of the debris fence above the guardrails (m). */
const FENCE_TOP = 3.4;
/** Beyond barrier + this (m) a car has escaped the circuit and is put back. */
const OUT_OF_BOUNDS_MARGIN = 6;
/** Height difference counts this much more than horizontal distance in "which road am I on" queries. */
const Y_WEIGHT = 4;
/** Elevated circuits: the level run-off reaches this far behind the barrier (m). */
const CORRIDOR_BEHIND_BARRIER = 4;
/** Below this height difference two roads touch (no bridge between them), m. */
const SAME_LEVEL = 3;
/** Circuit name on the pit building's roof fascia. */
const PIT_TITLES: Record<string, string> = { monza: 'Autodromo Nazionale Monza', spa: 'Circuit de Spa-Francorchamps', suzuka: 'Suzuka Circuit', monaco: 'Circuit de Monaco' };

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

  /**
   * Index of the nearest sample within `radius` (or -1) and its squared distance.
   * With `y`, height counts too (×Y_WEIGHT): where the circuit passes over
   * itself a car on the bridge belongs to the upper road, not the one below.
   */
  nearest(x: number, z: number, radius = this.cellSize, y = NaN): { index: number; distSq: number } {
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
          let d = (p.x - x) ** 2 + (p.z - z) ** 2;
          if (y === y) d += ((p.y - y) * Y_WEIGHT) ** 2;
          if (d < distSq) {
            distSq = d;
            index = i;
          }
        }
      }
    return { index, distSq };
  }

  /** Lowest sample height within `radius` (Infinity if none). */
  lowestWithin(x: number, z: number, radius: number): number {
    const r = Math.ceil(radius / this.cellSize);
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    let low = Infinity;
    for (let gx = cx - r; gx <= cx + r; gx++)
      for (let gz = cz - r; gz <= cz + r; gz++) {
        const cell = this.cells.get(this.key(gx, gz));
        if (!cell) continue;
        for (const i of cell) {
          const p = this.points[i];
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < radius * radius && p.y < low) low = p.y;
        }
      }
    return low;
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
  /** Box marking colours, one per team (pit lane). */
  pitBoxColors?: number[];
  /** Real landscape heights (circuits with elevation blend their surroundings into it). */
  realTerrain?: RealTerrain | null;
}

interface RibbonOptions {
  color?: (i: number) => THREE.Color;
  /** Only build segments for which this returns true. */
  include?: (i: number) => boolean;
  /** UVs = world x / -z in meters (matches the grass plane's texture, so overlaps don't show). */
  worldUv?: boolean;
  /** Also part of the drivable trimesh collider (elevated circuits), at the road's own height. */
  collide?: boolean;
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
  /** Pit lane (when the layout has one). */
  readonly pit: PitLaneData | null = null;
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
  /** Street circuit (Monaco): pavements, no gravel, paved town. */
  street = false;
  /** Centreline samples along the pit building (its side has no rails/fence visuals there). */
  private readonly pitBuildingAt = new Set<number>();
  private readonly crowdSeats: CrowdSeat[] = [];
  private readonly crowdMaterial = new CrowdMaterial();
  /** `distance`: per-object cull distance (`userData.cullDistance`, small props) or the scenery default. */
  private readonly cullables: { object: THREE.Object3D; center: THREE.Vector3; radius: number; distance: number }[] = [];
  private standMaterials: { concrete: THREE.Material; seats: THREE.Material; roof: THREE.Material } | null = null;
  /** The road has real heights (layout.heights); everything around it follows `ground`. */
  readonly elevated: boolean;
  /**
   * Ground height around an elevated circuit (level run-off, blended into the
   * real landscape). Null for flat circuits: Game drapes their surroundings itself.
   */
  ground: Ground | null = null;
  /** Samples of a bridge deck (the road passes over another part of the circuit). */
  private deck = new Uint8Array(0);
  /** Drivable surface for the trimesh collider of elevated circuits (road + run-off + pit lane). */
  private readonly surfaceVerts: number[] = [];
  /** Per-frame animations (Ferris wheel). */
  private readonly animations: ((time: number) => void)[] = [];
  /** Footprints kept free of OSM scenery (famous grandstands). */
  private reserved: { x: number; z: number; yaw: number; hl: number; hd: number }[] = [];

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

    this.street = !!layout.street;
    // A street circuit is paved all round (the ground material becomes paving stone).
    if (!this.street) shadeGrass(this.materials.grass);
    shadeAsphalt(this.materials.asphalt);
    shadeGravel(this.materials.gravel);

    this.elevated = !!layout.heights && layout.heights.length === layout.points.length;
    this.sampleCenterline();
    this.classifyCorners();

    const pad = this.barrierOffset + 2;
    for (const p of this.points) this.bounds.expandByPoint(p);
    this.bounds.expandByVector(new THREE.Vector3(pad, 0, pad));
    this.bounds.max.y = Math.max(50, this.bounds.max.y + 50);
    this.bounds.min.y = Math.min(-1, this.bounds.min.y - 10);

    if (layout.pitSide) {
      const colors = options.pitBoxColors ?? [0xffd200];
      const lane = layout.pitLane;
      this.pit = buildPitLaneData(this.points, this.rights, this.half, layout.pitSide, layout.sampleSpacing, Math.max(colors.length, 1), lane);
      for (let k = this.pit.limiterStart; k <= this.pit.limiterEnd; k++) this.pitBuildingAt.add(this.pit.pathIndex[k]);
    }
    if (this.elevated) {
      this.findBridges();
      this.ground = elevatedGround({
        points: this.points,
        rights: this.rights,
        corridor: (i, side) => this.corridorAt(side, i),
        excluded: this.deck,
        real: options.realTerrain ?? null,
        bounds: this.bounds,
        // A town is terraced: the ground meets the landscape quickly. The harbour stays wet.
        blend: layout.street ? 45 : undefined,
        water: layout.sea,
      });
    }

    this.buildGround();
    this.buildRoad();
    this.buildKerbsAndGravel();
    this.buildBarriers();
    if (this.pit) {
      this.buildPitLane(options.pitBoxColors ?? [0xffd200]);
      const building = buildPitBuilding(this.pit, this.rights, options.pitBoxColors ?? [0xffd200], PIT_TITLES[layout.id] ?? layout.name);
      this.disposables.push(...building.disposables);
      this.root.add(building.group);
      if (options.scenery) {
        // Built on flat ground, then laid onto the real slope (elevated circuits).
        const flatPit = this.ground ? { ...this.pit, path: this.pit.path.map((p) => p.clone().setY(0)) } : this.pit;
        const paddock = buildPaddock(flatPit, this.rights, options.pitBoxColors ?? [0xffd200], (x, z) => this.clearance(x, z) > this.barrierOffset + 4);
        this.disposables.push(...paddock.disposables);
        if (this.ground) drapeObject(paddock.group, this.ground.height);
        this.root.add(paddock.group);
      }
    }
    this.buildStartLine();
    const trackside = buildTrackside({
      points: this.points,
      tangents: this.tangents,
      rights: this.rights,
      curvature: this.curvature,
      gravelSide: this.gravelSide,
      half: this.half,
      sampleSpacing: layout.sampleSpacing,
      barrierAt: (side, i) => this.barrierAt(side, i, this.barrierOffset),
      clearance: (x, z) => this.clearance(x, z),
      blocked: (side, i) => (this.pitBuildingAt.has(i) && side === this.pit?.side) || this.deck[i] === 1,
      startGantry: { halfSpan: this.barrierOffset + 0.6, y: 7, height: 1.4, depth: 0.7 },
      groundAt: this.ground ? this.ground.height : undefined,
    });
    this.disposables.push(...trackside.disposables);
    this.root.add(trackside.group);
    // Real circuits get their real buildings from OSM; generic ones only otherwise.
    let forestTrees: [number, number][] = [];
    // Famous grandstands claim their ground first (OSM buildings / trees / props keep off it).
    const stands = layout.stands ? this.placeFamousStands(layout.stands) : [];
    this.reserved = stands.map((s) => ({ x: s.x, z: s.z, yaw: s.yaw, hl: s.length / 2 + 6, hd: s.depth / 2 + 6 }));
    for (const [x, z, r] of layout.clearings ?? []) this.reserved.push({ x, z, yaw: 0, hl: r, hd: r });
    if (layout.ferrisWheel) this.buildFerrisWheel(layout.ferrisWheel);
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
    const standRand = mulberry32(2024);
    for (const s of stands) this.addTribune(s, standRand);
    this.buildSpectatorBanks();
    if (this.crowdSeats.length) {
      dressFans(this.crowdSeats, layout.id);
      const crowd = buildCrowd(this.crowdSeats, this.crowdMaterial);
      this.disposables.push(...crowd.disposables, this.crowdMaterial);
      this.root.add(crowd.group);
    }
    if (this.elevated) this.buildSurfaceCollider();
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
    const hit = this.grid.nearest(p.x, p.z, 60, this.elevated ? p.y : NaN);
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

  /** Nearest centerline sample by position only (scenery placement: height unknown). */
  private nearestIndex2D(x: number, z: number): number {
    const hit = this.grid.nearest(x, z, 60);
    if (hit.index >= 0) return hit.index;
    let best = 0;
    let bestDist = Infinity;
    this.points.forEach((c, i) => {
      const d = (c.x - x) ** 2 + (c.z - z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  surfaceAt(p: THREE.Vector3): Surface {
    const hit = this.grid.nearest(p.x, p.z, this.barrierOffset + 5, this.elevated ? p.y : NaN);
    if (hit.index < 0) return 'grass';
    const i = hit.index;
    const c = this.points[i];
    const r = this.rights[i];
    const lateral = (p.x - c.x) * r.x + (p.z - c.z) * r.z;
    const a = Math.abs(lateral);
    if (a <= this.half) return 'asphalt';
    if (this.kerb[i] && a <= this.half + KERB_WIDTH) return 'kerb';
    if (this.gravelSide[i] === Math.sign(lateral) && a <= this.barrierOffset) return 'gravel';
    if (this.pit && this.pit.inRange(i) && Math.sign(lateral) === this.pit.side && Math.abs(a - this.pit.lateralAt(i)) <= PIT_LANE_WIDTH / 2 + 0.5) return 'asphalt';
    // Street circuit: pavement up to the wall, no grass.
    return this.street ? 'asphalt' : 'grass';
  }

  /** Pit lane surface, markings and the pit wall (with colliders). */
  private buildPitLane(colors: number[]): void {
    const pit = this.pit!;
    const built = buildPitLaneMeshes(pit, this.rights, this.materials, colors);
    this.disposables.push(...built.disposables);
    this.root.add(built.group);
    const { rapier, world } = this.physics;
    const body = this.fixedBody();
    const q = new THREE.Quaternion();
    for (const { a, b } of built.wall) {
      q.setFromAxisAngle(UP, Math.atan2(b.x - a.x, b.z - a.z));
      if (a.y !== b.y) q.multiply(pitchQ.setFromAxisAngle(X_AXIS, -Math.atan2(b.y - a.y, Math.hypot(b.x - a.x, b.z - a.z))));
      world.createCollider(
        rapier.ColliderDesc.cuboid(0.25, 0.8, a.distanceTo(b) / 2 + 0.05)
          .setTranslation((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.5, (a.z + b.z) / 2)
          .setRotation(q)
          .setFriction(0.05)
          .setRestitution(0.1)
          .setCollisionGroups(BARRIER_GROUPS),
        body,
      );
    }
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
    for (const a of this.animations) a(time);
    if (camera) {
      // Weaker devices (quality tier, runtime governor) draw a shorter distance.
      const scale = QUALITY.viewDistance;
      for (const c of this.cullables) c.object.visible = c.center.distanceTo(camera) - c.radius < c.distance * scale;
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
        if (!box.isEmpty() && sphere.radius < 900)
          this.cullables.push({ object: o, center: sphere.center.clone(), radius: sphere.radius, distance: (o.userData.cullDistance as number | undefined) ?? SCENERY_CULL_DISTANCE });
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
    const quaternion = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    if (this.elevated) {
      // Nose up / down with the road (rotation about the car's own X axis).
      const n = this.points.length;
      const a = this.points[(i - 2 + n) % n];
      const b = this.points[(i + 2) % n];
      const pitch = Math.atan2(b.y - a.y, Math.hypot(b.x - a.x, b.z - a.z));
      quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
    }
    return {
      position: this.points[i].clone().setY(this.points[i].y + SPAWN_HEIGHT),
      quaternion,
    };
  }

  /**
   * Heights for a racing line (x, z per point, same driving order as the
   * centerline): each point takes the height of the centerline next to it,
   * searching only around the matching share of the lap so the line over a
   * bridge gets the deck, not the road below. Undefined for flat circuits.
   */
  heightsFor(path: readonly [number, number][]): number[] | undefined {
    if (!this.elevated) return undefined;
    const n = this.points.length;
    const m = path.length;
    let hint = -1;
    return path.map(([x, z], k) => {
      const expected = Math.round((k / m) * n);
      const from = hint >= 0 ? hint : expected;
      let best = from;
      let bestD = Infinity;
      for (let o = -80; o <= 80; o++) {
        const i = (from + o + n) % n;
        const p = this.points[i];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      hint = best;
      return this.points[best].y;
    });
  }

  private sampleCenterline(): void {
    const heights = this.elevated ? this.layout.heights! : null;
    const ctrl = this.layout.points.map(([x, z], k) => new THREE.Vector3(x, heights ? heights[k] : 0, z));
    const curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal');
    // Default arc-length table (200) is far too coarse for real circuits with 1000+ points.
    curve.arcLengthDivisions = Math.max(200, ctrl.length * 10);
    const count = Math.max(16, Math.round(curve.getLength() / this.layout.sampleSpacing));
    const pts = curve.getSpacedPoints(count);
    pts.pop(); // closed curve: last == first
    this.points.push(...pts);
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      // Horizontal tangent: the cross-section stays level, right vectors stay horizontal.
      const t = pts[(i + 1) % n].clone().sub(pts[(i - 1 + n) % n]).setY(0).normalize();
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
      // Street circuits have no gravel traps: the wall is right there.
      if (!this.street && Math.abs(c) > 1 / GRAVEL_RADIUS) {
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
    const cell = this.ground ? 10 : 40; // elevated ground needs the detail
    const geo = new THREE.PlaneGeometry(w, d, Math.ceil(w / cell), Math.ceil(d / cell));
    geo.rotateX(-Math.PI / 2);
    // UVs in meters.
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * d);
    const mesh = this.addMesh(geo, this.materials.grass);
    mesh.position.set(center.x, -0.04, center.z);
    mesh.name = 'Grass';

    const { rapier, world } = this.physics;
    if (this.ground) {
      // Elevated: the plane follows the ground; next to the road it sinks under the
      // level run-off ribbons (exact heights, see buildRoad) so it never pokes through.
      const ground = this.ground;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      // One grid cell beyond the corridor the plane may not rise above the road either,
      // or a triangle spanning the corridor edge would cut through the run-off on a hillside.
      const near = this.barrierOffset + CORRIDOR_BEHIND_BARRIER + cell + 2;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + center.x;
        const z = pos.getZ(i) + center.z;
        const d = ground.distance(x, z);
        let y = ground.height(x, z);
        if (d < near) {
          // Below every road whose corridor this cell could reach (two roads side by side at different heights).
          const road = this.grid.lowestWithin(x, z, near + cell);
          y = Math.min(y, road) - 0.7;
        } else y -= 0.7 * (1 - smoothstepJs(near, near + 14, d));
        pos.setY(i, y);
        uv.setXY(i, x, -z);
      }
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      // Same surface for physics (a car that leaves the run-off lands on it, then gets reset).
      const verts = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) verts.set([pos.getX(i) + center.x, pos.getY(i) - 0.04, pos.getZ(i) + center.z], i * 3);
      world.createCollider(rapier.ColliderDesc.trimesh(verts, new Uint32Array(geo.index!.array)).setFriction(1.0), this.fixedBody());
      return;
    }
    world.createCollider(
      rapier.ColliderDesc.cuboid(w / 2, 1, d / 2).setTranslation(center.x, -1, center.z).setFriction(1.0),
      this.fixedBody(),
    );
  }

  /** Strip along the centerline between two lateral offsets. UVs: u = lateral m, v = distance m. */
  private ribbon(inner: number | ((i: number) => number), outer: number | ((i: number) => number), y: number, opts: RibbonOptions = {}): THREE.BufferGeometry {
    const n = this.points.length;
    const positions: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const innerAt = typeof inner === 'number' ? () => inner : inner;
    const outerAt = typeof outer === 'number' ? () => outer : outer;
    let dist = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const seg = this.points[i].distanceTo(this.points[j]);
      if (!opts.include || opts.include(i)) {
        const [ii, oi, ij, oj] = [innerAt(i), outerAt(i), innerAt(j), outerAt(j)];
        // Level cross-section at the road's height (y = 0 on flat circuits).
        v[0].copy(this.points[i]).addScaledVector(this.rights[i], ii).setY(this.points[i].y + y);
        v[1].copy(this.points[i]).addScaledVector(this.rights[i], oi).setY(this.points[i].y + y);
        v[2].copy(this.points[j]).addScaledVector(this.rights[j], ij).setY(this.points[j].y + y);
        v[3].copy(this.points[j]).addScaledVector(this.rights[j], oj).setY(this.points[j].y + y);
        const c = opts.color?.(i);
        // two triangles, counter-clockwise seen from above (normals +Y)
        for (const k of [0, 1, 2, 1, 3, 2]) {
          positions.push(v[k].x, v[k].y, v[k].z);
          if (opts.worldUv) uvs.push(v[k].x, -v[k].z);
          else uvs.push(k % 2 === 0 ? (k >= 2 ? ij : ii) : k >= 2 ? oj : oi, dist + (k >= 2 ? seg : 0));
          if (c) colors.push(c.r, c.g, c.b);
        }
        if (opts.collide) for (const k of [0, 1, 2, 1, 3, 2]) this.surfaceVerts.push(v[k].x, v[k].y - y, v[k].z);
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
    this.addMesh(this.ribbon(-half, half, 0.02, { collide: this.elevated }), this.materials.asphalt).name = 'Asphalt';

    const lineMat = this.own(new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.7 }));
    this.addMesh(this.ribbon(-half + 0.25, -half + 0.45, 0.03), lineMat);
    this.addMesh(this.ribbon(half - 0.45, half - 0.25, 0.03), lineMat);
    if (this.elevated) this.buildRunoff();
  }

  /**
   * Elevated circuits: level grass run-off from the road edge to just behind
   * the barrier, at the road's exact height (part of the drivable collider),
   * clipped where another part of the circuit is closer. Where the ground
   * falls away beside it (bridge approaches) a retaining wall closes the gap;
   * over the lower road it is a bridge deck with a slab and piers.
   */
  private buildRunoff(): void {
    const n = this.points.length;
    const ground = this.ground!;
    const extent = { [-1]: new Float32Array(n), [1]: new Float32Array(n) } as Record<number, Float32Array>;
    const q = new THREE.Vector3();
    for (const side of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const full = this.corridorAt(side, i);
        let reach = full;
        for (let l = this.half + 1; l <= full; l += 1) {
          q.copy(this.points[i]).addScaledVector(this.rights[i], side * l);
          const hit = this.grid.nearest(q.x, q.z, full + 10, q.y);
          if (hit.index >= 0 && loopGap(hit.index, i, n) > 10) {
            reach = l - 0.5;
            break;
          }
        }
        extent[side][i] = Math.max(reach, this.half);
      }
    }
    const runoff = (side: number) =>
      this.ribbon(
        side < 0 ? (i) => -extent[-1][i] : this.half,
        side < 0 ? -this.half : (i) => extent[1][i],
        -0.005,
        { worldUv: true, collide: true },
      );
    for (const side of [-1, 1]) this.addMesh(runoff(side), this.materials.grass).name = 'Runoff';

    // Retaining walls and bridge decks along the outer edges.
    const concrete = this.own(new THREE.MeshStandardMaterial({ color: 0xb9b5ac, roughness: 0.9 }));
    const pos: number[] = [];
    const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
      for (const v of [a, b, c, a, c, d]) pos.push(v.x, v.y, v.z);
    };
    const edge = (i: number, side: number, out = 0) =>
      this.points[i].clone().addScaledVector(this.rights[i], side * (extent[side][i] + out));
    const DECK = 1.3;
    for (const side of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = edge(i, side);
        const b = edge(j, side);
        if (this.deck[i] || this.deck[j]) {
          // Deck fascia + underside slab (whole width, once per segment from the left side).
          quad(a, b, b.clone().setY(b.y - DECK), a.clone().setY(a.y - DECK));
          if (side < 0) {
            const c = edge(i, 1);
            const d = edge(j, 1);
            quad(a.clone().setY(a.y - DECK), b.clone().setY(b.y - DECK), d.clone().setY(d.y - DECK), c.clone().setY(c.y - DECK));
          }
          continue;
        }
        // Ground just outside the edge: a wall down to it when it is clearly lower.
        const ga = ground.height(...xz(edge(i, side, 0.8)));
        const gb = ground.height(...xz(edge(j, side, 0.8)));
        if (a.y - ga < 0.4 && b.y - gb < 0.4) continue;
        quad(a, b, b.clone().setY(Math.min(b.y, gb) - 0.5), a.clone().setY(Math.min(a.y, ga) - 0.5));
      }
    }
    // Piers under the deck: a pair of columns every ~12 m, standing on the ground below.
    const pierGeo: THREE.BufferGeometry[] = [];
    for (let i = 0; i < n; i += 5) {
      if (!this.deck[i]) continue;
      for (const side of [-1, 1]) {
        const p = this.points[i].clone().addScaledVector(this.rights[i], side * (this.half - 1));
        const g = ground.height(p.x, p.z);
        // Only outside the lower road's corridor (no pillar on its tarmac).
        if (this.grid.nearest(p.x, p.z, this.barrierOffset + 2, g).distSq < (this.barrierOffset + 1.5) ** 2) continue;
        const h = p.y - DECK - g + 0.3;
        if (h < 1) continue;
        pierGeo.push(new THREE.BoxGeometry(1.2, h, 1.2).translate(p.x, g - 0.3 + h / 2, p.z));
      }
    }
    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      const mesh = this.addMesh(geo, concrete);
      mesh.name = 'Walls';
      mesh.castShadow = true;
      concrete.side = THREE.DoubleSide;
    }
    if (pierGeo.length) {
      const merged = mergeGeometries(pierGeo)!;
      pierGeo.forEach((g) => g.dispose());
      const piers = this.addMesh(merged, concrete);
      piers.name = 'BridgePiers';
      piers.castShadow = true;
    }
  }

  /** Trimesh collider of the drivable surface (elevated circuits): road, run-off, pit lane. */
  private buildSurfaceCollider(): void {
    const { rapier, world } = this.physics;
    const verts = new Float32Array(this.surfaceVerts);
    const index = new Uint32Array(verts.length / 3);
    for (let i = 0; i < index.length; i++) index[i] = i;
    world.createCollider(rapier.ColliderDesc.trimesh(verts, index).setFriction(1.0), this.fixedBody());
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

    if (this.street) {
      // Pavement between the road edge and the wall (light stone, a touch above the road).
      const pavement = this.own(new THREE.MeshStandardMaterial({ color: 0xb9b4aa, roughness: 0.85 }));
      const outer = this.barrierOffset + 0.3;
      this.addMesh(this.ribbon(-outer, -half, 0.018), pavement).name = 'Pavement';
      this.addMesh(this.ribbon(half, outer, 0.018), pavement).name = 'Pavement';
    }

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
    // Street circuits: the town (buildings, tall fences) stands right behind the wall.
    const colliderTop = FENCE_TOP + (this.street ? 4 : 0.5);
    const colliderThickness = 1.5;

    // Three W-beam rails in one unit-length geometry (scaled along Z per segment).
    const railParts = [0.42, 0.68, 0.94].map((y) => new THREE.BoxGeometry(0.08, 0.22, 1).translate(0, y, 0));
    const railGeo = this.own(mergeGeometries(railParts)!);
    railParts.forEach((g) => g.dispose());
    const postGeo = this.own(new THREE.BoxGeometry(0.12, 1.06, 0.12).translate(0, 0.53, 0));
    const railMat = this.own(new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.55 }));
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
        // Along the pit lane the pit-side barrier stands behind the lane.
        const offI = this.barrierAt(side, i, offset);
        const offJ = this.barrierAt(side, j, offset);
        a.copy(this.points[i]).addScaledVector(this.rights[i], side * offI);
        b.copy(this.points[j]).addScaledVector(this.rights[j], side * offJ);
        p.addVectors(a, b).multiplyScalar(0.5);
        // Skip pieces that would land on tarmac: inside of hairpins tighter than
        // the barrier offset, or where two parts of the circuit run close together.
        if (this.grid.nearest(p.x, p.z, offI, this.elevated ? p.y : NaN).distSq < (Math.min(offI, offJ) - 1.5) ** 2) continue;
        const len = a.distanceTo(b) + 0.3; // small overlap closes gaps on curves
        q.setFromAxisAngle(UP, Math.atan2(b.x - a.x, b.z - a.z));
        const yawOnly = q.clone();
        // Follow the gradient: pitch about the segment's own X axis (flat circuits: none).
        if (a.y !== b.y) q.multiply(pitchQ.setFromAxisAngle(X_AXIS, -Math.atan2(b.y - a.y, Math.hypot(b.x - a.x, b.z - a.z))));
        const scaled = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, len));
        // Along the pit building its garages are the wall: collider only.
        if (!(side === this.pit?.side && this.pitBuildingAt.has(i))) {
          railMatrices.push(scaled);
          fenceMatrices.push(scaled.clone());
          if (i % 2 === 0) postMatrices.push(new THREE.Matrix4().compose(p, yawOnly, one));
          if (i % 4 === 0) poleMatrices.push(new THREE.Matrix4().compose(p, yawOnly, one));
        }

        c.addVectors(this.rights[i], this.rights[j])
          .setY(0)
          .normalize()
          .multiplyScalar(side * (colliderThickness / 2 - 0.25));
        world.createCollider(
          rapier.ColliderDesc.cuboid(colliderThickness / 2, (colliderTop - colliderBottom) / 2, len / 2)
            .setTranslation(p.x + c.x, p.y + (colliderTop + colliderBottom) / 2, p.z + c.z)
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

  private barrierAt(side: number, i: number, offset: number): number {
    const pit = this.pit;
    if (!pit || side !== pit.side || !pit.inRange(i)) return offset;
    return Math.max(offset, pit.lateralAt(i) + PIT_LANE_WIDTH / 2 + 1.5);
  }

  /** True when `p` is clearly outside the barriers (escaped the circuit). */
  isOutOfBounds(p: THREE.Vector3): boolean {
    if (!this.elevated) return this.grid.nearest(p.x, p.z, this.barrierOffset + OUT_OF_BOUNDS_MARGIN).index < 0;
    // Also out when far below / above the road it is next to (fell off a bridge or an embankment).
    const hit = this.grid.nearest(p.x, p.z, this.barrierOffset + OUT_OF_BOUNDS_MARGIN, p.y);
    if (hit.index < 0) return true;
    const c = this.points[hit.index];
    const lateral = this.lateral(p, hit.index);
    return Math.abs(lateral) > this.barrierAt(Math.sign(lateral) || 1, hit.index, this.barrierOffset) + OUT_OF_BOUNDS_MARGIN || p.y < c.y - 4;
  }

  /** Outer edge of the level run-off on `side` at sample i (elevated circuits). */
  private corridorAt(side: number, i: number): number {
    return this.barrierAt(side, i, this.barrierOffset) + CORRIDOR_BEHIND_BARRIER;
  }

  /**
   * Bridge decks: where the circuit crosses itself, the samples of the upper
   * road that pass over the lower road's corridor. They don't shape the ground,
   * get a deck structure instead of an embankment, and the "same section" tests
   * treat the two roads as unrelated (they are metres apart vertically).
   */
  private findBridges(): void {
    const n = this.points.length;
    this.deck = new Uint8Array(n);
    const pts2 = this.points.map((p) => [p.x, p.z] as [number, number]);
    const crossings = findCrossings(pts2, this.points.map((p) => p.y));
    const reach = this.barrierOffset + CORRIDOR_BEHIND_BARRIER + 8;
    for (const c of crossings) {
      const lower = this.points[c.lower];
      for (let k = -60; k <= 60; k++) {
        const i = (c.upper + k + n) % n;
        const p = this.points[i];
        // Distance from this upper sample to the lower road's centerline (nearby lower samples).
        let d = Infinity;
        for (let m = -40; m <= 40; m++) {
          const q = this.points[(c.lower + m + n) % n];
          d = Math.min(d, Math.hypot(p.x - q.x, p.z - q.z));
        }
        if (d < reach && p.y - lower.y > SAME_LEVEL) this.deck[i] = 1;
      }
    }
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
    strip.position.set(p.x, p.y + (this.elevated ? 0.06 : 0.035), p.z);
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
    // Five pairs of start lights on a black pod, facing the grid (behind the line, -Z).
    const pod = new THREE.Mesh(this.own(new THREE.BoxGeometry(4.6, 1.9, 0.5)), beamMat);
    pod.position.set(0, 7, -0.55);
    gantry.add(pod);
    for (let k = -2; k <= 2; k++)
      for (const y of [6.6, 7.4]) {
        const l = new THREE.Mesh(lightGeo, lightMat);
        l.position.set(k * 0.85, y, -0.85);
        gantry.add(l);
      }
    gantry.position.set(p.x, p.y, p.z);
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
  /** True for points inside (or just behind) the pit building, where OSM's own pit box would clash. */
  private behindPitBuilding(x: number, z: number): boolean {
    const pit = this.pit;
    if (!pit) return false;
    // Cheap reject far from the circuit (nearestIndex brute-forces there).
    if (this.clearance(x, z, 130) === Infinity) return false;
    const p = new THREE.Vector3(x, 0, z);
    const i = this.nearestIndex2D(x, z);
    if (!this.pitBuildingAt.has(i)) return false;
    const lat = this.lateral(p, i) * pit.side;
    return lat > 0 && lat < pit.lateralAt(i) + PIT_BUILDING_FRONT + PIT_BUILDING_DEPTH + PADDOCK_DEPTH;
  }

  /**
   * Approximate distance (m) to the circuit anywhere around it (unlike
   * `clearance`, which only searches nearby): a 20 m raster, brute force over
   * every 4th centerline sample, built once.
   */
  private distanceField(margin: number): (x: number, z: number) => number {
    const cell = 20;
    const x0 = this.bounds.min.x - margin;
    const z0 = this.bounds.min.z - margin;
    const w = Math.ceil((this.bounds.max.x - this.bounds.min.x + 2 * margin) / cell);
    const h = Math.ceil((this.bounds.max.z - this.bounds.min.z + 2 * margin) / cell);
    const field = new Float32Array(w * h);
    const pts = this.points.filter((_, i) => i % 4 === 0);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const x = x0 + (i + 0.5) * cell;
        const z = z0 + (j + 0.5) * cell;
        let best = Infinity;
        for (const p of pts) best = Math.min(best, (p.x - x) ** 2 + (p.z - z) ** 2);
        field[j * w + i] = Math.sqrt(best);
      }
    return (x, z) => {
      const i = Math.floor((x - x0) / cell);
      const j = Math.floor((z - z0) / cell);
      if (i < 0 || j < 0 || i >= w || j >= h) return margin;
      return field[j * w + i];
    };
  }

  private buildScenery(data: OsmData): [number, number][] {
    const result = buildOsmScenery(data, {
      clearance: (x, z) => this.clearance(x, z),
      distance: this.distanceField(2000),
      nearestPoint: (x, z) => {
        const p = this.points[this.nearestIndex2D(x, z)];
        return { x: p.x, z: p.z };
      },
      minClearance: this.barrierOffset + 2,
      exclude: (x, z) => this.behindPitBuilding(x, z) || this.isReserved(x, z),
      asphalt: this.materials.asphalt,
      rand: mulberry32(4242),
    });
    this.disposables.push(...result.disposables);
    // Elevated circuits: buildings, roads, car parks, props onto the real slope.
    if (this.ground) drapeObject(result.group, this.ground.height);
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

  /** Grandstands at the circuit's famous corners (where OSM maps none), on the preferred side when it fits. */
  private placeFamousStands(stands: readonly StandSpec[]): TribuneSpec[] {
    const n = this.points.length;
    const out: TribuneSpec[] = [];
    for (const spec of stands) {
      const i = Math.round(spec.at / this.layout.sampleSpacing) % n;
      const t = this.tangents[i];
      const r = this.rights[i];
      for (const side of [spec.side, -spec.side]) {
        if (this.pitBuildingAt.has(i) && side === this.pit?.side) continue;
        const off = this.barrierAt(side, i, this.barrierOffset) + 6 + spec.depth / 2;
        const center = this.points[i].clone().addScaledVector(r, side * off);
        if (!this.isClear(center, t, r, spec.length, spec.depth)) continue;
        // Front (local -X) towards the track: direction -side * r.
        const fx = -side * r.x;
        const fz = -side * r.z;
        out.push({ x: center.x, z: center.z, yaw: Math.atan2(fz, -fx), length: spec.length, depth: spec.depth, height: spec.height });
        break;
      }
    }
    return out;
  }

  /** Inside a reserved footprint (famous grandstand + margin)? */
  private isReserved(x: number, z: number): boolean {
    for (const r of this.reserved) {
      const dx = x - r.x;
      const dz = z - r.z;
      // Tribune local axes: X = depth (away from the track), Z = length; rotation.y = yaw.
      const lx = dx * Math.cos(r.yaw) - dz * Math.sin(r.yaw);
      const lz = dx * Math.sin(r.yaw) + dz * Math.cos(r.yaw);
      if (Math.abs(lx) < r.hd && Math.abs(lz) < r.hl) return true;
    }
    return false;
  }

  private buildFerrisWheel(spec: { at: number; side: number; distance: number }): void {
    const n = this.points.length;
    const i = Math.round(spec.at / this.layout.sampleSpacing) % n;
    const r = this.rights[i];
    const p = this.points[i].clone().addScaledVector(r, spec.side * spec.distance);
    const y = this.ground ? this.ground.height(p.x, p.z) : 0;
    // Wheel plane facing the track.
    const wheel = buildFerrisWheel(p.x, y, p.z, Math.atan2(-spec.side * r.x, -spec.side * r.z));
    wheel.group.traverse((o) => (o.userData.cullDistance = 6000));
    this.disposables.push(...wheel.disposables);
    this.root.add(wheel.group);
    this.animations.push(wheel.update);
    // Keep the park's trees and buildings off its base.
    this.reserved.push({ x: p.x, z: p.z, yaw: 0, hl: 40, hd: 40 });
  }

  /** Stepped grandstand + its seated crowd. */
  private addTribune(spec: TribuneSpec, rand: () => number): void {
    if (!this.standMaterials) {
      this.standMaterials = {
        concrete: this.own(new THREE.MeshStandardMaterial({ color: 0xbdb8ae, roughness: 0.9 })),
        seats: this.own(new THREE.MeshStandardMaterial({ color: 0x2a5fb0, roughness: 0.7, vertexColors: true })),
        roof: this.own(new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5, metalness: 0.3 })),
      };
    }
    if (this.ground && spec.y === undefined) {
      // Stand on the lowest corner of its footprint (the slope disappears under the steps).
      const c = Math.cos(spec.yaw);
      const s = Math.sin(spec.yaw);
      let low = Infinity;
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
        [0, 0],
      ]) {
        const lx = (a * spec.depth) / 2;
        const lz = (b * spec.length) / 2;
        low = Math.min(low, this.ground.height(spec.x + c * lx + s * lz, spec.z - s * lx + c * lz));
      }
      spec = { ...spec, y: low - 0.2 };
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
          this.crowdSeats.push({ matrix: new THREE.Matrix4().compose(p.clone().setY((this.ground?.height(p.x, p.z) ?? 0) + 0.25), q, one), color });
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

const smoothstepJs = (e0: number, e1: number, x: number) => {
  const k = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return k * k * (3 - 2 * k);
};

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
