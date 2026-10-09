/**
 * Runtime config read from URL query params, so performance experiments
 * can be toggled without code changes, e.g.
 *   /?car=formula&track=monza&shadows=0&pr=1&aa=0&debug=1
 */
export interface SimConfig {
  /** Car / track ids; when missing (or `menu` is set) the start menu is shown. */
  car: string | null;
  track: string | null;
  showMenu: boolean;
  /** Directional-light shadow maps on/off. */
  shadows: boolean;
  /** Shadow map resolution (square). */
  shadowMapSize: number;
  /** Renderer MSAA. */
  antialias: boolean;
  /** Max device pixel ratio. */
  pixelRatio: number;
  /** Lower the render resolution automatically when frames get slow. */
  dynamicResolution: boolean;
  /** Draw Rapier collider wireframes. */
  physicsDebug: boolean;
  /** Instanced trees per km of track (instancing experiments). */
  treesPerKm: number;
  /** Fixed physics step rate in Hz. */
  physicsHz: number;
  /** Number of AI opponents (0 = free practice, max 19). */
  ai: number;
  /** Race distance in laps. */
  laps: number;
  /** Engine/tyre/wind audio. */
  sound: boolean;
  /** World look override (see world/themes.ts); null = the circuit's own theme. */
  theme: string | null;
  /** Benchmark length in seconds (0 = off). `?bench` alone = 40 s. */
  bench: number;
  /** Track ids still to benchmark after the current one. */
  benchQueue: string[];
  /** First run of a benchmark series (earlier results are discarded). */
  benchFirst: boolean;
}

function num(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bool(params: URLSearchParams, key: string, fallback: boolean): boolean {
  const raw = params.get(key);
  if (raw === null) return fallback;
  return raw !== '0' && raw !== 'false';
}

export function readConfig(search = window.location.search): SimConfig {
  const p = new URLSearchParams(search);
  const car = p.get('car');
  const track = p.get('track');
  const benchRaw = p.get('bench');
  const bench = benchRaw === null ? 0 : Number(benchRaw) > 1 ? Number(benchRaw) : 40;
  return {
    car,
    track,
    showMenu: !bench && (p.has('menu') || !car || !track),
    shadows: bool(p, 'shadows', true),
    shadowMapSize: num(p, 'shadowmap', 2048),
    antialias: bool(p, 'aa', true),
    pixelRatio: num(p, 'pr', 1.5),
    // Benchmarks measure the full-resolution cost, so dynamic resolution is off unless asked for.
    dynamicResolution: bool(p, 'dynres', !bench),
    physicsDebug: bool(p, 'debug', false),
    // Off by default: low-poly trees looked toy-like. ?trees=300 brings them back for instancing experiments.
    treesPerKm: num(p, 'trees', 0),
    physicsHz: num(p, 'hz', 60),
    sound: bool(p, 'sound', !bench),
    ai: num(p, 'ai', 19),
    // Benchmarks must not reach the finish (results screen) during the run.
    laps: bench ? 99 : num(p, 'laps', 3),
    bench,
    theme: p.get('theme'),
    benchQueue: (p.get('benchq') ?? '').split(',').filter(Boolean),
    benchFirst: !p.has('benchi'),
  };
}

/** Same URL with the given params set (others preserved). */
export function urlWith(params: Record<string, string | null>): string {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === null) p.delete(k);
    else p.set(k, v);
  }
  const qs = p.toString().replace(/=(&|$)/g, '$1');
  return `${window.location.pathname}${qs ? `?${qs}` : ''}`;
}
