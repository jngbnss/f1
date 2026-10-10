import type { DynamicResolution } from './DynamicResolution';
import type { PerfSnapshot } from './PerformanceMonitor';

/**
 * Second line of defence after DynamicResolution: when the frame time stays
 * over budget even at the lowest render resolution, the device is slower than
 * its quality tier assumed, so the governor gives up one feature at a time
 * (each step is a callback that returns a label, or null when it has nothing
 * left to give). Steps never come back during a session: switching shadows or
 * post-processing back on would stutter again (shader recompiles).
 */
export class QualityGovernor {
  private lastWindow = -1;
  private slowWindows = 0;
  private step = 0;
  private cooldownUntil = 0;

  constructor(
    private readonly resolution: DynamicResolution,
    private readonly steps: (() => string | null)[],
    private readonly onStep: (label: string) => void,
    /** Slower than this (ms) at minimum resolution counts as a slow window. */
    private readonly slowMs = 20,
    /** Slow windows in a row before the next step. */
    private readonly patience = 3,
  ) {}

  /** Call every frame after DynamicResolution.update. */
  update(perf: PerfSnapshot, now = performance.now()): void {
    if (perf.windowId === this.lastWindow || perf.frameTimeAvg === 0) return;
    this.lastWindow = perf.windowId;
    if (now < this.cooldownUntil || this.step >= this.steps.length) return;
    this.slowWindows = this.resolution.atMinimum && perf.frameTimeAvg > this.slowMs ? this.slowWindows + 1 : 0;
    if (this.slowWindows < this.patience) return;
    this.slowWindows = 0;
    // Give the change a few seconds (recompiles, new frame times) before judging again.
    this.cooldownUntil = now + 4000;
    while (this.step < this.steps.length) {
      const label = this.steps[this.step++]();
      if (label) {
        this.onStep(label);
        return;
      }
    }
  }
}
