/** Circuit data for Node scripts (the game itself loads it through Vite). */
import { existsSync, readFileSync } from 'node:fs';
import type { OsmData } from '../src/world/OsmScenery';
import { applyCircuitSpecifics, DEMO_TRACK, FAMOUS_STANDS, FERRIS_WHEELS, parseTumCsv, PIT_LANE, PIT_SIDE, type TrackLayout } from '../src/world/TrackLayout';

/** [id, name, data file] in 2026 calendar order — keep in sync with src/world/tracks/index.ts. */
export const REAL_CIRCUITS: [string, string, string][] = [
  ['melbourne', 'Albert Park', 'Melbourne'],
  ['shanghai', 'Shanghai International', 'Shanghai'],
  ['suzuka', 'Suzuka', 'Suzuka'],
  ['sakhir', 'Bahrain International', 'Sakhir'],
  ['monaco', 'Monaco', 'Monaco'],
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
  ['jeddah', 'Jeddah Corniche', 'Jeddah'],
  ['miami', 'Miami International Autodrome', 'Miami'],
  ['madrid', 'Madring', 'Madrid'],
  ['baku', 'Baku City Circuit', 'Baku'],
  ['singapore', 'Marina Bay', 'Singapore'],
  ['lasvegas', 'Las Vegas Strip', 'LasVegas'],
  ['lusail', 'Lusail International', 'Lusail'],
];

const dataUrl = (f: string) => new URL(`../src/world/tracks/data/${f}`, import.meta.url);

/** Layout by id ('test' = the hand-made demo track), with OSM scenery when present. */
export function loadLayout(id: string): TrackLayout {
  const entry = REAL_CIRCUITS.find(([cid]) => cid === id);
  if (!entry) return DEMO_TRACK;
  const [, name, file] = entry;
  const layout = parseTumCsv(id, name, readFileSync(dataUrl(`${file}.csv`), 'utf8'));
  applyCircuitSpecifics(layout);
  layout.pitSide = PIT_SIDE[id];
  layout.pitLane = PIT_LANE[id];
  layout.stands = FAMOUS_STANDS[id];
  layout.ferrisWheel = FERRIS_WHEELS[id];
  if (existsSync(dataUrl(`${file}_elev.json`))) layout.heights = (JSON.parse(readFileSync(dataUrl(`${file}_elev.json`), 'utf8')) as { heights: number[] }).heights;
  if (existsSync(dataUrl(`${file}_mintime.json`))) layout.minTimeLine = (JSON.parse(readFileSync(dataUrl(`${file}_mintime.json`), 'utf8')) as { path: [number, number][] }).path;
  if (existsSync(dataUrl(`${file}_teamlines.json`))) layout.teamLines = JSON.parse(readFileSync(dataUrl(`${file}_teamlines.json`), 'utf8')) as TrackLayout['teamLines'];
  if (existsSync(dataUrl(`${file}_osm.json`))) layout.scenery = JSON.parse(readFileSync(dataUrl(`${file}_osm.json`), 'utf8')) as OsmData;
  if (layout.scenery && existsSync(dataUrl(`${file}_woods.json`))) layout.scenery.woods = JSON.parse(readFileSync(dataUrl(`${file}_woods.json`), 'utf8')) as OsmData['woods'];
  return layout;
}
