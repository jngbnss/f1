import type { Vehicle } from '../vehicle/Vehicle';
import type { Track } from '../world/Track';
import type { RaceManager } from './RaceManager';

/**
 * Race-side 2026 rules:
 * - active aero zones: straight mode is allowed on the long straights only (the
 *   FIA designates them per circuit; here: stretches where the track bends
 *   less than a 700 m radius for at least 300 m, ending a little before the
 *   next corner so the wings are closed for braking);
 * - overtake mode: armed for a car less than a second behind the one ahead at
 *   the last timing point. AI drivers use it at once; the player presses a key.
 */
/** Straight mode where the bend radius stays above this (m)... */
const STRAIGHT_RADIUS = 700;
/** ...for at least this long (m). */
const MIN_ZONE = 300;
/** Wings close this far before the zone's end (m). */
const CLOSE_BEFORE = 50;
/** Gap that arms overtake mode (s). */
export const OVERTAKE_GAP = 1;

/** Per centreline sample: 1 inside an active-aero straight zone. */
export function straightZones(track: Track): Uint8Array {
  const pts = track.getCenterline();
  const n = pts.length;
  const step = track.length / n;
  const k = Math.max(2, Math.round(10 / step));
  const straight = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - k + n) % n];
    const b = pts[i];
    const c = pts[(i + k) % n];
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    const kappa = ab * bc * ca > 1e-6 ? (2 * cross) / (ab * bc * ca) : 0;
    straight[i] = kappa < 1 / STRAIGHT_RADIUS ? 1 : 0;
  }
  // Keep runs long enough, trimmed before their end.
  const zones = new Uint8Array(n);
  const start = straight.indexOf(0);
  if (start < 0) return zones.fill(1);
  const minRun = Math.round(MIN_ZONE / step);
  const trim = Math.round(CLOSE_BEFORE / step);
  let run = 0;
  for (let s = 1; s <= n; s++) {
    const i = (start + s) % n;
    if (straight[i]) {
      run++;
      continue;
    }
    if (run >= minRun) for (let j = 1; j <= run - trim; j++) zones[(i - run - 1 + j + n) % n] = 1;
    run = 0;
  }
  return zones;
}

/** One fixed step, before the cars' fixedUpdate. */
export function updateRules2026(track: Track, zones: Uint8Array, vehicles: readonly Vehicle[], race: RaceManager | null): void {
  for (const v of vehicles) {
    v.straightZone = zones[track.nearestIndex(v.position)] === 1;
    v.ers.lapLength = track.length;
  }
  if (!race || race.state !== 'racing') return;
  const order = race.standings();
  for (let p = 1; p < order.length; p++) {
    const me = order[p];
    if (me.finished) continue;
    const ers = me.vehicle.ers;
    const gap = race.gap(order[p - 1], me);
    ers.overtakeAvailable = ers.overtakeLeft && gap !== null && gap < OVERTAKE_GAP;
    if (me.ai && ers.overtakeAvailable) ers.activateOvertake();
  }
}
