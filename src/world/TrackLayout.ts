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
  /**
   * Street circuit (Monaco): walls right at the road edge, pavements instead of
   * grass run-off and gravel traps, a paved town around the track.
   */
  street?: boolean;
  /** Sea / harbour next to the circuit: water surface height (track datum) and world [x, z] outline. */
  sea?: { level: number; polygon: [number, number][] };
  /** Ground kept free of OSM buildings and props for a hand-built landmark: [x, z, half size]. */
  clearings?: [number, number, number][];
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
  // Monaco: start straight (Tribune K side of Bd Albert 1er), Sainte Dévote, Tabac, the Swimming Pool and Rascasse.
  monaco: [
    { at: 90, length: 130, depth: 16, height: 12, side: -1 },
    { at: 185, length: 60, depth: 12, height: 10, side: -1 },
    { at: 2300, length: 90, depth: 14, height: 10, side: -1 },
    { at: 2560, length: 110, depth: 14, height: 10, side: -1 },
    { at: 2860, length: 70, depth: 12, height: 10, side: 1 },
  ],
  // Albert Park: Brabham (main straight, across from the pits), Jones (T1), Clark (T3), Lauda (T6), Waite (T13), Prost (T14).
  melbourne: [
    { at: 90, length: 220, depth: 22, height: 14, side: -1 },
    { at: 370, length: 120, depth: 18, height: 11, side: -1 },
    { at: 1100, length: 110, depth: 16, height: 10, side: -1 },
    { at: 1870, length: 100, depth: 14, height: 9, side: -1 },
    { at: 4120, length: 110, depth: 16, height: 10, side: -1 },
    { at: 4380, length: 100, depth: 14, height: 9, side: -1 },
  ],
  // Shanghai: the main grandstand across from the pits (under the 'wing' bridges), T1-T2 snail, T6 hairpin, T11-T13, T14 hairpin.
  shanghai: [
    { at: 170, length: 340, depth: 30, height: 20, side: -1 },
    { at: 660, length: 160, depth: 20, height: 12, side: -1 },
    { at: 2560, length: 120, depth: 16, height: 10, side: 1 },
    { at: 3380, length: 140, depth: 16, height: 10, side: -1 },
    { at: 4800, length: 160, depth: 20, height: 12, side: -1 },
  ],
  // The rest of the calendar: a stand across from the pits and on the outside of the three
  // sharpest corners (placed from each centerline's corner list).
  sakhir: [
    { at: 120, length: 220, depth: 24, height: 15, side: -1 },
    { at: 730, length: 150, depth: 16, height: 10, side: -1 },
    { at: 2270, length: 160, depth: 16, height: 10, side: -1 },
    { at: 2680, length: 160, depth: 16, height: 10, side: 1 },
  ],
  montreal: [
    { at: 120, length: 220, depth: 24, height: 15, side: 1 },
    { at: 350, length: 160, depth: 16, height: 10, side: -1 },
    { at: 1250, length: 130, depth: 16, height: 10, side: 1 },
    { at: 2700, length: 160, depth: 16, height: 10, side: -1 },
  ],
  catalunya: [
    { at: 120, length: 220, depth: 24, height: 15, side: -1 },
    { at: 1990, length: 160, depth: 16, height: 10, side: 1 },
    { at: 2400, length: 140, depth: 16, height: 10, side: 1 },
    { at: 3390, length: 160, depth: 16, height: 10, side: 1 },
  ],
  spielberg: [
    { at: 120, length: 220, depth: 24, height: 15, side: -1 },
    { at: 440, length: 140, depth: 16, height: 10, side: -1 },
    { at: 1380, length: 150, depth: 16, height: 10, side: -1 },
    { at: 2190, length: 160, depth: 16, height: 10, side: -1 },
  ],
  silverstone: [
    { at: 120, length: 220, depth: 24, height: 15, side: -1 },
    { at: 880, length: 160, depth: 16, height: 10, side: -1 },
    { at: 1030, length: 160, depth: 16, height: 10, side: 1 },
    { at: 2170, length: 160, depth: 16, height: 10, side: -1 },
  ],
  budapest: [
    { at: 120, length: 220, depth: 24, height: 15, side: -1 },
    { at: 630, length: 160, depth: 16, height: 10, side: -1 },
    { at: 1140, length: 160, depth: 16, height: 10, side: 1 },
    { at: 3760, length: 160, depth: 16, height: 10, side: 1 },
  ],
  zandvoort: [
    { at: 120, length: 220, depth: 24, height: 15, side: -1 },
    { at: 400, length: 160, depth: 16, height: 10, side: -1 },
    { at: 890, length: 160, depth: 16, height: 10, side: 1 },
    { at: 3240, length: 160, depth: 16, height: 10, side: 1 },
  ],
  austin: [
    { at: 120, length: 220, depth: 24, height: 15, side: 1 },
    { at: 650, length: 160, depth: 16, height: 10, side: 1 },
    { at: 2560, length: 160, depth: 16, height: 10, side: 1 },
    { at: 4210, length: 160, depth: 16, height: 10, side: 1 },
  ],
  mexicocity: [
    { at: 120, length: 220, depth: 24, height: 15, side: -1 },
    { at: 1900, length: 130, depth: 16, height: 10, side: -1 },
    { at: 2040, length: 160, depth: 16, height: 10, side: -1 },
    { at: 3590, length: 140, depth: 16, height: 10, side: 1 },
  ],
  saopaulo: [
    { at: 120, length: 220, depth: 24, height: 15, side: 1 },
    { at: 2330, length: 160, depth: 16, height: 10, side: -1 },
    { at: 2470, length: 160, depth: 16, height: 10, side: 1 },
    { at: 2750, length: 160, depth: 16, height: 10, side: -1 },
  ],
  yasmarina: [
    { at: 120, length: 220, depth: 24, height: 15, side: 1 },
    { at: 1440, length: 160, depth: 16, height: 10, side: 1 },
    { at: 2630, length: 130, depth: 16, height: 10, side: 1 },
    { at: 4340, length: 140, depth: 16, height: 10, side: -1 },
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
export const PIT_SIDE: Record<string, number> = { monza: 1, spa: 1, suzuka: 1, monaco: 1, melbourne: 1, shanghai: 1,
  sakhir: 1, montreal: -1, catalunya: 1, spielberg: 1, silverstone: 1, budapest: 1, zandvoort: 1, austin: -1, mexicocity: 1, saopaulo: -1, yasmarina: -1,
};

/**
 * Pit lanes that don't fit the default (330 m before the line to 230 m after,
 * boxes centred on the line): Spa's runs from the Bus Stop exit to just
 * before La Source, Suzuka's along the long main straight.
 */
export const PIT_LANE: Record<string, { entry: number; exit: number; boxes: number }> = {
  spa: { entry: 145, exit: 330, boxes: 95 },
  suzuka: { entry: 140, exit: 420, boxes: 140 },
  // Monaco: from the Anthony Noghès exit along the harbour side of Boulevard Albert 1er.
  monaco: { entry: 190, exit: 150, boxes: 20 },
  // Albert Park: the real lane leaves inside T16 (OSM); here from the T16 exit, along the garages behind the line, out before T1.
  melbourne: { entry: 400, exit: 170, boxes: -150 },
  // Shanghai: in from the inside of T16 (OSM), out on the straight well before the T1 snail.
  shanghai: { entry: 270, exit: 230, boxes: 0 },
  // Pit lanes along OSM's raceway pit roads (side and extent), entries after the last corner,
  // exits before T1; boxes stay clear of the ramps (entry + boxes and exit - boxes >= 165 m).
  sakhir: { entry: 300, exit: 500, boxes: 0 },
  montreal: { entry: 380, exit: 180, boxes: 0 },
  catalunya: { entry: 360, exit: 300, boxes: 0 },
  spielberg: { entry: 280, exit: 300, boxes: 0 },
  silverstone: { entry: 200, exit: 300, boxes: 60 },
  budapest: { entry: 190, exit: 375, boxes: 90 },
  zandvoort: { entry: 330, exit: 280, boxes: 100 },
  austin: { entry: 120, exit: 520, boxes: 200 },
  saopaulo: { entry: 350, exit: 250, boxes: 0 },
  yasmarina: { entry: 110, exit: 300, boxes: 90 },
};

/** Per-circuit layout overrides that the CSV can't carry. */
export function applyCircuitSpecifics(layout: TrackLayout): void {
  if (layout.id === 'monaco') {
    // The real road is 8-10 m wide: widened less than the permanent circuits so it stays
    // a narrow street track, with the walls right at the kerb.
    layout.roadWidth = 13.5;
    layout.runoff = 1.6;
    layout.street = true;
    layout.attribution = 'Track & scenery: © OpenStreetMap contributors (ODbL)';
  }
  if (layout.id === 'catalunya' || layout.id === 'yasmarina') {
    // Current layouts from OSM (scripts/fetch-osm-circuit.ts); widths from TUMFTM.
    layout.attribution = 'Track: © OpenStreetMap contributors (ODbL), widths TUMFTM racetrack-database (LGPL-3.0)';
  }
  if (layout.id === 'melbourne') {
    // 2022 layout from OSM (scripts/fetch-albertpark.ts); widths from TUMFTM.
    layout.attribution = 'Track: © OpenStreetMap contributors (ODbL), widths TUMFTM racetrack-database (LGPL-3.0)';
  }
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
