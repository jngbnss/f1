/**
 * Pure geometry on MediaPipe hand landmarks (21 points, x/y normalized to the
 * camera frame). Kept free of DOM/MediaPipe so it can be tested from scripts.
 *
 * Landmark ids used: 0 wrist, 9 middle-finger knuckle, 8/12/16/20 fingertips.
 */

export interface Point {
  x: number;
  y: number;
}

const WRIST = 0;
const MIDDLE_MCP = 9;
const TIPS = [8, 12, 16, 20];

/**
 * Landmarks in a square, mirrored space: x flipped so the view is a selfie
 * (the user's right hand is on the right) and scaled by the frame aspect so
 * angles and distances are not squashed. y still points down.
 */
export function toView(lm: readonly Point[], aspect: number): Point[] {
  return lm.map((p) => ({ x: (1 - p.x) * aspect, y: p.y }));
}

/** Middle of the palm (between wrist and middle knuckle). */
export function palmCenter(lm: readonly Point[]): Point {
  const a = lm[WRIST];
  const b = lm[MIDDLE_MCP];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Fingertip-to-wrist / palm length: fist ≈ FIST_RATIO, flat open hand ≈ OPEN_RATIO. */
const FIST_RATIO = 1.15;
const OPEN_RATIO = 1.85;

/** How open the hand is, 0 = fist .. 1 = flat open palm. Independent of distance to the camera. */
export function openness(lm: readonly Point[]): number {
  const palm = dist(lm[WRIST], lm[MIDDLE_MCP]);
  if (palm < 1e-6) return 0;
  let sum = 0;
  for (const t of TIPS) sum += dist(lm[t], lm[WRIST]);
  const ratio = sum / TIPS.length / palm;
  return Math.max(0, Math.min(1, (ratio - FIST_RATIO) / (OPEN_RATIO - FIST_RATIO)));
}

/**
 * Steering-wheel angle in degrees (+ = turned right / clockwise) from two
 * hands holding an invisible wheel: the tilt of the line between the palms.
 */
export function twoHandAngle(a: readonly Point[], b: readonly Point[]): number {
  let l = palmCenter(a);
  let r = palmCenter(b);
  if (l.x > r.x) [l, r] = [r, l];
  // Turning right drops the right hand: dy > 0 in a y-down frame.
  return (Math.atan2(r.y - l.y, r.x - l.x) * 180) / Math.PI;
}

/** One-hand fallback: how far the hand leans from upright (+ = top leaning right). */
export function oneHandAngle(lm: readonly Point[]): number {
  const w = lm[WRIST];
  const m = lm[MIDDLE_MCP];
  return (Math.atan2(m.x - w.x, w.y - m.y) * 180) / Math.PI;
}

/** Fingertip / middle joint (PIP) of index, middle, ring, pinky. */
const FINGERS: [number, number][] = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
];
const THUMB_TIP = 4;
const PINKY_MCP = 17;

/** Raised fingers on one hand, 0..5. */
export function fingerCount(lm: readonly Point[]): number {
  const w = lm[WRIST];
  let n = 0;
  // A straight finger's tip is well beyond its middle joint, seen from the wrist; a bent one folds back.
  for (const [tip, pip] of FINGERS) if (dist(lm[tip], w) > dist(lm[pip], w) * 1.15) n++;
  // The thumb folds across the palm: out when its tip is far from the pinky side.
  if (dist(lm[THUMB_TIP], lm[PINKY_MCP]) > dist(lm[WRIST], lm[MIDDLE_MCP]) * 0.9) n++;
  return n;
}

/** Axis-aligned box in view space. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Hand on the head: the palm or a fingertip on the top half of the face or
 * just above / beside it (a face box covers brow to chin, not the hair).
 */
export function touchesHead(lm: readonly Point[], face: Box): boolean {
  const w = face.x1 - face.x0;
  const h = face.y1 - face.y0;
  const x0 = face.x0 - 0.45 * w;
  const x1 = face.x1 + 0.45 * w;
  const y0 = face.y0 - 0.9 * h;
  const y1 = face.y0 + 0.5 * h;
  const c = palmCenter(lm);
  return [c, lm[8], lm[12]].some((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1);
}

/**
 * One Euro filter (Casiez et al. 2012): smooths jitter when the hand is still
 * and follows quickly when it moves, so the wheel stays calm without lag.
 */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  constructor(
    private readonly minCutoff: number,
    private readonly beta: number,
    private readonly dCutoff = 1,
  ) {}

  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  filter(value: number, dt: number): number {
    if (this.x === null || dt <= 0) {
      this.x = value;
      return value;
    }
    const ad = alpha(dt, this.dCutoff);
    this.dx += ad * ((value - this.x) / dt - this.dx);
    const a = alpha(dt, this.minCutoff + this.beta * Math.abs(this.dx));
    this.x += a * (value - this.x);
    return this.x;
  }
}

function alpha(dt: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
