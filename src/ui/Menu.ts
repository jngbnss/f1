import type { CarInfo as CarDefinition } from '../vehicle/catalog';
import { COMPOUND_NAMES } from '../vehicle/Tyres';
import type { TrackEntry } from '../world/tracks';
import { mountWeatherPicker, readWeather } from '../world/Weather';
import { CIRCUIT_INFO, CIRCUIT_KIND_OF, CIRCUIT_KINDS, DIFFICULTY_LEVELS, difficultyLevel, difficultyText, type CircuitKind, type DifficultyLevel } from './circuitInfo';
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
/** Below this width the car detail opens under the picked card instead of beside the list. */
const NARROW = window.matchMedia('(max-width: 900px)');
const PHONE = window.matchMedia('(max-width: 600px)');
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

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
/** The four stats the detail panel shows (the rest still feed the circuit fit). */
const CORE_STATS = ['파워', '고속 코너', '트랙션', '타이어'];

/** Two best and two worst stats: the team's character at a glance. */
function strengthsOf(car: CarDefinition): { good: string[]; bad: string[] } {
  const stats = teamStats(car);
  const sorted = [...stats].sort((a, b) => b.value - a.value);
  return {
    good: sorted.slice(0, 2).filter((x) => x.value > 54).map((x) => x.label),
    bad: sorted.slice(-2).reverse().filter((x) => x.value < 46).map((x) => x.label),
  };
}

/** What a circuit asks of the car, read from its tags (in the order they are listed). */
const DEMAND_OF_TAG: Record<string, string> = {
  고속: '고속 코너', 초고속: '고속 코너', 중고속: '고속 코너', '고속 코너': '고속 코너', '연속 코너': '고속 코너', 'S 코너': '고속 코너', 다운포스: '고속 코너',
  '긴 직선': '파워', '최장 직선': '파워', 최고속도: '최고속도', '최장 거리': '파워',
  '강한 제동': '제동', 시케인: '제동',
  트랙션: '트랙션', 헤어핀: '트랙션', 저속: '저속 코너', '저속 구간': '저속 코너', 시가지: '저속 코너',
  '타이어 관리': '타이어',
};

/**
 * Why this car suits (or not) the picked circuit, as a sentence with its reasons —
 * never a made-up "fit score".
 */
function circuitFit(car: CarDefinition, track: TrackEntry | undefined): { tone: 'good' | 'bad' | 'even'; text: string } {
  if (car.cls !== 'formula') return { tone: 'even', text: `연습용 차량 · ${car.spec.top} km/h 제한 · 상대 AI도 같은 차로 달립니다` };
  const info = track && CIRCUIT_INFO[track.id];
  if (!track || !info) return { tone: 'even', text: '서킷을 고르면 이 차와 맞는 이유를 보여드립니다' };
  const demands = [...new Set(info.tags.map((t) => DEMAND_OF_TAG[t]).filter(Boolean))].slice(0, 3);
  if (!demands.length) return { tone: 'even', text: `${track.name}: 특정 성능보다 균형이 중요한 서킷입니다` };
  const stats = new Map(teamStats(car).map((s) => [s.label, s.value]));
  const good = demands.filter((d) => (stats.get(d) ?? 50) >= 55);
  const weak = demands.filter((d) => (stats.get(d) ?? 50) <= 45);
  if (good.length) return { tone: 'good', text: `추천 이유: ${good.join(' · ')} 강점이 ${track.name}에서 살아납니다` };
  if (weak.length) return { tone: 'bad', text: `주의: ${track.name}에서 중요한 ${weak.join(' · ')} 쪽이 이 차의 약점입니다` };
  return { tone: 'even', text: `${track.name}: ${demands.join(' · ')} 위주 서킷 · 이 차는 평균 수준입니다` };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};

