import type * as THREE from 'three';
import type { VehicleConfig } from '../vehicle/VehicleConfig';
import { powerAt } from '../vehicle/Ers';

/**
 * Minimum-lap-time racing line (refines the minimum-curvature line).
 *
 * Minimum curvature is the classic outside-inside-outside geometry, but it
 * treats every corner alike. Real lines trade a tighter slow corner for a
 * straighter exit onto a long straight. This does exactly that numerically:
 * lateral offsets at control points every CTRL samples are moved left/right
 * (coordinate descent, shrinking steps) and a move is kept when the lap time
 * of the quasi-steady-state speed profile (the same tyre + aero model the
 * game uses, as in TUMFTM's laptime-simulation) goes down.
 *
 * Expensive (~seconds): baked offline by scripts/bake-raceline.ts.
 */
const G = 9.81;
const CORNER_MARGIN = 0.8;
const BRAKE_MARGIN = 0.8;
const CTRL = 8;

export interface MinTimeInput {
  points: readonly THREE.Vector3[];
  rights: readonly THREE.Vector3[];
  halfWidth: number;
  /** Starting offsets (e.g. the minimum-curvature line), one per sample. */
  start: Float64Array;
  margin?: number;
}

export function lapTime(cx: Float64Array, cz: Float64Array, car: VehicleConfig, out?: Float64Array): number {
  const n = cx.length;
  const seg = new Float64Array(n);
  for (let i = 0; i < n; i++) seg[i] = Math.hypot(cx[(i + 1) % n] - cx[i], cz[(i + 1) % n] - cz[i]);
  const raw = new Float64Array(n);
  const k = 3;
  for (let i = 0; i < n; i++) {
    const a = (i - k + n) % n;
    const c = (i + k) % n;
    const ab = Math.hypot(cx[i] - cx[a], cz[i] - cz[a]);
    const bc = Math.hypot(cx[c] - cx[i], cz[c] - cz[i]);
    const ca = Math.hypot(cx[c] - cx[a], cz[c] - cz[a]);
    const cross = Math.abs((cx[i] - cx[a]) * (cz[c] - cz[a]) - (cz[i] - cz[a]) * (cx[c] - cx[a]));
    raw[i] = ab * bc * ca > 1e-9 ? (2 * cross) / (ab * bc * ca) : 0;
  }
  const mu = Math.min(car.frontFriction, car.rearFriction);
  const aero = car.downforce / car.mass;
  const v = out ?? new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -3; j <= 3; j++) s += raw[(i + j + n) % n];
    const kappa = s / 7;
    const denom = kappa - CORNER_MARGIN * mu * aero;
    v[i] = denom > 1e-6 ? Math.min(car.maxSpeed, Math.sqrt((CORNER_MARGIN * mu * G) / denom)) : car.maxSpeed;
  }
  const brakeAt = (s: number) => BRAKE_MARGIN * mu * (G + aero * s * s);
  const accelAt = (s: number) => {
    const vv = Math.max(s, 1);
    const drive = Math.min(car.engineForce, powerAt(car, vv) / vv, mu * G * car.mass * 0.6);
    return Math.max((drive - car.dragCoefficient * vv * vv) / car.mass - car.rollingResistance * G, 0.05);
  };
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * accelAt(v[i]) * seg[i]));
    }
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * brakeAt(v[j]) * seg[i]));
    }
  }
  let t = 0;
  for (let i = 0; i < n; i++) t += seg[i] / Math.max(v[i], 1);
  return t;
}

/**
 * @param evaluate lap time of a closed [x, z] path; defaults to the built-in
 *   model. The bake script passes the game's own RacingLine model so the
 *   optimizer cannot exploit differences between two speed models.
 */
export function optimizeMinTime(
  input: MinTimeInput,
  car: VehicleConfig,
  log?: (msg: string) => void,
  evaluate?: (path: [number, number][]) => number,
): { path: [number, number][]; before: number; after: number } {
  const { points, rights } = input;
  const n = points.length;
  const limit = Math.max(input.halfWidth - (input.margin ?? 1.6), 0);
  const m = Math.floor(n / CTRL);
  // Control offsets sampled from the start line; samples interpolate between them (smooth enough
  // at 20 m spacing; the curvature filter in lapTime() smooths the rest).
  const ctrl = new Float64Array(m);
  for (let k = 0; k < m; k++) ctrl[k] = input.start[k * CTRL];
  const cx = new Float64Array(n);
  const cz = new Float64Array(n);
  const build = () => {
    for (let k = 0; k < m; k++) {
      // Catmull-Rom through the control offsets: smooth (C1) so the line has no
      // kinks the lap-time model could exploit.
      const p0 = ctrl[(k - 1 + m) % m];
      const p1 = ctrl[k];
      const p2 = ctrl[(k + 1) % m];
      const p3 = ctrl[(k + 2) % m];
      const i0 = k * CTRL;
      const span = k + 1 < m ? CTRL : n - i0;
      for (let s = 0; s < span; s++) {
        const t = s / span;
        const off = 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
        const i = i0 + s;
        cx[i] = points[i].x + off * rights[i].x;
        cz[i] = points[i].z + off * rights[i].z;
      }
    }
  };
  const pathOf = () => Array.from({ length: n }, (_, i) => [cx[i], cz[i]] as [number, number]);
  const time = () => (evaluate ? evaluate(pathOf()) : lapTime(cx, cz, car));
  build();
  const before = time();
  let best = before;
  for (const step of [1.2, 0.6, 0.3, 0.15]) {
    for (let pass = 0; pass < 6; pass++) {
      let improved = 0;
      for (let k = 0; k < m; k++) {
        const orig = ctrl[k];
        for (const d of [step, -step]) {
          ctrl[k] = Math.max(-limit + 0.3, Math.min(limit - 0.3, orig + d));
          if (ctrl[k] === orig) continue;
          build();
          const t = time();
          if (t < best - 1e-4) {
            best = t;
            improved++;
            break;
          }
          ctrl[k] = orig;
        }
      }
      log?.(`  step ${step} m pass ${pass + 1}: ${best.toFixed(3)} s (${improved} moves)`);
      if (!improved) break;
    }
  }
  build();
  const path: [number, number][] = [];
  for (let i = 0; i < n; i++) path.push([+cx[i].toFixed(2), +cz[i].toFixed(2)]);
  return { path, before, after: best };
}
