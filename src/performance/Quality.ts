/**
 * Device quality tier: how much scenery a device can afford.
 *
 * - high: desktops and laptops (the full game, unchanged);
 * - mid: phones and tablets with a decent GPU (no post-processing, 1x pixels,
 *   smaller shadow map, shorter draw distance, fewer spectators);
 * - low: weak phones (also no shadows, MSAA or forest; sub-native resolution,
 *   short draw distance, sparse crowd).
 *
 * Picked from the device (touch + screen size, CPU cores, memory, GPU name),
 * `?quality=low|mid|high` forces a tier. Every individual URL switch
 * (?shadows, ?fx, ?pr ...) still overrides the tier's default.
 *
 * The world reads QUALITY while it is built (crowd size, LOD distances) and
 * every frame (scenery cull distance, car detail), so the runtime governor
 * can shorten the draw distance on a device that turns out slower than its tier.
 */
export type QualityTier = 'low' | 'mid' | 'high';

export interface QualityProfile {
  tier: QualityTier;
  /** Multiplier on scenery cull distances and LOD switch distances. */
  viewDistance: number;
  /** Share of grandstand seats with a spectator (0..1). */
  crowd: number;
  /** Cars closer than this (m) show wheel rims, brake discs and small parts. */
  carDetail: number;
}

const PROFILES: Record<QualityTier, Omit<QualityProfile, 'tier'>> = {
  high: { viewDistance: 1, crowd: 1, carDetail: 70 },
  mid: { viewDistance: 0.6, crowd: 0.5, carDetail: 45 },
  low: { viewDistance: 0.45, crowd: 0.35, carDetail: 30 },
};

/** The active profile (set once from the config, before the world is built). */
export const QUALITY: QualityProfile = { tier: 'high', ...PROFILES.high };

export function setQuality(tier: QualityTier): void {
  Object.assign(QUALITY, { tier }, PROFILES[tier]);
}

/** Renderer defaults per tier (each one overridable by its URL param). */
export const TIER_DEFAULTS: Record<QualityTier, { shadows: boolean; shadowMapSize: number; postfx: boolean; pixelRatio: number; antialias: boolean; forest: boolean }> = {
  high: { shadows: true, shadowMapSize: 2048, postfx: true, pixelRatio: 1.5, antialias: true, forest: true },
  mid: { shadows: true, shadowMapSize: 1024, postfx: false, pixelRatio: 1, antialias: true, forest: true },
  low: { shadows: false, shadowMapSize: 1024, postfx: false, pixelRatio: 0.75, antialias: false, forest: false },
};

/** GPUs of entry-level and older phones (WebGL renderer string). */
const WEAK_GPU = /Mali-(4|T[678]|G(31|51|52|57|68))|Adreno \(TM\) ([345]\d\d|6[01]\d)|PowerVR|SGX|Vivante|Intel\(R\) HD Graphics [2-5]\d{2}\b/i;

/** Tier for this device: `?quality=` if given, else from the hardware. */
export function detectTier(search: string, mobile: boolean): QualityTier {
  const forced = new URLSearchParams(search).get('quality');
  if (forced === 'low' || forced === 'mid' || forced === 'high') return forced;
  if (!mobile) return 'high';
  if (typeof navigator === 'undefined') return 'mid';
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  if (cores <= 4 || memory <= 3 || WEAK_GPU.test(gpuName())) return 'low';
  return 'mid';
}

/** The GPU's name from WebGL (empty when the browser hides it). */
function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return '';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}
