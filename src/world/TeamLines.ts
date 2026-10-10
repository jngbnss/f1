import type * as THREE from 'three';
import { CTRL, pathFromControls } from './MinTimeLine';
import { LINE_MARGIN, STREET_MARGIN } from './RacingLineOptimizer';

/**
 * Racing line per team (scripts/bake-team-lines.ts): the circuit's minimum-lap-time
 * line refined for each team's car. A high-downforce car takes the fast bends
 * tighter, a low-drag one straightens the exits onto the long straights; the
 * difference is up to ~1.5 m across the track and a few tenths a lap.
 *
 * Not on street circuits: between walls everyone drives the same line in single file
 * (in a 20-car race at Monaco, team lines meant 22 wings lost in 3 races vs 14 on the
 * shared line, for a few hundredths a lap).
 */
export interface TeamLinesData {
  /** Track samples the lines were baked on (a re-sampled track invalidates them). */
  samples: number;
  /** Samples between control points. */
  ctrl: number;
  /** Per car id: lap times (game model, s) on the shared and on its own line, and the control offsets (cm, + = right). */
  teams: Record<string, { shared: number; own: number; cm: number[] }>;
}

/** The team's own racing line on this track, or null (no data, other car, re-sampled track). */
export function teamLinePath(
  data: TeamLinesData | undefined,
  carId: string,
  track: { getCenterline(): readonly THREE.Vector3[]; getRights(): readonly THREE.Vector3[]; readonly halfWidth: number; readonly street?: boolean },
  /** The shared line: a team line never uses more road than it (or than the optimizer's margin) at any point. */
  shared?: readonly [number, number][],
): [number, number][] | null {
  const team = data?.teams[carId];
  const points = track.getCenterline();
  if (!data || !team || track.street || data.samples !== points.length || data.ctrl !== CTRL) return null;
  const rights = track.getRights();
  return pathFromControls(points, rights, team.cm.map((c) => c / 100), teamLineLimit(track, shared));
}

/**
 * Largest offset per sample a team line may use: the optimizer's margin from the asphalt
 * edge, or as far out as the shared line goes there (the curve between its control points
 * swings a little past them). The bake script optimizes with the same limit.
 */
export function teamLineLimit(
  track: { getCenterline(): readonly THREE.Vector3[]; getRights(): readonly THREE.Vector3[]; readonly halfWidth: number; readonly street?: boolean },
  shared?: readonly [number, number][],
): number[] {
  const points = track.getCenterline();
  const rights = track.getRights();
  const margin = track.halfWidth - (track.street ? STREET_MARGIN : LINE_MARGIN);
  return points.map((p, i) => {
    const s = shared?.[i];
    return Math.max(margin, s ? Math.abs((s[0] - p.x) * rights[i].x + (s[1] - p.z) * rights[i].z) : 0);
  });
}
