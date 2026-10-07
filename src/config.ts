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
  /** Draw Rapier collider wireframes. */
  physicsDebug: boolean;
  /** Instanced trees per km of track (instancing experiments). */
  treesPerKm: number;
  /** Fixed physics step rate in Hz. */
  physicsHz: number;
  /** Engine/tyre/wind audio. */
  sound: boolean;
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
  return {
    car,
    track,
    showMenu: p.has('menu') || !car || !track,
    shadows: bool(p, 'shadows', true),
    shadowMapSize: num(p, 'shadowmap', 2048),
    antialias: bool(p, 'aa', true),
    pixelRatio: num(p, 'pr', 2),
    physicsDebug: bool(p, 'debug', false),
    treesPerKm: num(p, 'trees', 300),
    physicsHz: num(p, 'hz', 60),
    sound: bool(p, 'sound', true),
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
