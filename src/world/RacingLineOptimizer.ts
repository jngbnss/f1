import type * as THREE from 'three';

export interface RacingLineInput {
  /** Closed centerline samples (driving order, roughly even spacing). */
  points: readonly THREE.Vector3[];
  /** Unit right vectors per sample. */
  rights: readonly THREE.Vector3[];
  /** Half of the road width (m). */
  halfWidth: number;
  /** Distance kept from the road edge (m): about half a car plus a little. */
  margin?: number;
  /** How far apexes are pushed later in slow corners (m). 0 = pure minimum curvature. */
  lateApex?: number;
}

/**
 * Racing line on the actual (game) road width.
 *
 * 1. Minimum curvature: lateral offsets α_i ∈ [-w, w] minimizing Σ|p_{i-1} − 2p_i + p_{i+1}|²,
 *    solved by projected Gauss-Seidel, coarse to fine (multigrid-style) so long
 *    corners converge. This gives the classic outside–inside–outside line.
 * 2. Late apex: in slow corners the offset profile is shifted later along the
 *    track, so the car turns in later, clips the apex after the geometric middle
 *    and straightens the exit ("slow in, fast out").
 *
 * Returns closed [x, z] points in driving order.
 */
export function optimizeRacingLine(input: RacingLineInput): [number, number][] {
  const shifted = minCurvatureOffsets(input);
  const out: [number, number][] = [];
  for (let i = 0; i < input.points.length; i++) out.push([input.points[i].x + shifted[i] * input.rights[i].x, input.points[i].z + shifted[i] * input.rights[i].z]);
  return out;
}

/** Lateral offsets (m, + = right) of the minimum-curvature + late-apex line, one per sample. */
export function minCurvatureOffsets(input: RacingLineInput): Float64Array {
  const { points, rights } = input;
  const n = points.length;
  const limit = Math.max(input.halfWidth - (input.margin ?? LINE_MARGIN), 0);
  const cx = Float64Array.from(points, (p) => p.x);
  const cz = Float64Array.from(points, (p) => p.z);
  const rx = Float64Array.from(rights, (r) => r.x);
  const rz = Float64Array.from(rights, (r) => r.z);
  const alpha = new Float64Array(n);

  // Coarse to fine: stride 16 → 1. Each level starts from the previous solution.
  for (const stride of [16, 8, 4, 2, 1]) {
    const m = Math.floor(n / stride);
    if (m < 8) continue;
    const idx = (k: number) => (((k % m) + m) % m) * stride;
    const sweeps = stride === 1 ? 400 : 300;
    for (let it = 0; it < sweeps; it++) {
      for (let k = 0; k < m; k++) {
        const i = idx(k);
        const a2 = idx(k - 2);
        const a1 = idx(k - 1);
        const b1 = idx(k + 1);
        const b2 = idx(k + 2);
        const px = (j: number) => cx[j] + alpha[j] * rx[j];
        const pz = (j: number) => cz[j] + alpha[j] * rz[j];
        // Terms of the three second differences that contain p_i, with p_i = c_i + α r_i.
        const ax = px(a2) - 2 * px(a1) + cx[i];
        const az = pz(a2) - 2 * pz(a1) + cz[i];
        const bx = px(a1) + px(b1) - 2 * cx[i];
        const bz = pz(a1) + pz(b1) - 2 * cz[i];
        const ex = cx[i] - 2 * px(b1) + px(b2);
        const ez = cz[i] - 2 * pz(b1) + pz(b2);
        const ri = rx[i];
        const rj = rz[i];
        const next = (2 * (ri * bx + rj * bz) - (ri * ax + rj * az) - (ri * ex + rj * ez)) / 6;
        alpha[i] = Math.max(-limit, Math.min(limit, next));
      }
    }
    // Fill the in-between samples for the next (finer) level.
    if (stride > 1) {
      for (let k = 0; k < m; k++) {
        const i0 = k * stride;
        const i1 = k + 1 < m ? (k + 1) * stride : 0;
        const span = k + 1 < m ? stride : n - i0;
        for (let s = 1; s < span; s++) alpha[(i0 + s) % n] = alpha[i0] + ((alpha[i1] - alpha[i0]) * s) / span;
      }
    }
  }

  const lateApex = input.lateApex ?? 6;
  return lateApex > 0 ? shiftApexes(alpha, cx, cz, rx, rz, lateApex) : alpha;
}

