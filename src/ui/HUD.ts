import type { PerfSnapshot } from '../performance/PerformanceMonitor';
import { formatLapTime, type LapTimer } from '../race/LapTimer';
import type { Racer, RaceManager } from '../race/RaceManager';

/** Per-car extras for the timing tower. */
export interface TowerInfo {
  /** Compound letter (S/M/H) and its colour. */
  tyre: string;
  tyreColor: string;
  inPit: boolean;
}

/** Player's car panel: tyres, pit status, intervals. */
export interface CarPanelState {
  compound: string;
  compoundColor: string;
  wear: [number, number];
  /** -1 cold, 0 in window, +1 hot, per axle. */
  temp: [number, number];
  tempC: [number, number];
  pit: string | null;
  /** Wing damage 0..1 (front, rear). */
  damage: [number, number];
  ahead: number | null;
  behind: number | null;
}

export interface VehicleHudState {
  speedKmh: number;
  /** Gear label from the gearbox ('R', 'N', '1'..). */
  gear: string;
  /** 0..1 engine speed between idle and redline. */
  rpmRatio: number;
  input: string;
}

const fmt = (v: number, digits = 1) => v.toFixed(digits);
const fmtInt = (v: number) => Math.round(v).toLocaleString('en-US');

/**
 * DOM overlay. Text is refreshed at a limited rate to keep layout/paint
 * cost out of the measurements; toggle with H.
 */
export class HUD {
  private readonly perfEl: HTMLDivElement;
  private readonly speedEl: HTMLDivElement;
  private readonly gearEl: HTMLDivElement;
  private readonly rpmEl: HTMLDivElement;
  private readonly helpEl: HTMLDivElement;
  private readonly lapEl: HTMLDivElement;
  private readonly lapFields: Record<'lap' | 'cur' | 'last' | 'best', HTMLSpanElement>;
  private readonly toastEl: HTMLDivElement;
  private toastUntil = 0;
  private readonly fields = new Map<string, HTMLSpanElement>();
  private lastPerfUpdate = 0;
  private lastSpeedUpdate = 0;
  private visible = true;

