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
  /** Team character (F1): small multipliers around the shared 2026 baseline. */
  traits?: CarTraits;
}

export interface CarTraits {
  /** Aero load: speed through fast bends. */
  downforce: number;
  /** Mechanical grip: slow corners. */
  grip: number;
  /** Rear traction out of slow corners (less wheelspin / snap oversteer). */
  traction: number;
  /** Tyre wear rate (lower = kinder on tyres). */
  tyreWear: number;
  /** Short description for the menu. */
  label: string;
}

type Row = [id: string, brand: string, model: string, body: BodyType, kw: number, kg: number, top: number, drive: Drive, dims: [number, number, number, number], engine: EngineType, color: number, accent?: number, limited?: boolean];

const rows = (cls: CarClass, list: Row[]): CarSpec[] =>
  list.map(([id, brand, model, body, kw, kg, top, drive, dims, engine, color, accent, limited]) => ({ id, brand, model, cls, body, kw, kg, top, drive, dims, engine, color, accent, limited }));

// --- F1 2026: ten teams, two cars each in a race ----------------------------
const F1_DIMS: [number, number, number, number] = [5.4, 1.9, 0.95, 3.4];
const FORMULA = rows('formula', [
  ['f1-ferrari', 'Ferrari', 'F1 2026', 'f1', 760, 800, 348, 'RWD', F1_DIMS, 'f1', 0xd40000, 0x1c1c1c],
  ['f1-mercedes', 'Mercedes', 'F1 2026', 'f1', 765, 800, 347, 'RWD', F1_DIMS, 'f1', 0xc7ccd1, 0x00a19b],
  ['f1-redbull', 'Red Bull', 'F1 2026', 'f1', 750, 800, 343, 'RWD', F1_DIMS, 'f1', 0x1e2a5a, 0xd0021b],
  ['f1-mclaren', 'McLaren', 'F1 2026', 'f1', 750, 800, 342, 'RWD', F1_DIMS, 'f1', 0xff8000, 0x1c1c1c],
  ['f1-aston', 'Aston Martin', 'F1 2026', 'f1', 740, 800, 340, 'RWD', F1_DIMS, 'f1', 0x00665e, 0xc4d600],
  ['f1-alpine', 'Alpine', 'F1 2026', 'f1', 745, 800, 343, 'RWD', F1_DIMS, 'f1', 0x1f5fbf, 0xff4fa0],
  ['f1-williams', 'Williams', 'F1 2026', 'f1', 755, 800, 350, 'RWD', F1_DIMS, 'f1', 0x00205b, 0x00a0de],
  ['f1-racingbulls', 'Racing Bulls', 'F1 2026', 'f1', 745, 800, 343, 'RWD', F1_DIMS, 'f1', 0xf2f2f2, 0x2f5fd0],
  ['f1-haas', 'Haas', 'F1 2026', 'f1', 755, 800, 345, 'RWD', F1_DIMS, 'f1', 0xf2f2f2, 0xd0021b],
  ['f1-audi', 'Audi', 'F1 2026', 'f1', 742, 808, 341, 'RWD', F1_DIMS, 'f1', 0x8a8f94, 0xbb0a30],
]);

// Team characters (rough reading of the 2025-26 field; small on purpose so every car can win).
const TRAITS: Record<string, CarTraits> = {
  'f1-ferrari': { downforce: 0.98, grip: 1, traction: 1.03, tyreWear: 1.05, label: '최고속도 · 직선 강함' },
  'f1-mercedes': { downforce: 1, grip: 1, traction: 1, tyreWear: 0.9, label: '강한 엔진 · 타이어 관리' },
  'f1-redbull': { downforce: 1.03, grip: 1.01, traction: 0.97, tyreWear: 1, label: '예리한 회두 · 오버스티어' },
  'f1-mclaren': { downforce: 1.04, grip: 1.02, traction: 1.02, tyreWear: 0.92, label: '코너 최강 · 타이어 관리' },
  'f1-aston': { downforce: 1.03, grip: 1, traction: 1, tyreWear: 1, label: '높은 다운포스 · 엔진 약함' },
  'f1-alpine': { downforce: 0.99, grip: 1, traction: 1, tyreWear: 1, label: '균형형' },
  'f1-williams': { downforce: 0.96, grip: 0.98, traction: 0.99, tyreWear: 1.03, label: '낮은 드래그 · 직선 최강' },
  'f1-racingbulls': { downforce: 1.01, grip: 1, traction: 0.98, tyreWear: 1.04, label: '민첩함 · 타이어 마모 큼' },
  'f1-haas': { downforce: 0.97, grip: 0.99, traction: 1.01, tyreWear: 1.1, label: '파워 · 타이어 마모 큼' },
  'f1-audi': { downforce: 0.98, grip: 0.99, traction: 1, tyreWear: 0.95, label: '안정적 · 무거운 차' },
};
for (const spec of FORMULA) spec.traits = TRAITS[spec.id];

export const CAR_SPECS: CarSpec[] = FORMULA;

export const CLASS_INFO: Record<CarClass, { label: string; description: string }> = {
  street: { label: '스트리트', description: '핫해치 · 고성능 세단' },
  sports: { label: '스포츠', description: '로드 스포츠카 · 쿠페' },
  gt: { label: 'GT 레이스', description: 'GT3 · GT2 레이스카' },
  hyper: { label: '하이퍼', description: '하이퍼카 · 르망 프로토타입' },
  formula: { label: 'F1 2026', description: '10개 팀 · 팀당 2대' },
};
