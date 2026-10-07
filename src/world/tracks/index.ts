import type { OsmData } from '../OsmScenery';
import { DEMO_TRACK, parseTumCsv, type TrackLayout } from '../TrackLayout';

export interface TrackEntry {
  id: string;
  name: string;
  location: string;
  /** Approximate real lap length, for the menu. */
  lengthKm: number;
  /** Loaded on demand (own chunks), so only the chosen circuit is downloaded. */
  load(): Promise<TrackLayout>;
}

// Lazy loaders for every data file; a missing optional file (e.g. no OSM
// scenery fetched yet) simply means "not available".
const files = import.meta.glob<string>('./data/*.{csv,json}', { query: '?raw', import: 'default' });
const loadFile = async (name: string): Promise<string | null> => {
  const loader = files[`./data/${name}`];
  return loader ? loader() : null;
};

/** Real circuit from TUMFTM centerline + racing line + OpenStreetMap surroundings. */
function realCircuit(id: string, name: string, location: string, lengthKm: number, file: string): TrackEntry {
  return {
    id,
    name,
    location,
    lengthKm,
    load: async () => {
      const [csv, raceline, osm] = await Promise.all([
        loadFile(`${file}.csv`),
        loadFile(`${file}_raceline.csv`),
        loadFile(`${file}_osm.json`),
      ]);
      if (!csv) throw new Error(`Missing track data: ${file}.csv`);
      const layout = parseTumCsv(id, name, csv, raceline ?? undefined);
      if (osm) {
        layout.scenery = JSON.parse(osm) as OsmData;
        layout.attribution += ' · Scenery © OpenStreetMap contributors (ODbL)';
      }
      return layout;
    },
  };
}

export const TRACKS: TrackEntry[] = [
  { id: 'test', name: 'Test Circuit', location: 'web-sim-lab', lengthKm: 1.2, load: async () => DEMO_TRACK },
  realCircuit('spielberg', 'Red Bull Ring', 'Spielberg, Austria', 4.3, 'Spielberg'),
  realCircuit('monza', 'Monza', 'Monza, Italy', 5.8, 'Monza'),
  realCircuit('silverstone', 'Silverstone', 'Silverstone, UK', 5.9, 'Silverstone'),
  realCircuit('spa', 'Spa-Francorchamps', 'Stavelot, Belgium', 7.0, 'Spa'),
];

export function findTrack(id: string | null | undefined): TrackEntry {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
