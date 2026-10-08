import type { EngineSoundProfile } from '../../audio/EngineSound';
import { buildGearbox, buildPhysics, buildSound, rateCar, type CarStats } from '../catalog/build';
import { ParametricCarVisual } from '../catalog/ParametricCarVisual';
import { CAR_SPECS, type CarClass, type CarSpec } from '../catalog/specs';
import type { GearboxConfig } from '../Gearbox';
import type { VehicleConfig } from '../VehicleConfig';
import type { VehicleVisual } from '../VehicleVisual';
import { FormulaCarVisual } from './CarVisuals';

/** Everything that makes one selectable car. Swap any part independently. */
export interface CarDefinition {
  id: string;
  name: string;
  description: string;
  cls: CarClass;
  spec: CarSpec;
  stats: CarStats;
  physics: VehicleConfig;
  gearbox: GearboxConfig;
  engine: EngineSoundProfile;
  /** Builds the car body; `color` overrides the default paint. */
  createVisual(color?: number): VehicleVisual;
}

function visualFor(spec: CarSpec, physics: VehicleConfig, color?: number): VehicleVisual {
  if (spec.cls === 'formula') {
    const [, width, , wheelbase] = spec.dims;
    // The modelled body is an F1 car (wheelbase 3.5 m, wheels at ±0.81 m): scale it to this car.
    const scale: [number, number, number] = [(width / 2 - 0.15) / 0.81, Math.min(1, 0.9 + width * 0.05), wheelbase / 3.5];
    return new FormulaCarVisual(physics, color ?? spec.color, spec.accent ?? 0xf2f2f2, { scale, aeroscreen: spec.body === 'indy' }).optimize();
  }
  return new ParametricCarVisual(physics, spec, color ?? spec.color).optimize();
}

function define(spec: CarSpec): CarDefinition {
  const physics = buildPhysics(spec);
  const stats = rateCar(spec, physics);
  const hp = Math.round(spec.kw * 1.341);
  return {
    id: spec.id,
    name: `${spec.brand} ${spec.model}`,
    description: `${hp} hp · ${spec.kg} kg · ${spec.top} km/h · ${spec.drive}`,
    cls: spec.cls,
    spec,
    stats,
    physics,
    gearbox: buildGearbox(spec),
    engine: buildSound(spec),
    createVisual: (color) => visualFor(spec, physics, color),
  };
}

export const CARS: CarDefinition[] = CAR_SPECS.map(define);

/** Old ids (before the 100-car catalog) still work in URLs and saved settings. */
const ALIASES: Record<string, string> = { formula: 'f1-ferrari', gt: 'porsche-911-gt3r', street: 'vw-golf-gti' };
export const DEFAULT_CAR_ID = 'f1-ferrari';

export function findCar(id: string | null | undefined): CarDefinition {
  const key = id ? (ALIASES[id] ?? id) : DEFAULT_CAR_ID;
  return CARS.find((c) => c.id === key) ?? CARS.find((c) => c.id === DEFAULT_CAR_ID)!;
}

/**
 * Opponents for a race: cars of the same class closest in performance index
 * (an F1 car races the other F1 teams first, then F2 / IndyCar ...).
 */
export function opponentsFor(car: CarDefinition, count: number): CarDefinition[] {
  const pool = CARS.filter((c) => c.cls === car.cls && c.id !== car.id).sort(
    (a, b) => Math.abs(a.stats.pi - car.stats.pi) - Math.abs(b.stats.pi - car.stats.pi),
  );
  const out: CarDefinition[] = [];
  for (let i = 0; i < count; i++) out.push(pool[i % pool.length]);
  return out;
}
