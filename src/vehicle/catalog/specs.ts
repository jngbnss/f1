/**
 * The 2026 F1 grid: ten teams with real headline figures (approximate, public
 * data): power, mass, top speed and dimensions. Physics and ratings are
 * derived from these numbers (see ./build.ts); the body is the shared F1 GLB
 * painted in team colors. The other classes and body types stay in the types
 * so the procedural visuals and build tables keep working if cars are added.
 */
export type CarClass = 'street' | 'sports' | 'gt' | 'hyper' | 'formula';
export type Drive = 'FWD' | 'RWD' | 'AWD';
/** Body archetype used by the procedural model. */
export type BodyType = 'hatch' | 'sedan' | 'wagon' | 'coupe' | 'roadster' | 'mid' | 'gt3' | 'supercar' | 'lmp' | 'f1' | 'openwheel' | 'indy' | 'fe';
/** Engine sound family. */
export type EngineType = 'i4' | 'i6' | 'flat6' | 'v6' | 'v8' | 'v10' | 'v12' | 'w16' | 'f1' | 'electric';

export interface CarSpec {
  id: string;
  brand: string;
  model: string;
  cls: CarClass;
  body: BodyType;
  /** Peak power (kW). */
  kw: number;
  /** Mass incl. driver (kg). */
  kg: number;
  /** Real top speed (km/h). */
  top: number;
  drive: Drive;
  /** Length, width, height, wheelbase (m). */
  dims: [number, number, number, number];
  engine: EngineType;
  /** Body color, accent (wings, stripes). */
  color: number;
  accent?: number;
  /** Electronically limited top speed (power could go faster). */
  limited?: boolean;
}

type Row = [id: string, brand: string, model: string, body: BodyType, kw: number, kg: number, top: number, drive: Drive, dims: [number, number, number, number], engine: EngineType, color: number, accent?: number, limited?: boolean];

const rows = (cls: CarClass, list: Row[]): CarSpec[] =>
  list.map(([id, brand, model, body, kw, kg, top, drive, dims, engine, color, accent, limited]) => ({ id, brand, model, cls, body, kw, kg, top, drive, dims, engine, color, accent, limited }));

// --- F1 2026: ten teams, two cars each in a race ----------------------------
const F1_DIMS: [number, number, number, number] = [5.4, 1.9, 0.95, 3.4];
const FORMULA = rows('formula', [
  ['f1-ferrari', 'Ferrari', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0xd40000, 0x1c1c1c],
  ['f1-mercedes', 'Mercedes', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0xc7ccd1, 0x00a19b],
  ['f1-redbull', 'Red Bull', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0x1e2a5a, 0xd0021b],
  ['f1-mclaren', 'McLaren', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0xff8000, 0x1c1c1c],
  ['f1-aston', 'Aston Martin', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0x00665e, 0xc4d600],
  ['f1-alpine', 'Alpine', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0x1f5fbf, 0xff4fa0],
  ['f1-williams', 'Williams', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0x00205b, 0x00a0de],
  ['f1-racingbulls', 'Racing Bulls', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0xf2f2f2, 0x2f5fd0],
  ['f1-haas', 'Haas', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0xf2f2f2, 0xd0021b],
  ['f1-audi', 'Audi', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0x8a8f94, 0xbb0a30],
]);

export const CAR_SPECS: CarSpec[] = FORMULA;

export const CLASS_INFO: Record<CarClass, { label: string; description: string }> = {
  street: { label: '스트리트', description: '핫해치 · 고성능 세단' },
  sports: { label: '스포츠', description: '로드 스포츠카 · 쿠페' },
  gt: { label: 'GT 레이스', description: 'GT3 · GT2 레이스카' },
  hyper: { label: '하이퍼', description: '하이퍼카 · 르망 프로토타입' },
  formula: { label: 'F1 2026', description: '10개 팀 · 팀당 2대' },
};
