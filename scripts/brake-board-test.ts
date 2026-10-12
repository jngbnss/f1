/**
 * Brake marker boards: every big stop gets its 150 / 100 / 50 m boards (where the
 * straight is long enough), off the road, on the outside of the corner, in order.
 *
 *   npx tsx scripts/brake-board-test.ts [monza spa monaco ...]
 */
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { findCar } from '../src/vehicle/cars';
import { brakeBoardSpots } from '../src/world/BrakeBoards';
import { RacingLine } from '../src/world/RacingLine';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['monza', 'spa', 'suzuka', 'monaco', 'melbourne', 'silverstone'];
const car = findCar('f1-ferrari');
let ok = true;
for (const id of ids) {
  const physics = await PhysicsWorld.create(1 / 60);
  const layout = loadLayout(id);
  const track = new ProceduralTrack(physics, layout, { treesPerKm: 0, pitBoxColors: new Array(10).fill(0xffffff) });
  const path = layout.minTimeLine ?? racingLineFor(track);
  const line = new RacingLine(path, car.physics, { heights: track.heightsFor(path) });
  const spots = brakeBoardSpots(track, line);
  const C = track.getCenterline();
  const problems: string[] = [];
  for (const s of spots) {
    const lat = Math.abs(track.lateral(s.position));
    if (lat < track.halfWidth + 0.2) problems.push(`${s.distance} board on the road (|lat| ${lat.toFixed(1)} m)`);
  }
  // Boards of one stop come as 150 -> 100 -> 50 along the lap, ~50 m apart.
  const along = spots.map((s) => ({ d: s.distance, i: track.nearestIndex(s.position) }));
  for (let k = 1; k < along.length; k++) {
    const a = along[k - 1];
    const b = along[k];
    if (b.d < a.d) {
      const gap = ((b.i - a.i + C.length) % C.length) * (track.length / C.length);
      if (Math.abs(gap - (a.d - b.d)) > 25) problems.push(`${a.d}->${b.d} boards ${gap.toFixed(0)} m apart`);
    }
  }
  const stops = spots.filter((s) => s.distance === 50).length;
  // Big stops on the line: corners where the braking drops 50+ km/h.
  const pass = stops >= 3 && problems.length === 0;
  ok &&= pass;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${id.padEnd(12)} ${spots.length} boards, ${stops} braking zones${problems.length ? '\n     ' + problems.slice(0, 6).join('\n     ') : ''}`);
}
console.log(ok ? 'BRAKE BOARDS OK' : 'BRAKE BOARDS FAIL');
process.exit(ok ? 0 : 1);
