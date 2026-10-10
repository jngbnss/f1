import * as THREE from 'three';
import type { Vehicle } from '../vehicle/Vehicle';
import type { Track } from '../world/Track';
import type { Racer } from './RaceManager';

/**
 * Track limits, as in F1 since 2023 and the F1 games: a car is off the track
 * when all four wheels are past the white line (asphalt edge; kerbs count as
 * track). Each excursion deletes that lap's time; the first three are
 * warnings (the black-and-white flag on the third), every one after that is
 * a 5 s time penalty added to the race time.
 *
 * Only real excursions count: at racing speed, for a moment, outside the pit
 * lane, and once per trip off the track (back on for a second re-arms it).
 * A car forced off by another one (a rival alongside or right there) is not
 * penalised, as the stewards would see it: in 20-car races nearly every
 * excursion was a squeeze in traffic, alone the AI almost never goes off.
 */
export const WARNINGS = 3;
export const PENALTY_SECONDS = 5;
/** Off with all four wheels this long (s) to count. */
const OFF_TIME = 0.25;
/** Back on track this long (s) before the next excursion can count. */
const REARM_TIME = 1;
/** Below this speed (m/s) nobody gains anything (a spin, a recovery). */
const MIN_SPEED = 14;
/** A rival this close (m, centre to centre) when the car goes off: forced off, no strike. */
const SQUEEZE_DISTANCE = 9;

export interface TrackLimitsState {
  /** Excursions counted so far. */
  strikes: number;
  /** Time penalty to add to the race time (s). */
  penalty: number;
}

export type PenaltyEvent = { kind: 'warning'; strike: number } | { kind: 'penalty'; strike: number; seconds: number } | { kind: 'overtake'; seconds: number };

interface Watch {
  off: number;
  on: number;
  armed: boolean;
  /** A rival was close during this excursion. */
  squeezed: boolean;
}

const _p = new THREE.Vector3();

export class Penalties {
  private readonly watch = new Map<Racer, Watch>();
  readonly state = new Map<Racer, TrackLimitsState>();
  /** Called for every counted excursion (toasts, lap invalidation). */
  onEvent: ((r: Racer, e: PenaltyEvent) => void) | null = null;

  constructor(private readonly track: Track) {}

  of(r: Racer): TrackLimitsState {
    let s = this.state.get(r);
    if (!s) this.state.set(r, (s = { strikes: 0, penalty: 0 }));
    return s;
  }

  /** True when every wheel of the car is past the white line. */
  offTrack(v: Vehicle): boolean {
    const half = this.track.halfWidth;
    for (const w of v.physics.config.wheels) {
      _p.set(w.position.x, 0, w.position.z).applyQuaternion(v.quaternion).add(v.position);
      const surface = this.track.surfaceAt(_p);
      if (surface === 'kerb') return false;
      if (surface === 'asphalt' && Math.abs(this.track.lateral(_p)) <= half) return false;
    }
    return true;
  }

  /**
   * Per fixed step for every racer still running.
   * @param exempt cars the rules leave alone this step (pit lane, a reset)
   */
  update(racers: readonly Racer[], dt: number, exempt: (r: Racer) => boolean): void {
    for (const r of racers) {
      if (r.finished) continue;
      let w = this.watch.get(r);
      if (!w) this.watch.set(r, (w = { off: 0, on: REARM_TIME, armed: true, squeezed: false }));
      const v = r.vehicle;
      if (exempt(r) || v.physics.speed < MIN_SPEED) {
        w.off = 0;
        continue;
      }
      if (this.offTrack(v)) {
        w.off += dt;
        w.on = 0;
        if (!w.squeezed) w.squeezed = racers.some((o) => o !== r && !o.finished && o.vehicle.position.distanceToSquared(v.position) < SQUEEZE_DISTANCE ** 2);
        if (w.armed && w.off >= OFF_TIME) {
          w.armed = false;
          if (!w.squeezed) this.count(r);
        }
      } else {
        w.off = 0;
        if (w.on + dt >= REARM_TIME) w.squeezed = false;
        w.on += dt;
        if (w.on >= REARM_TIME) w.armed = true;
      }
    }
  }

  /** A time penalty for something else than track limits (overtaking under yellow / VSC). */
  overtake(r: Racer): void {
    const s = this.of(r);
    s.penalty += PENALTY_SECONDS;
    r.penalty = s.penalty;
    this.onEvent?.(r, { kind: 'overtake', seconds: s.penalty });
  }

  private count(r: Racer): void {
    const s = this.of(r);
    s.strikes++;
    if (s.strikes <= WARNINGS) {
      this.onEvent?.(r, { kind: 'warning', strike: s.strikes });
    } else {
      s.penalty += PENALTY_SECONDS;
      r.penalty = s.penalty;
      this.onEvent?.(r, { kind: 'penalty', strike: s.strikes, seconds: s.penalty });
    }
  }
}
