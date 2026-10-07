/**
 * Pure-data description of a procedural circuit. A track editor, a JSON
 * file, or a GLB's embedded centerline can all produce this shape.
 */
export interface TrackLayout {
  name: string;
  /** Closed loop of centerline control points [x, z] in meters, in driving order. */
  controlPoints: [number, number][];
  roadWidth: number;
  /** Grass run-off between road edge and barrier (m). */
  runoff: number;
  /** Approx. distance between generated samples (m). */
  sampleSpacing: number;
}

/** ~1.4 km test circuit: long straight, hairpin, chicane, fast sweepers. */
export const DEMO_TRACK: TrackLayout = {
  name: 'Test Circuit',
  // First point = start line; placed mid-straight so the grid faces exactly down it.
  controlPoints: [
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
  roadWidth: 13,
  runoff: 5,
  sampleSpacing: 2.5,
};
