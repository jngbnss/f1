import type { EngineSoundProfile } from '../../audio/EngineSound';
import type { GearboxConfig } from '../Gearbox';
import type { VehicleConfig, WheelConfig } from '../VehicleConfig';
import type { BodyType, CarClass, CarSpec, EngineType } from './specs';

const G = 9.81;
const DRIVETRAIN = 0.88;
const CRR = 0.013;
/** F1 slicks at racing temperature (TUMFTM laptime-simulation F1 data: f_roll 0.03). */
const CRR_F1 = 0.03;
/** F1 baseline: a 760 kW car with neutral aero reaches 345 km/h; team drag scales from there. */
const F1_REF_KW = 760;
const F1_REF_TOP = 345 / 3.6;
/** Extra drag per unit of extra downforce (wing level). At 1.2 more downforce lost time even at Monaco. */
const DOWNFORCE_DRAG = 0.5;

/** Tyre μ, aero (½ρClA) and chassis template per body archetype. */
interface BodyTemplate {
  mu: number;
  downforce: number;
  wheelRadius: number;
  /** Collider half height, wheel mount height, suspension rest length. */
  halfY: number;
  wheelY: number;
  rest: number;
  /** Spring / damper per kg of car. */
  springPerKg: number;
  damperPerKg: number;
  grip: [number, number];
  steer: [low: number, high: number, fadeSpeed: number];
  /** Real centre-of-mass height (m) and anti-roll bars per kg of car (front, rear). */
  cgHeight?: number;
  antiRollPerKg?: [number, number];
}

const ROAD: BodyTemplate = { mu: 1.02, downforce: 0.04, wheelRadius: 0.33, halfY: 0.3, wheelY: -0.15, rest: 0.45, springPerKg: 18.5, damperPerKg: 1.85, grip: [0.85, 0.9], steer: [0.6, 0.12, 42] };

const BODY: Record<BodyType, BodyTemplate> = {
  hatch: ROAD,
  sedan: { ...ROAD, wheelRadius: 0.34 },
  wagon: { ...ROAD, wheelRadius: 0.35 },
  coupe: { ...ROAD, mu: 1.12, downforce: 0.08, wheelRadius: 0.34, halfY: 0.28, wheelY: -0.13, rest: 0.4, springPerKg: 21, steer: [0.58, 0.105, 48] },
  roadster: { ...ROAD, mu: 1.08, downforce: 0.03, wheelRadius: 0.31, halfY: 0.27, wheelY: -0.12, rest: 0.4, springPerKg: 20, steer: [0.6, 0.11, 46] },
  mid: { ...ROAD, mu: 1.18, downforce: 0.14, wheelRadius: 0.34, halfY: 0.27, wheelY: -0.12, rest: 0.38, springPerKg: 23, steer: [0.56, 0.1, 50] },
  gt3: { mu: 1.45, downforce: 0.95, wheelRadius: 0.35, halfY: 0.26, wheelY: -0.12, rest: 0.38, springPerKg: 26, damperPerKg: 2.2, grip: [0.88, 0.92], steer: [0.55, 0.085, 55] },
  supercar: { mu: 1.28, downforce: 0.35, wheelRadius: 0.355, halfY: 0.25, wheelY: -0.11, rest: 0.36, springPerKg: 26, damperPerKg: 2.2, grip: [0.88, 0.92], steer: [0.54, 0.085, 58] },
  lmp: { mu: 1.6, downforce: 2.0, wheelRadius: 0.36, halfY: 0.22, wheelY: -0.04, rest: 0.32, springPerKg: 45, damperPerKg: 3, grip: [0.9, 0.95], steer: [0.5, 0.072, 66] },
  // CoG 0.33 m (TUMFTM F1: 0.335); very stiff anti-roll bars (front stiffer): ~1° of roll at 4 g.
  // With the Pacejka tyres a stiffer rear bar made the car snap into oversteer when braking into
  // a corner: AI cars spun at Suzuka, Spa and Shanghai (solo laps up to 30 % slower).
  f1: { mu: 1.75, downforce: 2.9, wheelRadius: 0.36, halfY: 0.2, wheelY: 0, rest: 0.3, springPerKg: 56, damperPerKg: 3.25, grip: [0.9, 0.95], steer: [0.5, 0.07, 70], cgHeight: 0.33, antiRollPerKg: [120, 95] },
  openwheel: { mu: 1.6, downforce: 2.0, wheelRadius: 0.33, halfY: 0.2, wheelY: 0, rest: 0.3, springPerKg: 50, damperPerKg: 3.1, grip: [0.9, 0.95], steer: [0.5, 0.075, 66] },
  indy: { mu: 1.62, downforce: 2.3, wheelRadius: 0.34, halfY: 0.2, wheelY: 0, rest: 0.3, springPerKg: 52, damperPerKg: 3.2, grip: [0.9, 0.95], steer: [0.5, 0.07, 70] },
  fe: { mu: 1.38, downforce: 1.0, wheelRadius: 0.34, halfY: 0.2, wheelY: 0, rest: 0.3, springPerKg: 45, damperPerKg: 3, grip: [0.9, 0.95], steer: [0.52, 0.08, 62] },
};

