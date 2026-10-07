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
export class VehicleController {
  readonly commands: VehicleCommands = { drive: 0, brake: 0, handbrake: 0, steerAngle: 0 };
  /** Smoothed steering input, -1..1. */
  private steer = 0;

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

    // --- steering -----------------------------------------------------
    const target = input.steer;
    const returning = Math.abs(target) < Math.abs(this.steer) || Math.sign(target) !== Math.sign(this.steer);
    const rate = returning ? c.steerReturnRate : c.steerRate;
    const maxDelta = rate * dt;
    this.steer += Math.max(-maxDelta, Math.min(maxDelta, target - this.steer));

    const t = Math.min(Math.abs(forwardSpeed) / c.steerFadeSpeed, 1);
    const ease = t * (2 - t); // ease-out: range drops quickly at first
    const maxSteer = c.maxSteerLowSpeed + (c.maxSteerHighSpeed - c.maxSteerLowSpeed) * ease;
    cmd.steerAngle = this.steer * maxSteer;

    return cmd;
  }

  reset(): void {
    this.steer = 0;
    this.commands.drive = 0;
    this.commands.brake = 0;
    this.commands.handbrake = 0;
    this.commands.steerAngle = 0;
  }
}
