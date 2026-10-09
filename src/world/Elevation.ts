/**
 * Track elevation helpers shared by the bake script (scripts/bake-elevation.ts)
 * and the game: self-crossings of a centerline (Suzuka's figure-of-eight
 * bridge) and the "which part of the circuit is this" test that must look at
 * height as well as position where the track passes over itself.
 */

export interface Crossing {
  /** Segment (a, a+1) of the lower road and (b, b+1) of the upper one, in point indices. */
  lower: number;
  upper: number;
  x: number;
  z: number;
}

/**
 * Places where a closed polyline crosses itself (segments far apart along
 * the loop). Which road is upper is decided by `heights` when given (higher
 * one on top), else the later one in driving order.
 */
export function findCrossings(points: readonly [number, number][], heights?: readonly number[]): Crossing[] {
  const n = points.length;
  const out: Crossing[] = [];
  const minGap = Math.max(20, Math.floor(n / 20));
  for (let a = 0; a < n; a++) {
    const [ax, az] = points[a];
    const [bx, bz] = points[(a + 1) % n];
    for (let b = a + minGap; b < n; b++) {
      if (a + n - b < minGap) continue;
      const [cx, cz] = points[b];
      const [dx, dz] = points[(b + 1) % n];
      const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
      if (Math.abs(den) < 1e-9) continue;
      const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den;
      const u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const x = ax + t * (bx - ax);
      const z = az + t * (bz - az);
      const aUpper = heights ? heights[a] > heights[b] : false;
      out.push({ lower: aUpper ? b : a, upper: aUpper ? a : b, x, z });
    }
  }
  return out;
}

/** Shortest distance along a closed loop of `n` samples between indices. */
export function loopGap(i: number, j: number, n: number): number {
  const d = Math.abs(i - j) % n;
  return Math.min(d, n - d);
}
