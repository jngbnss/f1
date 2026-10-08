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

const wheelX = 0.82;
const wheelY = -0.15;

export const DEFAULT_CAR: VehicleConfig = {
  mass: 1200,
  halfExtents: { x: 0.9, y: 0.3, z: 2.1 },
  centerOfMass: { x: 0, y: -0.25, z: 0.05 },

  wheelRadius: 0.36,
  wheels: [
    { position: { x: -wheelX, y: wheelY, z: -1.35 }, steerable: true, driven: false, handbrake: false }, // FL
    { position: { x: wheelX, y: wheelY, z: -1.35 }, steerable: true, driven: false, handbrake: false }, // FR
    { position: { x: -wheelX, y: wheelY, z: 1.3 }, steerable: false, driven: true, handbrake: true }, // RL
    { position: { x: wheelX, y: wheelY, z: 1.3 }, steerable: false, driven: true, handbrake: true }, // RR
  ],

  suspensionRestLength: 0.45,
  suspensionStiffness: 22000,
  suspensionDamping: 2200,

  enginePower: 92000, // ≈ 125 hp at the wheels
  engineForce: 9000,
  reverseForce: 6000,
  brakeForce: 30000,
  handbrakeForce: 7000,
  maxSpeed: 60, // limiter 216 km/h; drag tops it out ≈ 209
  maxReverseSpeed: 12,

  dragCoefficient: 0.4, // CdA ≈ 0.65 m²
  rollingResistance: 0.013,
  downforce: 0.05,

  frontGrip: 0.85,
  rearGrip: 0.9,
  frontFriction: 1.05,
  rearFriction: 1.1,
  handbrakeGripFactor: 0.3,

  maxSteerLowSpeed: 0.6,
  maxSteerHighSpeed: 0.13,
  steerFadeSpeed: 40,
  steerRate: 3.2,
  steerReturnRate: 5.5,
};
