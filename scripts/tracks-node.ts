/** Circuit data for Node scripts (the game itself loads it through Vite). */
import { existsSync, readFileSync } from 'node:fs';
import type { OsmData } from '../src/world/OsmScenery';
import { DEMO_TRACK, parseTumCsv, PIT_SIDE, type TrackLayout } from '../src/world/TrackLayout';

/** [id, name, data file] in 2026 calendar order — keep in sync with src/world/tracks/index.ts. */
export const REAL_CIRCUITS: [string, string, string][] = [
  ['melbourne', 'Albert Park', 'Melbourne'],
  ['shanghai', 'Shanghai International', 'Shanghai'],
  ['suzuka', 'Suzuka', 'Suzuka'],
  ['sakhir', 'Bahrain International', 'Sakhir'],
  ['montreal', 'Circuit Gilles Villeneuve', 'Montreal'],
  ['catalunya', 'Barcelona-Catalunya', 'Catalunya'],
  ['spielberg', 'Red Bull Ring', 'Spielberg'],
  ['silverstone', 'Silverstone', 'Silverstone'],
  ['spa', 'Spa-Francorchamps', 'Spa'],
  ['budapest', 'Hungaroring', 'Budapest'],
  ['zandvoort', 'Zandvoort', 'Zandvoort'],
  ['monza', 'Monza', 'Monza'],
  ['austin', 'Circuit of the Americas', 'Austin'],
  ['mexicocity', 'Hermanos Rodríguez', 'MexicoCity'],
  ['saopaulo', 'Interlagos', 'SaoPaulo'],
  ['yasmarina', 'Yas Marina', 'YasMarina'],
];

const dataUrl = (f: string) => new URL(`../src/world/tracks/data/${f}`, import.meta.url);

/** Layout by id ('test' = the hand-made demo track), with OSM scenery when present. */
export function loadLayout(id: string): TrackLayout {
  const entry = REAL_CIRCUITS.find(([cid]) => cid === id);
  if (!entry) return DEMO_TRACK;
  const [, name, file] = entry;
  const layout = parseTumCsv(id, name, readFileSync(dataUrl(`${file}.csv`), 'utf8'));
  layout.pitSide = PIT_SIDE[id];
  if (existsSync(dataUrl(`${file}_osm.json`))) layout.scenery = JSON.parse(readFileSync(dataUrl(`${file}_osm.json`), 'utf8')) as OsmData;
  return layout;
}
