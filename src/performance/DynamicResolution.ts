import type * as THREE from 'three';
import type { PerfSnapshot } from './PerformanceMonitor';

/**
 * Adaptive render resolution: when the average frame time stays above the
 * budget, the pixel ratio is lowered step by step; when there is headroom it
 * is raised again (up to the configured maximum). Fill-rate is usually the
 * first bottleneck on laptops / high-DPI screens, so this keeps driving
 * smooth at the cost of some sharpness.
 *
 * It first stops at a soft floor (0.75 of a CSS pixel) where the picture is
 * still clean; the QualityGovernor then gives up shadows / effects / draw
 * distance, and only as its last step `lowerFloor` allows the blurry 0.5.
 */
export class DynamicResolution {
  ratio: number;
  private floor: number;
  private lastWindow = -1;
  private goodWindows = 0;
  private cooldownUntil = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly maxRatio: number,
    private readonly minRatio = 0.5,
    softFloor = 0.75,
    /** Slower than this (ms) -> lower resolution. 20 ms ≈ 50 fps. */
    private readonly slowMs = 20,
    /** Faster than this (ms) for a while -> raise resolution. */
    private readonly fastMs = 13,
  ) {
    this.ratio = renderer.getPixelRatio();
    this.floor = Math.min(maxRatio, Math.max(minRatio, softFloor));
  }

  /** At the lowest render resolution it may use for now (nothing left to give here). */
  get atMinimum(): boolean {
    return this.ratio <= this.floor * 1.001;
  }

  /** Let the resolution drop below the soft floor. False when it already could. */
  lowerFloor(): boolean {
    if (this.floor <= this.minRatio) return false;
    this.floor = this.minRatio;
    return true;
  }

  /** Call every frame with the monitor's snapshot (acts once per published window). */
  update(perf: PerfSnapshot, now = performance.now()): void {
    if (perf.windowId === this.lastWindow || perf.frameTimeAvg === 0) return;
    this.lastWindow = perf.windowId;
    if (now < this.cooldownUntil) return;

    if (perf.frameTimeAvg > this.slowMs && this.ratio > this.floor) {
      this.apply(Math.max(this.floor, this.ratio * 0.85), now);
      this.goodWindows = 0;
    } else if (perf.frameTimeAvg < this.fastMs && this.ratio < this.maxRatio) {
      if (++this.goodWindows >= 4) {
        this.apply(Math.min(this.maxRatio, this.ratio * 1.1), now);
        this.goodWindows = 0;
      }
    } else {
      this.goodWindows = 0;
    }
  }

  private apply(ratio: number, now: number): void {
    this.ratio = ratio;
    this.renderer.setPixelRatio(ratio);
    // Give the new size a moment before judging again.
    this.cooldownUntil = now + 1500;
  }
}
