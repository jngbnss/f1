import * as THREE from 'three';
import type { VehicleConfig } from '../vehicle/VehicleConfig';
import { smooth } from '../vehicle/cars/shapes';

const G = 9.81;
/** Share of the tyre limit the line plans with in corners / under braking (measured skidpad ≈ 0.8–0.95). */
const CORNER_MARGIN = 0.8;
const BRAKE_MARGIN = 0.8;
/** How far ahead of the car the line reacts to the current speed (m). */
const LOOKAHEAD = 400;

export interface RacingLineOptions {
  /** Ribbon width (m). */
  width?: number;
  /** Sample spacing (m). */
  spacing?: number;
  /** Road height per path point (elevated circuits, see Track.heightsFor). */
  heights?: readonly number[];
}

const GREEN = new THREE.Color(0x2bd56f);
const YELLOW = new THREE.Color(0xffd23f);
const RED = new THREE.Color(0xff3b30);
/** Alpha of the line inside the look-ahead window; outside it is invisible. */
const ALPHA = 0.8;

/**
 * Forza-style driving assist line drawn on the road.
 *
 * Path: the racing line from RacingLineOptimizer (minimum curvature on the
 * game's road width + late apexes). A speed profile is computed for the
 * selected car (aero-dependent cornering limit + power/drag acceleration and
 * braking passes).
 *
 * Coloring is dynamic: for every point ahead of the car we check whether the
 * car's *current* speed can still be braked down to the target speed there:
 *   red    = too fast, brake now
 *   yellow = brake soon
 *   green  = safe at this speed
 * Slow down and the line ahead turns green. Points further than LOOKAHEAD
 * and behind the car are hidden, like the assist line in racing games.
 */
export class RacingLine {
  readonly mesh: THREE.Mesh;
  /** Target speed (m/s) per sample — usable for AI drivers later. */
  readonly speeds: Float32Array;
  readonly points: THREE.Vector3[];

  private readonly colors: Float32Array;
  private readonly colorAttr: THREE.BufferAttribute;
  /** Distance from sample i to i+1. */
  private readonly segLen: Float32Array;
  /** Braking deceleration (m/s²) available at a speed (aero adds grip). */
  readonly brakeAt: (speed: number) => number;
  private carIndex = -1;
  private readonly tmp = new THREE.Color();

  /** Road height per path point (undefined = flat circuit). */
  readonly heights: readonly number[] | undefined;

  constructor(
    readonly path: readonly [number, number][],
    car: VehicleConfig,
    options: RacingLineOptions = {},
  ) {
    const width = options.width ?? 0.9;
    const spacing = options.spacing ?? 2;
    this.heights = options.heights;
    const heights = options.heights;

    const ctrl = path.map(([x, z], k) => new THREE.Vector3(x, heights ? heights[k] : 0, z));
    const curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal');
    curve.arcLengthDivisions = Math.max(200, ctrl.length * 10);
    const n = Math.max(16, Math.round(curve.getLength() / spacing));
    const pts = curve.getSpacedPoints(n);
    pts.pop();
    this.points = pts;
    const count = pts.length;
    this.segLen = new Float32Array(count);
    for (let i = 0; i < count; i++) this.segLen[i] = pts[i].distanceTo(pts[(i + 1) % count]);

    // --- curvature (circumscribed circle through neighbors, smoothed) -----
    const raw = new Float32Array(count);
    const k = 3; // ~6 m chord, less noisy than adjacent samples
    for (let i = 0; i < count; i++) {
      const a = pts[(i - k + count) % count];
      const b = pts[i];
      const c = pts[(i + k) % count];
      const ab = a.distanceTo(b);
      const bc = b.distanceTo(c);
      const ca = c.distanceTo(a);
      const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      raw[i] = ab * bc * ca > 1e-6 ? (2 * cross) / (ab * bc * ca) : 0;
    }
    const curvature = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let s = 0;
      for (let j = -3; j <= 3; j++) s += raw[(i + j + count) % count];
      curvature[i] = s / 7;
    }

