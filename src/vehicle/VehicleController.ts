import type { VehicleInput } from '../input/VehicleInput';
import type { VehicleConfig } from './VehicleConfig';

/** Low-level commands VehiclePhysics understands. No device or pedal semantics here. */
export interface VehicleCommands {
  /** -1 (full reverse) .. +1 (full forward) engine output. */
  drive: number;
  /** 0..1 service brake. */
  brake: number;
  /** 0..1 handbrake. */
  handbrake: number;
  /** Front wheel angle in radians, + = right. */
  steerAngle: number;
}

/**
 * Turns driver intent (VehicleInput) into physics commands:
 *  - brake pedal becomes reverse when (nearly) stopped
 *  - steering is rate-limited (smooth for digital keys) and its range
 *    shrinks with speed (stable at high speed, agile at low speed)
 *
 * An AI driver or a ghost replay can bypass this and feed VehicleCommands
 * directly, or produce a VehicleInput and go through it.
 */
/** Human steering boost: rate (turn-in speed), self-centring, lock kept at speed. */
const AGILE = { rate: 1.9, returnRate: 1.4, highSpeedLock: 1.35 };

export class VehicleController {
  readonly commands: VehicleCommands = { drive: 0, brake: 0, handbrake: 0, steerAngle: 0 };
  /** Smoothed steering input, -1..1. */
  private steer = 0;
  /** Brake line pressure, 0..1: builds up in ~0.1 s like a real pedal + hydraulics. */
  private brakePressure = 0;
  /** Human drivers get the pedal build-up; AI (already analog and planned) does not. */
  brakeRamp = true;
  /**
   * Sharper steering for human drivers: an F1 car turns in instantly and keeps
   * more lock at speed than a road car. AI (planned steering) keeps the base values.
   */
  agileSteering = true;

  constructor(private readonly config: VehicleConfig) {}

  update(input: Readonly<VehicleInput>, forwardSpeed: number, dt: number): VehicleCommands {
    const c = this.config;
    const cmd = this.commands;

    // --- pedals -------------------------------------------------------
    const stoppedThreshold = 1.0; // m/s
    cmd.drive = 0;
    cmd.brake = 0;
    if (input.throttle > 0) {
      if (forwardSpeed < -stoppedThreshold) cmd.brake = Math.max(cmd.brake, input.throttle);
      else cmd.drive += input.throttle;
    }
    if (input.brake > 0) {
      if (forwardSpeed > stoppedThreshold) cmd.brake = Math.max(cmd.brake, input.brake);
      else cmd.drive -= input.brake;
    }
    cmd.handbrake = input.handbrake;
    // Pressure ramps toward the pedal (a stamp on a digital key/button still takes ~0.1 s to bite).
    const pressureRate = cmd.brake > this.brakePressure ? 10 : 16;
    this.brakePressure += Math.max(-pressureRate * dt, Math.min(pressureRate * dt, cmd.brake - this.brakePressure));
    if (this.brakeRamp) cmd.brake = this.brakePressure;

    // --- steering -----------------------------------------------------
    const target = input.steer;
    const returning = Math.abs(target) < Math.abs(this.steer) || Math.sign(target) !== Math.sign(this.steer);
    const quick = this.agileSteering ? AGILE.rate : 1;
    const rate = (returning ? c.steerReturnRate * (this.agileSteering ? AGILE.returnRate : 1) : c.steerRate) * (returning ? 1 : quick);
    const maxDelta = rate * dt;
    this.steer += Math.max(-maxDelta, Math.min(maxDelta, target - this.steer));

    const t = Math.min(Math.abs(forwardSpeed) / c.steerFadeSpeed, 1);
    const ease = t * (2 - t); // ease-out: range drops quickly at first
    const high = c.maxSteerHighSpeed * (this.agileSteering ? AGILE.highSpeedLock : 1);
    const maxSteer = c.maxSteerLowSpeed + (high - c.maxSteerLowSpeed) * ease;
    cmd.steerAngle = this.steer * maxSteer;

    return cmd;
  }

  reset(): void {
    this.steer = 0;
    this.brakePressure = 0;
    this.commands.drive = 0;
    this.commands.brake = 0;
    this.commands.handbrake = 0;
    this.commands.steerAngle = 0;
  }
}
