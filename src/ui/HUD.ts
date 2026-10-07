import type { PerfSnapshot } from '../performance/PerformanceMonitor';
import { formatLapTime, type LapTimer } from '../race/LapTimer';

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
    this.helpEl.textContent = 'W/↑ 가속 · S/↓ 브레이크/후진 · A/D 조향 · Space 핸드브레이크 · R 리셋 · L 레이싱 라인 · M 소리 · H HUD · Esc 메뉴';

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
