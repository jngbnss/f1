/**
 * Runtime config read from URL query params, so performance experiments
 * can be toggled without code changes, e.g.
 *   /?shadows=0&pr=1&aa=0&debug=1
 */
export interface SimConfig {
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
  /** Number of instanced trees around the track (instancing experiments). */
  trees: number;
  /** Fixed physics step rate in Hz. */
  physicsHz: number;
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
  return {
    shadows: bool(p, 'shadows', true),
    shadowMapSize: num(p, 'shadowmap', 2048),
    antialias: bool(p, 'aa', true),
    pixelRatio: num(p, 'pr', 2),
    physicsDebug: bool(p, 'debug', false),
    trees: num(p, 'trees', 400),
    physicsHz: num(p, 'hz', 60),
  };
}
