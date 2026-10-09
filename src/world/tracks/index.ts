import type { OsmData } from '../OsmScenery';
import { DEMO_TRACK, parseTumCsv, PIT_SIDE, type TrackLayout } from '../TrackLayout';

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
const files = import.meta.glob<string>(['./data/*.{csv,json}', '!./data/*_raceline.csv'], { query: '?raw', import: 'default' });
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
      // The dataset's racing line is for the real road width; the game computes its own.
      const [csv, osm] = await Promise.all([loadFile(`${file}.csv`), loadFile(`${file}_osm.json`)]);
      if (!csv) throw new Error(`Missing track data: ${file}.csv`);
      const layout = parseTumCsv(id, name, csv);
      layout.pitSide = PIT_SIDE[id];
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
  // 2026 calendar order (circuits available in the TUMFTM dataset). Some
  // layouts in the dataset predate recent track changes (e.g. Yas Marina 2021).
  realCircuit('melbourne', 'Albert Park', 'Melbourne, Australia', 5.3, 'Melbourne'),
  realCircuit('shanghai', 'Shanghai International', 'Shanghai, China', 5.5, 'Shanghai'),
  realCircuit('suzuka', 'Suzuka', 'Suzuka, Japan', 5.8, 'Suzuka'),
  realCircuit('sakhir', 'Bahrain International', 'Sakhir, Bahrain', 5.4, 'Sakhir'),
  realCircuit('montreal', 'Circuit Gilles Villeneuve', 'Montréal, Canada', 4.4, 'Montreal'),
  realCircuit('catalunya', 'Barcelona-Catalunya', 'Montmeló, Spain', 4.7, 'Catalunya'),
  realCircuit('spielberg', 'Red Bull Ring', 'Spielberg, Austria', 4.3, 'Spielberg'),
  realCircuit('silverstone', 'Silverstone', 'Silverstone, UK', 5.9, 'Silverstone'),
  realCircuit('spa', 'Spa-Francorchamps', 'Stavelot, Belgium', 7.0, 'Spa'),
  realCircuit('budapest', 'Hungaroring', 'Mogyoród, Hungary', 4.4, 'Budapest'),
  realCircuit('zandvoort', 'Zandvoort', 'Zandvoort, Netherlands', 4.3, 'Zandvoort'),
  realCircuit('monza', 'Monza', 'Monza, Italy', 5.8, 'Monza'),
  realCircuit('austin', 'Circuit of the Americas', 'Austin, USA', 5.5, 'Austin'),
  realCircuit('mexicocity', 'Hermanos Rodríguez', 'Mexico City, Mexico', 4.3, 'MexicoCity'),
  realCircuit('saopaulo', 'Interlagos', 'São Paulo, Brazil', 4.3, 'SaoPaulo'),
  realCircuit('yasmarina', 'Yas Marina', 'Abu Dhabi, UAE', 5.3, 'YasMarina'),
];

/**
 * Circuits offered in the menu. One circuit at a time gets the full realism
 * pass (scenery, trees, trackside detail); the others stay reachable by URL
 * (?track=spa) for tests and benchmarks.
 */
export const FEATURED_TRACKS: TrackEntry[] = TRACKS.filter((t) => t.id === 'monza');

export function findTrack(id: string | null | undefined): TrackEntry {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
