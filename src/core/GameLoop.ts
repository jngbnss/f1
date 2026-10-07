export interface LoopCallbacks {
  /** Called zero or more times per frame with a constant dt (physics, gameplay). */
  fixedUpdate(dt: number): void;
  /**
   * Called once per frame. `alpha` (0..1) is how far we are between the last
   * and the next fixed step, for render interpolation.
   */
  update(frameDt: number, alpha: number): void;
  render(): void;
}

/**
 * Fixed-timestep loop with an accumulator (deterministic physics, decoupled
 * from the display refresh rate — 60/120/144 Hz monitors behave the same).
 */
export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;

  /** Upper bound on steps per frame, avoids the "spiral of death" after a stall. */
  private readonly maxSubSteps = 5;

  constructor(
    private readonly callbacks: LoopCallbacks,
    readonly fixedDt = 1 / 60,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    // Clamp large gaps (tab switch, breakpoint) so the sim doesn't jump.
    const frameDt = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;

    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < this.maxSubSteps) {
      this.callbacks.fixedUpdate(this.fixedDt);
      this.accumulator -= this.fixedDt;
      steps++;
    }
    if (steps === this.maxSubSteps) this.accumulator = 0;

    this.callbacks.update(frameDt, this.accumulator / this.fixedDt);
    this.callbacks.render();
  };
}