    // --- speed profile (same physics as VehiclePhysics) -------------------
    // Tyre limit grows with aero load: a(v) = k·μ·(g + downforce·v²/m).
    const mu = Math.min(car.frontFriction, car.rearFriction);
    const aero = car.downforce / car.mass;
    const km = CORNER_MARGIN;
    this.brakeAt = (speed) => BRAKE_MARGIN * mu * (G + aero * speed * speed);
    const accelAt = (speed: number) => {
      const vv = Math.max(speed, 1);
      const traction = mu * G * car.mass * 0.6; // rear-axle share
      const drive = Math.min(car.engineForce, car.enginePower / vv, traction);
      return Math.max((drive - car.dragCoefficient * vv * vv) / car.mass - car.rollingResistance * G, 0.05);
    };
    // Elevation: gradient (gravity along the road) and vertical curvature (a crest
    // unloads the tyres, a compression like Eau Rouge loads them). Zero when flat.
    const grade = new Float32Array(count);
    const vertical = new Float32Array(count);
    if (heights) {
      for (let i = 0; i < count; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % count];
        grade[i] = (b.y - a.y) / Math.max(Math.hypot(b.x - a.x, b.z - a.z), 0.1);
      }
      const k = 5;
      const raw = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const a = pts[(i - k + count) % count];
        const c = pts[(i + k) % count];
        const h = (k * spacing) ** 2;
        raw[i] = (a.y - 2 * pts[i].y + c.y) / h;
      }
      for (let i = 0; i < count; i++) {
        let s = 0;
        for (let j = -4; j <= 4; j++) s += raw[(i + j + count) % count];
        vertical[i] = s / 9;
      }
    }
    const vMax = car.maxSpeed;
    const v = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // v² = kμg / (κ − kμ·(aero + κ_vertical)); if the aero term wins, the corner is flat out.
      const denom = curvature[i] - km * mu * (aero + vertical[i]);
      v[i] = denom > 1e-6 ? Math.min(vMax, Math.sqrt((km * mu * G) / denom)) : vMax;
    }
    // Two laps of each pass so the closed loop converges.
    for (let lap = 0; lap < 2; lap++) {
      for (let i = 0; i < count; i++) {
        const j = (i + 1) % count;
        const a = accelAt(v[i]) - G * grade[i];
        v[j] = Math.min(v[j], Math.sqrt(Math.max(v[i] * v[i] + 2 * a * this.segLen[i], 1)));
      }
      for (let i = count - 1; i >= 0; i--) {
        const j = (i + 1) % count;
        const b = Math.max(this.brakeAt(v[j]) + BRAKE_MARGIN * mu * vertical[j] * v[j] * v[j] + G * grade[i], 1);
        v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * b * this.segLen[i]));
      }
    }
    this.speeds = v;

    // --- ribbon geometry -------------------------------------------------
    const positions = new Float32Array(count * 2 * 3);
    this.colors = new Float32Array(count * 2 * 4); // RGBA: alpha hides the line outside the window
    const right = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const p = pts[i];
      right.subVectors(pts[(i + 1) % count], pts[(i - 1 + count) % count]).cross(THREE.Object3D.DEFAULT_UP).normalize();
      for (let s = 0; s < 2; s++) {
        const o = (i * 2 + s) * 3;
        const side = s === 0 ? -width / 2 : width / 2;
        positions[o] = p.x + right.x * side;
        positions[o + 1] = p.y + 0.05;
        positions[o + 2] = p.z + right.z * side;
      }
      this.setColor(i, GREEN, 0);
    }
    const index: number[] = [];
    for (let i = 0; i < count; i++) {
      const a = i * 2;
      const b = ((i + 1) % count) * 2;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.colorAttr = new THREE.BufferAttribute(this.colors, 4);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('color', this.colorAttr);
    geo.setIndex(index);

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'RacingLine';
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
  }

  /** Recolor the line ahead of the car for its current speed (call once per frame). */
  update(carPosition: THREE.Vector3, carSpeed: number): void {
    if (!this.mesh.visible) return;
    const count = this.points.length;
    const prev = this.carIndex;
    this.carIndex = this.findIndex(carPosition);

    this.colorAttr.clearUpdateRanges();
    // Hide the previous window again.
    if (prev >= 0) this.paintWindow(prev, () => GREEN, () => 0);

    const speed = Math.max(carSpeed, 0);
    let dist = 0;
    this.paintWindow(this.carIndex, (j, step) => {
      if (step > 0) dist += this.segLen[(j - 1 + count) % count];
      // Highest speed we may carry *now* and still brake to the target speed at j.
      const allowed = Math.sqrt(this.speeds[j] ** 2 + 2 * this.brakeAt(this.speeds[j]) * dist);
      const ratio = speed / allowed;
      if (ratio <= 0.9) return GREEN;
      if (ratio <= 1) return this.tmp.copy(GREEN).lerp(YELLOW, (ratio - 0.9) / 0.1);
      return this.tmp.copy(YELLOW).lerp(RED, Math.min((ratio - 1) / 0.06, 1));
    });
    this.colorAttr.needsUpdate = true;
  }

  /** Nearest sample to `p`, searching around `hint` first (pass -1 for a full search). */
  nearestFrom(p: THREE.Vector3, hint: number): number {
    const count = this.points.length;
    const dist = (i: number) => (this.points[i].x - p.x) ** 2 + (this.points[i].z - p.z) ** 2;
    let best = -1;
    let bestD = Infinity;
    if (hint >= 0) {
      for (let k = -30; k <= 50; k++) {
        const i = (hint + k + count) % count;
        const d = dist(i);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (bestD < 25 * 25) return best;
    }
    for (let i = 0; i < count; i++) {
      const d = dist(i);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Distance (m) between consecutive samples i -> i+1. */
  segmentLength(i: number): number {
    return this.segLen[i % this.points.length];
  }

  /** Ideal lap time (s) of the computed speed profile. */
  get idealLapTime(): number {
    let t = 0;
    for (let i = 0; i < this.points.length; i++) t += this.segLen[i] / Math.max(this.speeds[i], 1);
    return t;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  // --------------------------------------------------------------------

  /**
   * Paints the look-ahead window starting at `start`. Default alpha starts a
   * few meters ahead of the car (so the line doesn't sit under it) and fades
   * out towards the end of the window.
   */
  private paintWindow(
    start: number,
    color: (j: number, step: number) => THREE.Color,
    alpha: (dist: number) => number = (d) => ALPHA * smooth(2, 8, d) * (1 - smooth(LOOKAHEAD * 0.7, LOOKAHEAD, d)),
  ): void {
    const count = this.points.length;
    let dist = 0;
    let steps = 0;
    for (; dist < LOOKAHEAD && steps < count; steps++) {
      const j = (start + steps) % count;
      this.setColor(j, color(j, steps), alpha(dist));
      dist += this.segLen[j];
    }
    // Upload only the touched samples (8 floats each), split at the wrap-around.
    const first = Math.min(steps, count - start);
    this.colorAttr.addUpdateRange(start * 8, first * 8);
    if (steps > first) this.colorAttr.addUpdateRange(0, (steps - first) * 8);
  }

  private setColor(i: number, c: THREE.Color, a: number): void {
    const o = i * 8;
    this.colors[o] = this.colors[o + 4] = c.r;
    this.colors[o + 1] = this.colors[o + 5] = c.g;
    this.colors[o + 2] = this.colors[o + 6] = c.b;
    this.colors[o + 3] = this.colors[o + 7] = a;
  }

  /** Nearest sample: local search around the last index, full search if lost. */
  private findIndex(p: THREE.Vector3): number {
    const count = this.points.length;
    const dist = (i: number) => (this.points[i].x - p.x) ** 2 + (this.points[i].z - p.z) ** 2;
    let best = -1;
    let bestD = Infinity;
    if (this.carIndex >= 0) {
      for (let k = -40; k <= 60; k++) {
        const i = (this.carIndex + k + count) % count;
        const d = dist(i);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (bestD < 30 * 30) return best;
    }
    for (let i = 0; i < count; i++) {
      const d = dist(i);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
}
