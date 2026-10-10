import type { OsmData } from '../OsmScenery';
import { applyCircuitSpecifics, DEMO_TRACK, FAMOUS_STANDS, FERRIS_WHEELS, parseTumCsv, PIT_LANE, PIT_SIDE, type TrackLayout } from '../TrackLayout';

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
      const [csv, osm, mintime, woods, elev, marks, teamLines] = await Promise.all([
        loadFile(`${file}.csv`),
        loadFile(`${file}_osm.json`),
        loadFile(`${file}_mintime.json`),
        loadFile(`${file}_woods.json`),
        loadFile(`${file}_elev.json`),
        file === 'Monaco' ? loadFile(`${file}_landmarks.json`) : Promise.resolve(null),
        loadFile(`${file}_teamlines.json`),
      ]);
      if (!csv) throw new Error(`Missing track data: ${file}.csv`);
      const layout = parseTumCsv(id, name, csv);
      applyCircuitSpecifics(layout);
      layout.pitSide = PIT_SIDE[id];
      layout.pitLane = PIT_LANE[id];
      layout.stands = FAMOUS_STANDS[id];
      layout.ferrisWheel = FERRIS_WHEELS[id];
      if (marks) {
        const m = JSON.parse(marks) as { seaLevel: number | null; sea?: number[]; casino?: [number, number] | null };
        layout.sea = seaFrom(m);
        // The Casino de Monte-Carlo is built by hand (MonacoDressing): keep OSM's box off its square.
        if (m.casino) layout.clearings = [[m.casino[0], m.casino[1], 42]];
      }
      if (elev) layout.heights = (JSON.parse(elev) as { heights: number[] }).heights;
      if (mintime) layout.minTimeLine = (JSON.parse(mintime) as { path: [number, number][] }).path;
      if (teamLines) layout.teamLines = JSON.parse(teamLines) as TrackLayout['teamLines'];
      if (osm) {
        layout.scenery = JSON.parse(osm) as OsmData;
        if (woods) layout.scenery.woods = JSON.parse(woods) as OsmData['woods'];
        layout.attribution += ' · Scenery © OpenStreetMap contributors (ODbL)';
      }
      return layout;
    },
  };
}

function seaFrom(m: { seaLevel: number | null; sea?: number[] }): TrackLayout['sea'] {
  if (m.seaLevel === null || !m.sea) return undefined;
  const polygon: [number, number][] = [];
  for (let i = 0; i + 1 < m.sea.length; i += 2) polygon.push([m.sea[i], m.sea[i + 1]]);
  return { level: m.seaLevel, polygon };
}

export const TRACKS: TrackEntry[] = [
  { id: 'test', name: 'Test Circuit', location: 'web-sim-lab', lengthKm: 1.2, load: async () => DEMO_TRACK },
  // 2026 calendar order (circuits available in the TUMFTM dataset). Some
  // layouts in the dataset predate recent track changes (e.g. Yas Marina 2021).
  realCircuit('melbourne', 'Albert Park', 'Melbourne, Australia', 5.3, 'Melbourne'),
  realCircuit('shanghai', 'Shanghai International', 'Shanghai, China', 5.5, 'Shanghai'),
  realCircuit('suzuka', 'Suzuka', 'Suzuka, Japan', 5.8, 'Suzuka'),
  realCircuit('sakhir', 'Bahrain International', 'Sakhir, Bahrain', 5.4, 'Sakhir'),
  // Not in TUMFTM: built from OpenStreetMap (scripts/build-osm-circuit.ts).
  realCircuit('jeddah', 'Jeddah Corniche', 'Jeddah, Saudi Arabia', 6.2, 'Jeddah'),
  realCircuit('miami', 'Miami International Autodrome', 'Miami, USA', 5.4, 'Miami'),
  realCircuit('montreal', 'Circuit Gilles Villeneuve', 'Montréal, Canada', 4.4, 'Montreal'),
  // Street circuit: centerline built from OpenStreetMap (scripts/fetch-monaco.ts), not TUMFTM.
  realCircuit('monaco', 'Monaco', 'Monte Carlo, Monaco', 3.3, 'Monaco'),
  realCircuit('catalunya', 'Barcelona-Catalunya', 'Montmeló, Spain', 4.7, 'Catalunya'),
  realCircuit('spielberg', 'Red Bull Ring', 'Spielberg, Austria', 4.3, 'Spielberg'),
  realCircuit('silverstone', 'Silverstone', 'Silverstone, UK', 5.9, 'Silverstone'),
  realCircuit('spa', 'Spa-Francorchamps', 'Stavelot, Belgium', 7.0, 'Spa'),
  realCircuit('budapest', 'Hungaroring', 'Mogyoród, Hungary', 4.4, 'Budapest'),
  realCircuit('zandvoort', 'Zandvoort', 'Zandvoort, Netherlands', 4.3, 'Zandvoort'),
  realCircuit('monza', 'Monza', 'Monza, Italy', 5.8, 'Monza'),
  realCircuit('madrid', 'Madring', 'Madrid, Spain', 5.5, 'Madrid'),
  realCircuit('baku', 'Baku City Circuit', 'Baku, Azerbaijan', 6.0, 'Baku'),
  realCircuit('singapore', 'Marina Bay', 'Singapore', 4.9, 'Singapore'),
  realCircuit('austin', 'Circuit of the Americas', 'Austin, USA', 5.5, 'Austin'),
  realCircuit('mexicocity', 'Hermanos Rodríguez', 'Mexico City, Mexico', 4.3, 'MexicoCity'),
  realCircuit('saopaulo', 'Interlagos', 'São Paulo, Brazil', 4.3, 'SaoPaulo'),
  realCircuit('lasvegas', 'Las Vegas Strip', 'Las Vegas, USA', 6.2, 'LasVegas'),
  realCircuit('lusail', 'Lusail International', 'Lusail, Qatar', 5.4, 'Lusail'),
  realCircuit('yasmarina', 'Yas Marina', 'Abu Dhabi, UAE', 5.3, 'YasMarina'),
];

/** Circuits offered in the menu: every real circuit, in calendar order (the test track stays reachable by URL, ?track=test). */
export const FEATURED_TRACKS: TrackEntry[] = TRACKS.filter((t) => t.id !== 'test');

export function findTrack(id: string | null | undefined): TrackEntry {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
