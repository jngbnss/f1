/**
 * Look of the world around a circuit: sky, light, haze, ground and the
 * distant landscape. Each real circuit maps to a theme for its region;
 * `?theme=<id>` overrides it (handy for comparing looks).
 *
 * Colors are sRGB hex. HDRIs are Poly Haven "pure sky" images (CC0).
 */
export interface TerrainStyle {
  /** Peak height (m) of the distant landscape (0 = flat horizon). */
  height: number;
  /** Feature size (m) of the hills: small = busy, large = broad ranges. */
  scale: number;
  /** Distance (m) beyond the circuit's surroundings over which hills rise to full height. */
  ramp: number;
  /** Sharp ridges (mountains) instead of rounded hills. */
  ridged: boolean;
  /** 0..1 share of the land covered by woods (dark patches seen from afar). */
  forest: number;
  meadow: number;
  woods: number;
  rock: number;
  /** Height fraction above which slopes turn to rock (1 = never). */
  rockLine: number;
}

export interface WorldTheme {
  id: string;
  /** File in public/hdri/. */
  hdri: string;
  /** Renderer tone-mapping exposure. */
  exposure: number;
  sunIntensity: number;
  sunColor: number;
  /** Sky/ground hemisphere fill once the HDRI is in (adds to image lighting). */
  hemiIntensity: number;
  envIntensity: number;
  /** Exponential haze density (1/m): higher = mistier. */
  fogDensity: number;
  /** Sky/fog colors used until the HDRI has streamed in. */
  skyTop: number;
  skyHorizon: number;
  /** Multiplies the grass texture (lush vs dry vs dull). */
  grassTint: number;
  terrain: TerrainStyle;
}

const BASE: WorldTheme = {
  id: 'default',
  hdri: 'sky_2k.hdr',
  exposure: 1,
  sunIntensity: 2.6,
  sunColor: 0xfff1dc,
  hemiIntensity: 0.25,
  envIntensity: 0.9,
  fogDensity: 0.00016,
  skyTop: 0x3d7cc9,
  skyHorizon: 0xc9e3f5,
  grassTint: 0x8fc46a,
  terrain: {
    height: 90,
    scale: 2600,
    ramp: 2500,
    ridged: false,
    forest: 0.35,
    meadow: 0x45652f,
    woods: 0x22361c,
    rock: 0x7a7468,
    rockLine: 1,
  },
};

export const THEMES: Record<string, WorldTheme> = {
  default: BASE,
  // Styrian Alps around the Red Bull Ring: forested mountains, clear air.
  alpine: {
    ...BASE,
    id: 'alpine',
    fogDensity: 0.00011,
    grassTint: 0x86c064,
    terrain: {
      height: 1300,
      scale: 4200,
      ramp: 3500,
      ridged: true,
      forest: 0.6,
      meadow: 0x3f5a2a,
      woods: 0x1b2c17,
      rock: 0x6f6a60,
      rockLine: 0.72,
    },
  },
  // Lombardy plain, Monza park: warm hazy afternoon, flat with a wooded horizon.
  lombardy: {
    ...BASE,
    id: 'lombardy',
    hdri: 'qwantani_late_afternoon_puresky_2k.hdr',
    exposure: 1.05,
    sunColor: 0xffdcae,
    sunIntensity: 2.8,
    fogDensity: 0.00024,
    skyTop: 0x5a86b8,
    skyHorizon: 0xe6d4b8,
    grassTint: 0x98bf62,
    terrain: {
      height: 26,
      scale: 900,
      ramp: 600,
      ridged: false,
      forest: 0.75,
      meadow: 0x4f6332,
      woods: 0x22351c,
      rock: 0x6e6a5e,
      rockLine: 1,
    },
  },
  // Northamptonshire: overcast, flat farmland with hedges and copses.
  england: {
    ...BASE,
    id: 'england',
    hdri: 'kloofendal_overcast_puresky_2k.hdr',
    exposure: 1.1,
    sunIntensity: 0.9,
    sunColor: 0xe8ecf0,
    hemiIntensity: 0.55,
    envIntensity: 1.1,
    fogDensity: 0.0003,
    skyTop: 0x8a97a6,
    skyHorizon: 0xc4ccd4,
    grassTint: 0x7fb15c,
    terrain: {
      height: 45,
      scale: 1800,
      ramp: 1200,
      ridged: false,
      forest: 0.3,
      meadow: 0x41602d,
      woods: 0x1f331b,
      rock: 0x6b6a62,
      rockLine: 1,
    },
  },
  // Ardennes around Spa: steep wooded valleys, misty.
  ardennes: {
    ...BASE,
    id: 'ardennes',
    hdri: 'kloofendal_28d_misty_puresky_2k.hdr',
    exposure: 1.05,
    sunIntensity: 1.6,
    sunColor: 0xfff0dc,
    hemiIntensity: 0.4,
    fogDensity: 0.00022,
    skyTop: 0x9fb2c4,
    skyHorizon: 0xd2d9df,
    grassTint: 0x7fb45a,
    terrain: {
      height: 380,
      scale: 2200,
      ramp: 1500,
      ridged: false,
      forest: 0.85,
      meadow: 0x41602b,
      woods: 0x182a15,
      rock: 0x6b675d,
      rockLine: 1,
    },
  },
};

const BY_TRACK: Record<string, string> = {
  spielberg: 'alpine',
  monza: 'lombardy',
  silverstone: 'england',
  spa: 'ardennes',
};

export function themeFor(trackId: string, override?: string | null): WorldTheme {
  return THEMES[override ?? ''] ?? THEMES[BY_TRACK[trackId] ?? 'default'];
}