/** Curvature (1/m) of the line through the given offsets, lightly smoothed. */
function curvatureOf(alpha: Float64Array, cx: Float64Array, cz: Float64Array, rx: Float64Array, rz: Float64Array): Float64Array {
  const n = alpha.length;
  const x = (i: number) => cx[(i + n) % n] + alpha[(i + n) % n] * rx[(i + n) % n];
  const z = (i: number) => cz[(i + n) % n] + alpha[(i + n) % n] * rz[(i + n) % n];
  const raw = new Float64Array(n);
  const k = 3;
  for (let i = 0; i < n; i++) {
    const ax = x(i - k);
    const az = z(i - k);
    const bx = x(i);
    const bz = z(i);
    const qx = x(i + k);
    const qz = z(i + k);
    const ab = Math.hypot(bx - ax, bz - az);
    const bc = Math.hypot(qx - bx, qz - bz);
    const ca = Math.hypot(qx - ax, qz - az);
    const cross = Math.abs((bx - ax) * (qz - az) - (bz - az) * (qx - ax));
    raw[i] = ab * bc * ca > 1e-9 ? (2 * cross) / (ab * bc * ca) : 0;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -4; j <= 4; j++) s += raw[(i + j + n) % n];
    out[i] = s / 9;
  }
  return out;
}

/**
 * Delays the offset profile in tight corners: sample i takes the offset the
 * minimum-curvature line had `shift(i)` meters earlier. Tight = small radius;
 * fast sweepers (radius > 250 m) stay untouched.
 */
function shiftApexes(alpha: Float64Array, cx: Float64Array, cz: Float64Array, rx: Float64Array, rz: Float64Array, maxShift: number): Float64Array {
  const n = alpha.length;
  const kappa = curvatureOf(alpha, cx, cz, rx, rz);
  // Mean spacing (m) to convert meters to samples.
  let len = 0;
  for (let i = 0; i < n; i++) len += Math.hypot(cx[(i + 1) % n] - cx[i], cz[(i + 1) % n] - cz[i]);
  const ds = len / n;
  // Corner tightness, spread ±40 m so entry and exit move together.
  const tight = new Float64Array(n);
  for (let i = 0; i < n; i++) tight[i] = Math.min(Math.max((kappa[i] - 1 / 250) / (1 / 40 - 1 / 250), 0), 1);
  const spread = Math.round(40 / ds);
  const weight = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let w = 0;
    for (let j = -spread; j <= spread; j++) w = Math.max(w, tight[(i + j + n) % n] * (1 - Math.abs(j) / (spread + 1)));
    weight[i] = w;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const back = (weight[i] * maxShift) / ds;
    const f = i - back;
    const i0 = Math.floor(f);
    const t = f - i0;
    const a = alpha[((i0 % n) + n) % n];
    const b = alpha[(((i0 + 1) % n) + n) % n];
    out[i] = a + (b - a) * t;
  }
  return out;
}

/**
 * Room kept between the line and the road edge on street circuits, where the wall is
 * the edge: with path-tracking AI a car runs up to ~2 m off its line at a slow
 * corner's exit, which put Jeddah's, Baku's and Las Vegas's T1 walls in reach at 1.6 m.
 */
export const STREET_MARGIN = 3;
/** Line centre to asphalt edge on open circuits (m): half a car plus room. */
export const LINE_MARGIN = 1.6;

/** Racing line for a built track (uses its centerline, right vectors and road width). */
export function racingLineFor(track: {
  getCenterline(): readonly THREE.Vector3[];
  getRights(): readonly THREE.Vector3[];
  readonly halfWidth: number;
  readonly street?: boolean;
}): [number, number][] {
  return optimizeRacingLine({ points: track.getCenterline(), rights: track.getRights(), halfWidth: track.halfWidth, margin: track.street ? STREET_MARGIN : undefined });
}
