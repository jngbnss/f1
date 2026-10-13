import './style.css';
import './ui/responsive.css';
import { installDiagnostics } from './ui/Diagnostics';
import { music } from './audio/Music';
import { driveSettings } from './ui/DriveSettings';
import { mountVolumeControl } from './ui/VolumeControl';
import { readConfig, urlWith } from './config';
import { clearBenchResults } from './performance/Benchmark';
import { runLobby, type LobbyResult } from './ui/Lobby';
import { showMenu, type MenuSelection } from './ui/Menu';
import { CAR_LIST, resolveCarId } from './vehicle/catalog';
import { FEATURED_TRACKS, findTrack, TRACKS } from './world/tracks';
import type { HandPreview } from './ui/HandPreview';
import { ControlModeSwitch, readControlMode, saveControlMode, type ControlMode } from './ui/ControlModeSwitch';
import { VoiceCommands } from './input/VoiceCommands';

/**
 * After a new deploy, a page loaded earlier still asks for the old hashed
 * chunks, which no longer exist ("Failed to fetch dynamically imported
 * module"). Reload once to pick up the new build instead of failing.
 */
const RELOAD_KEY = 'f1:chunk-reload';
function reloadForNewBuild(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_KEY)) return false;
    sessionStorage.setItem(RELOAD_KEY, '1');
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
window.addEventListener('vite:preloadError', (e) => {
  if (reloadForNewBuild()) e.preventDefault();
});
window.addEventListener('load', () => setTimeout(() => {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    /* ignore */
  }
}, 15000));

