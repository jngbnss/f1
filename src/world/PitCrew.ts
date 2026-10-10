import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PitStops } from '../race/PitStops';
import type { Vehicle } from '../vehicle/Vehicle';
import { BOX_LANE_SHIFT, type PitLaneData } from './PitLane';

/**
 * Pit crews, F1-game style but light: per box four wheel-gun men, four tyre
 * carriers, a front and a rear jack man and a release man with a lollipop
 * (red while the car is serviced, green on release). They wait in front of
 * the garage, step out as their car swings into the box, crouch at the wheels
 * while it is up on the jacks, and walk back once it has gone.
 *
 * All boxes share three instanced meshes (crew, tyres, lollipops): ~3 draw calls.
 */
const CREW = 11;
const GUN = 0;
const CARRY = 4;
const FRONT_JACK = 8;
const REAR_JACK = 9;
const RELEASE = 10;
/** Path samples before the box at which the crew steps out (~30 m). */
const STEP_OUT = 12;
/** Car lifted by the jacks (m). */
const LIFT = 0.06;

interface BoxState {
  /** 0 = waiting at the garage, 1 = in service positions. */
  out: number;
  /** Anchor pose the service positions are laid out around (eases towards the car). */
  pos: THREE.Vector3;
  yaw: number;
  /** Seconds since the last car was released (crew lingers, then walks back). */
  sinceRelease: number;
  wasStopped: boolean;
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
const UP = new THREE.Vector3(0, 1, 0);
/** Hidden instances go far below the ground (a zero scale gives NaN normals, which bloom spreads over the screen). */
const HIDDEN = -1000;
const AXLE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);

/**
 * A crew member, low-poly but human: shoes, legs, hips, torso, arms, gloves, neck and a
 * helmet with a dark visor. Vertex shades are multiplied by the team colour per instance:
 * suit 1, trousers 0.04 (linear: a near-black team colour), gloves 0.2, shoes and visor ~0.08. Faces -Z, feet at y = 0.
 */
function crewGeometry(pose: 'stand' | 'kneel'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, shade: number) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng !== g) g.dispose();
    const n = ng.getAttribute('position').count;
    ng.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(shade), 3));
    ng.deleteAttribute('uv');
    parts.push(ng);
  };
  const _from = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  /** A rounded limb (cylinder with ball ends) between two points. */
  const limb = (from: [number, number, number], to: [number, number, number], r: number, shade: number) => {
    _from.set(...from);
    _dir.set(...to).sub(_from);
    const len = _dir.length();
    const g = new THREE.CylinderGeometry(r, r * 0.9, len, 7);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), _dir.clone().normalize()));
    g.translate(_from.x + _dir.x / 2, _from.y + _dir.y / 2, _from.z + _dir.z / 2);
    add(g, shade);
    add(new THREE.SphereGeometry(r, 7, 5).translate(...to), shade);
  };
  const box = (w: number, h: number, d: number, at: [number, number, number], shade: number, tiltX = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (tiltX) g.rotateX(tiltX);
    add(g.translate(...at), shade);
  };
  const SUIT = 1;
  const TROUSERS = 0.04;
  const GLOVES = 0.2;
  const DARK = 0.08;
  if (pose === 'stand') {
    for (const x of [-0.11, 0.11]) {
      box(0.12, 0.08, 0.27, [x, 0.04, -0.04], DARK);
      limb([x, 0.1, 0], [x, 0.9, 0], 0.075, TROUSERS);
      // Arms reach forward (carrying, holding the car): shoulder -> elbow -> hand.
      limb([x * 2.4, 1.44, 0], [x * 2.6, 1.15, -0.12], 0.058, SUIT);
      limb([x * 2.6, 1.15, -0.12], [x * 1.9, 1.05, -0.38], 0.052, SUIT);
      add(new THREE.SphereGeometry(0.06, 6, 5).translate(x * 1.9, 1.05, -0.42), GLOVES);
    }
    box(0.36, 0.18, 0.22, [0, 0.95, 0], TROUSERS);
    box(0.44, 0.52, 0.27, [0, 1.27, 0], SUIT);
    limb([0, 1.52, 0], [0, 1.58, 0], 0.06, TROUSERS);
    add(new THREE.SphereGeometry(0.155, 10, 8).translate(0, 1.7, 0), SUIT * 0.95);
    box(0.22, 0.07, 0.06, [0, 1.71, -0.13], DARK);
  } else {
    // One knee down at the wheel, leaning in, wheel gun held in both hands.
    box(0.12, 0.08, 0.27, [0.11, 0.04, -0.42], DARK);
    limb([0.11, 0.52, 0], [0.11, 0.48, -0.42], 0.08, TROUSERS); // right thigh, forward
    limb([0.11, 0.48, -0.42], [0.11, 0.08, -0.42], 0.07, TROUSERS); // right shin, down
    limb([-0.11, 0.52, 0], [-0.11, 0.08, 0.06], 0.08, TROUSERS); // left thigh, knee on the ground
    limb([-0.11, 0.08, 0.06], [-0.11, 0.06, 0.44], 0.07, TROUSERS); // left shin, back along the ground
    box(0.36, 0.18, 0.22, [0, 0.55, 0], TROUSERS);
    box(0.44, 0.5, 0.27, [0, 0.86, -0.1], SUIT, -0.35);
    for (const x of [-0.11, 0.11]) {
      limb([x * 2.4, 1.02, -0.17], [x * 2.2, 0.8, -0.38], 0.058, SUIT);
      limb([x * 2.2, 0.8, -0.38], [x * 0.9, 0.72, -0.6], 0.052, SUIT);
      add(new THREE.SphereGeometry(0.06, 6, 5).translate(x * 0.9, 0.72, -0.63), GLOVES);
    }
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.34, 8).rotateX(Math.PI / 2).translate(0, 0.72, -0.75), DARK); // wheel gun
    limb([0, 1.08, -0.2], [0, 1.13, -0.24], 0.06, TROUSERS);
    add(new THREE.SphereGeometry(0.155, 10, 8).translate(0, 1.25, -0.3), SUIT * 0.95);
    box(0.22, 0.07, 0.06, [0, 1.25, -0.43], DARK, -0.35);
  }
  const g = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  return g;
}

