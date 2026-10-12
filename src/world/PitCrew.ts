import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PitStops } from '../race/PitStops';
import { COMPOUND_COLORS } from '../vehicle/cars/GltfF1Visual';
import type { Compound } from '../vehicle/Tyres';
import type { Vehicle } from '../vehicle/Vehicle';
import { WHEEL_OFF } from '../vehicle/VehicleVisual';
import { BOX_LANE_SHIFT, type PitLaneData } from './PitLane';

/**
 * Pit crews, as at a modern F1 stop: per box, at each wheel a gun man, a man who takes
 * the old wheel off and one who fits the new one; a front jack man with the long nose
 * jack, a rear jack man, two stabilisers holding the car level at the sidepods and a
 * release man under the overhead light gantry (no lollipop since 2011). They wait in front
 * of the garage and sprint out as their car swings into the box. The stop, in about two
 * seconds:
 *   jacks up -> the car's wheels slide off and are carried away -> new wheels (compound
 *   stripe on the sidewall) go on -> wheel guns -> jacks down, front jack pulled aside ->
 *   gantry light red to green, go. Then the crew jogs back.
 * The car's own wheels move (VehicleVisual.setWheelOffset); off the hub a crew wheel takes
 * over.
 *
 * All boxes share instanced meshes (crew standing / kneeling in team colour and in fixed
 * colours, wheels, compound stripes, jacks, gantries, lights): ~10 draw calls.
 */
const CREW = 17;
const GUN = 0;
const OFF = 4;
const ON = 8;
const FRONT_JACK = 12;
const REAR_JACK = 13;
const RELEASE = 14;
const STABILISER = 15; // two: left, right
/** Path samples before the box at which the crew steps out (~30 m). */
const STEP_OUT = 12;
/** Car lifted by the jacks (m). */
const LIFT = 0.07;
/** How fast the crew runs out / back (share of the way per second). */
const RUN = 2.4;
/** Stop timeline (s after the car stops; each wheel a few hundredths later or earlier). */
const T = { liftUp: [0.08, 0.3], off: [0.36, 0.7], carry: [0.7, 1.2], on: [0.78, 1.12], gun: [1.12, 1.45] } as const;
/** Before the release (s before the end of service): jacks down, front jack pulled aside, green light. */
const T_DOWN = [0.5, 0.3] as const;
const T_ASIDE = [0.32, 0.06] as const;
const T_GO = [0.15, 0] as const;
const STAGGER = [0, 0.05, 0.09, 0.03];
/** Old wheel slid this far off before it is carried away (m); the new one is held this far out. */
const OFF_DIST = 0.7;
const HOLD_DIST = 1.05;
/** The crew stays out this long after the release (s). */
const LINGER = 1.2;
/** Car-local nose / gearbox ends where the jacks go under (m). */
const NOSE_Z = -2.8;
const TAIL_Z = 2.6;
/** Overhead light gantry: height of the light box and its distance ahead of the box centre (m). */
const GANTRY_H = 2.5;
const GANTRY_Z = -2.6;
/** Gantry pole: this far to the garage side of the car's centreline (m). */
const GANTRY_X = 2.4;

/** 0..1 progress of t through [a, b], smoothed. */
function phase(t: number, [a, b]: readonly [number, number]): number {
  const x = THREE.MathUtils.clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
}

interface BoxState {
  /** 0 = waiting at the garage, 1 = in service positions. */
  out: number;
  /** Anchor pose the service positions are laid out around (eases towards the car). */
  pos: THREE.Vector3;
  yaw: number;
  /** Seconds since the last car was released (crew lingers, then walks back). */
  sinceRelease: number;
  wasStopped: boolean;
  /** The car being serviced (its wheels go back on their hubs when it leaves). */
  car: Vehicle | null;
  /** Compound of the set coming off (noted as the car arrives) and of the new set. */
  oldCompound: Compound;
  newCompound: Compound;
}