/** Junior single-seaters get less grip and aero than an F2 car, scaled by power. */
function openWheelScale(spec: CarSpec): number {
  return Math.min(Math.max((spec.kw - 85) / (455 - 85), 0), 1);
}

/** Where the engine sits: positive = towards the rear (center of mass offset, m). */
function comShift(spec: CarSpec): number {
  if (spec.cls === 'formula' || spec.body === 'lmp') return 0.15;
  if (spec.body === 'mid' || spec.body === 'supercar') return 0.18;
  if (spec.brand === 'Porsche' && spec.body !== 'gt3') return 0.22; // rear engine
  if (spec.drive === 'FWD') return -0.12;
  return 0.05;
}

export function buildPhysics(spec: CarSpec): VehicleConfig {
  const t = { ...BODY[spec.body] };
  if (spec.body === 'openwheel') {
    const s = openWheelScale(spec);
    t.mu = 1.38 + 0.24 * s;
    t.downforce = 0.5 + 1.7 * s;
  }
  // Track-focused road cars carry more aero (Senna, Valkyrie, GT3 RS...).
  if (spec.body === 'supercar' && spec.kg < 1400) t.downforce = 0.7;
  const tr = spec.traits;
  if (tr) {
    t.downforce *= tr.downforce;
  }
  const [length, width, , wheelbase] = spec.dims;
  const mass = spec.kg;

  // Drag from the real top speed: P·η = c·v³ + Crr·m·g·v. Limited cars could go
  // ~12 % faster on power, so their drag is lower and the limiter stops them.
  let vTop = spec.top / 3.6;
  const vDrag = spec.limited ? vTop * 1.12 : vTop;
  const power = spec.kw * 1000 * DRIVETRAIN;
  const formula = spec.cls === 'formula';
  const crr = formula ? CRR_F1 : CRR;
  // Rolling resistance grows with the tyre load, downforce included: P·η = c·v³ + Crr·(m·g + D·v²)·v.
  let drag = Math.max((power / vDrag - crr * mass * G) / (vDrag * vDrag) - crr * t.downforce, 0.15);
  if (tr) {
    // F1 teams: drag from the shared baseline (neutral aero) x aero efficiency x wing level
    // (more wing, more drag); the top speed then follows from power, drag and rolling resistance.
    const refPower = F1_REF_KW * 1000 * DRIVETRAIN;
    const baseDownforce = t.downforce / tr.downforce;
    const refDrag = (refPower / F1_REF_TOP - crr * mass * G) / F1_REF_TOP ** 2 - crr * baseDownforce;
    drag = refDrag * tr.drag * (1 + DOWNFORCE_DRAG * (tr.downforce - 1));
    let lo = 50;
    let hi = 150;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (drag * mid ** 3 + crr * (mass * G + t.downforce * mid * mid) * mid < power) lo = mid;
      else hi = mid;
    }
    vTop = lo;
    spec.top = Math.round(vTop * 3.6);
  }

  const wx = width / 2 - 0.15;
  const front = { steerable: true, driven: spec.drive !== 'RWD', handbrake: false };
  const rear = { steerable: false, driven: spec.drive !== 'FWD', handbrake: true };
  const wheels: WheelConfig[] = [
    { position: { x: -wx, y: t.wheelY, z: -wheelbase / 2 }, ...front },
    { position: { x: wx, y: t.wheelY, z: -wheelbase / 2 }, ...front },
    { position: { x: -wx, y: t.wheelY, z: wheelbase / 2 }, ...rear },
    { position: { x: wx, y: t.wheelY, z: wheelbase / 2 }, ...rear },
  ];
  return {
    mass,
    halfExtents: { x: formula ? 0.75 : (width / 2) * 0.9, y: t.halfY, z: (length / 2) * 0.92 },
    centerOfMass: { x: 0, y: -t.halfY + 0.08, z: comShift(spec) },
    wheelRadius: t.wheelRadius,
    wheels,
    suspensionRestLength: t.rest,
    suspensionStiffness: mass * t.springPerKg,
    suspensionDamping: mass * t.damperPerKg,
    antiRollFront: mass * (t.antiRollPerKg?.[0] ?? 15),
    antiRollRear: mass * (t.antiRollPerKg?.[1] ?? 12),
    cgHeight: t.cgHeight ?? 0.45,
    enginePower: power,
    engineForce: mass * G * 1.4,
    reverseForce: mass * 5,
    brakeForce: mass * G * 4,
    // Single-seaters run strong forward bias; road cars a little less.
    brakeBias: formula ? 0.56 : 0.6,
    handbrakeForce: mass * 6,
    maxSpeed: spec.limited ? vTop : vTop * 1.04,
    maxReverseSpeed: 12,
    dragCoefficient: drag,
    rollingResistance: crr,
    downforce: t.downforce,
    // Aero balance near the weight distribution (TUMFTM F1: front ClA 2.20 of 4.88 = 45 %).
    aeroBalance: formula ? 0.45 : 0.5 - comShift(spec) / wheelbase,
    frontGrip: t.grip[0],
    rearGrip: t.grip[1],
    frontFriction: t.mu,
    rearFriction: t.mu * 1.03,
    traction: tr?.traction ?? 1,
    tyreWear: tr?.tyreWear ?? 1,
    braking: tr?.braking ?? 1,
    mechGrip: tr?.grip ?? 1,
    handbrakeGripFactor: 0.3,
    maxSteerLowSpeed: t.steer[0],
    maxSteerHighSpeed: t.steer[1],
    steerFadeSpeed: t.steer[2],
    steerRate: 3.4,
    steerReturnRate: 5.8,
  };
}

