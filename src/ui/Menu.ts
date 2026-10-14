import type { CarInfo as CarDefinition } from '../vehicle/catalog';
import { COMPOUND_NAMES } from '../vehicle/Tyres';
import type { TrackEntry } from '../world/tracks';
import { mountWeatherPicker, readWeather } from '../world/Weather';
import { CIRCUIT_INFO } from './circuitInfo';
import circuitMaps from './circuitMaps.json';
import { mountTyrePicker, readStartTyre } from './TyrePicker';
import { AI_LEVEL, AI_LEVELS, DIFFICULTIES, DIFFICULTY, readAiLevel, readDifficulty, saveAiLevel, saveDifficulty } from '../race/Difficulty';
import { DRIVERS, readDriverIndex, saveDriverIndex } from '../race/Drivers';
import { CALENDAR, loadSeason } from '../race/Season';
import { isTouchDevice } from '../platform';
import { CONTROL_MODE_LABEL, CONTROL_MODES, readControlMode, saveControlMode, type ControlMode } from './ControlModeSwitch';
import { setVoicePack, voicePackOn } from '../audio/VoicePack';
import { QUALITY_OPTIONS, readTier, saveTier } from '../performance/Quality';

const CONTROL_HINTS: Record<ControlMode, string> = { keyboard: '키보드·게임패드', hand: '웹캠: 주먹 핸들 · 속도는 자동' };

export interface MenuSelection {
  carId: string;
  trackId: string;
  /** AI opponents (0 = free practice). */
  ai: number;
  laps: number;
  /** Qualifying before the race (sets the grid). */
  quali: boolean;
  /** Season mode: continue the saved season or start a new one; null = a single race. */
  season?: 'continue' | 'new' | null;
  /** Just watch the podium ceremony (the picked driver on the top step), then back to the menu. */
  podium?: boolean;
  /** Race friends online instead (opens the multiplayer lobby). */
  multiplayer?: boolean;
}

const AI_OPTIONS: [number, string, string][] = [
  [0, '자유 주행', '혼자 연습'],
  [5, '6대', '상대 5대'],
  [11, '12대', '상대 11대'],
  [19, '20대', '풀 그리드'],
];
const LAP_OPTIONS = [1, 3, 5, 10];
/** Any race distance up to Monaco's real one. */
const MAX_LAPS = 78;
const WEATHER_NAMES: Record<string, string> = { clear: '맑음', cloudy: '흐림', drizzle: '약한 비', rain: '비' };
const TIME_NAMES: Record<string, string> = { day: '낮', dusk: '해 질 녘', night: '밤' };

type MapData = { d: string; start: [number, number]; dir: [number, number] };
const MAPS = circuitMaps as unknown as Record<string, MapData>;
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** The seven team stats as 0..100 bars relative to the F1 field (50 = the baseline car), with the figure behind each. */
function teamStats(car: CarDefinition): { label: string; value: number; raw: string }[] {
  const tr = car.spec.traits;
  const s = car.stats;
  if (!tr) {
    return [
      { label: '최고속도', value: s.topSpeed, raw: `${car.spec.top} km/h` },
      { label: '가속', value: s.acceleration, raw: `0-100 ${s.t100.toFixed(1)} s` },
      { label: '핸들링', value: s.handling, raw: `${s.lateralG.toFixed(2)} g` },
      { label: '제동', value: s.braking, raw: `200-0 ${s.brake200} m` },
    ];
  }
  const rel = (dev: number) => Math.round(Math.min(100, Math.max(4, 50 + dev * 4.5)));
  const pct = (x: number) => `${x >= 1 ? '+' : ''}${Math.round((x - 1) * 100)}%`;
  return [
    { label: '최고속도', value: rel((car.spec.top - 345) / 3), raw: `${car.spec.top} km/h` },
    { label: '파워', value: rel(((car.spec.kw - 760) / 760) * 100), raw: `${car.spec.kw} kW` },
    { label: '고속 코너', value: rel((tr.downforce - 1) * 100), raw: `다운포스 ${pct(tr.downforce)}` },
    { label: '저속 코너', value: rel((tr.grip - 1) * 250), raw: `그립 ${pct(tr.grip)}` },
    { label: '트랙션', value: rel((tr.traction - 1) * 100), raw: pct(tr.traction) },
    { label: '제동', value: rel((tr.braking - 1) * 100), raw: pct(tr.braking) },
    { label: '타이어', value: rel((1 - tr.tyreWear) * 70), raw: `마모 ${pct(tr.tyreWear)}` },
  ];
}

