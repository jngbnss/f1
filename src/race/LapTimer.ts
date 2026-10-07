/**
 * Lap timing from progress along the track centerline (no trigger volumes
 * needed, works for any Track). A lap counts when the car has travelled one
 * full centerline length forward since crossing the start line.
 * Using the reset key marks the current lap invalid (no record).
 */
export class LapTimer {
  /** Current lap time (s); null before crossing the start line the first time. */
  current: number | null = null;
  last: number | null = null;
  best: number | null;
  lap = 0;
  valid = true;
  /** Set for one update when a lap completes ('best' if it was a record). */
  event: 'lap' | 'best' | null = null;

  private progress: number;
  private lastIndex: number;

  /**
   * @param sampleCount number of centerline samples
   * @param startIndex  spawn position on the centerline (just behind the line)
   * @param storageKey  where the best lap is remembered between visits
   */
  constructor(
    private readonly sampleCount: number,
    startIndex: number,
    private readonly storageKey: string,
  ) {
    this.lastIndex = startIndex;
    // Spawn is behind the line: negative progress until we cross it.
    this.progress = startIndex > sampleCount / 2 ? startIndex - sampleCount : startIndex;
    this.best = this.load();
  }

  update(index: number, dt: number): void {
    const n = this.sampleCount;
    this.event = null;
    let delta = index - this.lastIndex;
    if (delta < -n / 2) delta += n;
    if (delta > n / 2) delta -= n;
    this.lastIndex = index;
    this.progress += delta;

    if (this.current !== null) this.current += dt;

    if (this.current === null && this.progress >= 0) {
      // First crossing of the start line.
      this.current = 0;
      this.progress = 0;
      this.lap = 1;
      return;
    }
    if (this.current !== null && this.progress >= n) {
      this.last = this.current;
      if (this.valid && (this.best === null || this.current < this.best)) {
        this.best = this.current;
        this.save(this.best);
        this.event = 'best';
      } else {
        this.event = 'lap';
      }
      this.current = 0;
      this.progress -= n;
      this.lap++;
      this.valid = true;
    }
  }

  invalidate(): void {
    if (this.current !== null) this.valid = false;
  }

  private load(): number | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      const v = raw === null ? NaN : Number(raw);
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  private save(v: number): void {
    try {
      localStorage.setItem(this.storageKey, String(v));
    } catch {
      /* storage unavailable (private mode) — keep in memory only */
    }
  }
}

export function formatLapTime(t: number | null): string {
  if (t === null) return '–:––.–––';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
