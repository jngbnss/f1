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

  /** Peak engine force at standstill (N). Fades out towards maxSpeed. */
  engineForce: number;
  reverseForce: number;
  brakeForce: number;
  handbrakeForce: number;
  /** m/s */
  maxSpeed: number;
  maxReverseSpeed: number;

  /** Quadratic aerodynamic drag coefficient (F = c·v²). */
  dragCoefficient: number;
  /** Linear rolling resistance coefficient (F = c·v). */
  rollingResistance: number;
  /** Extra down force (F = c·v²), keeps fast cars planted. */
  downforce: number;

  /** Fraction of lateral slip cancelled per step (0..1). <1 = some slide. */
  frontGrip: number;
  rearGrip: number;
  /** Friction coefficient: caps lateral force to μ·load. */
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

  engineForce: 13000,
  reverseForce: 6000,
  brakeForce: 18000,
  handbrakeForce: 7000,
  maxSpeed: 58, // ≈ 209 km/h
  maxReverseSpeed: 12,

  dragCoefficient: 0.42,
  rollingResistance: 30,
  downforce: 1.2,

  frontGrip: 0.85,
  rearGrip: 0.9,
  frontFriction: 1.5,
  rearFriction: 1.6,
  handbrakeGripFactor: 0.3,

  maxSteerLowSpeed: 0.6,
  maxSteerHighSpeed: 0.13,
  steerFadeSpeed: 40,
  steerRate: 3.2,
  steerReturnRate: 5.5,
};
