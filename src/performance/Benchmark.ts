import type * as THREE from 'three';
import { QUALITY } from './Quality';

/** Frames slower than this miss the 90 fps target (ms). */
const TARGET_FRAME_MS = 1000 / 90;
/** Ignore the first seconds after the start lights (shader compiles, texture uploads, pack spreading out). */
const WARMUP_S = 3;
const STORAGE_KEY = 'web-sim-lab:bench';

export interface BenchResult {
  track: string;
  car: string;
  cars: number;
  seconds: number;
  frames: number;
  fpsAvg: number;
  /** fps of the 1% slowest frames (99th percentile frame time). */
  fps1Low: number;
  fpsMin: number;
  frameMsAvg: number;
  frameMsP99: number;
  frameMsMax: number;
  /** Share of frames slower than 90 fps (%). */
  slowFramesPct: number;
  physicsMsAvg: number;
  renderMsAvg: number;
  drawCallsAvg: number;
  drawCallsMax: number;
  trianglesAvg: number;
  trianglesMax: number;
  heapMB: number | null;
  /** Page navigation -> first rendered frame (ms). */
  loadMs: number;
  resolution: string;
  pixelRatio: number;
  /** Device quality tier the run used. */
  quality: string;
  gpu: string;
  userAgent: string;
  date: string;
}

export interface BenchContext {
  track: string;
  car: string;
  cars: number;
  renderer: THREE.WebGLRenderer;
  /** Remaining track ids of a multi-track run (navigates to the next one when done). */
  queue: string[];
  nextUrl(track: string, queue: string[]): string;
}

/**
 * Fixed-length performance run (?bench=<seconds>). The game drives the
 * player with an AI so every run follows the same path; this class records
 * every frame after the warmup and reports fps, frame-time percentiles,
 * CPU time and renderer load. Results are logged as `BENCH_RESULT {json}`
 * (picked up by scripts/bench.ts) and shown in an overlay.
 */
export class Benchmark {
  private readonly frameMs: Float32Array;
  private readonly physicsMs: Float32Array;
  private readonly renderMs: Float32Array;
  private readonly calls: Float32Array;
  private readonly tris: Float32Array;
  private count = 0;
  private last = 0;
  private recordFrom = -1;
  private loadMs = 0;
  private done = false;

  constructor(
    private readonly seconds: number,
    private readonly ctx: BenchContext,
  ) {
    // Room for 500 fps; extra frames are simply dropped.
    const cap = Math.ceil(seconds * 500);
    this.frameMs = new Float32Array(cap);
    this.physicsMs = new Float32Array(cap);
    this.renderMs = new Float32Array(cap);
    this.calls = new Float32Array(cap);
    this.tris = new Float32Array(cap);
  }

  /**
   * Call once per frame after rendering.
   * @param racing false while the cars wait for the start lights
   */
  frame(racing: boolean, cpu: { physicsMs: number; renderMs: number }, info: THREE.WebGLInfo): void {
    const now = performance.now();
    if (this.done) return;
    if (this.last === 0) this.loadMs = now;
    const dt = this.last > 0 ? now - this.last : 0;
    this.last = now;
    if (this.recordFrom < 0) {
      if (racing) this.recordFrom = now + WARMUP_S * 1000;
      return;
    }
    if (now < this.recordFrom) return;
    if (now - this.recordFrom >= this.seconds * 1000) {
      this.finish();
      return;
    }
    const i = this.count;
    if (i >= this.frameMs.length) return;
    this.frameMs[i] = dt;
    this.physicsMs[i] = cpu.physicsMs;
    this.renderMs[i] = cpu.renderMs;
    this.calls[i] = info.render.calls;
    this.tris[i] = info.render.triangles;
    this.count++;
  }

  private finish(): void {
    this.done = true;
    const result = this.result();
    console.log(`BENCH_RESULT ${JSON.stringify(result)}`);
    const all = [...loadResults(), result];
    saveResults(all);
    const [next, ...rest] = this.ctx.queue;
    if (next) {
      window.location.href = this.ctx.nextUrl(next, rest);
      return;
    }
    console.log(`BENCH_DONE ${all.length}`);
    showResults(all);
  }

