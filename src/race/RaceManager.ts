import type { Vehicle } from '../vehicle/Vehicle';
import type { Track } from '../world/Track';
import type { AIDriver } from './AIDriver';

export interface Racer {
  name: string;
  vehicle: Vehicle;
  ai: AIDriver | null;
  isPlayer: boolean;
  /** Centerline samples travelled since the start line (can be negative on the grid). */
  progress: number;
  lastIndex: number;
  finished: boolean;
  finishTime: number;
  /** Paint color, for the standings list. */
  color: number;
  /** Race time at each timing point passed (point -> s), for gaps. */
  splits?: Map<number, number>;
  /** Last timing point passed. */
  lastPoint?: number;
  /** Time penalties to add to the race time (s), e.g. track limits. */
  penalty?: number;
}

export type RaceState = 'countdown' | 'racing' | 'finished';

/** Seconds of the start-light sequence. */
export const COUNTDOWN = 4;

/**
 * Race rules: countdown, progress / laps / positions for every car (player
 * and AI) from centerline progress, finish order.
 */
/** Timing points every 40 samples (100 m): gaps update ~3x per second at racing speed. */
const TIMING_STEP = 40;

export class RaceManager {
  state: RaceState = 'countdown';
  /** Remaining countdown (s). */
  countdown = COUNTDOWN;
  /** Race clock (s), starts at the green light. */
  time = 0;
  private readonly samples: number;
  private finishOrder = 0;

  constructor(
    private readonly track: Track,
    readonly racers: Racer[],
    readonly laps: number,
  ) {
    this.samples = track.getCenterline().length;
    for (const r of racers) this.place(r);
  }

  get player(): Racer | undefined {
    return this.racers.find((r) => r.isPlayer);
  }

  /** True while cars must stay on the grid. */
  get frozen(): boolean {
    return this.state === 'countdown';
  }

  /** Call once per fixed step, after physics. */
  update(dt: number): void {
    if (this.state === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.state = 'racing';
        this.countdown = 0;
      }
      return;
    }
    this.time += dt;
    const n = this.samples;
    for (const r of this.racers) {
      const i = this.track.nearestIndex(r.vehicle.position);
      let delta = i - r.lastIndex;
      if (delta < -n / 2) delta += n;
      if (delta > n / 2) delta -= n;
      r.lastIndex = i;
      if (r.finished) continue;
      const before = Math.floor(r.progress / TIMING_STEP);
      r.progress += delta;
      // Timing points: remember when this car passed each one.
      const point = Math.floor(r.progress / TIMING_STEP);
      if (point > before && r.progress > 0) {
        (r.splits ??= new Map()).set(point, this.time);
        r.lastPoint = point;
      }
      if (r.progress >= this.laps * n) {
        r.finished = true;
        r.finishTime = this.time;
        r.progress = this.laps * n + 1000 - this.finishOrder++; // keep finish order stable
        if (r.isPlayer) this.state = 'finished';
      }
    }
  }

  /**
   * Time gap (s) from `ahead` to `behind` at the last timing point `behind`
   * passed (both must have passed it); null before the first point.
   */
  gap(ahead: Racer, behind: Racer): number | null {
    if (behind.lastPoint === undefined) return null;
    const tb = behind.splits?.get(behind.lastPoint);
    const ta = ahead.splits?.get(behind.lastPoint);
    return tb !== undefined && ta !== undefined ? Math.max(0, tb - ta) : null;
  }

  /** Current lap (1-based, clamped to the race distance). */
  lapOf(r: Racer): number {
    return Math.min(this.laps, Math.max(1, Math.floor(r.progress / this.samples) + 1));
  }

  /** Sorted standings: finished cars by time, then by distance covered. */
  standings(): Racer[] {
    return [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return this.resultTime(a) - this.resultTime(b);
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.progress - a.progress;
    });
  }

  /** Race time with penalties added (finished cars). */
  resultTime(r: Racer): number {
    return r.finishTime + (r.penalty ?? 0);
  }

  positionOf(r: Racer): number {
    return this.standings().indexOf(r) + 1;
  }

  /** After a teleport (reset): resync the progress tracker without counting the jump. */
  resync(r: Racer): void {
    r.lastIndex = this.track.nearestIndex(r.vehicle.position);
  }

  private place(r: Racer): void {
    const n = this.samples;
    const i = this.track.nearestIndex(r.vehicle.position);
    r.lastIndex = i;
    // Grid slots are just behind the line: negative progress until crossing it.
    r.progress = i > n / 2 ? i - n : i;
  }
}
