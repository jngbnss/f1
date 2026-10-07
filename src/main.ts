import './style.css';
import { readConfig, urlWith } from './config';
import { Game } from './core/Game';
import { showMenu } from './ui/Menu';
import { CARS, findCar } from './vehicle/cars';
import { findTrack, TRACKS } from './world/tracks';

async function main(): Promise<void> {
  const container = document.getElementById('app');
  const loading = document.getElementById('loading');
  if (!container) throw new Error('#app container missing');

  try {
    const config = readConfig();
    let carId = findCar(config.car).id;
    let trackId = findTrack(config.track).id;

    if (config.showMenu) {
      loading?.classList.add('hidden');
      const sel = await showMenu(CARS, TRACKS, { carId, trackId, ai: config.ai, laps: config.laps });
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
    const layout = await trackEntry.load();
    const game = await Game.create(container, config, findCar(carId), layout);
    game.start();
    loading?.remove();

    if (import.meta.env.DEV) {
      // Console handle for experiments: sim.perf.snapshot, sim.player, sim.resetPlayer() ...
      (window as unknown as { sim: Game }).sim = game;
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
