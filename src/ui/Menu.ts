import type { CarDefinition } from '../vehicle/cars';
import type { TrackEntry } from '../world/tracks';

export interface MenuSelection {
  carId: string;
  trackId: string;
}

/**
 * Start screen: pick a car and a circuit. The click on "Start" is also the
 * user gesture browsers require before audio may play.
 */
export function showMenu(
  cars: CarDefinition[],
  tracks: TrackEntry[],
  initial: MenuSelection,
): Promise<MenuSelection> {
  return new Promise((resolve) => {
    let carId = initial.carId;
    let trackId = initial.trackId;

    const root = document.createElement('div');
    root.className = 'menu';
    root.innerHTML = `
      <div class="menu-panel">
        <h1>web-sim-lab <span>Racing</span></h1>
        <h2>자동차</h2>
        <div class="menu-grid" data-group="car"></div>
        <h2>서킷</h2>
        <div class="menu-grid" data-group="track"></div>
        <button class="menu-start" type="button">출발 ▶ <small>(Enter)</small></button>
        <p class="menu-note">실제 서킷 레이아웃: TUMFTM racetrack-database (LGPL-3.0) · © OpenStreetMap contributors. 높낮이 없이 평지로 재현됩니다.</p>
      </div>`;

    const carGrid = root.querySelector<HTMLDivElement>('[data-group="car"]')!;
    const trackGrid = root.querySelector<HTMLDivElement>('[data-group="track"]')!;

    const card = (title: string, subtitle: string, selected: boolean, onPick: () => void) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'menu-card' + (selected ? ' selected' : '');
      const strong = document.createElement('strong');
      strong.textContent = title;
      const span = document.createElement('span');
      span.textContent = subtitle;
      el.append(strong, span);
      el.addEventListener('click', onPick);
      el.addEventListener('dblclick', start);
      return el;
    };

    const render = () => {
      carGrid.replaceChildren(
        ...cars.map((c) =>
          card(c.name, c.description, c.id === carId, () => {
            carId = c.id;
            render();
          }),
        ),
      );
      trackGrid.replaceChildren(
        ...tracks.map((t) =>
          card(t.name, `${t.location} · ${t.lengthKm} km`, t.id === trackId, () => {
            trackId = t.id;
            render();
          }),
        ),
      );
    };

    function start(): void {
      window.removeEventListener('keydown', onKey);
      root.remove();
      resolve({ carId, trackId });
    }
    function onKey(e: KeyboardEvent): void {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') start();
    }

    root.querySelector('.menu-start')!.addEventListener('click', start);
    window.addEventListener('keydown', onKey);
    render();
    document.body.append(root);
  });
}