const REVS: Record<EngineType, [idle: number, redline: number]> = {
  i4: [850, 7000],
  i6: [800, 7500],
  flat6: [950, 9000],
  v6: [1000, 8000],
  v8: [900, 8200],
  v10: [1000, 8700],
  v12: [1000, 9250],
  w16: [900, 6800],
  f1: [4500, 15000],
  electric: [0, 16000],
};

const GEARS: Record<CarClass, number> = { street: 7, sports: 7, gt: 6, hyper: 7, formula: 8 };

export function buildGearbox(spec: CarSpec): GearboxConfig {
  const [idleRpm, redlineRpm] = REVS[spec.engine];
  const n = spec.engine === 'electric' ? 1 : spec.cls === 'formula' && spec.kw < 250 ? 6 : GEARS[spec.cls];
  const top = (spec.top / 3.6) * 1.02;
  // Geometric spread, first gear ≈ 30 % of top speed (single gear for EVs).
  const r = n > 1 ? Math.pow(0.3, 1 / (n - 1)) : 1;
  const gearTopSpeeds = Array.from({ length: n }, (_, i) => top * Math.pow(r, n - 1 - i));
  return { idleRpm: Math.max(idleRpm, 600), redlineRpm, gearTopSpeeds, shiftTime: spec.cls === 'street' ? 0.16 : spec.cls === 'formula' ? 0.05 : 0.09 };
}