export interface PitCrewSnapshot {
  vehicle: Vehicle;
  phase: 'in' | 'stopped' | 'out';
  box: number;
  k: number;
  timer: number;
  service: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _lean = new THREE.Quaternion();
const _face = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
/** Hidden instances go far below the ground (a zero scale gives NaN normals, which bloom spreads over the screen). */
const HIDDEN = -1000;
const AXLE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const HIDDEN_MATRIX = new THREE.Matrix4().makeTranslation(0, HIDDEN, 0);

type Vec3 = [number, number, number];

/**
 * A crew member in a fire suit: the team-coloured parts (top, darker trousers, helmet)
 * and the fixed-colour ones (black gloves, shoes and visor, white chest band, wheel gun)
 * as two geometries, so each box's crew wears its team colour. Faces -Z, feet at y = 0.
 */
function crewGeometry(pose: 'stand' | 'kneel'): { team: THREE.BufferGeometry; fixed: THREE.BufferGeometry } {
  const team: THREE.BufferGeometry[] = [];
  const fixed: THREE.BufferGeometry[] = [];
  const _col = new THREE.Color();
  /** Team part: shade multiplies the team colour. Fixed part: its own colour. */
  const add = (g: THREE.BufferGeometry, shade: number, own?: number) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng !== g) g.dispose();
    const n = ng.getAttribute('position').count;
    if (own === undefined) _col.setRGB(shade, shade, shade);
    else _col.setHex(own);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([_col.r, _col.g, _col.b], i * 3);
    ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
    ng.deleteAttribute('uv');
    (own === undefined ? team : fixed).push(ng);
  };
  const _from = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  /** A rounded limb (capsule) between two points. */
  const limb = (from: Vec3, to: Vec3, r: number, shade: number, own?: number) => {
    _from.set(...from);
    _dir.set(...to).sub(_from);
    const len = Math.max(_dir.length() - 0.0001, 0.001);
    const g = new THREE.CapsuleGeometry(r, len, 3, 8);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), _dir.clone().normalize()));
    g.translate(_from.x + _dir.x / 2, _from.y + _dir.y / 2, _from.z + _dir.z / 2);
    add(g, shade, own);
  };
  /** Rounded torso block: a capsule squashed to a chest's width and depth. */
  const torso = (at: Vec3, tiltX: number, h: number) => {
    const g = new THREE.CapsuleGeometry(0.16, h, 4, 12).scale(1.3, 1, 0.78);
    g.rotateX(tiltX).translate(...at);
    add(g, 1);
    // Sponsor band across the chest, side panels in the darker team tone.
    const band = new THREE.BoxGeometry(0.34, 0.07, 0.03).translate(0, 0.08, -0.13).rotateX(tiltX).translate(...at);
    add(band, 1, 0xf2f2f2);
    for (const x of [-0.2, 0.2]) add(new THREE.BoxGeometry(0.03, h * 0.9, 0.2).rotateX(tiltX).translate(at[0] + x, at[1], at[2]), 0.06);
  };
  const shoe = (at: Vec3) => add(new THREE.CapsuleGeometry(0.05, 0.18, 2, 6).rotateX(Math.PI / 2).scale(1.15, 1, 1).translate(...at), 1, 0x151515);
  /** Helmet (team colour) with a dark visor band and a white stripe over the top. */
  const helmet = (at: Vec3, tiltX: number) => {
    const h = new THREE.SphereGeometry(0.15, 14, 10).scale(1, 1.08, 1.05);
    add(h.rotateX(tiltX).translate(...at), 0.95);
    const visor = new THREE.SphereGeometry(0.155, 14, 4, Math.PI * 1.5 - 0.95, 1.9, 1.3, 0.42).scale(1, 1.08, 1.05);
    add(visor.rotateX(tiltX).translate(...at), 1, 0x0b0d10);
    const stripe = new THREE.SphereGeometry(0.153, 4, 8, -0.1, 0.2, 0, 1.2).scale(1, 1.08, 1.05);
    add(stripe.rotateX(tiltX).translate(...at), 1, 0xf2f2f2);
  };
  const TROUSERS = 0.05;
  const GLOVE = 0x18191b;
  if (pose === 'stand') {
    for (const x of [-0.1, 0.1]) {
      shoe([x, 0.05, -0.05]);
      limb([x, 0.1, 0], [x, 0.5, 0.01], 0.07, TROUSERS);
      limb([x, 0.5, 0.01], [x * 1.1, 0.92, 0], 0.082, TROUSERS);
      // Arms reach forward (carrying, holding the car): shoulder -> elbow -> hand.
      limb([x * 2.1, 1.42, 0], [x * 2.4, 1.16, -0.1], 0.056, 1);
      limb([x * 2.4, 1.16, -0.1], [x * 1.8, 1.06, -0.38], 0.05, 0.85);
      add(new THREE.SphereGeometry(0.058, 8, 6).scale(1, 0.8, 1.2).translate(x * 1.8, 1.05, -0.43), 1, GLOVE);
    }
    add(new THREE.CapsuleGeometry(0.14, 0.12, 3, 10).rotateZ(Math.PI / 2).scale(1, 1, 0.75).translate(0, 0.95, 0), TROUSERS);
    torso([0, 1.24, 0], 0, 0.26);
    limb([0, 1.47, 0], [0, 1.57, 0], 0.055, 1, 0x18191b);
    helmet([0, 1.69, 0], 0);
  } else {
    // One knee down at the wheel, leaning in, wheel gun held in both hands.
    shoe([0.11, 0.05, -0.47]);
    shoe([-0.11, 0.06, 0.5]);
    limb([0.11, 0.52, 0], [0.11, 0.48, -0.42], 0.082, TROUSERS); // right thigh, forward
    limb([0.11, 0.48, -0.42], [0.11, 0.1, -0.44], 0.07, TROUSERS); // right shin, down
    limb([-0.11, 0.52, 0], [-0.11, 0.09, 0.06], 0.082, TROUSERS); // left thigh, knee on the ground
    limb([-0.11, 0.09, 0.06], [-0.11, 0.07, 0.44], 0.07, TROUSERS); // left shin, back along the ground
    add(new THREE.CapsuleGeometry(0.14, 0.12, 3, 10).rotateZ(Math.PI / 2).scale(1, 1, 0.75).translate(0, 0.56, 0), TROUSERS);
    torso([0, 0.86, -0.1], -0.4, 0.24);
    for (const x of [-0.1, 0.1]) {
      limb([x * 2.1, 1.02, -0.18], [x * 2.2, 0.8, -0.38], 0.056, 1);
      limb([x * 2.2, 0.8, -0.38], [x * 0.9, 0.72, -0.6], 0.05, 0.85);
      add(new THREE.SphereGeometry(0.058, 8, 6).translate(x * 0.9, 0.72, -0.63), 1, GLOVE);
    }
    // Wheel gun: body, handle and the socket towards the wheel nut, with its air hose trailing.
    add(new THREE.CylinderGeometry(0.055, 0.06, 0.3, 10).rotateX(Math.PI / 2).translate(0, 0.73, -0.72), 1, 0x2a2d31);
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 8).rotateX(Math.PI / 2).translate(0, 0.73, -0.9), 1, 0xb8bcc2);
    add(new THREE.BoxGeometry(0.05, 0.14, 0.05).translate(0, 0.64, -0.64), 1, 0x2a2d31);
    limb([0, 0.62, -0.6], [0.05, 0.05, -0.2], 0.018, 1, 0x101010);
    limb([0, 1.07, -0.22], [0, 1.13, -0.26], 0.055, 1, 0x18191b);
    helmet([0, 1.24, -0.32], -0.4);
  }
  const merge = (list: THREE.BufferGeometry[]) => {
    const g = mergeGeometries(list)!;
    for (const p of list) p.dispose();
    return g;
  };
  return { team: merge(team), fixed: merge(fixed) };
}

