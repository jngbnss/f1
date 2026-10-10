import { CLASS_INFO, type CarClass } from '../vehicle/catalog/specs';
import type { CarInfo as CarDefinition } from '../vehicle/catalog';
import type { TrackEntry } from '../world/tracks';
import { mountWeatherPicker } from '../world/Weather';
import { mountTyrePicker } from './TyrePicker';

export interface MenuSelection {
  carId: string;
  trackId: string;
  /** AI opponents (0 = free practice). */
  ai: number;
  laps: number;
  /** Race friends online instead (opens the multiplayer lobby). */
  multiplayer?: boolean;
}

const AI_OPTIONS: [number, string, string][] = [
  [0, '자유 주행', '혼자 연습 · 랩타임 기록'],
  [5, '6대 레이스', '상대 5대'],
  [11, '12대 레이스', '상대 11대'],
  [19, '20대 레이스', '상대 19대 · 풀 그리드'],
];
const LAP_OPTIONS = [1, 3, 5, 10];
/** Any race distance up to Monaco's real one. */
const MAX_LAPS = 78;

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
        <div class="menu-grid menu-laps" data-group="laps"></div>
        <div data-group="weather"></div>
        <div data-group="tyre"></div>
        <button class="menu-start" type="button">출발 ▶ <small>(Enter)</small></button>
        <button class="menu-start menu-mp" type="button" style="background:#2f6fde;margin-top:10px">👥 친구와 레이스 <small>방 만들기 · 최대 20명</small></button>
        <p class="menu-note">실제 서킷 레이아웃: TUMFTM racetrack-database (LGPL-3.0) · © OpenStreetMap contributors. 스파·스즈카·레드불링·인터라고스 등은 실제 높낮이(Copernicus DEM)까지 재현합니다.</p>
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
        ...(Object.keys(CLASS_INFO) as CarClass[])
          .filter((k) => cars.some((c) => c.cls === k))
          .map((k) =>
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
      // A number field for any race length (the cards are the usual ones).
      const custom = document.createElement('label');
      custom.className = 'menu-card menu-laps-custom' + (LAP_OPTIONS.includes(laps) ? '' : ' selected');
      const title = document.createElement('strong');
      title.textContent = '직접 입력';
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.max = String(MAX_LAPS);
      input.value = String(laps);
      input.setAttribute('aria-label', '랩 수');
      input.addEventListener('change', () => {
        laps = Math.min(MAX_LAPS, Math.max(1, Math.round(Number(input.value) || 1)));
        render();
      });
      // Typing in the field must not start the race (Enter starts it on purpose, after the change).
      input.addEventListener('keydown', (e) => e.stopPropagation());
      const unit = document.createElement('span');
      unit.textContent = `랩 (최대 ${MAX_LAPS})`;
      custom.append(title, input, unit);
      lapGrid.replaceChildren(
        ...LAP_OPTIONS.map((n) =>
          card(`${n} 랩`, n === 1 ? '스프린트' : n === 3 ? '기본' : n === 5 ? '중거리' : '내구', n === laps, () => {
            laps = n;
            render();
          }),
        ),
        custom,
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
    root.querySelector('.menu-mp')!.addEventListener('click', () => {
      window.removeEventListener('keydown', onKey);
      root.remove();
      resolve({ carId, trackId, ai, laps, multiplayer: true });
    });
    window.addEventListener('keydown', onKey);
    mountWeatherPicker(root.querySelector<HTMLDivElement>('[data-group="weather"]')!);
    mountTyrePicker(root.querySelector<HTMLDivElement>('[data-group="tyre"]')!);
    render();
    document.body.append(root);
  });
}

/** Five rating bars of the selected car, with the figures behind them. */
function renderSpec(el: HTMLElement, car: CarDefinition): void {
  const s = car.stats;
  const tr = car.spec.traits;
  // F1 teams: seven bars relative to the field (the middle = the baseline car), so the
  // strengths and weaknesses show instead of ten near-identical F1 bars.
  const rel = (dev: number) => Math.round(Math.min(100, Math.max(4, 50 + dev * 4.5)));
  const pct = (x: number) => `${x >= 1 ? '+' : ''}${Math.round((x - 1) * 100)}%`;
  const bars: [string, number, string][] = tr
    ? [
        ['최고속도', rel((car.spec.top - 345) / 3), `${car.spec.top} km/h`],
        ['파워', rel(((car.spec.kw - 760) / 760) * 100), `${car.spec.kw} kW`],
        ['고속 코너', rel((tr.downforce - 1) * 100), `다운포스 ${pct(tr.downforce)}`],
        ['저속 코너', rel((tr.grip - 1) * 250), `기계적 그립 ${pct(tr.grip)}`],
        ['트랙션', rel((tr.traction - 1) * 100), pct(tr.traction)],
        ['제동', rel((tr.braking - 1) * 100), pct(tr.braking)],
        ['타이어', rel((1 - tr.tyreWear) * 70), `마모 ${pct(tr.tyreWear)}`],
      ]
    : [
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
