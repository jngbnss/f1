import type { VehicleConfig } from './VehicleConfig';

/**
 * 2026 power unit: an ICE of ~400 kW plus a 350 kW MGU-K fed by a battery
 * (energy store). FIA 2026 technical regulations, in short:
 * - MGU-K deployment up to 350 kW, tapering at high speed: full up to
 *   ~290 km/h, down to nothing at 355 km/h;
 * - up to 8.5 MJ recovered per lap (braking), a ~4 MJ usable state-of-charge window;
 * - Manual Override ("overtake") mode for a car within a second of the one ahead:
 *   full deployment held up to 337 km/h and 0.5 MJ of extra energy (here: for
 *   OVERTAKE_TIME seconds, about one straight).
 *
 * Deployment is automatic (as the teams' energy maps): full power while the
 * battery is above a reserve, then scaled down so a car never runs completely
 * flat; harvesting under braking and, more gently, when lifting off.
 */
/** Usable energy store (J). */
export const ERS_CAPACITY = 4e6;
/** Recovery allowed per lap (J). */
export const HARVEST_PER_LAP = 8.5e6;
/** Extra energy in overtake mode (J). */
export const OVERTAKE_ENERGY = 0.5e6;
/** How long overtake mode lasts once armed (s): about one straight. */
export const OVERTAKE_TIME = 12;
/** Battery share below which deployment is scaled down (keeps some for the next straight). */
const RESERVE = 0.3;
/** Harvest power when lifting off without braking (W, a share of the MGU-K). */
const COAST_HARVEST = 120e3;
/** Below this speed the MGU-K neither deploys nor recovers much (m/s). */
const MIN_SPEED = 5;

/** Share of the MGU-K power the rules allow at this speed (m/s). */
export function mgukTaper(speed: number, overtake = false): number {
  const kmh = speed * 3.6;
  const full = overtake ? 337 : 290;
  if (kmh <= full) return 1;
  return Math.max(0, (355 - kmh) / (355 - full));
}

/** Maximum power at the wheels (W) at this speed with a charged battery. */
export function powerAt(car: VehicleConfig, speed: number, overtake = false): number {
  return car.enginePower - car.mgukPower + car.mgukPower * mgukTaper(speed, overtake);
}

export class Ers {
  /** Energy in the store (J). */
  energy = ERS_CAPACITY;
  /** Recovered on this lap (J), against HARVEST_PER_LAP. */
  harvestedThisLap = 0;
  /** Overtake mode energy left (J); > 0 while it is active. */
  overtakeEnergy = 0;
  /** Overtake mode time left (s); > 0 while it is active. */
  overtakeTime = 0;
  /** A car within a second ahead at the last timing point: overtake mode can be armed. */
  overtakeAvailable = false;
  /** Deployment (+) or recovery (-) in the last step (W), for the HUD. */
  power = 0;
  /** Times overtake mode was used (race stats). */
  overtakeUses = 0;
  /** Overtake mode already used on this lap (once per lap). */
  private overtakeUsedThisLap = false;
  private lapDistance = 0;

  constructor(
    private readonly car: VehicleConfig,
    /** Lap length (m): the recovery allowance resets every lap. */
    public lapLength = 5000,
  ) {}

  get charge(): number {
    return this.energy / ERS_CAPACITY;
  }

  get overtakeActive(): boolean {
    return this.overtakeTime > 0;
  }

  /** Overtake mode can still be used on this lap. */
  get overtakeLeft(): boolean {
    return !this.overtakeUsedThisLap && this.car.mgukPower > 0;
  }

  /** Arms overtake mode if a car is close enough ahead (returns whether it did). */
  activateOvertake(): boolean {
    if (!this.overtakeAvailable || this.overtakeUsedThisLap || this.car.mgukPower <= 0) return false;
    this.overtakeUsedThisLap = true;
    this.overtakeEnergy = OVERTAKE_ENERGY;
    this.overtakeTime = OVERTAKE_TIME;
    this.overtakeAvailable = false;
    this.overtakeUses++;
    return true;
  }

  /** Power available at the wheels this step (W) for this throttle and speed. */
  available(speed: number, throttle: number): number {
    const c = this.car;
    if (c.mgukPower <= 0) return c.enginePower;
    const ice = c.enginePower - c.mgukPower;
    if (throttle <= 0 || speed < MIN_SPEED) return ice;
    const overtake = this.overtakeActive;
    // Overtake energy first; then the battery, scaled down below the reserve.
    const store = overtake && this.overtakeEnergy > 0 ? 1 : Math.min(1, this.charge / RESERVE);
    return ice + c.mgukPower * mgukTaper(speed, overtake) * store;
  }

  /**
   * After the physics step: account for what the MGU-K did. `deployed` = power
   * used above the ICE (W), `braking` = brake pedal 0..1.
   */
  step(dt: number, speed: number, deployed: number, throttle: number, braking: number): void {
    const c = this.car;
    if (c.mgukPower <= 0) return;
    this.lapDistance += speed * dt;
    if (this.lapDistance >= this.lapLength) {
      this.lapDistance -= this.lapLength;
      this.harvestedThisLap = 0;
      this.overtakeEnergy = 0;
      this.overtakeTime = 0;
      this.overtakeUsedThisLap = false;
    }
    this.overtakeTime = Math.max(0, this.overtakeTime - dt);
    let recovered = 0;
    if (speed > MIN_SPEED && this.harvestedThisLap < HARVEST_PER_LAP) {
      if (braking > 0) recovered = c.mgukPower * Math.min(1, braking * 1.5);
      else if (throttle <= 0.05) recovered = COAST_HARVEST;
    }
    const used = Math.max(0, deployed) * dt;
    const fromOvertake = Math.min(this.overtakeEnergy, used);
    this.overtakeEnergy -= fromOvertake;
    const gain = Math.min(recovered * dt, HARVEST_PER_LAP - this.harvestedThisLap);
    this.harvestedThisLap += gain;
    this.energy = Math.min(ERS_CAPACITY, Math.max(0, this.energy - (used - fromOvertake) + gain));
    this.power = used > 0 ? deployed : -recovered;
  }

  /** Full battery, new lap (pit exit, reset of a session). */
  reset(): void {
    this.energy = ERS_CAPACITY;
    this.harvestedThisLap = 0;
    this.overtakeEnergy = 0;
    this.overtakeTime = 0;
    this.overtakeAvailable = false;
    this.overtakeUsedThisLap = false;
    this.lapDistance = 0;
    this.power = 0;
  }
}