/** Track outline (start line in red) as inline SVG. */
function trackSvg(id: string): string {
  const map = MAPS[id];
  if (!map) return '';
  const [sx, sy] = map.start;
  const [dx, dy] = map.dir;
  // Start line: a short bar across the direction of travel.
  const lx = -dy * 3.5;
  const ly = dx * 3.5;
  return (
    `<svg viewBox="0 0 100 100" aria-hidden="true"><path class="trk-base" d="${map.d}"/><path class="trk" d="${map.d}"/>` +
    `<line class="trk-start" x1="${sx - lx}" y1="${sy - ly}" x2="${sx + lx}" y2="${sy + ly}"/></svg>`
  );
}

type CircuitSort = 'calendar' | 'difficulty' | 'short' | 'long' | 'corners';
const SORT_OPTIONS: [CircuitSort, string][] = [
  ['calendar', '캘린더순'],
  ['difficulty', '난이도 낮은순'],
  ['short', '거리 짧은순'],
  ['long', '거리 긴순'],
  ['corners', '코너 많은순'],
];

/**
 * Start screen, F1-game style, in three steps — car, circuit, race — each a list to compare
 * next to the picked item's detail (why it fits); a bar at the bottom sums it up and starts.
 * The click on "Start" is also the user gesture browsers require before audio.
 */
