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
}

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
