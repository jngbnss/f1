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
}

export type RaceState = 'countdown' | 'racing' | 'finished';

/** Seconds of the start-light sequence. */
export const COUNTDOWN = 4;

/**
 * Race rules: countdown, progress / laps / positions for every car (player
 * and AI) from centerline progress, finish order.
 */
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
      r.progress += delta;
      if (r.progress >= this.laps * n) {
        r.finished = true;
        r.finishTime = this.time;
        r.progress = this.laps * n + 1000 - this.finishOrder++; // keep finish order stable
        if (r.isPlayer) this.state = 'finished';
      }
    }
  }

  /** Current lap (1-based, clamped to the race distance). */
  lapOf(r: Racer): number {
    return Math.min(this.laps, Math.max(1, Math.floor(r.progress / this.samples) + 1));
  }

  /** Sorted standings: finished cars by time, then by distance covered. */
  standings(): Racer[] {
    return [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.progress - a.progress;
    });
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