export function showMenu(cars: CarDefinition[], tracks: TrackEntry[], initial: MenuSelection): Promise<MenuSelection> {
  return new Promise((resolve) => {
    let carId = initial.carId;
    /** Car list tab: the F1 teams or the practice car. */
    const isF1 = (c: CarDefinition) => c.cls === 'formula';
    let showF1 = !cars.some((c) => c.id === carId && !isF1(c));
    let trackId = initial.trackId;
    let circuitSort: CircuitSort = 'calendar';
    let levelFilter: DifficultyLevel | null = null;
    const kindFilter = new Set<CircuitKind>();
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

    const stepHead = (n: number, title: string, key: string) =>
      `<div class="step-head"><h2><b>${n}</b>${title}</h2><span class="step-pick" data-group="pick-${key}"></span>` +
      `<button class="step-fold" type="button" aria-expanded="true" aria-controls="step-${key}">접기</button></div>`;

    const root = el('div', 'menu');
    root.innerHTML = `
      <div class="menu-panel">
        <header class="menu-head">
          <h1>web-sim-lab <span>Racing</span></h1>
          <p>F1 2026 · ${cars.filter((c) => c.cls === 'formula').length}개 팀 · 연습용 차량 · ${tracks.length}개 서킷</p>
          <nav class="menu-steps" aria-label="단계" data-group="steps"></nav>
        </header>
        <section class="menu-step" data-step="car">
          ${stepHead(1, '차량 선택', 'car')}
          <div class="step-body" id="step-car">
            <div class="chip-row car-category" data-group="category"></div>
            <div class="car-layout">
              <div class="team-grid" data-group="car"></div>
              <aside class="car-side" data-group="car-side"></aside>
            </div>
          </div>
        </section>
        <section class="menu-step" data-step="track">
          ${stepHead(2, '서킷 선택', 'track')}
          <div class="step-body" id="step-track">
            <div class="circuit-detail" data-group="track-detail" aria-live="polite"></div>
            <div class="circuit-tools">
              <div class="circuit-filters">
                <div class="chip-row" data-group="track-level" role="group" aria-label="난이도 필터"></div>
                <div class="chip-row" data-group="track-kind" role="group" aria-label="성격 필터 (복수 선택)"></div>
              </div>
              <label class="circuit-sort"><span>정렬</span><select data-group="track-sort"></select></label>
            </div>
            <p class="circuit-note" data-group="track-note" aria-live="polite"></p>
            <div class="circuit-grid" data-group="track"></div>
          </div>
        </section>
        <section class="menu-step menu-race" data-step="race">
          ${stepHead(3, '레이스 설정', 'race')}
          <div class="step-body" id="step-race">
            <div class="race-main">
              <div class="race-group"><h3>모드</h3><div class="chip-row" data-group="mode"></div></div>
              <div class="race-group" data-group="ai-wrap"><h3>참가 대수</h3><div class="chip-row" data-group="ai"></div></div>
              <div class="race-group"><h3>난이도</h3><div class="chip-row" data-group="difficulty"></div></div>
              <div class="race-group"><h3>AI 실력</h3><div class="chip-row" data-group="ailevel"></div></div>
              <div class="race-group" data-group="laps-wrap"><h3>랩 수</h3><div class="chip-row" data-group="laps"></div>
                <h3>예선</h3><div class="chip-row" data-group="quali"></div></div>
              <div class="race-group menu-pickers" data-group="weather"></div>
              <div class="race-group menu-pickers" data-group="tyre"></div>
            </div>
            <details class="menu-advanced">
              <summary>고급 설정 <small>조작 · 보이스 팩 · 그래픽</small></summary>
              <div data-group="control-wrap"><h3>조작</h3><div class="chip-row" data-group="control"></div></div>
              <h3>보이스 팩</h3><div class="chip-row" data-group="voicepack"></div>
              <h3>그래픽 <small>느리면 낮춰 보세요</small></h3><div class="chip-row" data-group="quality"></div>
            </details>
          </div>
        </section>
        <p class="menu-note">실제 서킷 레이아웃: TUMFTM racetrack-database (LGPL-3.0) · © OpenStreetMap contributors · 높낮이 Copernicus DEM.</p>
      </div>
      <div class="menu-dock">
        <div class="menu-summary" data-group="summary"></div>
        <button class="menu-missing" type="button" data-group="missing" hidden></button>
        <div class="menu-extra">
          <button class="menu-mp" type="button" aria-label="친구와 레이스"><span aria-hidden="true">👥</span><em>친구와 레이스</em></button>
          <button class="menu-podium" type="button" aria-label="포디움 보기" title="레이스 없이 포디움 세리머니만 봅니다"><span aria-hidden="true">🏆</span><em>포디움</em></button>
          <button class="menu-b206" type="button" title="B206 보이스 팩: 우리가 녹음한 팀 라디오와 엔진 소리로 달립니다">B206</button>
        </div>
        <button class="menu-start" type="button">출발 ▶ <small>Enter</small></button>
      </div>`;
    const q = <T extends HTMLElement>(g: string) => root.querySelector<T>(`[data-group="${g}"]`)!;
    const teamGrid = q<HTMLDivElement>('car');
    const carSide = q<HTMLElement>('car-side');
    const categoryRow = q<HTMLDivElement>('category');
    const detail = el('div', 'team-detail');
    const trackGrid = q<HTMLDivElement>('track');
    const trackSort = q<HTMLSelectElement>('track-sort');
    const trackLevel = q<HTMLDivElement>('track-level');
    const trackKind = q<HTMLDivElement>('track-kind');
    const trackNote = q<HTMLParagraphElement>('track-note');
    const trackDetail = q<HTMLDivElement>('track-detail');
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
    const stepsNav = q<HTMLElement>('steps');
    const missingBtn = q<HTMLButtonElement>('missing');
    const startBtn = root.querySelector<HTMLButtonElement>('.menu-start')!;
    const sections = [...root.querySelectorAll<HTMLElement>('.menu-step')];
    const sectionOf = (step: string) => sections.find((s) => s.dataset.step === step)!;

    const chip = (title: string, sub: string, selected: boolean, onPick: () => void) => {
      const b = el('button', 'chip' + (selected ? ' selected' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(selected));
      b.append(el('strong', '', title));
      if (sub) b.append(el('span', '', sub));
      b.addEventListener('click', onPick);
      return b;
    };

    const teamCard = (c: CarDefinition) => {
      const selected = c.id === carId;
      const b = el('button', 'team-card' + (selected ? ' selected' : ''));
      b.type = 'button';
      b.dataset.key = `car:${c.id}`;
      b.setAttribute('aria-pressed', String(selected));
      b.style.setProperty('--team', hex(c.spec.color));
      b.style.setProperty('--accent', hex(c.spec.accent ?? c.spec.color));
      const img = el('img');
      img.src = `${base}menu/cars/${c.id}.webp`;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => img.remove();
      // The card keeps to the name and two strengths; the figures live in the detail panel.
      const tags = el('div', 'tags');
      if (c.cls !== 'formula') tags.append(el('span', 'even', '연습용'));
      else {
        const { good } = strengthsOf(c);
        for (const g of good) tags.append(el('span', 'good', `▲ ${g}`));
        if (!good.length) tags.append(el('span', 'even', '◆ 균형형'));
      }
      const name = el('strong', '', c.spec.brand);
      name.title = c.name;
      b.append(img, name, tags);
      b.addEventListener('click', () => {
        carId = c.id;
        render();
      });
      b.addEventListener('dblclick', start);
      return b;
    };

    const renderDetail = () => {
      const c = cars.find((x) => x.id === carId)!;
      const t = tracks.find((x) => x.id === trackId);
      detail.style.setProperty('--team', hex(c.spec.color));
      const img = el('img');
      img.src = `${base}menu/cars/${c.id}.webp`;
      img.alt = c.name;
      img.onerror = () => img.remove();
      const head = el('div', 'td-head');
      const name = el('strong', '', c.name);
      name.title = c.name;
      head.append(name, el('span', '', `${Math.round(c.spec.kw * 1.341)} hp · 최고 ${c.spec.top} km/h · ${c.spec.kg} kg`));
      const parts: HTMLElement[] = [img, head];
      // Driver: one of the team's two (the other one drives the team-mate's car).
      const pair = DRIVERS[c.id];
      if (pair) {
        const row = el('div', 'chip-row td-drivers');
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', '드라이버');
        pair.forEach((p, i) =>
          row.append(
            chip(`#${p.number} ${p.ko}`, i === driver ? '내가 운전' : '팀메이트 (AI)', i === driver, () => {
              driver = i;
              saveDriverIndex(i);
              render();
            }),
          ),
        );
        parts.push(row);
      }
      const all = teamStats(c);
      const shown = c.spec.traits ? all.filter((s) => CORE_STATS.includes(s.label)) : all;
      const bars = el('div', 'td-bars');
      for (const s of shown) {
        const row = el('div', 'menu-bar');
        const bar = el('div');
        bar.setAttribute('role', 'meter');
        bar.setAttribute('aria-label', s.label);
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(s.value));
        const fill = el('i');
        fill.style.width = `${Math.max(s.value, 3)}%`;
        bar.append(fill);
        row.append(el('span', '', s.label), bar, el('b', '', s.raw));
        bars.append(row);
      }
      const fit = circuitFit(c, t);
      const why = el('p', `td-fit ${fit.tone}`, fit.text);
      parts.push(bars, why);
      detail.replaceChildren(...parts);
      // Wide screens: beside the list. Narrow: right under the picked card, so the
      // detail never pushes the list down before anything is picked.
      detail.classList.toggle('inline', NARROW.matches);
      if (NARROW.matches) {
        // After the last card of the picked card's row (columns as in the CSS breakpoints).
        const cards = [...teamGrid.querySelectorAll<HTMLElement>('.team-card')];
        const i = cards.findIndex((b) => b.dataset.key === `car:${c.id}`);
        const cols = PHONE.matches ? 2 : 3;
        const rowEnd = cards[Math.min(cards.length - 1, Math.floor(Math.max(i, 0) / cols) * cols + cols - 1)];
        if (rowEnd) rowEnd.after(detail);
        else teamGrid.prepend(detail);
      } else carSide.replaceChildren(detail);
    };

    const circuitCard = (t: TrackEntry) => {
      const selected = t.id === trackId;
      const b = el('button', 'circuit-card' + (selected ? ' selected' : ''));
      b.type = 'button';
      b.dataset.key = `track:${t.id}`;
      b.setAttribute('aria-pressed', String(selected));
      b.insertAdjacentHTML('beforeend', trackSvg(t.id));
      const info = CIRCUIT_INFO[t.id];
      const name = el('strong');
      name.title = `${t.name} · ${t.location}`;
      if (info) name.append(el('i', 'cc', info.code));
      name.append(t.name);
      b.append(name, el('span', '', t.location), el('em', '', `${t.lengthKm.toFixed(1)} km${info ? ` · 코너 ${info.corners}` : ''}`));
      if (info) b.append(el('small', `cc-level lv-${difficultyLevel(info.difficulty)}`, difficultyText(info.difficulty)));
      b.addEventListener('click', () => {
        trackId = t.id;
        render();
      });
      b.addEventListener('dblclick', start);
      return b;
    };

    const renderCircuitDetail = () => {
      const t = tracks.find((x) => x.id === trackId);
      if (!t) {
        trackDetail.replaceChildren(el('p', 'cd-empty', '아래 목록에서 서킷을 골라 주세요.'));
        return;
      }
      const info = CIRCUIT_INFO[t.id];
      const visual = el('div', 'cd-map');
      visual.innerHTML = trackSvg(t.id);
      const body = el('div', 'cd-body');
      const title = el('div', 'cd-title');
      const name = el('strong', '', t.name);
      if (info) title.append(el('i', 'cc', info.code));
      title.append(name, el('span', '', info?.character ?? t.location));
      const stats = el('div', 'cd-stats');
      const stat = (label: string, value: string) => {
        const item = el('div');
        item.append(el('span', '', label), el('b', '', value));
        return item;
      };
      stats.append(stat('길이', `${t.lengthKm.toFixed(1)} km`), stat('코너', String(info?.corners ?? '—')), stat('난이도', info ? difficultyText(info.difficulty) : '—'));
      const tags = el('div', 'cd-tags');
      for (const tag of (info?.tags ?? []).slice(0, 3)) tags.append(el('span', '', tag));
      body.append(title, el('p', '', info?.description ?? `${t.location}에 위치한 서킷입니다.`), stats, tags);
      trackDetail.replaceChildren(visual, body);
    };

    const shownTracks = () => {
      const list = tracks.filter((t) => {
        const info = CIRCUIT_INFO[t.id];
        if (levelFilter && (!info || difficultyLevel(info.difficulty) !== levelFilter)) return false;
        if (kindFilter.size && !(CIRCUIT_KIND_OF[t.id] ?? []).some((k) => kindFilter.has(k))) return false;
        return true;
      });
      const diff = (t: TrackEntry) => CIRCUIT_INFO[t.id]?.difficulty ?? 0;
      const corners = (t: TrackEntry) => CIRCUIT_INFO[t.id]?.corners ?? 0;
      if (circuitSort === 'difficulty') list.sort((a, b) => diff(a) - diff(b) || a.lengthKm - b.lengthKm);
      if (circuitSort === 'short') list.sort((a, b) => a.lengthKm - b.lengthKm);
      if (circuitSort === 'long') list.sort((a, b) => b.lengthKm - a.lengthKm);
      if (circuitSort === 'corners') list.sort((a, b) => corners(b) - corners(a));
      return list;
    };

    const renderCircuits = () => {
      trackLevel.replaceChildren(
        el('span', 'filter-label', '난이도'),
        chip('전체', '', levelFilter === null, () => {
          levelFilter = null;
          render();
        }),
        ...DIFFICULTY_LEVELS.map((l) =>
          chip(l, '', levelFilter === l, () => {
            levelFilter = levelFilter === l ? null : l;
            render();
          }),
        ),
      );
      trackKind.replaceChildren(
        el('span', 'filter-label', '성격'),
        ...CIRCUIT_KINDS.map((k) =>
          chip(k, '', kindFilter.has(k), () => {
            if (kindFilter.has(k)) kindFilter.delete(k);
            else kindFilter.add(k);
            render();
          }),
        ),
      );
      if (!trackSort.options.length) {
        for (const [value, label] of SORT_OPTIONS) trackSort.append(new Option(label, value));
      }
      trackSort.value = circuitSort;
      const list = shownTracks();
      trackGrid.replaceChildren(...list.map(circuitCard));
      // The pick survives filters; say so when it is filtered out of view.
      const picked = tracks.find((t) => t.id === trackId);
      const filtered = levelFilter !== null || kindFilter.size > 0;
      trackNote.replaceChildren();
      if (filtered) {
        const text = !list.length
          ? '조건에 맞는 서킷이 없습니다.'
          : picked && !list.includes(picked)
            ? `선택한 서킷(${picked.name})은 현재 필터에 보이지 않지만 선택은 유지됩니다.`
            : `${list.length}개 서킷`;
        const clear = el('button', 'link-btn', '필터 해제');
        clear.type = 'button';
        clear.addEventListener('click', () => {
          levelFilter = null;
          kindFilter.clear();
          render();
        });
        trackNote.append(el('span', '', text), clear);
      }
      trackNote.classList.toggle('warn', filtered && (!list.length || (!!picked && !list.includes(picked))));
      renderCircuitDetail();
    };

    /** The first step still missing a pick (start stays off until it is done). */
    const missingStep = (): { step: string; label: string } | null => {
      if (!cars.some((c) => c.id === carId)) return { step: 'car', label: '차량을 선택하세요' };
      if (!tracks.some((t) => t.id === trackId)) return { step: 'track', label: '서킷을 선택하세요' };
      return null;
    };

    const goTo = (step: string) => {
      const s = sectionOf(step);
      setFolded(s, false);
      s.scrollIntoView({ behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth', block: 'start' });
      s.querySelector<HTMLElement>('.step-fold')?.focus({ preventScroll: true });
    };

    const setFolded = (s: HTMLElement, folded: boolean) => {
      s.classList.toggle('folded', folded);
      const b = s.querySelector<HTMLButtonElement>('.step-fold')!;
      b.setAttribute('aria-expanded', String(!folded));
      b.textContent = folded ? '펼치기' : '접기';
    };

    const renderSummary = () => {
      const c = cars.find((x) => x.id === carId);
      const t = tracks.find((x) => x.id === trackId);
      const w = readWeather();
      const seasonText = season === 'continue' && savedLive ? `시즌 R${savedLive.round + 1} ${tracks.find((x) => x.id === CALENDAR[savedLive.round])?.name ?? ''}` : season === 'new' ? `새 시즌 R1 ${tracks.find((x) => x.id === CALENDAR[0])?.name ?? ''}` : '';
      const carText = c ? (DRIVERS[c.id] ? `${c.spec.brand} · ${DRIVERS[c.id][driver].ko}` : c.spec.brand) : '차량 미선택';
      const raceText = ai === 0 ? '자유 주행' : `${ai + 1}대 · ${quali ? '예선 + ' : ''}${laps}랩`;
      const parts = [carText, seasonText || t?.name || '서킷 미선택', `AI ${AI_LEVEL[readAiLevel(difficulty)].name}`, raceText, `${WEATHER_NAMES[w.weather] ?? w.weather} ${TIME_NAMES[w.time] ?? ''}`, COMPOUND_NAMES[readStartTyre()]];
      summary.replaceChildren(...parts.filter(Boolean).map((p, i) => el(i === 0 ? 'strong' : 'span', '', p)));
      summary.title = parts.filter(Boolean).join(' · ');
      if (c) summary.style.setProperty('--team', hex(c.spec.color));
      const missing = missingStep();
      startBtn.disabled = !!missing;
      missingBtn.hidden = !missing;
      if (missing) {
        missingBtn.textContent = `${missing.label} →`;
        missingBtn.onclick = () => goTo(missing.step);
      }
      // Step headers: what is picked (shown when a step is folded) and the quick-jump nav.
      const picks: Record<string, string> = { car: carText, track: t?.name ?? '미선택', race: raceText };
      for (const [k, v] of Object.entries(picks)) q(`pick-${k}`).textContent = v;
      stepsNav.replaceChildren(
        ...(
          [
            ['car', '1', '차량'],
            ['track', '2', '서킷'],
            ['race', '3', '레이스'],
          ] as const
        ).map(([k, n, label]) => {
          const b = el('button', 'step-link');
          b.type = 'button';
          b.dataset.step = k;
          b.append(el('b', '', n), el('span', '', label), el('small', '', picks[k]));
          b.addEventListener('click', () => goTo(k));
          return b;
        }),
      );
      markCurrentStep();
    };

    /** The header nav follows the step in view. */
    const markCurrentStep = () => {
      let current = sections[0].dataset.step;
      for (const s of sections) if (s.getBoundingClientRect().top < window.innerHeight * 0.4) current = s.dataset.step;
      for (const b of stepsNav.querySelectorAll<HTMLElement>('.step-link')) {
        if (b.dataset.step === current) b.setAttribute('aria-current', 'step');
        else b.removeAttribute('aria-current');
      }
    };

    const render = () => {
      // Re-rendering replaces the buttons: keep the keyboard focus where it was.
      const active = document.activeElement as HTMLElement | null;
      const focusKey = active?.dataset.key;
      const focusGroup = active?.closest<HTMLElement>('[data-group]');
      const focusIndex = focusGroup ? [...focusGroup.querySelectorAll('button')].indexOf(active as HTMLButtonElement) : -1;

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
      renderCircuits();
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
      const b206 = root.querySelector('.menu-b206')!;
      b206.classList.toggle('on', packOn);
      b206.setAttribute('aria-pressed', String(packOn));
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

      if (active && !active.isConnected) {
        const again = (focusKey && root.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)) || (focusGroup?.isConnected && focusIndex >= 0 ? focusGroup.querySelectorAll<HTMLElement>('button')[focusIndex] : null);
        again?.focus({ preventScroll: true });
      }
    };

    function teardown(): void {
      window.removeEventListener('keydown', onKey);
      NARROW.removeEventListener('change', render);
      PHONE.removeEventListener('change', render);
      root.remove();
    }
    function start(): void {
      if (missingStep()) return;
      teardown();
      resolve({ carId, trackId, ai, laps, quali, season });
    }
    function leave(sel: MenuSelection): void {
      teardown();
      resolve(sel);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      // Enter on a focused control picks it; only elsewhere does it start the race.
      const t = e.target as HTMLElement | null;
      if (t && t !== startBtn && t.closest('button, input, select, summary, a')) return;
      start();
    }

    startBtn.addEventListener('click', start);
    root.querySelector('.menu-podium')!.addEventListener('click', () => leave({ carId, trackId, ai, laps, quali: false, podium: true }));
    root.querySelector('.menu-mp')!.addEventListener('click', () => leave({ carId, trackId, ai, laps, quali, multiplayer: true }));
    root.querySelector('.menu-b206')!.addEventListener('click', () => {
      setVoicePack(!voicePackOn());
      render();
    });
    trackSort.addEventListener('change', () => {
      circuitSort = trackSort.value as CircuitSort;
      render();
    });
    for (const s of sections) s.querySelector('.step-fold')!.addEventListener('click', () => setFolded(s, !s.classList.contains('folded')));
    root.addEventListener('scroll', markCurrentStep, { passive: true });
    NARROW.addEventListener('change', render);
    PHONE.addEventListener('change', render);
    window.addEventListener('keydown', onKey);
    mountWeatherPicker(q('weather'));
    mountTyrePicker(q('tyre'));
    // The pickers keep their own state (URL / storage): refresh the summary after a pick.
    for (const g of ['weather', 'tyre']) q(g).addEventListener('click', () => setTimeout(renderSummary));
    render();
    document.body.append(root);
    markCurrentStep();
  });
}