async function main(): Promise<void> {
  installDiagnostics();
  // Background music (menu included) if public/audio/bgm has a playlist; silent otherwise.
  void music.start();
  const container = document.getElementById('app');
  const loading = document.getElementById('loading');
  if (!container) throw new Error('#app container missing');

  try {
    // Menu artwork: a studio shot of one car (scripts/render-cars.ts).
    const carShot = new URLSearchParams(window.location.search).get('carshot');
    if (carShot) {
      loading?.remove();
      const { runCarShot } = await import('./ui/CarShot');
      await runCarShot(carShot, container);
      return;
    }
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

    // Multiplayer: a ?room=CODE link (join) or the menu's "race friends" button (host).
    const roomCode = new URLSearchParams(window.location.search).get('room');
    let lobby: LobbyResult | null = null;
    let sel: MenuSelection | null = null;
    if (roomCode && config.bench === 0) {
      loading?.classList.add('hidden');
      lobby = await runLobby(roomCode.toUpperCase());
    } else if (config.showMenu) {
      loading?.classList.add('hidden');
      if (!FEATURED_TRACKS.some((t) => t.id === trackId)) trackId = FEATURED_TRACKS[0].id;
      sel = await showMenu(CAR_LIST, FEATURED_TRACKS, { carId, trackId, ai: config.ai, laps: config.laps, quali: config.quali });
      if (sel.multiplayer) lobby = await runLobby(null);
    }
    if (lobby) {
      // The grid comes from the room: my slot's car, the room's circuit and distance.
      const mine = lobby.plan.slots.find((s) => s.id === lobby!.room.myId) ?? lobby.plan.slots[0];
      carId = mine.carId;
      trackId = lobby.plan.trackId;
      config.laps = lobby.plan.laps;
      loading?.classList.remove('hidden');
    } else if (sel) {
      ({ carId, trackId } = sel);
      // Podium preview: two rivals are enough for the steps (loads faster).
      config.ai = sel.podium ? 2 : sel.ai;
      config.laps = sel.laps;
      config.quali = sel.quali && sel.ai > 0;
      config.grid = 0;
      // Season: the saved (or a new) season decides the team, driver, circuit and distance.
      let seasonDriver: string | null = null;
      if (sel.podium) config.season = false;
      else if (sel.season) {
        const { CALENDAR, loadSeason, newSeason } = await import('./race/Season');
        const { readDriverIndex } = await import('./race/Drivers');
        const old = sel.season === 'continue' ? loadSeason() : null;
        const s = old && old.round < CALENDAR.length ? old : newSeason(sel.carId, readDriverIndex(), sel.laps, sel.quali);
        carId = s.carId;
        trackId = CALENDAR[s.round];
        config.ai = 19;
        config.laps = s.laps;
        config.quali = s.quali;
        config.season = true;
        seasonDriver = String(s.driver);
      } else config.season = false;
      // Shareable / reload-safe URL for this selection.
      history.replaceState(
        null,
        '',
        urlWith({
          car: carId,
          track: trackId,
          ai: String(sel.podium ? sel.ai : config.ai),
          laps: String(config.laps),
          quali: config.quali ? '1' : null,
          grid: null,
          season: config.season ? '1' : null,
          ...(seasonDriver ? { driver: seasonDriver } : {}),
          menu: null,
          podium: sel.podium ? 'only' : null,
        }),
      );
      loading?.classList.remove('hidden');
    }

    const trackEntry = findTrack(trackId);
    if (loading) loading.textContent = `Loading ${trackEntry.name}…`;
    const [layout, [{ Game }, { findCar }]] = await Promise.all([trackEntry.load(), engine]);
    const net = lobby ? new (await import('./net/NetRace')).NetRace(lobby.room, lobby.plan) : null;
    const game = await Game.create(container, config, findCar(carId), layout, net);
    if (loading) loading.textContent = `Preparing ${trackEntry.name}…`;
    await game.prepare();
    game.start();
    loading?.remove();
    setupDriving(game, config.touch, config.bench > 0);

    if (import.meta.env.DEV || config.bench > 0 || lobby) {
      // Console handle for experiments: sim.perf.snapshot, sim.player, sim.resetPlayer() ...
      (window as unknown as { sim: typeof game }).sim = game;
    }
  } catch (err) {
    console.error(err);
    if (err instanceof Error && /dynamically imported module|Importing a module script failed/i.test(err.message) && reloadForNewBuild()) return;
    if (loading) {
      loading.classList.remove('hidden');
      loading.classList.add('error');
      loading.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * Driver aids and touch controls around the running game: brake assist from
 * the saved settings (B toggles it), on-screen controls on touch screens,
 * webcam hand steering on desktop (G toggles it).
 */
async function setupDriving(game: import('./core/Game').Game, touch: boolean, autopilot: boolean): Promise<void> {
  driveSettings.watch((s) => {
    // The benchmark autopilot always drives with the assist (like every AI car); beginner too.
    game.player.physics.brakeAssist = s.brakeAssist || autopilot || game.difficulty.abs;
  });
  const toast = document.createElement('div');
  toast.className = 'toast';
  document.body.append(toast);
  let hide = 0;
  const show = (text: string) => {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(hide);
    hide = window.setTimeout(() => toast.classList.remove('show'), 1600);
  };
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyB' || e.repeat) return;
    const on = !driveSettings.get().brakeAssist;
    driveSettings.set({ brakeAssist: on });
    show(
      game.difficulty.abs
        ? '초보 난이도: 브레이크 보조는 항상 켜짐'
        : on
          ? '브레이크 보조 켬 (잠김 없음)'
          : '브레이크 보조 끔 (세게 밟으면 바퀴 잠김)',
    );
  });
  if (!touch) {
    mountVolumeControl();
    let hand: { preview: HandPreview; voice: VoiceCommands | null } | 'loading' | null = null;
    const setMode = async (mode: ControlMode): Promise<void> => {
      if (hand === 'loading' || (mode === 'hand') === !!hand) return;
      if (hand) {
        hand.preview.dispose();
        game.input.remove('hand');
        if (hand.voice) game.input.remove('voice');
        hand = null;
        modeSwitch.set('keyboard');
        show('키보드 조작');
        return;
      }
      hand = 'loading';
      modeSwitch.set('hand', true);
      show('손 조작 준비 중… (카메라 허용)');
      try {
        // Lazy: keeps the MediaPipe bundle out of the startup chunk for players who never use it.
        const [{ HandInput }, { HandPreview }] = await Promise.all([import('./input/HandInput'), import('./ui/HandPreview')]);
        const input = await HandInput.create();
        game.input.add(input);
        // Spoken pit calls ride along with the hands (Chrome/Edge only).
        let voice: VoiceCommands | null = null;
        if (VoiceCommands.supported) {
          voice = new VoiceCommands(
            () => game.radioSpeaking,
            (a) => {
              if (a === 'pit') input.openTyreWindow();
            },
            () => show('마이크 권한이 없어 음성 명령은 꺼짐'),
          );
          game.input.add(voice);
        }
        hand = { preview: new HandPreview(input), voice };
        modeSwitch.set('hand');
        show(voice ? '손 조작 켬: 주먹 핸들 · 손 펴면 브레이크 · "박스 디스 랩"' : '손 조작 켬: 두 주먹으로 핸들, 손 펴면 브레이크');
      } catch (err) {
        hand = null;
        modeSwitch.set('keyboard');
        console.error(err);
        show(err instanceof DOMException && err.name === 'NotAllowedError' ? '카메라 권한이 거부됨' : '손 인식을 시작하지 못함');
      }
    };
    const modeSwitch = new ControlModeSwitch((mode) => {
      saveControlMode(mode);
      void setMode(mode);
    });
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyG' || e.repeat || hand === 'loading') return;
      const mode = hand ? 'keyboard' : 'hand';
      saveControlMode(mode);
      void setMode(mode);
    });
    // Picked in the menu (or last race): start the camera right away. Not for the benchmark autopilot.
    if (!autopilot && readControlMode() === 'hand') void setMode('hand');
    return;
  }
  const { TouchControls } = await import('./ui/TouchControls');
  const controls = new TouchControls({
    setPaused: (p) => game.setPaused(p),
    playerLocked: () => game.player.physics.wheels.slice(0, 2).some((w) => w.locked),
  });
  game.input.add(controls.input);
}

void main();
