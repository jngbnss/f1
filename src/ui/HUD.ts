import type { PerfSnapshot } from '../performance/PerformanceMonitor';

export interface VehicleHudState {
  speedKmh: number;
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
  private readonly helpEl: HTMLDivElement;
  private readonly fields = new Map<string, HTMLSpanElement>();
  private lastPerfUpdate = 0;
  private lastSpeedUpdate = 0;
  private visible = true;

  constructor(parent: HTMLElement = document.body) {
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
    speedo.append(this.speedEl, unit, this.gearEl);

    this.helpEl = document.createElement('div');
    this.helpEl.className = 'help';
    this.helpEl.textContent = 'W/↑ gas · S/↓ brake/reverse · A/D steer · Space handbrake · R reset · H hide HUD';

    parent.append(this.perfEl, speedo, this.helpEl);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyH' && !e.repeat) this.toggle();
    });
  }

  update(perf: PerfSnapshot, vehicle: VehicleHudState, now = performance.now()): void {
    if (now - this.lastSpeedUpdate > 66) {
      this.lastSpeedUpdate = now;
      const kmh = Math.abs(vehicle.speedKmh);
      this.speedEl.textContent = String(Math.round(kmh));
      this.gearEl.textContent = vehicle.speedKmh < -1 ? 'R' : kmh < 1 ? 'N' : 'D';
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