/** Two best and two worst stats: the team's character at a glance. */
function strengthsOf(car: CarDefinition): { good: string[]; bad: string[] } {
  const stats = teamStats(car);
  const sorted = [...stats].sort((a, b) => b.value - a.value);
  return {
    good: sorted.slice(0, 2).filter((x) => x.value > 54).map((x) => x.label),
    bad: sorted.slice(-2).reverse().filter((x) => x.value < 46).map((x) => x.label),
  };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};

/**
 * Start screen, F1-game style: pick a team (car render, strengths and weaknesses), a
 * circuit (map, flag, length, corners) and the race; a bar at the bottom sums it up and
 * starts. The click on "Start" is also the user gesture browsers require before audio.
 */
export function showMenu(cars: CarDefinition[], tracks: TrackEntry[], initial: MenuSelection): Promise<MenuSelection> {
  return new Promise((resolve) => {
    let carId = initial.carId;
    /** Car list tab: the F1 teams or the practice car. */
    const isF1 = (c: CarDefinition) => c.cls === 'formula';
    let showF1 = !cars.some((c) => c.id === carId && !isF1(c));
    let trackId = initial.trackId;
    let ai = initial.ai;
    let laps = initial.laps;
    let quali = initial.quali;
    const saved = loadSeason();
    const savedLive = saved && saved.round < CALENDAR.length ? saved : null;
    let season: 'continue' | 'new' | null = null;
    let difficulty = readDifficulty();
    let driver = readDriverIndex();
    // Webcam hands are a desktop option (touch screens drive with on-screen buttons / tilt).
    const desktop = !isTouchDevice();
    let control = readControlMode();
    const base = import.meta.env.BASE_URL;

    const root = el('div', 'menu');
    root.innerHTML = `
      <div class="menu-panel">
        <header class="menu-head">
          <h1>web-sim-lab <span>Racing</span></h1>
          <p>F1 2026 · ${cars.filter((c) => c.cls === 'formula').length}개 팀 · 연습용 차량 · ${tracks.length}개 서킷</p>
        </header>
        <section class="menu-step">
          <h2><b>1</b>차량 선택</h2>
          <div class="chip-row car-category" data-group="category"></div>
          <div class="team-grid" data-group="car"></div>
          <div class="team-detail" data-group="spec"></div>
        </section>
        <section class="menu-step">
          <h2><b>2</b>서킷</h2>
          <div class="circuit-grid" data-group="track"></div>
        </section>
        <section class="menu-step menu-race">
          <h2><b>3</b>레이스</h2>
          <div data-group="control-wrap"><h3>조작</h3><div class="chip-row" data-group="control"></div></div>
          <h3>난이도</h3>
          <div class="chip-row" data-group="difficulty"></div>
          <h3>AI 실력</h3>
          <div class="chip-row" data-group="ailevel"></div>
          <h3>모드</h3>
          <div class="chip-row" data-group="mode"></div>
          <div data-group="ai-wrap"><h3>방식</h3>
          <div class="chip-row" data-group="ai"></div></div>
          <div data-group="laps-wrap"><h3>랩 수</h3><div class="chip-row" data-group="laps"></div>
            <h3>예선</h3><div class="chip-row" data-group="quali"></div></div>
          <h3>보이스 팩</h3><div class="chip-row" data-group="voicepack"></div>
          <h3>그래픽 <small>느리면 낮춰 보세요</small></h3><div class="chip-row" data-group="quality"></div>
          <div class="menu-pickers" data-group="weather"></div>
          <div class="menu-pickers" data-group="tyre"></div>
        </section>
        <p class="menu-note">실제 서킷 레이아웃: TUMFTM racetrack-database (LGPL-3.0) · © OpenStreetMap contributors · 높낮이 Copernicus DEM.</p>
      </div>
      <div class="menu-dock">
        <div class="menu-summary" data-group="summary"></div>
        <button class="menu-start" type="button">출발 ▶ <small>Enter</small></button>
        <button class="menu-mp" type="button">👥 친구와 레이스</button>
        <button class="menu-podium" type="button" title="레이스 없이 포디움 세리머니만 봅니다">🏆 포디움 보기</button>
        <button class="menu-b206" type="button" title="B206 보이스 팩: 우리가 녹음한 팀 라디오와 엔진 소리로 달립니다">B206</button>
      </div>`;
    const q = <T extends HTMLElement>(g: string) => root.querySelector<T>(`[data-group="${g}"]`)!;
    const teamGrid = q<HTMLDivElement>('car');
    const categoryRow = q<HTMLDivElement>('category');
    const detail = q<HTMLDivElement>('spec');
    const trackGrid = q<HTMLDivElement>('track');
    const aiRow = q<HTMLDivElement>('ai');
    const lapWrap = q<HTMLDivElement>('laps-wrap');
    const lapRow = q<HTMLDivElement>('laps');
    const diffRow = q<HTMLDivElement>('difficulty');
    const aiLevelRow = q<HTMLDivElement>('ailevel');
    const qualiRow = q<HTMLDivElement>('quali');
    const modeRow = q<HTMLDivElement>('mode');
    const voicePackRow = q<HTMLDivElement>('voicepack');
    const qualityRow = q<HTMLDivElement>('quality');
    const aiWrap = q<HTMLDivElement>('ai-wrap');
    const controlRow = q<HTMLDivElement>('control');
    q<HTMLDivElement>('control-wrap').style.display = desktop ? '' : 'none';
    const summary = q<HTMLDivElement>('summary');

    const chip = (title: string, sub: string, selected: boolean, onPick: () => void) => {
      const b = el('button', 'chip' + (selected ? ' selected' : ''));
      b.type = 'button';
      b.append(el('strong', '', title));
      if (sub) b.append(el('span', '', sub));
      b.addEventListener('click', onPick);
      return b;
    };

    const teamCard = (c: CarDefinition) => {
      const b = el('button', 'team-card' + (c.id === carId ? ' selected' : ''));
      b.type = 'button';
      b.style.setProperty('--team', hex(c.spec.color));
      b.style.setProperty('--accent', hex(c.spec.accent ?? c.spec.color));
      const img = el('img');
      img.src = `${base}menu/cars/${c.id}.webp`;
      img.alt = c.spec.brand;
      img.loading = 'lazy';
      img.onerror = () => img.remove();
      const tags = el('div', 'tags');
      if (c.cls !== 'formula') tags.append(el('span', 'even', `◆ 연습용 · 최고 ${c.spec.top} km/h`));
      else {
        const { good, bad } = strengthsOf(c);
        for (const g of good) tags.append(el('span', 'good', `▲ ${g}`));
        for (const w of bad) tags.append(el('span', 'bad', `▼ ${w}`));
        if (!good.length && !bad.length) tags.append(el('span', 'even', '◆ 균형형'));
      }
      b.append(img, el('strong', '', c.spec.brand), tags);
      b.addEventListener('click', () => {
        carId = c.id;
        render();
      });
      b.addEventListener('dblclick', start);
      return b;
    };

    const renderDetail = () => {
      const c = cars.find((x) => x.id === carId)!;
      detail.style.setProperty('--team', hex(c.spec.color));
      const img = el('img');
      img.src = `${base}menu/cars/${c.id}.webp`;
      img.alt = c.name;
      img.onerror = () => img.remove();
      const info = el('div', 'td-info');
      const head = el('div', 'td-head');
      head.append(el('strong', '', c.name), el('span', '', `${Math.round(c.spec.kw * 1.341)} hp · ${c.spec.top} km/h · ${c.spec.kg} kg`));
      const sw = el('div', 'td-sw');
      if (c.cls !== 'formula') sw.append(el('p', '', `연습용 차량 · ${c.spec.top} km/h 제한 · 상대 AI도 같은 차`));
      else {
        const { good, bad } = strengthsOf(c);
        if (good.length) sw.append(el('p', 'good', `강점 · ${good.join(', ')}`));
        if (bad.length) sw.append(el('p', 'bad', `약점 · ${bad.join(', ')}`));
      }
      const bars = el('div', 'td-bars');
      for (const s of teamStats(c)) {
        const row = el('div', 'menu-bar');
        const track = el('div');
        const fill = el('i');
        fill.style.width = `${Math.max(s.value, 3)}%`;
        track.append(fill);
        row.append(el('span', '', s.label), track, el('b', '', s.raw));
        bars.append(row);
      }
      // Driver: one of the team's two (the other one drives the team-mate's car).
      const pair = DRIVERS[c.id];
      if (pair) {
        const row = el('div', 'chip-row td-drivers');
        pair.forEach((p, i) =>
          row.append(
            chip(`#${p.number} ${p.ko}`, i === driver ? '내가 운전' : '팀메이트 (AI)', i === driver, () => {
              driver = i;
              saveDriverIndex(i);
              render();
            }),
          ),
        );
        info.append(head, row, sw, bars);
      } else info.append(head, sw, bars);
      detail.replaceChildren(img, info);
    };

    const circuitCard = (t: TrackEntry) => {
      const b = el('button', 'circuit-card' + (t.id === trackId ? ' selected' : ''));
      b.type = 'button';
      const map = MAPS[t.id];
      if (map) {
        const [sx, sy] = map.start;
        const [dx, dy] = map.dir;
        // Start line: a short bar across the direction of travel.
        const lx = -dy * 3.5;
        const ly = dx * 3.5;
        b.insertAdjacentHTML(
          'beforeend',
          `<svg viewBox="0 0 100 100" aria-hidden="true"><path class="trk-base" d="${map.d}"/><path class="trk" d="${map.d}"/>` +
            `<line class="trk-start" x1="${sx - lx}" y1="${sy - ly}" x2="${sx + lx}" y2="${sy + ly}"/></svg>`,
        );
      }
      const info = CIRCUIT_INFO[t.id];
      const name = el('strong');
      if (info) name.append(el('i', 'cc', info.code));
      name.append(t.name);
      b.append(name, el('span', '', `${t.location}`), el('em', '', `${t.lengthKm} km${info ? ` · 코너 ${info.corners}` : ''}`));
      b.addEventListener('click', () => {
        trackId = t.id;
        render();
      });
      b.addEventListener('dblclick', start);
      return b;
    };

    const renderSummary = () => {
      const c = cars.find((x) => x.id === carId)!;
      const t = tracks.find((x) => x.id === trackId);
      const w = readWeather();
      const seasonText = season === 'continue' && savedLive ? `시즌 R${savedLive.round + 1} ${tracks.find((x) => x.id === CALENDAR[savedLive.round])?.name ?? ''}` : season === 'new' ? `새 시즌 R1 ${tracks.find((x) => x.id === CALENDAR[0])?.name ?? ''}` : '';
      const parts = [seasonText, DRIVERS[c.id] ? `${c.spec.brand} · ${DRIVERS[c.id][driver].ko}` : c.spec.brand, t?.name ?? '', `${DIFFICULTY[difficulty].name} · AI ${AI_LEVEL[readAiLevel(difficulty)].name}`, ai === 0 ? '자유 주행' : `${ai + 1}대 · ${quali ? '예선 + ' : ''}${laps}랩`, `${WEATHER_NAMES[w.weather] ?? w.weather} ${TIME_NAMES[w.time] ?? ''}`, COMPOUND_NAMES[readStartTyre()], desktop ? CONTROL_MODE_LABEL[control] : ''];
      summary.replaceChildren(...parts.filter(Boolean).map((p, i) => el(i === 0 ? 'strong' : 'span', '', p)));
      summary.style.setProperty('--team', hex(c.spec.color));
    };

    const render = () => {
      const practice = cars.find((c) => !isF1(c));
      const tabs: [f1: boolean, title: string, sub: string][] = [[true, 'F1 2026', `${cars.filter(isF1).length}개 팀`]];
      if (practice) tabs.unshift([false, '연습용', `${practice.spec.top} km/h 제한`]);
      categoryRow.replaceChildren(
        ...tabs.map(([f1, title, sub]) =>
          chip(title, sub, f1 === showF1, () => {
            showF1 = f1;
            // Keep the detail panel on a car of the shown list.
            if (isF1(cars.find((c) => c.id === carId)!) !== f1) carId = cars.find((c) => isF1(c) === f1)!.id;
            render();
          }),
        ),
      );
      teamGrid.replaceChildren(...cars.filter((c) => isF1(c) === showF1).map(teamCard));
      renderDetail();
      trackGrid.replaceChildren(...tracks.map(circuitCard));
      controlRow.replaceChildren(
        ...CONTROL_MODES.map((m) =>
          chip(CONTROL_MODE_LABEL[m], CONTROL_HINTS[m], m === control, () => {
            control = m;
            saveControlMode(m);
            render();
          }),
        ),
      );
      diffRow.replaceChildren(
        ...DIFFICULTIES.map((d) =>
          chip(DIFFICULTY[d].name, DIFFICULTY[d].hint, d === difficulty, () => {
            difficulty = d;
            saveDifficulty(d);
            render();
          }),
        ),
      );
      // AI skill on its own (follows the difficulty until picked).
      const level = readAiLevel(difficulty);
      aiLevelRow.replaceChildren(
        ...AI_LEVELS.map((l) =>
          chip(AI_LEVEL[l].name, `레이싱 속도 ${Math.round(AI_LEVEL[l].pace * 100)}%`, l === level, () => {
            saveAiLevel(l);
            render();
          }),
        ),
      );
      aiRow.replaceChildren(
        ...AI_OPTIONS.map(([n, title, sub]) =>
          chip(title, sub, n === ai, () => {
            ai = n;
            render();
          }),
        ),
      );
      const roundName = (s: { round: number }) => tracks.find((t) => t.id === CALENDAR[s.round])?.name ?? '';
      const myPoints = (s: NonNullable<typeof saved>) => Object.entries(s.drivers).find(([n]) => s.info[n]?.player)?.[1] ?? 0;
      modeRow.replaceChildren(
        chip('단일 레이스', '서킷·대수 직접 선택', season === null, () => {
          season = null;
          render();
        }),
        ...(savedLive
          ? [
              chip(`시즌 이어하기`, `R${savedLive.round + 1}/${CALENDAR.length} ${roundName(savedLive)} · ${myPoints(savedLive)}점`, season === 'continue', () => {
                season = 'continue';
                render();
              }),
            ]
          : []),
        chip('새 시즌', `2026 캘린더 ${CALENDAR.length}라운드 · 포인트·순위`, season === 'new', () => {
          season = 'new';
          render();
        }),
      );
      // A season races the full grid on the calendar's circuit.
      aiWrap.style.display = season ? 'none' : '';
      if (season) ai = 19;
      lapWrap.style.display = ai > 0 ? '' : 'none';
      // A number field for any race length next to the usual distances.
      const custom = el('label', 'chip chip-input' + (LAP_OPTIONS.includes(laps) ? '' : ' selected'));
      const input = el('input');
      input.type = 'number';
      input.min = '1';
      input.max = String(MAX_LAPS);
      input.value = String(laps);
      input.setAttribute('aria-label', '랩 수 직접 입력');
      input.addEventListener('change', () => {
        laps = Math.min(MAX_LAPS, Math.max(1, Math.round(Number(input.value) || 1)));
        render();
      });
      // Typing in the field must not start the race.
      input.addEventListener('keydown', (e) => e.stopPropagation());
      custom.append(el('strong', '', '직접'), input, el('span', '', `최대 ${MAX_LAPS}`));
      lapRow.replaceChildren(
        ...LAP_OPTIONS.map((n) =>
          chip(`${n}랩`, n === 1 ? '스프린트' : n === 3 ? '기본' : n === 5 ? '중거리' : '내구', n === laps, () => {
            laps = n;
            render();
          }),
        ),
        custom,
      );
      qualiRow.replaceChildren(
        chip('바로 결승', '중간 그리드에서 출발', !quali, () => {
          quali = false;
          render();
        }),
        chip('예선 후 결승', '측정 랩 3번으로 출발 순서 결정', quali, () => {
          quali = true;
          render();
        }),
      );
      const packOn = voicePackOn();
      voicePackRow.replaceChildren(
        chip('기본', '엔지니어 무전 · 녹음 엔진음', !packOn, () => {
          setVoicePack(false);
          render();
        }),
        chip('B206', '우리가 녹음한 외침 + 목소리 엔진음', packOn, () => {
          setVoicePack(true);
          render();
        }),
      );
      root.querySelector('.menu-b206')!.classList.toggle('on', packOn);
      const tier = readTier();
      qualityRow.replaceChildren(
        ...QUALITY_OPTIONS.map(([t, title, sub]) =>
          chip(title, sub, t === tier, () => {
            saveTier(t);
            render();
          }),
        ),
      );
      renderSummary();
    };

    function start(): void {
      window.removeEventListener('keydown', onKey);
      root.remove();
      resolve({ carId, trackId, ai, laps, quali, season });
    }
    function onKey(e: KeyboardEvent): void {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') start();
    }

    root.querySelector('.menu-start')!.addEventListener('click', start);
    root.querySelector('.menu-podium')!.addEventListener('click', () => {
      window.removeEventListener('keydown', onKey);
      root.remove();
      resolve({ carId, trackId, ai, laps, quali: false, podium: true });
    });
    root.querySelector('.menu-mp')!.addEventListener('click', () => {
      window.removeEventListener('keydown', onKey);
      root.remove();
      resolve({ carId, trackId, ai, laps, quali, multiplayer: true });
    });
    root.querySelector('.menu-b206')!.addEventListener('click', () => {
      setVoicePack(!voicePackOn());
      render();
    });
    window.addEventListener('keydown', onKey);
    mountWeatherPicker(q('weather'));
    mountTyrePicker(q('tyre'));
    // The pickers keep their own state (URL / storage): refresh the summary after a pick.
    for (const g of ['weather', 'tyre']) q(g).addEventListener('click', () => setTimeout(renderSummary));
    render();
    document.body.append(root);
  });
}
