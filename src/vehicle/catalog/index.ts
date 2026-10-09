import { buildPhysics, rateCar, type CarStats } from './build';
import { CAR_SPECS, type CarClass, type CarSpec } from './specs';

/**
 * Menu-weight view of the catalog: names, figures and ratings, no Three.js.
 * The start menu only needs this, so it shows before the 3D engine (and the
 * Rapier WASM) has downloaded.
 */
export interface CarInfo {
  id: string;
  name: string;
  description: string;
  cls: CarClass;
  spec: CarSpec;
  stats: CarStats;
}

export function carInfo(spec: CarSpec): CarInfo {
  const hp = Math.round(spec.kw * 1.341);
  return {
    id: spec.id,
    name: `${spec.brand} ${spec.model}`,
    description: `${hp} hp · ${spec.kg} kg · ${spec.top} km/h · ${spec.drive}`,
    cls: spec.cls,
    spec,
    stats: rateCar(spec, buildPhysics(spec)),
  };
}

export const CAR_LIST: CarInfo[] = CAR_SPECS.map(carInfo);

/** Old ids still work in URLs and saved settings (removed cars fall back to the default). */
const ALIASES: Record<string, string> = { formula: 'f1-ferrari' };
export const DEFAULT_CAR_ID = 'f1-ferrari';

/** Catalog id for a URL/config value (aliases and unknown ids resolved). */
export function resolveCarId(id: string | null | undefined): string {
  const key = id ? (ALIASES[id] ?? id) : DEFAULT_CAR_ID;
  return CAR_SPECS.some((s) => s.id === key) ? key : DEFAULT_CAR_ID;
}
