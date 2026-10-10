import type { Track } from '../world/Track';
import type { DebrisField } from './Debris';
import type { Racer } from './RaceManager';

/**
 * Race control, F1 style (and as in the F1 games):
 *  - local yellow: a car stopped on or next to the track; slow down in that
 *    stretch, no overtaking there;
 *  - VSC (virtual safety car): the car is not moving again within a few
 *    seconds, or a wing lies on the track: everybody runs a set speed below
 *    racing pace (here 60 % of the racing line), no overtaking anywhere, pit
 *    stops cost less; marshals clear the debris; "VSC ending" then green.
 * Overtaking under yellow or VSC costs a 5 s time penalty (Penalties).
 */
export type Flag = 'green' | 'vsc' | 'vsc-ending';

/** Speed under the VSC, as a share of the racing line's speed there. */
export const VSC_SPEED = 0.6;
/** Stopped this long (s) on or near the track: yellow flag there. */
const YELLOW_AFTER = 1.5;
/** Still stopped after this long (s): VSC. */
const VSC_AFTER = 6;
/** Below this speed (m/s) a car counts as stopped (the Loews hairpin queue crawls at ~8). */
const STOPPED = 5;
/** How far off the asphalt edge (m) a stopped car is still a danger. */
const NEAR_TRACK = 6;
/** Yellow zone: this far before / after the incident (m along the track). */
const YELLOW_BEFORE = 250;
const YELLOW_AFTER_M = 80;
/** VSC lasts at least this long (s); clear for this long before it ends; ending phase. */
const VSC_MIN = 15;
const VSC_CLEAR = 4;
const VSC_ENDING = 5;
/** Marshals take a wing off the track this long (s) into the VSC. */
const MARSHALS = 10;
/** A car this close ahead (m) makes a stopped car a queue, not an incident. */
const QUEUE_GAP = 14;
/** A pass counts once the passer is this far clear (centreline samples, ~a car length). */
const CLEAR_SAMPLES = 3;
/** No race control in the first seconds (the start, the first-corner jostle). */
const START_GRACE = 8;

export interface YellowZone {
  /** Distance along the track (m) of the incident. */
  s: number;
}

export type ControlMessage = 'yellow' | 'vsc' | 'vsc-ending' | 'green';

export class RaceControl {
  flag: Flag = 'green';
  /** Local yellows right now (one per incident). */
  yellows: YellowZone[] = [];
  /** Seconds in the current flag state. */
  private timer = 0;
  /** Seconds the track has been clear (VSC ends after VSC_CLEAR). */
  private clear = 0;
  private readonly stopped = new Map<Racer, number>();
  /** Called when the state changes (HUD banner, radio). */
  onMessage: ((m: ControlMessage) => void) | null = null;
  private hadYellow = false;
  /**
   * Who is clearly ahead of whom, per pair ("a|b" -> true when a is ahead), changed only
   * once one leads by a car length: side by side the order flips every step, which is not a pass.
   */
  private ahead = new Map<string, boolean>();
  /** Pairs already punished during this neutralisation ("passer>passed"). */
  private punished = new Set<string>();

  constructor(private readonly track: Track) {}

  /** Distance along the track (m) of a position. */
  sOf(r: Racer): number {
    const n = this.track.getCenterline().length;
    return (this.track.nearestIndex(r.vehicle.position) / n) * this.track.length;
  }

  /** True when `a` is ahead of `b` on the track (by centreline progress). */
  private aheadOf(a: Racer, b: Racer): boolean {
    return a.progress > b.progress;
  }

  /** True when `r` is inside a yellow zone. */
  inYellow(r: Racer): boolean {
    if (!this.yellows.length) return false;
    const s = this.sOf(r);
    const L = this.track.length;
    return this.yellows.some((z) => {
      let d = z.s - s; // + = incident ahead
      if (d > L / 2) d -= L;
      if (d < -L / 2) d += L;
      return d <= YELLOW_BEFORE && d >= -YELLOW_AFTER_M;
    });
  }

  /** No overtaking for this car right now. */
  noOvertaking(r: Racer): boolean {
    return this.flag !== 'green' || this.inYellow(r);
  }

