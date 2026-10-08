/**
 * 100 cars in 5 classes, with real-world headline figures (approximate,
 * public manufacturer / series data): power, mass, top speed, drivetrain and
 * exterior dimensions. Physics, ratings and the procedural body are all
 * derived from these numbers (see ./build.ts).
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

// --- 1. Street: hot hatches and performance saloons ---------------------
const STREET = rows('street', [
  ['vw-golf-gti', 'Volkswagen', 'Golf GTI', 'hatch', 180, 1430, 250, 'FWD', [4.29, 1.79, 1.46, 2.63], 'i4', 0xc8102e, undefined, true],
  ['vw-golf-r', 'Volkswagen', 'Golf R', 'hatch', 245, 1550, 270, 'AWD', [4.29, 1.79, 1.46, 2.63], 'i4', 0x2a4d8f, undefined, true],
  ['honda-civic-type-r', 'Honda', 'Civic Type R', 'hatch', 235, 1430, 275, 'FWD', [4.59, 1.89, 1.41, 2.73], 'i4', 0xf2f2f2, 0xc8102e],
  ['toyota-gr-yaris', 'Toyota', 'GR Yaris', 'hatch', 206, 1280, 230, 'AWD', [4.0, 1.81, 1.46, 2.56], 'i4', 0xf2f2f2, 0xd0021b, true],
  ['toyota-gr-corolla', 'Toyota', 'GR Corolla', 'hatch', 221, 1475, 230, 'AWD', [4.41, 1.85, 1.48, 2.64], 'i4', 0x1c1c1c, 0xd0021b, true],
  ['hyundai-i30n', 'Hyundai', 'i30 N', 'hatch', 206, 1480, 250, 'FWD', [4.34, 1.8, 1.45, 2.65], 'i4', 0x5aa0d8, 0xd0021b, true],
  ['hyundai-elantra-n', 'Hyundai', 'Elantra N', 'sedan', 206, 1450, 250, 'FWD', [4.68, 1.83, 1.41, 2.72], 'i4', 0x5aa0d8, 0xd0021b, true],
  ['hyundai-ioniq5-n', 'Hyundai', 'IONIQ 5 N', 'hatch', 478, 2200, 260, 'AWD', [4.72, 1.94, 1.59, 3.0], 'electric', 0x6fb0e0, 0xd0021b, true],
  ['ford-focus-rs', 'Ford', 'Focus RS', 'hatch', 257, 1530, 266, 'AWD', [4.39, 1.82, 1.47, 2.65], 'i4', 0x3a6fb5],
  ['renault-megane-rs-trophy', 'Renault', 'Mégane R.S. Trophy', 'hatch', 221, 1420, 260, 'FWD', [4.37, 1.87, 1.44, 2.67], 'i4', 0xf5b400],
  ['mini-jcw', 'MINI', 'John Cooper Works', 'hatch', 170, 1300, 250, 'FWD', [3.88, 1.73, 1.41, 2.5], 'i4', 0x1f5f3a, 0xf2f2f2, true],
  ['audi-rs3', 'Audi', 'RS 3 Sportback', 'hatch', 294, 1575, 290, 'AWD', [4.39, 1.85, 1.44, 2.63], 'i4', 0x7d8a96, undefined, true],
  ['amg-a45s', 'Mercedes-AMG', 'A 45 S', 'hatch', 310, 1635, 270, 'AWD', [4.45, 1.85, 1.41, 2.73], 'i4', 0xe2e4e6, undefined, true],
  ['bmw-m3', 'BMW', 'M3 Competition', 'sedan', 375, 1730, 290, 'RWD', [4.79, 1.9, 1.43, 2.86], 'i6', 0x8bc34a, undefined, true],
  ['amg-c63', 'Mercedes-AMG', 'C 63 S E Performance', 'sedan', 500, 2111, 280, 'AWD', [4.83, 1.9, 1.44, 2.87], 'i4', 0x2b2b2e, undefined, true],
  ['audi-rs6', 'Audi', 'RS 6 Avant', 'wagon', 441, 2075, 305, 'AWD', [4.99, 1.95, 1.46, 2.93], 'v8', 0x5b6670, undefined, true],
  ['alfa-giulia-qv', 'Alfa Romeo', 'Giulia Quadrifoglio', 'sedan', 382, 1580, 307, 'RWD', [4.64, 1.87, 1.43, 2.82], 'v6', 0xa01020],
  ['kia-stinger-gt', 'Kia', 'Stinger GT', 'sedan', 272, 1780, 270, 'RWD', [4.83, 1.87, 1.4, 2.91], 'v6', 0xb3121c],
  ['tesla-model3-p', 'Tesla', 'Model 3 Performance', 'sedan', 377, 1850, 262, 'AWD', [4.72, 1.85, 1.44, 2.88], 'electric', 0xf2f2f2, undefined, true],
  ['subaru-wrx-sti', 'Subaru', 'WRX STI', 'sedan', 227, 1530, 255, 'AWD', [4.6, 1.8, 1.48, 2.65], 'i4', 0x1f3f8f, 0xc9a227],
]);

// --- 2. Sports: road sports cars and coupés --------------------------------
const SPORTS = rows('sports', [
  ['mazda-mx5', 'Mazda', 'MX-5', 'roadster', 135, 1060, 220, 'RWD', [3.92, 1.74, 1.24, 2.31], 'i4', 0xa3001e],
  ['toyota-gr86', 'Toyota', 'GR86', 'coupe', 172, 1270, 226, 'RWD', [4.27, 1.78, 1.31, 2.58], 'flat6', 0xd8d8d8],
  ['nissan-z', 'Nissan', 'Z', 'coupe', 298, 1570, 250, 'RWD', [4.38, 1.85, 1.32, 2.55], 'v6', 0xf2c400, undefined, true],
  ['toyota-gr-supra', 'Toyota', 'GR Supra 3.0', 'coupe', 285, 1540, 250, 'RWD', [4.38, 1.86, 1.29, 2.47], 'i6', 0xd0021b, undefined, true],
  ['bmw-m2', 'BMW', 'M2', 'coupe', 338, 1725, 285, 'RWD', [4.58, 1.89, 1.4, 2.75], 'i6', 0x2f86c9, undefined, true],
  ['bmw-m4', 'BMW', 'M4 Competition', 'coupe', 390, 1725, 290, 'RWD', [4.8, 1.89, 1.39, 2.86], 'i6', 0xe8e8e8, undefined, true],
  ['porsche-cayman-gt4rs', 'Porsche', '718 Cayman GT4 RS', 'mid', 368, 1415, 315, 'RWD', [4.46, 1.82, 1.27, 2.46], 'flat6', 0x7fb3d5, 0x1c1c1c],
  ['porsche-911-carrera-s', 'Porsche', '911 Carrera S', 'coupe', 331, 1515, 308, 'RWD', [4.52, 1.85, 1.3, 2.45], 'flat6', 0xd7d9db],
  ['porsche-911-turbo-s', 'Porsche', '911 Turbo S', 'coupe', 478, 1640, 330, 'AWD', [4.54, 1.9, 1.3, 2.45], 'flat6', 0x2b2b2e],
  ['porsche-911-gt3', 'Porsche', '911 GT3', 'coupe', 375, 1435, 318, 'RWD', [4.57, 1.85, 1.28, 2.46], 'flat6', 0x3fa34d, 0x1c1c1c],
  ['corvette-z06', 'Chevrolet', 'Corvette Z06', 'mid', 500, 1660, 312, 'RWD', [4.69, 2.02, 1.23, 2.72], 'v8', 0xf2c400, 0x1c1c1c],
  ['mustang-dark-horse', 'Ford', 'Mustang Dark Horse', 'coupe', 373, 1760, 270, 'RWD', [4.81, 1.92, 1.4, 2.72], 'v8', 0x1d3557, 0xf2f2f2],
  ['nissan-gtr-nismo', 'Nissan', 'GT-R NISMO', 'coupe', 441, 1720, 315, 'AWD', [4.71, 1.9, 1.37, 2.78], 'v6', 0xf2f2f2, 0xc8102e],
  ['lotus-emira', 'Lotus', 'Emira V6', 'mid', 298, 1458, 290, 'RWD', [4.41, 1.9, 1.23, 2.58], 'v6', 0xf2c400],
  ['alpine-a110s', 'Alpine', 'A110 S', 'mid', 221, 1109, 275, 'RWD', [4.18, 1.8, 1.25, 2.42], 'i4', 0x1f5fbf],
  ['audi-r8', 'Audi', 'R8 V10 performance', 'mid', 456, 1590, 331, 'AWD', [4.43, 1.94, 1.24, 2.65], 'v10', 0x2b2b2e],
  ['lexus-lc500', 'Lexus', 'LC 500', 'coupe', 351, 1935, 270, 'RWD', [4.77, 1.92, 1.35, 2.87], 'v8', 0xc8a02e, undefined, true],
  ['amg-gt63', 'Mercedes-AMG', 'GT 63', 'coupe', 430, 1970, 315, 'AWD', [4.73, 1.98, 1.35, 2.7], 'v8', 0x8a8f94],
  ['jaguar-ftype-r', 'Jaguar', 'F-TYPE R', 'coupe', 423, 1745, 300, 'AWD', [4.47, 1.92, 1.31, 2.62], 'v8', 0x0f4d2c, undefined, true],
  ['aston-vantage', 'Aston Martin', 'Vantage', 'coupe', 492, 1605, 325, 'RWD', [4.5, 1.98, 1.27, 2.7], 'v8', 0x4a7a3a],
]);

// --- 3. GT: GT3 / GT2 race cars --------------------------------------------
const GT = rows('gt', [
  ['ferrari-296-gt3', 'Ferrari', '296 GT3', 'gt3', 441, 1270, 290, 'RWD', [4.71, 2.05, 1.16, 2.66], 'v6', 0xd40000, 0xf2c400],
  ['porsche-911-gt3r', 'Porsche', '911 GT3 R', 'gt3', 416, 1300, 285, 'RWD', [4.62, 2.05, 1.26, 2.51], 'flat6', 0xf2f2f2, 0xc8102e],
  ['lambo-huracan-gt3', 'Lamborghini', 'Huracán GT3 EVO2', 'gt3', 456, 1270, 290, 'RWD', [4.55, 2.22, 1.16, 2.65], 'v10', 0x7cc242, 0x1c1c1c],
  ['mclaren-720s-gt3', 'McLaren', '720S GT3 EVO', 'gt3', 441, 1290, 290, 'RWD', [4.96, 2.04, 1.19, 2.67], 'v8', 0xff8000, 0x1c1c1c],
  ['amg-gt3', 'Mercedes-AMG', 'GT3 EVO', 'gt3', 405, 1300, 285, 'RWD', [4.75, 2.05, 1.24, 2.63], 'v8', 0xc7ccd1, 0x00a19b],
  ['bmw-m4-gt3', 'BMW', 'M4 GT3', 'gt3', 438, 1300, 290, 'RWD', [5.02, 2.04, 1.24, 2.92], 'i6', 0xf2f2f2, 0x1c69d4],
  ['audi-r8-lms', 'Audi', 'R8 LMS GT3 EVO II', 'gt3', 430, 1265, 290, 'RWD', [4.58, 2.0, 1.17, 2.65], 'v10', 0xe8e8e8, 0xbb0a30],
  ['aston-vantage-gt3', 'Aston Martin', 'Vantage AMR GT3', 'gt3', 397, 1280, 285, 'RWD', [4.68, 2.05, 1.21, 2.7], 'v8', 0x00665e, 0xc4d600],
  ['ford-mustang-gt3', 'Ford', 'Mustang GT3', 'gt3', 397, 1300, 285, 'RWD', [5.1, 2.05, 1.2, 2.8], 'v8', 0x1d3557, 0xff6600],
  ['corvette-gt3r', 'Chevrolet', 'Corvette Z06 GT3.R', 'gt3', 400, 1300, 285, 'RWD', [4.67, 2.05, 1.18, 2.72], 'v8', 0xf2c400, 0x1c1c1c],
  ['lexus-rcf-gt3', 'Lexus', 'RC F GT3', 'gt3', 405, 1300, 280, 'RWD', [4.79, 2.05, 1.27, 2.73], 'v8', 0xf2f2f2, 0x1c1c1c],
  ['honda-nsx-gt3', 'Honda', 'NSX GT3 EVO22', 'gt3', 410, 1285, 285, 'RWD', [4.65, 2.05, 1.17, 2.63], 'v6', 0xf2f2f2, 0xc8102e],
  ['nissan-gtr-gt3', 'Nissan', 'GT-R NISMO GT3', 'gt3', 405, 1300, 285, 'RWD', [4.75, 2.04, 1.26, 2.78], 'v6', 0x1c1c1c, 0xc8102e],
  ['bentley-conti-gt3', 'Bentley', 'Continental GT3', 'gt3', 410, 1300, 285, 'RWD', [4.86, 2.05, 1.3, 2.85], 'v8', 0x00543c, 0xf2f2f2],
  ['ferrari-488-gt3', 'Ferrari', '488 GT3 EVO', 'gt3', 441, 1260, 290, 'RWD', [4.71, 2.05, 1.16, 2.65], 'v8', 0xd40000, 0xf2f2f2],
  ['porsche-gt2rs-cs', 'Porsche', '911 GT2 RS Clubsport', 'gt3', 515, 1390, 300, 'RWD', [4.74, 1.98, 1.25, 2.46], 'flat6', 0x1c1c1c, 0xc8102e],
  ['amg-gt2', 'Mercedes-AMG', 'GT2', 'gt3', 515, 1400, 300, 'RWD', [4.75, 2.05, 1.24, 2.63], 'v8', 0x1c1c1c, 0xc7ccd1],
  ['ktm-xbow-gt2', 'KTM', 'X-Bow GT2', 'gt3', 441, 1048, 280, 'RWD', [4.62, 2.04, 1.2, 2.69], 'i4', 0xff6600, 0x1c1c1c],
  ['lambo-st-evo2', 'Lamborghini', 'Huracán Super Trofeo EVO2', 'gt3', 456, 1270, 285, 'RWD', [4.55, 2.22, 1.16, 2.65], 'v10', 0xf2c400, 0x1c1c1c],
  ['porsche-911-cup', 'Porsche', '911 GT3 Cup', 'gt3', 375, 1260, 280, 'RWD', [4.59, 1.92, 1.25, 2.46], 'flat6', 0xf2f2f2, 0x2b2b2e],
]);

// --- 4. Hyper: road hypercars and Le Mans prototypes --------------------------
const HYPER = rows('hyper', [
  ['bugatti-chiron-ss', 'Bugatti', 'Chiron Super Sport', 'supercar', 1177, 1995, 440, 'AWD', [4.62, 2.04, 1.21, 2.71], 'w16', 0x1a2b5f, 0x1c1c1c, true],
  ['koenigsegg-jesko', 'Koenigsegg', 'Jesko Absolut', 'supercar', 1195, 1390, 440, 'RWD', [4.61, 2.03, 1.21, 2.7], 'v8', 0xf2f2f2, 0x1c1c1c],
  ['rimac-nevera', 'Rimac', 'Nevera', 'supercar', 1408, 2300, 412, 'AWD', [4.75, 1.99, 1.21, 2.75], 'electric', 0x2a4f7a, undefined, true],
  ['mclaren-p1', 'McLaren', 'P1', 'supercar', 674, 1490, 350, 'RWD', [4.59, 1.95, 1.19, 2.67], 'v8', 0xff8000, undefined, true],
  ['ferrari-laferrari', 'Ferrari', 'LaFerrari', 'supercar', 708, 1585, 350, 'RWD', [4.7, 1.99, 1.12, 2.65], 'v12', 0xd40000],
  ['porsche-918', 'Porsche', '918 Spyder', 'supercar', 652, 1675, 345, 'AWD', [4.64, 1.94, 1.17, 2.73], 'v8', 0xd7d9db, 0x6f8f3f],
  ['amg-one', 'Mercedes-AMG', 'ONE', 'supercar', 782, 1695, 352, 'AWD', [4.76, 2.01, 1.26, 2.72], 'f1', 0xc7ccd1, 0x00a19b, true],
  ['aston-valkyrie', 'Aston Martin', 'Valkyrie', 'supercar', 865, 1355, 355, 'RWD', [4.39, 1.92, 1.06, 2.71], 'v12', 0x00665e, 0xc4d600],
  ['ferrari-sf90-xx', 'Ferrari', 'SF90 XX Stradale', 'supercar', 760, 1560, 320, 'AWD', [4.85, 2.01, 1.22, 2.65], 'v8', 0xd40000, 0xf2f2f2, true],
  ['lambo-revuelto', 'Lamborghini', 'Revuelto', 'supercar', 747, 1772, 350, 'AWD', [4.95, 2.03, 1.16, 2.78], 'v12', 0x7cc242],
  ['mclaren-senna', 'McLaren', 'Senna', 'supercar', 588, 1198, 335, 'RWD', [4.74, 1.96, 1.23, 2.67], 'v8', 0xf2f2f2, 0x2f86c9, true],
  ['pagani-huayra-r', 'Pagani', 'Huayra R', 'supercar', 625, 1050, 350, 'RWD', [4.86, 2.05, 1.16, 2.8], 'v12', 0x1c1c1c, 0x2f86c9],
  ['ford-gt', 'Ford', 'GT', 'supercar', 485, 1385, 347, 'RWD', [4.76, 2.0, 1.11, 2.71], 'v6', 0x1d3557, 0xf2f2f2],
  ['toyota-gr010', 'Toyota', 'GR010 HYBRID', 'lmp', 500, 1060, 340, 'AWD', [4.9, 2.0, 1.15, 3.15], 'v6', 0x1c1c1c, 0xd0021b],
  ['ferrari-499p', 'Ferrari', '499P', 'lmp', 500, 1060, 340, 'AWD', [5.0, 2.0, 1.15, 3.15], 'v6', 0xd40000, 0xf2c400],
  ['porsche-963', 'Porsche', '963', 'lmp', 500, 1060, 340, 'RWD', [5.1, 2.0, 1.06, 3.15], 'v8', 0xf2f2f2, 0xc8102e],
  ['cadillac-vseries-r', 'Cadillac', 'V-Series.R', 'lmp', 500, 1060, 340, 'RWD', [5.1, 2.0, 1.06, 3.15], 'v8', 0x1c1c1c, 0xc8a02e],
  ['peugeot-9x8', 'Peugeot', '9X8', 'lmp', 500, 1060, 340, 'AWD', [5.0, 2.0, 1.18, 3.05], 'v6', 0x8a8f94, 0x7cc242],
  ['bmw-m-hybrid-v8', 'BMW', 'M Hybrid V8', 'lmp', 500, 1060, 340, 'RWD', [5.1, 2.0, 1.06, 3.15], 'v8', 0xf2f2f2, 0x1c69d4],
  ['alpine-a424', 'Alpine', 'A424', 'lmp', 500, 1060, 340, 'RWD', [5.1, 2.0, 1.06, 3.15], 'v6', 0x1f5fbf, 0xff4fa0],
]);

// --- 5. Formula: single-seaters --------------------------------------------
const F1_DIMS: [number, number, number, number] = [5.4, 1.9, 0.95, 3.4];
const FORMULA = rows('formula', [
  ['f1-ferrari', 'Ferrari', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0xd40000, 0xf2c400],
  ['f1-mercedes', 'Mercedes', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0xc7ccd1, 0x00a19b],
  ['f1-redbull', 'Red Bull', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0x1e2a5a, 0xd0021b],
  ['f1-mclaren', 'McLaren', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0xff8000, 0x1c1c1c],
  ['f1-aston', 'Aston Martin', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0x00665e, 0xc4d600],
  ['f1-alpine', 'Alpine', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0x1f5fbf, 0xff4fa0],
  ['f1-williams', 'Williams', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0x00205b, 0x00a0de],
  ['f1-racingbulls', 'Racing Bulls', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0xf2f2f2, 0x2f5fd0],
  ['f1-haas', 'Haas', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0xf2f2f2, 0xd0021b],
  ['f1-audi', 'Audi', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0x8a8f94, 0xbb0a30],
  ['f1-cadillac', 'Cadillac', 'F1 2026', 'f1', 750, 800, 345, 'RWD', F1_DIMS, 'f1', 0x1c1c1c, 0xc8a02e],
  ['f2-dallara', 'Dallara', 'F2 2024', 'openwheel', 455, 795, 335, 'RWD', [5.22, 1.9, 1.1, 3.14], 'v6', 0x2f86c9, 0xf2f2f2],
  ['f3-dallara', 'Dallara', 'F3 2025', 'openwheel', 280, 673, 300, 'RWD', [4.97, 1.85, 1.05, 2.95], 'v6', 0xf2c400, 0x1c1c1c],
  ['fe-gen3', 'Formula E', 'GEN3 Evo', 'fe', 350, 900, 322, 'AWD', [5.02, 1.7, 1.02, 2.97], 'electric', 0x1c1c1c, 0x00d0ff],
  ['indycar-ir18', 'Dallara', 'IndyCar IR-18', 'indy', 530, 770, 380, 'RWD', [5.21, 1.97, 1.0, 3.07], 'v6', 0x1d3557, 0xf2c400],
  ['super-formula-sf23', 'Dallara', 'Super Formula SF23', 'openwheel', 410, 670, 320, 'RWD', [5.23, 1.9, 0.96, 3.12], 'i4', 0xf2f2f2, 0xd0021b],
  ['fr-tatuus-t318', 'Tatuus', 'Formula Regional T-318', 'openwheel', 200, 640, 260, 'RWD', [4.86, 1.78, 0.97, 2.75], 'i4', 0xc8102e, 0xf2f2f2],
  ['f4-tatuus', 'Tatuus', 'F4 T-421', 'openwheel', 132, 570, 230, 'RWD', [4.47, 1.75, 0.96, 2.75], 'i4', 0x7cc242, 0x1c1c1c],
  ['usf-pro2000', 'Tatuus', 'USF Pro 2000 IP-22', 'openwheel', 190, 590, 250, 'RWD', [4.73, 1.75, 0.96, 2.73], 'i4', 0x2a4f7a, 0xf2c400],
  ['formula-ford-1600', 'Ray', 'Formula Ford 1600', 'openwheel', 85, 500, 200, 'RWD', [4.1, 1.6, 0.95, 2.4], 'i4', 0x1f5f3a, 0xf2f2f2],
]);

export const CAR_SPECS: CarSpec[] = [...STREET, ...SPORTS, ...GT, ...HYPER, ...FORMULA];

export const CLASS_INFO: Record<CarClass, { label: string; description: string }> = {
  street: { label: '스트리트', description: '핫해치 · 고성능 세단' },
  sports: { label: '스포츠', description: '로드 스포츠카 · 쿠페' },
  gt: { label: 'GT 레이스', description: 'GT3 · GT2 레이스카' },
  hyper: { label: '하이퍼', description: '하이퍼카 · 르망 프로토타입' },
  formula: { label: '포뮬러', description: 'F1 · F2 · 인디카 · 주니어 포뮬러' },
};