  private result(): BenchResult {
    const n = this.count;
    const frames = Array.from(this.frameMs.subarray(0, n)).sort((a, b) => a - b);
    const avg = (a: Float32Array) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += a[i];
      return n ? s / n : 0;
    };
    const max = (a: Float32Array) => {
      let m = 0;
      for (let i = 0; i < n; i++) m = Math.max(m, a[i]);
      return m;
    };
    const frameAvg = avg(this.frameMs);
    const p99 = frames[Math.min(n - 1, Math.floor(n * 0.99))] ?? 0;
    const frameMax = frames[n - 1] ?? 0;
    let slow = 0;
    for (const f of frames) if (f > TARGET_FRAME_MS) slow++;
    const r = this.ctx.renderer;
    const canvas = r.domElement;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
    return {
      track: this.ctx.track,
      car: this.ctx.car,
      cars: this.ctx.cars,
      seconds: this.seconds,
      frames: n,
      fpsAvg: round(frameAvg ? 1000 / frameAvg : 0),
      fps1Low: round(p99 ? 1000 / p99 : 0),
      fpsMin: round(frameMax ? 1000 / frameMax : 0),
      frameMsAvg: round(frameAvg, 2),
      frameMsP99: round(p99, 2),
      frameMsMax: round(frameMax, 2),
      slowFramesPct: round(n ? (slow / n) * 100 : 0, 2),
      physicsMsAvg: round(avg(this.physicsMs), 2),
      renderMsAvg: round(avg(this.renderMs), 2),
      drawCallsAvg: Math.round(avg(this.calls)),
      drawCallsMax: max(this.calls),
      trianglesAvg: Math.round(avg(this.tris)),
      trianglesMax: max(this.tris),
      heapMB: mem ? round(mem.usedJSHeapSize / 1048576) : null,
      loadMs: Math.round(this.loadMs),
      resolution: `${canvas.width}x${canvas.height}`,
      pixelRatio: r.getPixelRatio(),
      quality: QUALITY.tier,
      gpu: gpuName(r),
      userAgent: navigator.userAgent,
      date: new Date().toISOString(),
    };
  }
}

/** Start of a new benchmark series: forget results of earlier runs. */
export function clearBenchResults(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: single-run results only */
  }
}

function loadResults(): BenchResult[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') as BenchResult[];
  } catch {
    return [];
  }
}

function saveResults(results: BenchResult[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(results));
  } catch {
    /* ignore */
  }
}

function gpuName(r: THREE.WebGLRenderer): string {
  const gl = r.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
}

function showResults(results: BenchResult[]): void {
  const el = document.createElement('div');
  el.className = 'bench';
  const cols: [keyof BenchResult, string][] = [
    ['track', 'Track'],
    ['fpsAvg', 'Avg fps'],
    ['fps1Low', '1% low'],
    ['fpsMin', 'Min fps'],
    ['slowFramesPct', '<90fps %'],
    ['physicsMsAvg', 'Physics ms'],
    ['renderMsAvg', 'Render ms'],
    ['drawCallsAvg', 'Draw calls'],
    ['trianglesAvg', 'Triangles'],
    ['loadMs', 'Load ms'],
  ];
  const head = cols.map(([, label]) => `<th>${label}</th>`).join('');
  const rows = results
    .map((r) => {
      const cells = cols.map(([k]) => {
        const v = r[k];
        const bad = (k === 'fpsMin' || k === 'fps1Low') && Number(v) < 90;
        return `<td${bad ? ' class="bad"' : ''}>${typeof v === 'number' ? v.toLocaleString() : String(v)}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');
  const first = results[0];
  el.innerHTML = `
    <h2>Benchmark</h2>
    <p>${first?.gpu ?? ''} · ${first?.resolution ?? ''} · ${first?.car ?? ''} × ${first?.cars ?? 0} · ${first?.seconds ?? 0}s per track · target 90 fps</p>
    <table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
    <button type="button">Copy JSON</button>`;
  el.querySelector('button')!.addEventListener('click', (e) => {
    void navigator.clipboard?.writeText(JSON.stringify(results, null, 2));
    (e.target as HTMLButtonElement).textContent = 'Copied';
  });
  document.body.appendChild(el);
}
