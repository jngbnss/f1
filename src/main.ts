import './style.css';
import { readConfig } from './config';
import { Game } from './core/Game';

async function main(): Promise<void> {
  const container = document.getElementById('app');
  const loading = document.getElementById('loading');
  if (!container) throw new Error('#app container missing');

  try {
    const game = await Game.create(container, readConfig());
    game.start();
    loading?.remove();

    if (import.meta.env.DEV) {
      // Console handle for experiments: sim.perf.snapshot, sim.player, sim.resetPlayer() ...
      (window as unknown as { sim: Game }).sim = game;
    }
  } catch (err) {
    console.error(err);
    if (loading) {
      loading.classList.add('error');
      loading.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

void main();
