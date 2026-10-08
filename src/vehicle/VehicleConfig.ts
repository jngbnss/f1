/**
 * All tuning numbers for one car. A future "car select" screen just swaps
 * this object (plus the visual). SI units: meters, kg, newtons, seconds.
 *
 * Coordinate convention (vehicle local space): +X right, +Y up, -Z forward.
 */
export interface WheelConfig {
  /** Suspension mount point in chassis local space. */
  position: { x: number; y: number; z: number };
  steerable: boolean;
  driven: boolean;
  /** Affected by handbrake. */
  handbrake: boolean;
}

export interface VehicleConfig {
  mass: number;
  /** Chassis collider half extents. */
  halfExtents: { x: number; y: number; z: number };
  /** Center of mass offset (lower = more stable). */
  centerOfMass: { x: number; y: number; z: number };

  wheelRadius: number;
  wheels: WheelConfig[];

  suspensionRestLength: number;
  suspensionStiffness: number;
  suspensionDamping: number;

  /** Engine power at the wheels (W). Drive force = min(engineForce, power / speed). */
  enginePower: number;
  /** Max tractive force (N): launch limit before power takes over. */
  engineForce: number;
  reverseForce: number;
  brakeForce: number;
  handbrakeForce: number;
  /** Rev limiter in top gear (m/s). Real top speed usually comes from power vs drag first. */
  maxSpeed: number;
  maxReverseSpeed: number;

  /** Aerodynamic drag ½ρ·Cd·A (F = c·v², N per (m/s)²). */
  dragCoefficient: number;
  /** Rolling resistance coefficient Crr (F = Crr · wheel load). */
  rollingResistance: number;
  /** Aerodynamic downforce ½ρ·Cl·A (F = c·v²); adds tyre load, so grip grows with speed. */
  downforce: number;

  /** Fraction of lateral slip cancelled per step (0..1). <1 = some slide. */
  frontGrip: number;
  rearGrip: number;
  /** Tyre friction coefficient μ: total (lateral + longitudinal) force ≤ μ·load. */
  frontFriction: number;
  rearFriction: number;
  /** Rear friction multiplier while handbrake is held (drift). */
  handbrakeGripFactor: number;

  /** Max steer angle (rad) at standstill and at high speed. */
  maxSteerLowSpeed: number;
  maxSteerHighSpeed: number;
  /** Speed (m/s) at which steering reaches maxSteerHighSpeed. */
  steerFadeSpeed: number;
  /** Steering wheel turn rate (input units/s) and return-to-center rate. */
  steerRate: number;
  steerReturnRate: number;
}
