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

/** Graphics level when nobody has chosen one: the lightest, so a weak machine never stutters. */
const DEFAULT_TIER: QualityTier = 'low';
const TIER_KEY = 'f1:quality';

/** Pickable graphics levels. Menu and lobby share these. */
export const QUALITY_OPTIONS: [QualityTier, string, string][] = [
  ['low', '낮음', '그림자 끔 · 가장 가벼움 (기본)'],
  ['mid', '보통', '그림자 · 1배 해상도'],
  ['high', '높음', '후처리 · 선명하게 (빠른 PC)'],
];

/** The level the player picked, or the default. */
export function readTier(): QualityTier {
  try {
    const v = localStorage.getItem(TIER_KEY);
    return v === 'low' || v === 'mid' || v === 'high' ? v : DEFAULT_TIER;
  } catch {
    return DEFAULT_TIER;
  }
}

export function saveTier(tier: QualityTier): void {
  try {
    localStorage.setItem(TIER_KEY, tier);
  } catch {
    /* not remembered; ?quality= still works */
  }
}

/** Tier for this run: `?quality=` wins, else the player's choice, else the default. */
export function detectTier(search: string): QualityTier {
  const forced = new URLSearchParams(search).get('quality');
  if (forced === 'low' || forced === 'mid' || forced === 'high') return forced;
  return readTier();
}