export class PitCrew {
  readonly group = new THREE.Group();
  /** Standing and kneeling crew (each instance lives in one of the two; the other copy is hidden). */
  private readonly crew: THREE.InstancedMesh;
  private readonly kneeling: THREE.InstancedMesh;
  private readonly tyres: THREE.InstancedMesh;
  private readonly lollipops: THREE.InstancedMesh;
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
    const crewGeo = crewGeometry('stand');
    const kneelGeo = crewGeometry('kneel');
    const crewMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
    this.crew = new THREE.InstancedMesh(crewGeo, crewMat, n * CREW);
    this.kneeling = new THREE.InstancedMesh(kneelGeo, crewMat, n * CREW);
    const color = new THREE.Color();
    for (let b = 0; b < n; b++)
      for (let c = 0; c < CREW; c++) {
        color.setHex(teamColors[b % teamColors.length]);
        this.crew.setColorAt(b * CREW + c, color);
        this.kneeling.setColorAt(b * CREW + c, color);
      }
    const tyreGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.36, 14);
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.9 });
    this.tyres = new THREE.InstancedMesh(tyreGeo, tyreMat, n * 4);
    const pole = new THREE.CylinderGeometry(0.025, 0.025, 1.3, 6).translate(0, 0.65, 0);
    const disc = new THREE.CylinderGeometry(0.2, 0.2, 0.03, 16).rotateX(Math.PI / 2).translate(0, 1.38, 0);
    const lollipopGeo = mergeGeometries([pole.toNonIndexed(), disc.toNonIndexed()])!;
    pole.dispose();
    disc.dispose();
    const lollipopMat = new THREE.MeshStandardMaterial({ roughness: 0.5 });
    this.lollipops = new THREE.InstancedMesh(lollipopGeo, lollipopMat, n);
    for (const mesh of [this.crew, this.kneeling, this.tyres, this.lollipops]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.disposables.push(crewGeo, kneelGeo, crewMat, tyreGeo, tyreMat, lollipopGeo, lollipopMat);
    this.boxes = pit.boxes.map((k) => {
      const yaw = this.pathYaw(k);
      return { out: 0, pos: this.boxCentre(k, new THREE.Vector3()), yaw, sinceRelease: 99, wasStopped: false };
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

  /** Per frame, after the cars have been rendered (lifts the car on the jacks). */
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
      st.wasStopped = stopped;
      st.sinceRelease += dt;
      // Out while a car arrives / is serviced and for a moment after it leaves.
      const wantOut = s || st.sinceRelease < 1.6 ? 1 : 0;
      st.out = THREE.MathUtils.clamp(st.out + Math.sign(wantOut - st.out) * dt * 1.4, 0, 1);
      // Anchor: the stopped car itself, else the box.
      if (stopped) {
        const ease = 1 - Math.exp(-dt * 8);
        st.pos.lerp(_a.copy(s.vehicle.position), ease);
        const yaw = this.pathYaw(k);
        st.yaw += (yaw - st.yaw) * ease;
      } else if (!s && st.sinceRelease > 1.6) {
        this.boxCentre(k, st.pos);
        st.yaw = this.pathYaw(k);
      }
      const tau = stopped ? s.timer : 0;
      const service = stopped ? s.service : 1;
      const up = stopped && tau > 0.15 && tau < service - 0.15;
      if (up) s.vehicle.object3D.position.y += LIFT;
      this.layoutBox(b, st, k, stopped, tau, s?.vehicle ?? null);
      // Lollipop: red while the car is serviced, green as it is released.
      this.lollipops.setColorAt(b, color.setHex(stopped && tau < service ? 0xe02020 : 0x22c55e));
    });
    for (const mesh of [this.crew, this.kneeling, this.tyres, this.lollipops]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Places one box's crew, tyres and lollipop. */
  private layoutBox(b: number, st: BoxState, k: number, stopped: boolean, tau: number, car: Vehicle | null): void {
    const out = st.out * st.out * (3 - 2 * st.out);
    const walking = st.out > 0.02 && st.out < 0.98;
    _q.setFromAxisAngle(UP, st.yaw);
    const wheels = car?.config.wheels;
    const idle = this.boxCentre(k, _b);
    const outward = this.pit.outward[k];
    /** Car-local point (x right, z back) to world. */
    const local = (x: number, z: number, target: THREE.Vector3) => target.set(x, 0, z).applyQuaternion(_q).add(st.pos);
    const place = (i: number, x: number, z: number, crouch: boolean, faceYaw: number) => {
      // Waiting spot: a row in front of the garage, facing the lane.
      const along = (i - (CREW - 1) / 2) * 1.05;
      _a.copy(idle).addScaledVector(outward, 2.7);
      _p.set(0, 0, along).applyQuaternion(_q);
      _a.add(_p);
      local(x, z, _p);
      _p.lerp(_a, 1 - out);
      const bob = walking ? Math.abs(Math.sin(this.time * 9 + i)) * 0.05 : 0;
      _p.y = THREE.MathUtils.lerp(_a.y, st.pos.y, out) - 0.02 + bob;
      const yaw = THREE.MathUtils.lerp(Math.atan2(-outward.x, -outward.z) + Math.PI, faceYaw, out);
      // Kneeling once in place at the wheel; the unused pose is parked below the ground.
      const kneel = crouch && out > 0.9;
      const shown = _m.compose(_p, new THREE.Quaternion().setFromAxisAngle(UP, yaw), _s.setScalar(0.95)).clone();
      _p.y = HIDDEN;
      const hidden = _m.compose(_p, _q, _s.setScalar(1));
      this.crew.setMatrixAt(b * CREW + i, kneel ? hidden : shown);
      this.kneeling.setMatrixAt(b * CREW + i, kneel ? shown : hidden);
      if (!kneel) _m.copy(shown);
    };
    const yaw = st.yaw;
    for (let w = 0; w < 4; w++) {
      const wp = wheels?.[w]?.position ?? { x: w % 2 ? 0.8 : -0.8, z: w < 2 ? -1.7 : 1.7 };
      const side = Math.sign(wp.x) || 1;
      // Gun man crouched at the wheel, facing it.
      place(GUN + w, wp.x + side * 0.6, wp.z, true, yaw - side * (Math.PI / 2));
      // Carrier: holds the new tyre, fits it (~0.9 s in), then steps back with the old one.
      const back = stopped && tau > 0.9 ? 0.8 : 0;
      place(CARRY + w, wp.x + side * (1.25 + back), wp.z + (w < 2 ? -0.45 : 0.45), false, yaw - side * (Math.PI / 2));
      this.crew.getMatrixAt(b * CREW + CARRY + w, _m);
      _p.setFromMatrixPosition(_m);
      const show = st.out > 0.3;
      _a.set(-side * 0.35, 0.95, 0).applyQuaternion(_q);
      _p.add(_a);
      if (!show) _p.y = HIDDEN;
      _m.compose(_p, _q.clone().multiply(AXLE), _s.setScalar(1));
      this.tyres.setMatrixAt(b * 4 + w, _m);
    }
    place(FRONT_JACK, 0, -3.5, stopped, yaw);
    place(REAR_JACK, 0, 3.2, stopped, yaw + Math.PI);
    // Release man ahead of the car on the garage side, lollipop in front of the driver.
    place(RELEASE, 1.4, -4.6, false, yaw + Math.PI);
    this.crew.getMatrixAt(b * CREW + RELEASE, _m);
    _p.setFromMatrixPosition(_m);
    _a.set(-0.45, 0, 0.3).applyQuaternion(_q);
    _p.add(_a);
    if (st.out <= 0.5) _p.y = HIDDEN;
    _m.compose(_p, _q, _s.setScalar(1));
    this.lollipops.setMatrixAt(b, _m);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
