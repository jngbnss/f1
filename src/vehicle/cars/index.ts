import type { EngineSoundProfile } from '../../audio/EngineSound';
import { buildGearbox, buildPhysics, buildSound } from '../catalog/build';
import { carInfo, resolveCarId, type CarInfo } from '../catalog';
import { ParametricCarVisual } from '../catalog/ParametricCarVisual';
import { CAR_SPECS, type CarSpec } from '../catalog/specs';
import type { GearboxConfig } from '../Gearbox';
import type { VehicleConfig } from '../VehicleConfig';
import type { VehicleVisual } from '../VehicleVisual';
import { FormulaCarVisual } from './CarVisuals';
import { f1ModelReady, GltfF1Visual } from './GltfF1Visual';

/** Everything that makes one selectable car. Swap any part independently. */
export interface CarDefinition extends CarInfo {
  physics: VehicleConfig;
  gearbox: GearboxConfig;
  engine: EngineSoundProfile;
  /** Builds the car body; `color` overrides the default paint. */
  createVisual(color?: number): VehicleVisual;
}

function visualFor(spec: CarSpec, physics: VehicleConfig, color?: number): VehicleVisual {
  if (spec.body === 'f1' && f1ModelReady()) return new GltfF1Visual(physics, color ?? spec.color, spec.accent ?? 0xf2f2f2);
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
  return {
    ...carInfo(spec),
    physics,
    gearbox: buildGearbox(spec),
    engine: buildSound(spec),
    createVisual: (color) => visualFor(spec, physics, color),
  };
}

export const CARS: CarDefinition[] = CAR_SPECS.map(define);

export function findCar(id: string | null | undefined): CarDefinition {
  const key = resolveCarId(id);
  return CARS.find((c) => c.id === key)!;
}

/**
 * Opponents for a race, like a real grid: the player's teammate first, then
 * every other team with both of its cars (10 teams = 20 cars incl. player).
 */
export function opponentsFor(car: CarDefinition, count: number): CarDefinition[] {
  const others = CARS.filter((c) => c.cls === car.cls && c.id !== car.id);
  const grid = [car, ...others.flatMap((c) => [c, c])];
  return Array.from({ length: count }, (_, i) => grid[i % grid.length]);
}
