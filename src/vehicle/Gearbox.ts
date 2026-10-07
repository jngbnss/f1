export interface GearboxConfig {
  idleRpm: number;
  redlineRpm: number;
  /** Road speed (m/s) at redline in each forward gear. */
  gearTopSpeeds: number[];
  /** Seconds the engine is "between gears" (sound dips). */
  shiftTime: number;
}

/**
 * Automatic gearbox that derives engine RPM from road speed.
 * Currently drives sound + HUD only; the physics uses a smooth force curve.
 * Gear: -1 = R, 0 = N, 1..n = forward gears.
 */
export class Gearbox {
  gear = 0;
  rpm: number;
  /** >0 while a shift is in progress. */
  shiftTimer = 0;

  constructor(readonly config: GearboxConfig) {
    this.rpm = config.idleRpm;
  }

  /** 0..1 position between idle and redline. */
  get rpmRatio(): number {
    const c = this.config;
    return (this.rpm - c.idleRpm) / (c.redlineRpm - c.idleRpm);
  }

  get label(): string {
    return this.gear < 0 ? 'R' : this.gear === 0 ? 'N' : String(this.gear);
  }

  update(forwardSpeed: number, throttle: number, grounded: boolean, dt: number): void {
    const c = this.config;
    const tops = c.gearTopSpeeds;
    const v = Math.abs(forwardSpeed);
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);

    // --- gear selection ----------------------------------------------
    if (forwardSpeed < -0.5) {
      this.gear = -1;
    } else if (v < 0.5 && throttle <= 0) {
      this.gear = 0;
    } else {
      if (this.gear <= 0) this.gear = 1;
      const top = tops[this.gear - 1];
      if (v > top * 0.93 && this.gear < tops.length) this.shift(+1);
      else if (this.gear > 1 && v < tops[this.gear - 2] * 0.62) this.shift(-1);
    }

    // --- target rpm ----------------------------------------------------
    let target: number;
    if (this.gear === 0) {
      target = c.idleRpm + throttle * (c.redlineRpm - c.idleRpm) * 0.75; // free revving
    } else {
      const top = this.gear < 0 ? tops[0] * 0.8 : tops[this.gear - 1];
      target = c.idleRpm + (v / top) * (c.redlineRpm - c.idleRpm);
      // Clutch slip at launch / wheels in the air: engine runs ahead of the road speed.
      const slipRpm = c.idleRpm + throttle * (c.redlineRpm - c.idleRpm) * (grounded ? 0.45 : 0.9);
      if (v < top * 0.4 || !grounded) target = Math.max(target, slipRpm);
    }
    if (this.shiftTimer > 0) target *= 0.92;
    target = Math.min(Math.max(target, c.idleRpm), c.redlineRpm * 1.02);

    const rate = target > this.rpm ? 14 : 9;
    this.rpm += (target - this.rpm) * (1 - Math.exp(-rate * dt));
  }

  private shift(direction: 1 | -1): void {
    if (this.shiftTimer > 0) return;
    this.gear += direction;
    this.shiftTimer = this.config.shiftTime;
  }
}
