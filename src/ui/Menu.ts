import { CLASS_INFO, type CarClass } from '../vehicle/catalog/specs';
import type { CarDefinition } from '../vehicle/cars';
import type { TrackEntry } from '../world/tracks';

export interface MenuSelection {
  carId: string;
  trackId: string;
  /** AI opponents (0 = free practice). */
  ai: number;
  laps: number;
}

const AI_OPTIONS: [number, string, string][] = [
  [0, '자유 주행', '혼자 연습 · 랩타임 기록'],
  [5, '6대 레이스', '상대 5대'],
  [11, '12대 레이스', '상대 11대'],
  [19, '20대 레이스', '상대 19대 · 풀 그리드'],
];
const LAP_OPTIONS = [1, 3, 5];

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
    let ai = initial.ai;
    let laps = initial.laps;

    const root = document.createElement('div');
    root.className = 'menu';
    root.innerHTML = `
      <div class="menu-panel">
        <h1>web-sim-lab <span>Racing</span></h1>
        <h2>자동차 <small>등급을 고른 뒤 차량을 선택하세요 · 총 ${cars.length}대</small></h2>
        <div class="menu-grid menu-classes" data-group="class"></div>
        <div class="menu-grid" data-group="car"></div>
        <div class="menu-spec" data-group="spec"></div>
        <h2>서킷</h2>
        <div class="menu-grid" data-group="track"></div>
        <h2>레이스</h2>
        <div class="menu-grid" data-group="ai"></div>
        <div class="menu-grid laps" data-group="laps"></div>
        <button class="menu-start" type="button">출발 ▶ <small>(Enter)</small></button>
        <p class="menu-note">실제 서킷 레이아웃: TUMFTM racetrack-database (LGPL-3.0) · © OpenStreetMap contributors. 높낮이 없이 평지로 재현됩니다.</p>
      </div>`;

    const carGrid = root.querySelector<HTMLDivElement>('[data-group="car"]')!;
    const classGrid = root.querySelector<HTMLDivElement>('[data-group="class"]')!;
    const specEl = root.querySelector<HTMLDivElement>('[data-group="spec"]')!;
    let cls: CarClass = cars.find((c) => c.id === carId)?.cls ?? 'formula';
    const trackGrid = root.querySelector<HTMLDivElement>('[data-group="track"]')!;
    const aiGrid = root.querySelector<HTMLDivElement>('[data-group="ai"]')!;
    const lapGrid = root.querySelector<HTMLDivElement>('[data-group="laps"]')!;

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
      classGrid.replaceChildren(
        ...(Object.keys(CLASS_INFO) as CarClass[]).map((k) =>
          card(CLASS_INFO[k].label, CLASS_INFO[k].description, k === cls, () => {
            cls = k;
            // Keep the selection inside the visible class.
            if (cars.find((c) => c.id === carId)?.cls !== k) carId = cars.find((c) => c.cls === k)!.id;
            render();
          }),
        ),
      );
      carGrid.replaceChildren(
        ...cars
          .filter((c) => c.cls === cls)
          .map((c) =>
            card(c.name, `PI ${c.stats.pi} · ${c.description}`, c.id === carId, () => {
              carId = c.id;
              render();
            }),
          ),
      );
      renderSpec(specEl, cars.find((c) => c.id === carId)!);
      trackGrid.replaceChildren(
        ...tracks.map((t) =>
          card(t.name, `${t.location} · ${t.lengthKm} km`, t.id === trackId, () => {
            trackId = t.id;
            render();
          }),
        ),
      );
      aiGrid.replaceChildren(
        ...AI_OPTIONS.map(([n, title, sub]) =>
          card(title, sub, n === ai, () => {
            ai = n;
            render();
          }),
        ),
      );
      lapGrid.style.display = ai > 0 ? '' : 'none';
      lapGrid.replaceChildren(
        ...LAP_OPTIONS.map((n) =>
          card(`${n} 랩`, n === 1 ? '스프린트' : n === 3 ? '기본' : '내구', n === laps, () => {
            laps = n;
            render();
          }),
        ),
      );
    };

    function start(): void {
      window.removeEventListener('keydown', onKey);
      root.remove();
      resolve({ carId, trackId, ai, laps });
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

/** Five rating bars of the selected car, with the figures behind them. */
function renderSpec(el: HTMLElement, car: CarDefinition): void {
  const s = car.stats;
  const bars: [string, number, string][] = [
    ['최고속도', s.topSpeed, `${car.spec.top} km/h`],
    ['가속', s.acceleration, `0-100 ${s.t100.toFixed(1)} s`],
    ['핸들링', s.handling, `${s.lateralG.toFixed(2)} g @150`],
    ['제동', s.braking, `200-0 ${s.brake200} m`],
    ['무게', s.weight, `${car.spec.kg} kg`],
  ];
  el.innerHTML = `<div class="menu-spec-head"><strong></strong><span>PI ${s.pi}</span></div>` +
    bars
      .map(
        ([label, value, raw]) =>
          `<div class="menu-bar"><span>${label}</span><div><i style="width:${Math.max(value, 3)}%"></i></div><b>${raw}</b></div>`,
      )
      .join('');
  el.querySelector('strong')!.textContent = car.name;
}