/** Engine sound per engine family (pitch range, oscillator stack, grit). */
const SOUND: Record<EngineType, EngineSoundProfile> = {
  f1: {
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
  v10: {
    idleHz: 80,
    redlineHz: 440,
    sampleGain: 1,
    synthGain: 0.45,
    voices: [
      { type: 'sawtooth', mult: 1, gain: 0.25 },
      { type: 'square', mult: 0.5, gain: 0.28 },
      { type: 'sine', mult: 0.25, gain: 0.3 },
    ],
    noise: 0.1,
    distortion: 9,
    filterMin: 700,
    filterMax: 4400,
    volume: 0.75,
  },
  v12: {
    idleHz: 75,
    redlineHz: 470,
    sampleGain: 1,
    synthGain: 0.5,
    voices: [
      { type: 'sawtooth', mult: 1, gain: 0.26 },
      { type: 'sawtooth', mult: 0.5, gain: 0.2 },
      { type: 'sine', mult: 0.25, gain: 0.32 },
    ],
    noise: 0.08,
    distortion: 6,
    filterMin: 800,
    filterMax: 4800,
    volume: 0.75,
  },
  v8: {
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
  v6: {
    idleHz: 48,
    redlineHz: 330,
    sampleGain: 1,
    synthGain: 0.45,
    voices: [
      { type: 'sawtooth', mult: 1, gain: 0.3 },
      { type: 'square', mult: 0.5, gain: 0.25 },
      { type: 'sine', mult: 0.5, gain: 0.25 },
    ],
    noise: 0.14,
    distortion: 10,
    filterMin: 450,
    filterMax: 3200,
    volume: 0.75,
  },
  flat6: {
    idleHz: 46,
    redlineHz: 420,
    sampleGain: 1,
    synthGain: 0.45,
    voices: [
      { type: 'sawtooth', mult: 1, gain: 0.3 },
      { type: 'square', mult: 0.5, gain: 0.22 },
      { type: 'sawtooth', mult: 1.5, gain: 0.08 },
      { type: 'sine', mult: 0.5, gain: 0.25 },
    ],
    noise: 0.12,
    distortion: 9,
    filterMin: 600,
    filterMax: 4000,
    volume: 0.75,
  },
  i6: {
    idleHz: 40,
    redlineHz: 280,
    sampleGain: 0.95,
    synthGain: 0.4,
    voices: [
      { type: 'sawtooth', mult: 1, gain: 0.28 },
      { type: 'sine', mult: 0.5, gain: 0.3 },
      { type: 'sine', mult: 0.25, gain: 0.2 },
    ],
    noise: 0.1,
    distortion: 6,
    filterMin: 500,
    filterMax: 3000,
    volume: 0.7,
  },
  i4: {
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
  w16: {
    idleHz: 32,
    redlineHz: 230,
    sampleGain: 1.1,
    synthGain: 0.55,
    voices: [
      { type: 'square', mult: 0.5, gain: 0.35 },
      { type: 'sawtooth', mult: 1, gain: 0.25 },
      { type: 'sine', mult: 0.25, gain: 0.4 },
    ],
    noise: 0.18,
    distortion: 10,
    filterMin: 300,
    filterMax: 2200,
    volume: 0.8,
  },
  // Electric: no combustion sample, a clean motor whine rising with speed.
  electric: {
    idleHz: 70,
    redlineHz: 1400,
    sampleGain: 0,
    synthGain: 0.35,
    voices: [
      { type: 'sine', mult: 1, gain: 0.35 },
      { type: 'triangle', mult: 2, gain: 0.12 },
      { type: 'sine', mult: 0.5, gain: 0.15 },
    ],
    noise: 0.02,
    distortion: 0,
    filterMin: 1200,
    filterMax: 6000,
    volume: 0.45,
  },
};

export function buildSound(spec: CarSpec): EngineSoundProfile {
  return SOUND[spec.engine];
}

// --- ratings ---------------------------------------------------------------

export interface CarStats {
  /** 0..100 bars. */
  topSpeed: number;
  acceleration: number;
  handling: number;
  braking: number;
  weight: number;
  /** Raw estimates shown next to the bars. */
  t100: number;
  lateralG: number;
  brake200: number;
  /** Overall performance index 100..999. */
  pi: number;
}

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

/**
 * Performance figures from the same force model as VehiclePhysics (point
 * mass): driven-axle traction, power/drag, aero load, friction-limited brakes.
 */
export function rateCar(spec: CarSpec, c: VehicleConfig): CarStats {
  const m = c.mass;
  const mu = c.frontFriction;
  const drivenShare = spec.drive === 'AWD' ? 1 : spec.drive === 'FWD' ? 0.58 : 0.6;
  // 0-100 km/h
  let v = 0;
  let t = 0;
  const dt = 0.01;
  while (v < 100 / 3.6 && t < 30) {
    const load = m * G + c.downforce * v * v;
    const traction = mu * load * drivenShare;
    const drive = Math.min(c.engineForce, c.enginePower / Math.max(v, 1), traction);
    v += ((drive - c.dragCoefficient * v * v - c.rollingResistance * load) / m) * dt;
    t += dt;
  }
  // 200-0 km/h (or from top speed if slower)
  let vb = Math.min(200, spec.top) / 3.6;
  let d = 0;
  while (vb > 0.5) {
    const decel = mu * (G + (c.downforce * vb * vb) / m) + (c.dragCoefficient * vb * vb) / m;
    d += vb * dt;
    vb -= decel * dt;
  }
  const vRef = 150 / 3.6;
  const lateralG = mu * (1 + (c.downforce * vRef * vRef) / (m * G));
  const stats = {
    topSpeed: Math.round(clamp01((spec.top - 190) / (440 - 190)) * 100),
    acceleration: Math.round(clamp01((7.5 - t) / (7.5 - 1.9)) * 100),
    handling: Math.round(clamp01((lateralG - 0.95) / (3.4 - 0.95)) * 100),
    braking: Math.round(clamp01((150 - d) / (150 - 55)) * 100),
    weight: Math.round(clamp01((2300 - m) / (2300 - 500)) * 100),
    t100: Math.round(t * 10) / 10,
    lateralG: Math.round(lateralG * 100) / 100,
    brake200: Math.round(d),
    pi: 0,
  };
  stats.pi = Math.round(100 + 8.99 * (stats.topSpeed * 0.2 + stats.acceleration * 0.25 + stats.handling * 0.3 + stats.braking * 0.15 + stats.weight * 0.1));
  return stats;
}