/** Front jack: long lever handle and a wide foot that goes under the nose. Handle end at z = 0, foot at z = +1.35. */
function jackGeometry(): THREE.BufferGeometry {
  const parts = [
    new THREE.CylinderGeometry(0.03, 0.03, 1.5, 8).rotateX(0.55 - Math.PI / 2).translate(0, 0.52, 0.66),
    new THREE.BoxGeometry(0.5, 0.08, 0.22).translate(0, 0.12, 1.35),
    new THREE.CylinderGeometry(0.06, 0.06, 0.1, 10).rotateZ(Math.PI / 2).translate(0.2, 0.06, 1.25),
    new THREE.CylinderGeometry(0.06, 0.06, 0.1, 10).rotateZ(Math.PI / 2).translate(-0.2, 0.06, 1.25),
  ].map((g) => g.toNonIndexed());
  const g = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  return g;
}

/**
 * Overhead release gantry for one box, built for the garage on the car's right (+x):
 * pole, boom over the car and the light box facing the driver (+z). Mirrored per box.
 */
function gantryGeometry(): { frame: THREE.BufferGeometry; lights: THREE.BufferGeometry } {
  const frame = [
    new THREE.CylinderGeometry(0.06, 0.08, GANTRY_H + 0.3, 10).translate(GANTRY_X, (GANTRY_H + 0.3) / 2, 0),
    new THREE.BoxGeometry(GANTRY_X + 0.2, 0.1, 0.1).translate(GANTRY_X / 2, GANTRY_H + 0.25, 0),
    new THREE.BoxGeometry(0.75, 0.32, 0.16).translate(0, GANTRY_H, 0),
    new THREE.CylinderGeometry(0.25, 0.25, 0.04, 16).translate(GANTRY_X, 0.02, 0),
  ].map((g) => g.toNonIndexed());
  // Lamps on both faces: the driver sees one side, the TV camera ahead of the box the other.
  const lights = [-0.2, 0.2].flatMap((x) => [0.085, -0.085].map((z) => new THREE.CircleGeometry(0.11, 16).translate(x, GANTRY_H, z).toNonIndexed()));
  const out = { frame: mergeGeometries(frame)!, lights: mergeGeometries(lights)! };
  for (const p of [...frame, ...lights]) p.dispose();
  return out;
}

