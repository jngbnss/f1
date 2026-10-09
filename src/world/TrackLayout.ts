/**
 * Pure-data description of a circuit. Hand-made layouts, real-world
 * centerline datasets, a track editor, or a GLB's embedded centerline
 * can all produce this shape.
 */
export interface TrackLayout {
  id: string;
  name: string;
  /** Closed loop of centerline points [x, z] in meters, in driving order. First point = start line. */
  points: [number, number][];
  roadWidth: number;
  /** Grass run-off between road edge and barrier (m). */
  runoff: number;
  /** Approx. distance between generated samples (m). */
  sampleSpacing: number;
  /** Optional optimal racing line [x, z] (closed, driving order). Falls back to the centerline. */
  raceline?: [number, number][];
  /** Real-world surroundings (OpenStreetMap), already in track coordinates. */
  scenery?: import('./OsmScenery').OsmData;
  /** Data source credit shown in the UI. */
  attribution?: string;
  /** Baked minimum-lap-time racing line for the F1 car (scripts/bake-raceline.ts). */
  minTimeLine?: [number, number][];
  /** Pit lane along the start/finish straight: +1 right, -1 left of the driving direction. */
  pitSide?: number;
  /** Where the pit lane leaves / rejoins the track (m before / after the start line) and the box row centre (m after the line). */
  pitLane?: { entry: number; exit: number; boxes: number };
  /**
   * Real road height (m) per centerline point (scripts/bake-elevation.ts).
   * Without it the circuit is flat (y = 0) and only the landscape around it
   * follows the real relief.
   */
  heights?: number[];
  /** Grandstands at the circuit's famous corners (m along the lap, preferred side), where OSM has none. */
  stands?: StandSpec[];
  /** Landmark visible from the track (Suzuka's Ferris wheel): m along the lap, side, distance from the centerline. */
  ferrisWheel?: { at: number; side: number; distance: number };
}

export interface StandSpec {
  at: number;
  length: number;
  depth: number;
  height: number;
  /** +1 right of the driving direction, -1 left; the other side is tried when it doesn't fit. */
  side: number;
}

/** Famous grandstands (Spa: Raidillon, Pouhon, Blanchimont, Bus Stop; Suzuka: main straight, S curves, hairpin, Spoon, 130R, chicane). */
export const FAMOUS_STANDS: Record<string, StandSpec[]> = {
  spa: [
    { at: 1180, length: 110, depth: 20, height: 12, side: -1 },
    { at: 2510, length: 90, depth: 16, height: 9, side: 1 },
    { at: 3950, length: 110, depth: 16, height: 9, side: 1 },
    { at: 6200, length: 90, depth: 14, height: 8, side: 1 },
    { at: 6800, length: 130, depth: 22, height: 12, side: -1 },
  ],
  suzuka: [
    { at: 120, length: 260, depth: 28, height: 16, side: -1 },
    { at: 720, length: 140, depth: 22, height: 12, side: -1 },
    { at: 1250, length: 150, depth: 20, height: 10, side: 1 },
    { at: 1560, length: 130, depth: 18, height: 10, side: -1 },
    { at: 2930, length: 100, depth: 16, height: 8, side: 1 },
    { at: 3930, length: 130, depth: 18, height: 9, side: 1 },
    { at: 4970, length: 120, depth: 18, height: 10, side: 1 },
    { at: 5440, length: 150, depth: 20, height: 12, side: -1 },
  ],
};

export const FERRIS_WHEELS: Record<string, { at: number; side: number; distance: number }> = {
  suzuka: { at: 700, side: -1, distance: 300 },
};

/** Side of the pit lane on the start/finish straight (+1 right), where the real one is. */
export const PIT_SIDE: Record<string, number> = { monza: 1, spa: 1, suzuka: 1 };

/**
 * Pit lanes that don't fit the default (330 m before the line to 230 m after,
 * boxes centred on the line): Spa's runs from the Bus Stop exit to just
 * before La Source, Suzuka's along the long main straight.
 */
export const PIT_LANE: Record<string, { entry: number; exit: number; boxes: number }> = {
  spa: { entry: 145, exit: 330, boxes: 95 },
  suzuka: { entry: 140, exit: 420, boxes: 140 },
};

/** ~1.2 km hand-made test circuit: long straight, hairpin, chicane, fast sweepers. */
export const DEMO_TRACK: TrackLayout = {
  id: 'test',
  name: 'Test Circuit',
  // First point = start line; placed mid-straight so the grid faces exactly down it.
  points: [
    [0, 40],
    [0, -40],
    [0, -100],
    [18, -165],
    [75, -200],
    [145, -185],
    [172, -125],
    [140, -70],
    [138, -15],
    [190, 30],
    [205, 105],
    [165, 170],
    [95, 195],
    [35, 185],
    [4, 160],
    [0, 120],
  ],
  roadWidth: 18,
  runoff: 6,
  sampleSpacing: 2.5,
};

/**
 * Parses a TUMFTM racetrack-database CSV
 * (`# x_m,y_m,w_tr_right_m,w_tr_left_m`, x east / y north, meters).
 * World mapping: x -> x, north (y) -> -z, so the layout is not mirrored.
 */
export function parseTumCsv(id: string, name: string, csv: string, racelineCsv?: string): TrackLayout {
  const points: [number, number][] = [];
  let widthSum = 0;
  for (const line of csv.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [x, y, wr, wl] = line.split(',').map(Number);
    if (![x, y, wr, wl].every(Number.isFinite)) continue;
    points.push([x, -y]);
    widthSum += wr + wl;
  }
  if (points.length < 10) throw new Error(`Track ${id}: not enough points`);

  // Drop a duplicated closing point if present.
  const [fx, fz] = points[0];
  const [lx, lz] = points[points.length - 1];
  if (Math.hypot(fx - lx, fz - lz) < 0.5) points.pop();

  const avgWidth = widthSum / points.length;
  return {
    id,
    name,
    points,
    // Real widths are ~10-16 m. Widened by 40% (clamped 16-22 m) so a 20-car arcade
    // field has room to race side by side; the layout itself stays real.
    roadWidth: Math.min(Math.max(avgWidth * 1.4, 16), 22),
    runoff: 8,
    sampleSpacing: 2.5,
    raceline: racelineCsv ? parseXY(racelineCsv) : undefined,
    attribution: 'Track: TUMFTM racetrack-database (LGPL-3.0), based on © OpenStreetMap contributors',
  };
}

/** Parses a TUMFTM raceline CSV (`# x_m,y_m`) into world [x, z]. */
function parseXY(csv: string): [number, number][] {
  const out: [number, number][] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [x, y] = line.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, -y]);
  }
  return out;
}