  constructor(trackName: string, attribution = '', parent: HTMLElement = document.body) {
    this.perfEl = document.createElement('div');
    this.perfEl.className = 'hud';
    const rows: [string, string][] = [
      ['fps', 'FPS'],
      ['frame', 'frame (avg/max)'],
      ['physics', 'physics'],
      ['render', 'render cpu'],
      ['res', 'resolution'],
      ['calls', 'draw calls'],
      ['tris', 'triangles'],
      ['geo', 'geometries / tex'],
      ['heap', 'JS heap'],
      ['input', 'input'],
    ];
    for (const [key, label] of rows) {
      const row = document.createElement('div');
      row.className = 'row';
      const l = document.createElement('span');
      l.className = 'label';
      l.textContent = label;
      const v = document.createElement('span');
      v.textContent = '–';
      row.append(l, v);
      this.perfEl.append(row);
      this.fields.set(key, v);
    }

    const speedo = document.createElement('div');
    speedo.className = 'speedo';
    this.speedEl = document.createElement('div');
    this.speedEl.className = 'value';
    this.speedEl.textContent = '0';
    const unit = document.createElement('div');
    unit.className = 'unit';
    unit.textContent = 'km/h';
    this.gearEl = document.createElement('div');
    this.gearEl.className = 'gear';
    const rpm = document.createElement('div');
    rpm.className = 'rpm';
    this.rpmEl = document.createElement('div');
    rpm.append(this.rpmEl);
    speedo.append(this.gearEl, rpm, this.speedEl, unit);

    this.helpEl = document.createElement('div');
    this.helpEl.className = 'help';
    this.helpEl.textContent = 'W/↑ 가속 · S/↓ 브레이크/후진 · A/D 조향 · Space 핸드브레이크 · B 브레이크 보조 · R 리셋 · L 레이싱 라인 · C 시점 · M 소리 · H HUD · Esc 메뉴';

    const trackEl = document.createElement('div');
    trackEl.className = 'trackname';
    trackEl.textContent = trackName;
    if (attribution) {
      const small = document.createElement('small');
      small.textContent = attribution;
      trackEl.append(small);
    }

    this.lapEl = document.createElement('div');
    this.lapEl.className = 'laps';
    const mk = (label: string) => {
      const row = document.createElement('div');
      const l = document.createElement('span');
      l.textContent = label;
      const v = document.createElement('b');
      row.append(l, v);
      this.lapEl.append(row);
      return v;
    };
    this.lapFields = { lap: mk('LAP'), cur: mk('TIME'), last: mk('LAST'), best: mk('BEST') };
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'toast';

    parent.append(this.perfEl, speedo, this.helpEl, trackEl, this.lapEl, this.toastEl);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyH' && !e.repeat) this.toggle();
    });
  }

  update(perf: PerfSnapshot, vehicle: VehicleHudState, now = performance.now()): void {
    if (now - this.lastSpeedUpdate > 66) {
      this.lastSpeedUpdate = now;
      const kmh = Math.abs(vehicle.speedKmh);
      this.speedEl.textContent = String(Math.round(kmh));
      this.gearEl.textContent = vehicle.gear;
      const r = Math.min(Math.max(vehicle.rpmRatio, 0), 1);
      this.rpmEl.style.width = `${(r * 100).toFixed(1)}%`;
      this.rpmEl.className = r > 0.9 ? 'high' : '';
    }
    if (!this.visible || now - this.lastPerfUpdate < 250) return;
    this.lastPerfUpdate = now;

    this.set('fps', fmtInt(perf.fps), perf.fps < 30 ? 'bad' : perf.fps < 55 ? 'warn' : '');
    this.set('frame', `${fmt(perf.frameTimeAvg)} / ${fmt(perf.frameTimeMax)} ms`, perf.frameTimeMax > 33 ? 'warn' : '');
    this.set('physics', `${fmt(perf.physicsMs, 2)} ms (${fmt(perf.stepsPerFrame)}×)`);
    this.set('render', `${fmt(perf.renderMs, 2)} ms`);
    this.set('res', `${fmt(perf.pixelRatio, 2)}×`);
    this.set('calls', fmtInt(perf.drawCalls));
    this.set('tris', fmtInt(perf.triangles));
    this.set('geo', `${perf.geometries} / ${perf.textures}`);
    this.set('heap', perf.heapMB === null ? 'n/a' : `${fmt(perf.heapMB)} MB`);
    this.set('input', vehicle.input);
  }

  updateLaps(timer: LapTimer, event: 'lap' | 'best' | null, now = performance.now()): void {
    const f = this.lapFields;
    const set = (el: HTMLElement, text: string) => {
      if (el.textContent !== text) el.textContent = text;
    };
    set(f.lap, timer.lap > 0 ? String(timer.lap) : '–');
    set(f.cur, formatLapTime(timer.current) + (timer.valid ? '' : ' ✕'));
    set(f.last, formatLapTime(timer.last));
    set(f.best, formatLapTime(timer.best));
    if (event) this.toast(event === 'best' ? `🏁 신기록! ${formatLapTime(timer.last)}` : `LAP ${formatLapTime(timer.last)}`, now);
    if (this.toastUntil && now > this.toastUntil) {
      this.toastEl.classList.remove('show');
      this.toastUntil = 0;
    }
  }

  private raceEls: { pos: HTMLDivElement; countdown: HTMLDivElement; board: HTMLOListElement; results: HTMLDivElement } | null = null;
  private lastBoardUpdate = 0;
  private resultsShown = false;

  /** Position, lap, start lights, live standings and final results. */
  updateRace(race: RaceManager, towerInfo?: (r: Racer) => TowerInfo, now = performance.now()): void {
    if (!this.raceEls) {
      const pos = document.createElement('div');
      pos.className = 'race-pos';
      const countdown = document.createElement('div');
      countdown.className = 'countdown';
      const board = document.createElement('ol');
      board.className = 'board';
      const results = document.createElement('div');
      results.className = 'results';
      document.body.append(pos, countdown, board, results);
      this.raceEls = { pos, countdown, board, results };
    }
    const els = this.raceEls;
    const me = race.player;
    if (!me) return;

    // Start lights: 3, 2, 1, GO!
    if (race.state === 'countdown') {
      const n = Math.ceil(race.countdown - 1);
      els.countdown.textContent = n >= 1 ? String(n) : '';
      els.countdown.className = 'countdown show red';
    } else if (race.time < 1.2) {
      els.countdown.textContent = 'GO!';
      els.countdown.className = 'countdown show green';
    } else {
      els.countdown.className = 'countdown';
    }

    if (now - this.lastBoardUpdate < 200) return;
    this.lastBoardUpdate = now;
    const standings = race.standings();
    const position = standings.indexOf(me) + 1;
    els.pos.innerHTML = `<span>POS</span><b>${position}<small>/${standings.length}</small></b><span>LAP</span><b>${race.lapOf(me)}<small>/${race.laps}</small></b>`;

    // Timing tower, F1 TV style: position, team colour, car, gap to the leader, tyre, pit.
    els.board.replaceChildren(
      ...standings.map((r, i) => {
        const li = document.createElement('li');
        if (r === me) li.className = 'me';
        const info = towerInfo?.(r);
        const pos = document.createElement('b');
        pos.textContent = String(i + 1);
        const bar = document.createElement('i');
        bar.style.background = `#${r.color.toString(16).padStart(6, '0')}`;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = r.name;
        const gap = document.createElement('span');
        gap.className = 'gap';
        const g = i > 0 ? race.gap(standings[0], r) : null;
        gap.textContent = info?.inPit ? 'PIT' : i === 0 ? 'Leader' : r.finished ? 'FIN' : g !== null ? `+${g.toFixed(1)}` : '';
        if (info?.inPit) gap.classList.add('pit');
        li.append(pos, bar, name, gap);
        if (info) {
          const tyre = document.createElement('em');
          tyre.textContent = info.tyre;
          tyre.style.borderColor = info.tyreColor;
          tyre.style.color = info.tyreColor;
          li.append(tyre);
        }
        return li;
      }),
    );

    if (race.state === 'finished' && !this.resultsShown) {
      this.resultsShown = true;
      const lines = standings
        .map((r, i) => `<li class="${r === me ? 'me' : ''}">${i + 1}. ${r.name} <span>${r.finished ? formatLapTime(r.finishTime) : 'running'}</span></li>`)
        .join('');
      els.results.innerHTML = `<h2>🏁 ${position}위로 완주!</h2><ol>${lines}</ol><p>Esc: 메뉴 · 새로고침: 다시 레이스</p>`;
      els.results.classList.add('show');
    }
  }

  private carEl: HTMLDivElement | null = null;
  private lastCarUpdate = 0;

  /** Tyre / pit / interval panel above the speedometer. */
  updateCar(s: CarPanelState, now = performance.now()): void {
    if (!this.carEl) {
      this.carEl = document.createElement('div');
      this.carEl.className = 'car-panel';
      document.body.append(this.carEl);
    }
    if (now - this.lastCarUpdate < 200) return;
    this.lastCarUpdate = now;
    const tempClass = (t: number) => (t < 0 ? 'cold' : t > 0 ? 'hot' : 'ok');
    const axle = (label: string, k: 0 | 1) =>
      `<div class="axle"><span>${label}</span><div class="wear"><i style="width:${Math.round((1 - s.wear[k]) * 100)}%"></i></div><b>${Math.round(s.wear[k] * 100)}%</b><em class="${tempClass(s.temp[k])}">${Math.round(s.tempC[k])}°</em></div>`;
    const gap = (v: number | null, sign: string) => (v === null ? '–' : `${sign}${v.toFixed(1)}`);
    this.carEl.innerHTML =
      `<div class="tyre"><b style="color:${s.compoundColor};border-color:${s.compoundColor}">${s.compound}</b><div>${axle('앞', 0)}${axle('뒤', 1)}</div></div>` +
      (s.damage[0] > 0.02 || s.damage[1] > 0.02
        ? `<div class="damage"><span class="${s.damage[0] >= 0.6 ? 'bad' : s.damage[0] > 0.02 ? 'warn' : ''}">앞날개 ${Math.round(s.damage[0] * 100)}%</span><span class="${s.damage[1] >= 0.6 ? 'bad' : s.damage[1] > 0.02 ? 'warn' : ''}">뒷날개 ${Math.round(s.damage[1] * 100)}%</span></div>`
        : '') +
      `<div class="intervals"><span>앞차 <b>${gap(s.ahead, '-')}</b></span><span>뒤차 <b>${gap(s.behind, '+')}</b></span></div>` +
      (s.pit ? `<div class="pit">${s.pit}</div>` : '<div class="pit hint">P 피트 · 1/2/3 타이어</div>');
  }

  toast(text: string, now = performance.now()): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    this.toastUntil = now + 2500;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.perfEl.style.display = this.visible ? '' : 'none';
    this.helpEl.style.display = this.visible ? '' : 'none';
  }

  private set(key: string, text: string, cls = ''): void {
    const el = this.fields.get(key);
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    if (el.className !== cls) el.className = cls;
  }
}