export class PitCrew {
  readonly group = new THREE.Group();
  /** Standing and kneeling crew, team-coloured and fixed-colour parts (an instance shows in one pose; the other is parked below ground). */
  private readonly crew: THREE.InstancedMesh[];
  private readonly kneeling: THREE.InstancedMesh[];
  /** Per box: four old wheels (off the car) and four new ones, each with its compound stripe. */
  private readonly wheels: THREE.InstancedMesh;
  private readonly stripes: THREE.InstancedMesh;
  /** Per box: front and rear jack. */
  private readonly jacks: THREE.InstancedMesh;
  private readonly gantries: THREE.InstancedMesh;
  private readonly lights: THREE.InstancedMesh;
  private readonly boxes: BoxState[];
  private readonly disposables: { dispose(): void }[] = [];
  private time = 0;
  /** Called once per stop when the car is released, with the stationary time (s). */
  onRelease: ((v: Vehicle, seconds: number) => void) | null = null;

  constructor(
    private readonly pit: PitLaneData,
    teamColors: number[],
  ) {
    this.group.name = 'PitCrew';
    const n = pit.boxes.length;
    const stand = crewGeometry('stand');
    const kneel = crewGeometry('kneel');
    const teamMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62 });
    const fixedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 });
    this.crew = [new THREE.InstancedMesh(stand.team, teamMat, n * CREW), new THREE.InstancedMesh(stand.fixed, fixedMat, n * CREW)];
    this.kneeling = [new THREE.InstancedMesh(kneel.team, teamMat, n * CREW), new THREE.InstancedMesh(kneel.fixed, fixedMat, n * CREW)];
    const color = new THREE.Color();
    for (let b = 0; b < n; b++)
      for (let c = 0; c < CREW; c++) {
        color.setHex(teamColors[b % teamColors.length]);
        this.crew[0].setColorAt(b * CREW + c, color);
        this.kneeling[0].setColorAt(b * CREW + c, color);
      }
    // A wheel the size of the car's (0.36 m radius): black tyre, grey rim faces on both sides,
    // and a compound-coloured stripe on each sidewall (own mesh, coloured per instance).
    const shade = (g: THREE.BufferGeometry, v: number) => {
      const ng = g.toNonIndexed();
      g.dispose();
      ng.setAttribute('color', new THREE.Float32BufferAttribute(new Array(ng.getAttribute('position').count * 3).fill(v), 3));
      ng.deleteAttribute('uv');
      return ng;
    };
    const tyre = shade(new THREE.CylinderGeometry(0.36, 0.36, 0.38, 24), 0.04);
    const rim = shade(new THREE.CylinderGeometry(0.235, 0.235, 0.385, 18), 0.22);
    const nut = shade(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 8), 0.6);
    const wheelGeo = mergeGeometries([tyre, rim, nut])!;
    for (const g of [tyre, rim, nut]) g.dispose();
    const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.25 });
    this.wheels = new THREE.InstancedMesh(wheelGeo, wheelMat, n * 8);
    const ring = (y: number) => new THREE.TorusGeometry(0.3, 0.014, 4, 32).rotateX(Math.PI / 2).translate(0, y, 0).toNonIndexed();
    const rings = [ring(0.193), ring(-0.193)];
    const stripeGeo = mergeGeometries(rings)!;
    for (const g of rings) g.dispose();
    const stripeMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
    this.stripes = new THREE.InstancedMesh(stripeGeo, stripeMat, n * 8);
    const jackGeo = jackGeometry();
    const jackMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.4, metalness: 0.6 });
    this.jacks = new THREE.InstancedMesh(jackGeo, jackMat, n * 2);
    const gantry = gantryGeometry();
    const gantryMat = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.5, metalness: 0.5, side: THREE.DoubleSide });
    this.gantries = new THREE.InstancedMesh(gantry.frame, gantryMat, n);
    const lightMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
    this.lights = new THREE.InstancedMesh(gantry.lights, lightMat, n);
    for (const mesh of [...this.crew, ...this.kneeling, this.wheels, this.stripes, this.jacks, this.gantries, this.lights]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.disposables.push(
      stand.team, stand.fixed, kneel.team, kneel.fixed, teamMat, fixedMat, wheelGeo, wheelMat, stripeGeo, stripeMat,
      jackGeo, jackMat, gantry.frame, gantry.lights, gantryMat, lightMat,
    );
    this.boxes = pit.boxes.map((k) => {
      const yaw = this.pathYaw(k);
      return { out: 0, pos: this.boxCentre(k, new THREE.Vector3()), yaw, sinceRelease: 99, wasStopped: false, car: null, oldCompound: 'medium', newCompound: 'medium' };
    });
    // The gantries stand still: placed once, mirrored to the garage side of each box.
    pit.boxes.forEach((k, b) => {
      const centre = this.boxCentre(k, new THREE.Vector3());
      const q = new THREE.Quaternion().setFromAxisAngle(UP, this.pathYaw(k));
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const garage = Math.sign(right.dot(pit.outward[k])) || 1;
      const at = new THREE.Vector3(0, 0, GANTRY_Z).applyQuaternion(q).add(centre);
      const m = new THREE.Matrix4().compose(at, q, new THREE.Vector3(garage, 1, 1));
      this.gantries.setMatrixAt(b, m);
      this.lights.setMatrixAt(b, m);
      this.lights.setColorAt(b, color.setHex(0x1a0505));
    });
  }

  private pathYaw(k: number): number {
    const p = this.pit.path;
    const a = p[Math.max(0, k - 1)];
    const b = p[Math.min(p.length - 1, k + 1)];
    // Car forward is -Z (as Track.poseAt).
    return Math.atan2(-(b.x - a.x), -(b.z - a.z));
  }

  private boxCentre(k: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pit.path[k]).addScaledVector(this.pit.outward[k], BOX_LANE_SHIFT);
  }

  /** Per frame, after the cars have been rendered (lifts the car on the jacks, moves its wheels). */
  update(dt: number, pitStops: PitStops): void {
    this.time += dt;
    const pit = this.pit;
    // The car each box is working on: the one stopped there, else the nearest one arriving.
    const active: (PitCrewSnapshot | null)[] = pit.boxes.map(() => null);
    for (const s of pitStops.snapshots()) {
      const k = pit.boxes[s.box];
      const cur = active[s.box];
      if (s.phase === 'stopped') active[s.box] = s;
      else if (s.phase === 'in' && s.k >= k - STEP_OUT && cur?.phase !== 'stopped' && (!cur || s.k > cur.k)) active[s.box] = s;
    }
    const color = new THREE.Color();
    pit.boxes.forEach((k, b) => {
      const st = this.boxes[b];
      const s = active[b];
      const stopped = s?.phase === 'stopped';
      if (st.wasStopped && !stopped) {
        st.sinceRelease = 0;
        const done = pitStops.lastService(b);
        if (done) this.onRelease?.(done.vehicle, done.seconds);
      }
      if (st.car && st.car !== (stopped ? s.vehicle : null)) {
        for (let w = 0; w < 4; w++) st.car.visual.setWheelOffset?.(w, 0);
        st.car = null;
      }
      // The set coming off is the one the car arrives on; the new set is fitted as it stops.
      if (s?.phase === 'in') st.oldCompound = s.vehicle.tyres.compound;
      if (stopped) {
        st.car = s.vehicle;
        st.newCompound = s.vehicle.tyres.compound;
      }
      st.wasStopped = stopped;
      st.sinceRelease += dt;
      // Out while a car arrives / is serviced and for a moment after it leaves.
      const wantOut = s || st.sinceRelease < LINGER ? 1 : 0;
      st.out = THREE.MathUtils.clamp(st.out + Math.sign(wantOut - st.out) * dt * RUN, 0, 1);
      // Anchor: the stopped car itself, else the box. Always at the box's ground height: the
      // car's position is its chassis centre, ~0.6 m up, and a crew placed there worked in mid-air.
      if (stopped) {
        const ease = 1 - Math.exp(-dt * 8);
        st.pos.lerp(_a.copy(s.vehicle.position).setY(this.boxCentre(k, _b).y), ease);
        const yaw = this.pathYaw(k);
        st.yaw += (yaw - st.yaw) * ease;
      } else if (!s && st.sinceRelease > LINGER) {
        this.boxCentre(k, st.pos);
        st.yaw = this.pathYaw(k);
      }
      const tau = stopped ? s.timer : 0;
      const service = stopped ? s.service : 1;
      let up = 0;
      if (stopped) {
        // Up on the jacks, down again just before the release.
        up = phase(tau, T.liftUp) * (1 - phase(tau, [service - T_DOWN[0], service - T_DOWN[1]]));
        s.vehicle.object3D.position.y += LIFT * up;
        s.vehicle.object3D.updateMatrixWorld(true);
      }
      this.layoutBox(b, st, k, tau, service, up, stopped ? s.vehicle : null);
      // Release light: red while the car is serviced, green as it is released, dark otherwise.
      const go = stopped && tau >= service - T_GO[0];
      this.lights.setColorAt(b, color.setHex(stopped ? (go ? 0x2cff6a : 0xff2020) : st.sinceRelease < LINGER ? 0x2cff6a : 0x1a0505));
    });
    for (const mesh of [...this.crew, ...this.kneeling, this.wheels, this.stripes, this.jacks, this.lights]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Places one box's crew, wheels and jacks. `car`: the car stopped in the box; `up`: 0..1 on the jacks. */
  private layoutBox(b: number, st: BoxState, k: number, tau: number, service: number, up: number, car: Vehicle | null): void {
    const out = st.out * st.out * (3 - 2 * st.out);
    const running = st.out > 0.02 && st.out < 0.98;
    _q.setFromAxisAngle(UP, st.yaw);
    const idle = this.boxCentre(k, _b);
    const outward = this.pit.outward[k];
    const waitY = idle.y;
    const groundY = THREE.MathUtils.lerp(waitY, st.pos.y, out);
    const garageYaw = Math.atan2(-outward.x, -outward.z) + Math.PI;
    // Garage side in car-local x (the release man and the gantry pole stand there).
    const garage = Math.sign(_c.set(1, 0, 0).applyQuaternion(_q).dot(outward)) || 1;
    /** Car-local point (x right, z back) to world. */
    const local = (x: number, z: number, target: THREE.Vector3) => target.set(x, 0, z).applyQuaternion(_q).add(st.pos);
    /**
     * Crew member i at car-local (x, z), or (part way) at his waiting spot in front of the garage.
     * `faceYaw`: the direction he faces at work, as a car yaw (yaw = the way the car points).
     */
    const place = (i: number, x: number, z: number, crouch: boolean, faceYaw: number) => {
      const along = (i - (CREW - 1) / 2) * 0.75;
      _a.copy(this.pit.path[k]).addScaledVector(outward, BOX_LANE_SHIFT + 2.7);
      _a.add(_p.set(0, 0, along).applyQuaternion(_q));
      local(x, z, _p);
      _p.lerp(_a, 1 - out);
      // Running: a bouncing stride, leaning into it.
      const bob = running ? Math.abs(Math.sin(this.time * 14 + i * 1.7)) * 0.09 : 0;
      _p.y = groundY - 0.02 + bob;
      // Turn the short way round from facing the lane to facing his job.
      const turn = Math.atan2(Math.sin(faceYaw - garageYaw), Math.cos(faceYaw - garageYaw));
      _face.setFromAxisAngle(UP, garageYaw + turn * out);
      if (running) _face.multiply(_lean.setFromAxisAngle(X_AXIS, -0.22));
      // Kneeling once in place at the wheel, only with a car there (after the release they stand up);
      // the unused pose is parked below the ground.
      const kneel = crouch && car !== null && out > 0.9;
      _m.compose(_p, _face, _s.setScalar(0.95));
      for (let part = 0; part < 2; part++) {
        this.crew[part].setMatrixAt(b * CREW + i, kneel ? HIDDEN_MATRIX : _m);
        this.kneeling[part].setMatrixAt(b * CREW + i, kneel ? _m : HIDDEN_MATRIX);
      }
    };
    const yaw = st.yaw;
    const carQ = car ? car.object3D.quaternion : _q;
    const wheels = car?.config.wheels;
    const color = new THREE.Color();
    for (let w = 0; w < 4; w++) {
      const wp = wheels?.[w]?.position ?? { x: w % 2 ? 0.8 : -0.8, z: w < 2 ? -1.8 : 1.8 };
      const side = Math.sign(wp.x) || 1;
      const end = wp.z < 0 ? -1 : 1; // towards the nose / the gearbox
      const t = tau - STAGGER[w];
      const off = car ? phase(t, T.off) : 0;
      const carry = car ? phase(t, T.carry) : 0;
      const on = car ? phase(t, T.on) : 0;
      // The car's wheel: slides off, then the new one slides on.
      const slide = !car ? 0 : on > 0 ? HOLD_DIST * (1 - on) : OFF_DIST * off;
      car?.visual.setWheelOffset?.(w, slide);
      // Gun man kneels by the wheel, towards the middle of the car; leans in while the gun runs.
      const gun = car && t > T.gun[0] && t < T.gun[1] ? 0.12 + Math.sin(this.time * 70) * 0.015 : 0;
      place(GUN + w, wp.x + side * (0.62 - gun), wp.z - end * 0.62, true, yaw + side * (Math.PI / 2) + end * side * 0.6);
      // Off man takes the old wheel and carries it back towards the garage; on man pushes the new one on.
      place(OFF + w, wp.x + side * (OFF_DIST + 0.75 + 1.6 * carry), wp.z + end * 0.4, false, yaw + side * (Math.PI / 2));
      place(ON + w, wp.x + side * (HOLD_DIST * (1 - on) + 0.75), wp.z - end * 0.15, false, yaw + side * (Math.PI / 2));

      // Crew wheels at hub height, axle across the car.
      const hub = car?.visual.wheelHub ? car.visual.wheelHub(w, _b) : local(wp.x, wp.z, _b).setY(st.pos.y + 0.36);
      _c.set(side, 0, 0).applyQuaternion(carQ).setY(0).normalize();
      _q2.copy(carQ).multiply(AXLE);
      // Old wheel: once off the hub, in the off man's hands, then set down by the garage.
      _p.copy(hub).addScaledVector(_c, OFF_DIST + 1.6 * carry);
      _p.y += 0.25 * Math.sin(Math.PI * Math.min(carry * 1.2, 1));
      if (!car || off * OFF_DIST < WHEEL_OFF) _p.y = HIDDEN;
      _m.compose(_p, _q2, _s.setScalar(1));
      this.wheels.setMatrixAt(b * 8 + w, _m);
      this.stripes.setMatrixAt(b * 8 + w, _m);
      this.stripes.setColorAt(b * 8 + w, color.setHex(COMPOUND_COLORS[st.oldCompound]));
      // New wheel: held out at hub height (in the on man's hands while he runs out) until it is on the hub.
      _p.copy(hub).addScaledVector(_c, car ? HOLD_DIST * (1 - on) : HOLD_DIST);
      if (!car) _p.y = groundY + 0.4;
      if (st.out < 0.3 || (car && HOLD_DIST * (1 - on) < WHEEL_OFF)) _p.y = HIDDEN;
      _m.compose(_p, _q2, _s.setScalar(1));
      this.wheels.setMatrixAt(b * 8 + 4 + w, _m);
      this.stripes.setMatrixAt(b * 8 + 4 + w, _m);
      this.stripes.setColorAt(b * 8 + 4 + w, color.setHex(COMPOUND_COLORS[car ? st.newCompound : st.oldCompound]));
    }
    // Stabilisers: one each side at the sidepods, hands on the car, keeping it level on the jacks.
    place(STABILISER, -1.25, 0.1, false, yaw - Math.PI / 2);
    place(STABILISER + 1, 1.25, 0.1, false, yaw + Math.PI / 2);
    // Front jack man ahead of the nose with the long jack; he pulls it out to the side before the release.
    const aside = car ? phase(tau, [service - T_ASIDE[0], service - T_ASIDE[1]]) : st.sinceRelease < LINGER ? 1 : 0;
    const fx = -garage * 1.9 * aside;
    place(FRONT_JACK, fx, NOSE_Z - 1.85 + 0.3 * aside, false, yaw + Math.PI);
    place(REAR_JACK, 0, TAIL_Z + 1.75, false, yaw);
    // Release man under the gantry on the garage side, watching the lane.
    place(RELEASE, garage * (GANTRY_X - 0.5), GANTRY_Z - 0.4, false, yaw + Math.PI - garage * 0.6);
    // Jacks: under the nose / gearbox while the crew is in place; the lever handle drops as the car goes up.
    const jacksOut = st.out > 0.97 && (car !== null || st.sinceRelease < LINGER);
    const tilt = 0.25 * up;
    // Front: handle end at the jack man's hands, foot under the nose (pulled aside with him).
    local(fx, NOSE_Z - 1.4, _p).setY(jacksOut ? groundY : HIDDEN);
    _q2.copy(_q).multiply(_lean.setFromAxisAngle(X_AXIS, tilt));
    this.jacks.setMatrixAt(b * 2, _m.compose(_p, _q2, _s.setScalar(1)));
    // Rear: same jack turned round, from behind the gearbox.
    local(0, TAIL_Z + 1.35, _p).setY(jacksOut && car ? groundY : HIDDEN);
    _q2.copy(_q).multiply(_lean.setFromAxisAngle(UP, Math.PI)).multiply(_face.setFromAxisAngle(X_AXIS, tilt));
    this.jacks.setMatrixAt(b * 2 + 1, _m.compose(_p, _q2, _s.setScalar(1)));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
