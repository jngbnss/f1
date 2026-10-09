import './style.css';
import { readConfig, urlWith } from './config';
import { clearBenchResults } from './performance/Benchmark';
import { showMenu } from './ui/Menu';
import { CAR_LIST, resolveCarId } from './vehicle/catalog';
import { FEATURED_TRACKS, findTrack, TRACKS } from './world/tracks';

async function main(): Promise<void> {
  const container = document.getElementById('app');
  const loading = document.getElementById('loading');
  if (!container) throw new Error('#app container missing');

  try {
    const config = readConfig();
    // The 3D engine, physics WASM and car models download while the menu is open.
    const engine = Promise.all([import('./core/Game'), import('./vehicle/cars')]);
    let carId = resolveCarId(config.car);
    let trackId = findTrack(config.track ?? FEATURED_TRACKS[0].id).id;

    if (config.bench > 0) {
      if (config.benchFirst) clearBenchResults();
      // ?bench without a track: run every circuit in turn.
      if (!config.track) [trackId, ...config.benchQueue] = TRACKS.map((t) => t.id);
    }

    if (config.showMenu) {
      loading?.classList.add('hidden');
      if (!FEATURED_TRACKS.some((t) => t.id === trackId)) trackId = FEATURED_TRACKS[0].id;
      const sel = await showMenu(CAR_LIST, FEATURED_TRACKS, { carId, trackId, ai: config.ai, laps: config.laps });
      ({ carId, trackId } = sel);
      config.ai = sel.ai;
      config.laps = sel.laps;
      // Shareable / reload-safe URL for this selection.
      history.replaceState(
        null,
        '',
        urlWith({ car: carId, track: trackId, ai: String(sel.ai), laps: String(sel.laps), menu: null }),
      );
      loading?.classList.remove('hidden');
    }

    const trackEntry = findTrack(trackId);
    if (loading) loading.textContent = `Loading ${trackEntry.name}…`;
    const [layout, [{ Game }, { findCar }]] = await Promise.all([trackEntry.load(), engine]);
    const game = await Game.create(container, config, findCar(carId), layout);
    game.start();
    loading?.remove();

    if (import.meta.env.DEV || config.bench > 0) {
      // Console handle for experiments: sim.perf.snapshot, sim.player, sim.resetPlayer() ...
      (window as unknown as { sim: typeof game }).sim = game;
    }
  } catch (err) {
    console.error(err);
    if (loading) {
      loading.classList.remove('hidden');
      loading.classList.add('error');
      loading.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

void main();