  /**
   * Per fixed step during the race.
   * @param raceTime race clock (s)
   * @param exempt cars race control ignores (in the pit lane)
   */
  update(dt: number, racers: readonly Racer[], raceTime: number, debris: DebrisField | null, exempt: (r: Racer) => boolean): void {
    if (raceTime < START_GRACE) return;
    // --- incidents: cars stopped on or next to the track ---------------------
    const yellows: YellowZone[] = [];
    let longest = 0;
    for (const r of racers) {
      const v = r.vehicle;
      const near = Math.abs(this.track.lateral(v.position)) < this.track.halfWidth + NEAR_TRACK;
      // Stopped right behind another car is a queue (Monaco's first lap at Sainte Devote), not an incident.
      const queued = racers.some((o) => o !== r && !o.finished && o.vehicle.physics.speed < 2 * STOPPED && o.vehicle.position.distanceToSquared(v.position) < QUEUE_GAP ** 2 && this.aheadOf(o, r));
      const still = !r.finished && !exempt(r) && near && v.physics.speed < STOPPED && !queued;
      const t = still ? (this.stopped.get(r) ?? 0) + dt : 0;
      this.stopped.set(r, t);
      if (t >= YELLOW_AFTER) yellows.push({ s: this.sOf(r) });
      longest = Math.max(longest, t);
    }
    const wingOnTrack = !!debris?.pieces.some((p) => p.kind === 'wing' && Math.abs(this.track.lateral(p.position)) < this.track.halfWidth + 1);
    this.yellows = yellows;
    if (yellows.length && !this.hadYellow && this.flag === 'green') this.onMessage?.('yellow');
    this.hadYellow = yellows.length > 0;

    // --- VSC ------------------------------------------------------------------------------
    this.timer += dt;
    const danger = longest >= VSC_AFTER || wingOnTrack;
    if (this.flag === 'green' && danger) this.set('vsc');
    else if (this.flag === 'vsc') {
      // Marshals clear the wings from the track.
      if (debris && this.timer >= MARSHALS) for (const p of debris.pieces) if (p.kind === 'wing') p.age = Number.MAX_VALUE;
      this.clear = danger || yellows.length ? 0 : this.clear + dt;
      if (this.timer >= VSC_MIN && this.clear >= VSC_CLEAR) this.set('vsc-ending');
    } else if (this.flag === 'vsc-ending') {
      if (danger) this.set('vsc');
      else if (this.timer >= VSC_ENDING) this.set('green');
    }
  }

  /**
   * Cars that overtook a running rival where overtaking is not allowed. A pass counts once
   * the passer is a car length clear, having been a car length behind; passing a car in the
   * pit lane, stopped or out of the race does not count.
   */
  overtakes(racers: readonly Racer[], exempt: (r: Racer) => boolean): Racer[] {
    const offenders: Racer[] = [];
    const neutral = this.flag !== 'green' || this.yellows.length > 0;
    if (!neutral) this.punished.clear();
    for (let i = 0; i < racers.length; i++) {
      for (let j = i + 1; j < racers.length; j++) {
        const a = racers[i];
        const b = racers[j];
        const diff = a.progress - b.progress; // samples, + = a ahead
        if (Math.abs(diff) < CLEAR_SAMPLES) continue;
        const key = `${a.name}|${b.name}`;
        const was = this.ahead.get(key);
        const now = diff > 0;
        this.ahead.set(key, now);
        if (was === undefined || was === now || !neutral) continue;
        const [passer, passed] = now ? [a, b] : [b, a];
        if (passer.finished || passed.finished || exempt(passer) || exempt(passed) || passed.vehicle.physics.speed < STOPPED || !this.noOvertaking(passer)) continue;
        const pair = `${passer.name}>${passed.name}`;
        if (this.punished.has(pair)) continue;
        this.punished.add(pair);
        offenders.push(passer);
      }
    }
    return offenders;
  }

  private set(flag: Flag): void {
    this.flag = flag;
    this.timer = 0;
    this.clear = 0;
    this.onMessage?.(flag === 'green' ? 'green' : flag);
  }
}
