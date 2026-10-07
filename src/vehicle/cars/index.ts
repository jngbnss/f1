import type { EngineSoundProfile } from '../../audio/EngineSound';
import type { GearboxConfig } from '../Gearbox';
import { DEFAULT_CAR, type VehicleConfig } from '../VehicleConfig';
import type { VehicleVisual } from '../VehicleVisual';
import { FormulaCarVisual, GTCarVisual, StreetCarVisual } from './CarVisuals';

/** Everything that makes one selectable car. Swap any part independently. */
export interface CarDefinition {
  id: string;
  name: string;
  description: string;
  physics: VehicleConfig;
  gearbox: GearboxConfig;
  engine: EngineSoundProfile;
  /** Builds the car body; `color` overrides the default paint (opponents get their own livery colors). */
  createVisual(color?: number): VehicleVisual;
}

// --- Formula (open-wheel, F1-style) ------------------------------------
const FORMULA: VehicleConfig = {
  mass: 800,
  halfExtents: { x: 0.75, y: 0.2, z: 2.45 },
  centerOfMass: { x: 0, y: -0.2, z: 0.15 },
  wheelRadius: 0.34,
  wheels: [
    { position: { x: -0.82, y: 0, z: -1.8 }, steerable: true, driven: false, handbrake: false },
    { position: { x: 0.82, y: 0, z: -1.8 }, steerable: true, driven: false, handbrake: false },
    { position: { x: -0.8, y: 0, z: 1.7 }, steerable: false, driven: true, handbrake: true },
    { position: { x: 0.8, y: 0, z: 1.7 }, steerable: false, driven: true, handbrake: true },
  ],
  suspensionRestLength: 0.3,
  suspensionStiffness: 45000,
  suspensionDamping: 2600,
  engineForce: 10500,
  reverseForce: 4500,
  brakeForce: 26000,
  handbrakeForce: 5000,
  maxSpeed: 92, // ≈ 331 km/h
  maxReverseSpeed: 10,
  dragCoefficient: 0.3,
  rollingResistance: 20,
  downforce: 2.6,
  frontGrip: 0.9,
  rearGrip: 0.95,
  frontFriction: 2.0,
  rearFriction: 2.1,
  handbrakeGripFactor: 0.35,
  maxSteerLowSpeed: 0.5,
  maxSteerHighSpeed: 0.07,
  steerFadeSpeed: 70,
  steerRate: 3.6,
  steerReturnRate: 6,
};

// --- GT sports car -------------------------------------------------------
const GT: VehicleConfig = {
  mass: 1450,
  halfExtents: { x: 0.95, y: 0.3, z: 2.3 },
  centerOfMass: { x: 0, y: -0.28, z: 0.1 },
  wheelRadius: 0.35,
  wheels: [
    { position: { x: -0.86, y: -0.12, z: -1.42 }, steerable: true, driven: false, handbrake: false },
    { position: { x: 0.86, y: -0.12, z: -1.42 }, steerable: true, driven: false, handbrake: false },
    { position: { x: -0.86, y: -0.12, z: 1.38 }, steerable: false, driven: true, handbrake: true },
    { position: { x: 0.86, y: -0.12, z: 1.38 }, steerable: false, driven: true, handbrake: true },
  ],
  suspensionRestLength: 0.38,
  suspensionStiffness: 30000,
  suspensionDamping: 2800,
  engineForce: 16000,
  reverseForce: 7000,
  brakeForce: 22000,
  handbrakeForce: 8000,
  maxSpeed: 84, // ≈ 302 km/h
  maxReverseSpeed: 12,
  dragCoefficient: 0.38,
  rollingResistance: 30,
  downforce: 1.1,
  frontGrip: 0.85,
  rearGrip: 0.9,
  frontFriction: 1.65,
  rearFriction: 1.75,
  handbrakeGripFactor: 0.3,
  maxSteerLowSpeed: 0.55,
  maxSteerHighSpeed: 0.085,
  steerFadeSpeed: 55,
  steerRate: 3.2,
  steerReturnRate: 5.5,
};

export const CARS: CarDefinition[] = [
  {
    id: 'formula',
    name: 'Formula',
    description: 'F1 스타일 오픈휠 · V10 · 331 km/h',
    physics: FORMULA,
    gearbox: { idleRpm: 4500, redlineRpm: 18000, gearTopSpeeds: [24, 34, 44, 54, 64, 74, 84, 95], shiftTime: 0.06 },
    engine: {
      // Deep, layered "scream": pitch range kept low (120-520 Hz) with a
      // strong sub-octave body instead of a thin high whine.
      idleHz: 120,
      redlineHz: 520,
      sampleGain: 1,
      synthGain: 0.45,
      voices: [
        { type: 'sawtooth', mult: 1, gain: 0.22 },
        { type: 'square', mult: 0.5, gain: 0.3 },
        { type: 'sine', mult: 0.25, gain: 0.35 },
        { type: 'sawtooth', mult: 2, gain: 0.05 },
      ],
      noise: 0.1,
      distortion: 8,
      filterMin: 900,
      filterMax: 5200,
      volume: 0.75,
    },
    createVisual: (color) => new FormulaCarVisual(FORMULA, color).optimize(),
  },
  {
    id: 'gt',
    name: 'GT Sports',
    description: 'GT 스포츠카 · V8 · 302 km/h',
    physics: GT,
    gearbox: { idleRpm: 900, redlineRpm: 8000, gearTopSpeeds: [17, 27, 38, 50, 62, 74, 88], shiftTime: 0.12 },
    engine: {
      // V8 rumble: low firing frequency, cross-plane style half-order burble.
      idleHz: 42,
      redlineHz: 330,
      sampleGain: 1.1,
      synthGain: 0.5,
      voices: [
        { type: 'square', mult: 0.5, gain: 0.4 },
        { type: 'sawtooth', mult: 1, gain: 0.22 },
        { type: 'sine', mult: 0.25, gain: 0.35 },
      ],
      noise: 0.16,
      distortion: 12,
      filterMin: 380,
      filterMax: 2600,
      volume: 0.8,
    },
    createVisual: (color) => new GTCarVisual(GT, color).optimize(),
  },
  {
    id: 'street',
    name: 'Street',
    description: '스트리트 해치백 · 4기통 · 209 km/h',
    physics: DEFAULT_CAR,
    gearbox: { idleRpm: 850, redlineRpm: 7000, gearTopSpeeds: [14, 23, 32, 41, 50, 62], shiftTime: 0.18 },
    engine: {
      idleHz: 38,
      redlineHz: 235,
      sampleGain: 0.9,
      synthGain: 0.4,
      voices: [
        { type: 'sawtooth', mult: 1, gain: 0.3 },
        { type: 'square', mult: 0.5, gain: 0.2 },
        { type: 'sine', mult: 0.5, gain: 0.25 },
      ],
      noise: 0.12,
      distortion: 5,
      filterMin: 500,
      filterMax: 2800,
      volume: 0.65,
    },
    createVisual: (color) => new StreetCarVisual(DEFAULT_CAR, color).optimize(),
  },
];

export function findCar(id: string | null | undefined): CarDefinition {
  return CARS.find((c) => c.id === id) ?? CARS[0];
}
