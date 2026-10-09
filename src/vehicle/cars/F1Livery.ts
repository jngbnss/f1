import * as THREE from 'three';

/**
 * Team liveries for the shared F1 body. The body has no UVs, so everything is
 * placed in model space (m; x right, y up from the ground, z forward negative,
 * origin between the axles):
 *  - colour regions (lower body, fades, bands, wings, exposed carbon) are
 *    computed in the paint shader from the position, so borders stay crisp at
 *    any distance and cost no texture memory;
 *  - decals (invented sponsor wordmarks, team name, tyre-maker text) are drawn
 *    once per team into three canvases projected along x (sides), y (top) and
 *    z (rear), blended by the surface normal;
 *  - the race number (per car) is a small texture placed on the nose and the
 *    engine-cover flanks.
 * Exposed carbon gets a procedural 2x2 twill weave that fades out before it
 * would alias. Colours follow each team's 2026 look; no real logos or sponsors.
 */

export interface Livery {
  primary: number;
  secondary: number;
  /** Pinstripes, small details. */
  accent: number;
  helmet: number;
  /** Two race numbers (one per car of the team). */
  numbers: [number, number];
  /** Team name on the engine cover / sidepod tops. */
  name: string;
  /** Invented sponsors: [sidepod, nose & small, wings]. */
  sponsors: [string, string, string];
  /** Decal colours: on the sidepod, on the nose/engine cover, on the (carbon) wings. */
  inks: [number, number, number];
  /** Region below y = a + b z + c z² (from the sidepods back): secondary paint or bare carbon. */
  lower: { mode: 'none' | 'secondary' | 'carbon'; a: number; b?: number; c?: number; pin?: boolean };
  /** Primary fades to secondary between these z. */
  fade?: [number, number];
  /** Coloured band on the upper bodywork: z0, z1, from height y, colour. */
  band?: [number, number, number, number];
  /** Stripe along the top centre line: half width (m), colour. */
  spine?: [number, number];
  noseTip: number;
  /** Upper wing flaps and wing endplates. */
  flap: number;
  endplate: number;
  /** Paint finish. */
  matte?: boolean;
  metal?: number;
  /** Wheel-nut / wheel-cover ring colour. */
  rim: number;
  /** Helmet design colours: stripe, top. */
  helmetStripe: number;
  helmetTop: number;
}

const LIVERIES: Record<string, Livery> = {
  'f1-ferrari': {
    primary: 0xd40000, secondary: 0x161616, accent: 0xffffff, helmet: 0xffd400, numbers: [16, 44], name: 'FERRARI',
    sponsors: ['VANTIS', 'QORA', 'HELIXA'], inks: [0xffffff, 0xffffff, 0xffffff],
    lower: { mode: 'carbon', a: 0.36, b: 0.015, pin: true },
    noseTip: 0xd40000, flap: 0xd40000, endplate: 0xd40000, rim: 0xffd400, helmetStripe: 0xd40000, helmetTop: 0xffffff,
  },
  'f1-mercedes': {
    primary: 0xb9c0c7, secondary: 0x0e0f11, accent: 0x00d2be, helmet: 0xe8e8e8, numbers: [63, 12], name: 'MERCEDES',
    sponsors: ['ORBIQ', 'NEXORA', 'KYNET'], inks: [0x00d2be, 0x0e0f11, 0xffffff],
    lower: { mode: 'carbon', a: 0.42, pin: true }, fade: [-0.7, 1.1], metal: 0.55,
    noseTip: 0x0e0f11, flap: 0x00d2be, endplate: 0x0e0f11, rim: 0x00d2be, helmetStripe: 0x00d2be, helmetTop: 0x222222,
  },
  'f1-redbull': {
    primary: 0x1b2343, secondary: 0xd0021b, accent: 0xffc906, helmet: 0x1b2343, numbers: [1, 6], name: 'RED BULL',
    sponsors: ['STRATA', 'LUMEN', 'ZENTRA'], inks: [0xffc906, 0xffffff, 0xffffff],
    lower: { mode: 'carbon', a: 0.31 }, band: [-0.75, 0.25, 0.3, 0xd0021b], matte: true,
    noseTip: 0xffc906, flap: 0xd0021b, endplate: 0x1b2343, rim: 0xd0021b, helmetStripe: 0xd0021b, helmetTop: 0xffc906,
  },
  'f1-mclaren': {
    primary: 0xff7a00, secondary: 0x202124, accent: 0x47c7fc, helmet: 0xff8000, numbers: [4, 81], name: 'McLAREN',
    sponsors: ['VELTRO', 'ARKON', 'PRAXA'], inks: [0xffffff, 0x202124, 0xff8000],
    lower: { mode: 'secondary', a: 0.47, b: 0.03, c: 0.02, pin: true },
    noseTip: 0x202124, flap: 0xff8000, endplate: 0x202124, rim: 0xff8000, helmetStripe: 0x47c7fc, helmetTop: 0x202124,
  },
  'f1-aston': {
    primary: 0x00594f, secondary: 0x0b2b27, accent: 0xcedc00, helmet: 0x00594f, numbers: [14, 18], name: 'ASTON MARTIN',
    sponsors: ['SOLVEN', 'OMNIS', 'CRESTA'], inks: [0xffffff, 0xcedc00, 0xcedc00],
    lower: { mode: 'carbon', a: 0.38, b: 0.02, pin: true }, spine: [0.018, 0xcedc00],
    noseTip: 0x00594f, flap: 0x00594f, endplate: 0x00594f, rim: 0xcedc00, helmetStripe: 0xcedc00, helmetTop: 0xffffff,
  },
  'f1-alpine': {
    primary: 0x0a5cd6, secondary: 0xff5fae, accent: 0xffffff, helmet: 0x0a5cd6, numbers: [10, 43], name: 'ALPINE',
    sponsors: ['NOVUX', 'TERRA-X', 'AXIOS'], inks: [0xffffff, 0xffffff, 0xff5fae],
    lower: { mode: 'carbon', a: 0.34 }, fade: [-0.3, 1.3],
    noseTip: 0xff5fae, flap: 0xff5fae, endplate: 0x0a5cd6, rim: 0xff5fae, helmetStripe: 0xff5fae, helmetTop: 0xffffff,
  },
  'f1-williams': {
    primary: 0x0d2a62, secondary: 0x0093d0, accent: 0xffffff, helmet: 0x0093d0, numbers: [23, 55], name: 'WILLIAMS',
    sponsors: ['QUBIT', 'MAREN', 'DYNEX'], inks: [0xffffff, 0xffffff, 0xffffff],
    lower: { mode: 'carbon', a: 0.4, pin: true }, band: [-0.35, 0.15, 0.42, 0x0093d0],
    noseTip: 0x0093d0, flap: 0x0093d0, endplate: 0x0d2a62, rim: 0x0093d0, helmetStripe: 0xffffff, helmetTop: 0x0d2a62,
  },
  'f1-racingbulls': {
    primary: 0xf3f3f5, secondary: 0x1d3fa6, accent: 0xe4002b, helmet: 0xf3f3f5, numbers: [30, 41], name: 'RACING BULLS',
    sponsors: ['FLUXA', 'KORIN', 'VEXO'], inks: [0xffffff, 0x1d3fa6, 0xffffff],
    lower: { mode: 'secondary', a: 0.5, b: 0.02, c: 0.03, pin: true },
    noseTip: 0x1d3fa6, flap: 0x1d3fa6, endplate: 0xf3f3f5, rim: 0xe4002b, helmetStripe: 0x1d3fa6, helmetTop: 0xe4002b,
  },
  'f1-haas': {
    primary: 0xf4f4f4, secondary: 0x1a1a1a, accent: 0xd0021b, helmet: 0xd0021b, numbers: [31, 87], name: 'HAAS',
    sponsors: ['MONOLIT', 'TRAVEX', 'GRIDA'], inks: [0xffffff, 0x1a1a1a, 0xffffff],
    lower: { mode: 'secondary', a: 0.46, b: 0.02, pin: true },
    noseTip: 0xd0021b, flap: 0xd0021b, endplate: 0x1a1a1a, rim: 0xd0021b, helmetStripe: 0xffffff, helmetTop: 0x1a1a1a,
  },
  'f1-audi': {
    primary: 0x8e959c, secondary: 0x141518, accent: 0xe2003c, helmet: 0x141518, numbers: [27, 5], name: 'AUDI',
    sponsors: ['REVOL', 'SYNKA', 'ELARA'], inks: [0xffffff, 0x141518, 0xe2003c],
    lower: { mode: 'secondary', a: 0.44, b: 0.025, pin: true }, band: [-0.95, -0.72, 0.3, 0xe2003c], metal: 0.5,
    noseTip: 0xe2003c, flap: 0xe2003c, endplate: 0x141518, rim: 0xe2003c, helmetStripe: 0xe2003c, helmetTop: 0x8e959c,
  },
};

export function liveryFor(carId: string, color: number, accent: number): Livery {
  return (
    LIVERIES[carId] ?? {
      primary: color, secondary: 0x1c1c1c, accent, helmet: accent, numbers: [7, 8], name: 'TEAM',
      sponsors: ['VANTIS', 'QORA', 'HELIXA'], inks: [0xffffff, 0xffffff, 0xffffff],
      lower: { mode: 'carbon', a: 0.36 }, noseTip: color, flap: color, endplate: color, rim: accent,
      helmetStripe: color, helmetTop: 0xffffff,
    }
  );
}

/** Invented tyre maker (wing endplates, sidewalls). */
export const TYRE_BRAND = 'TRAXA';

// ---- Canvas helpers -------------------------------------------------------------------------

const css = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const FONT = '"Arial Black", "Arial", sans-serif';

function canvasTexture(canvas: HTMLCanvasElement, anisotropy = 8): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.premultiplyAlpha = true;
  return tex;
}

/**
 * A model-space plane mapped onto a canvas rectangle. `a` runs along the
 * canvas x (flipped when `mirror`), `b` along the canvas y (up = larger b
 * unless `down`). Text is always drawn unmirrored so it reads correctly.
 */
interface Plane {
  x: number;
  y: number;
  w: number;
  h: number;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  mirror?: boolean;
  /** b grows downwards on the canvas (top view: z towards the rear). */
  down?: boolean;
}

interface TextStyle {
  ink: number;
  /** Pill/badge behind the text. */
  badge?: number;
  /** Rotate the text 90° (reads along a). */
  rotate?: number;
  weight?: string;
  italic?: boolean;
  spacing?: number;
}

function px(pl: Plane, a: number, b: number): [number, number] {
  let u = (a - pl.a0) / (pl.a1 - pl.a0);
  if (pl.mirror) u = 1 - u;
  let v = (b - pl.b0) / (pl.b1 - pl.b0);
  if (!pl.down) v = 1 - v;
  return [pl.x + u * pl.w, pl.y + v * pl.h];
}

/** Draws text centred at model (a, b), height h (m), squeezed to at most maxW (m). */
function text(g: CanvasRenderingContext2D, pl: Plane, s: string, a: number, b: number, h: number, maxW: number, st: TextStyle): void {
  const ppmA = pl.w / Math.abs(pl.a1 - pl.a0);
  const ppmB = pl.h / Math.abs(pl.b1 - pl.b0);
  const rot = st.rotate ?? 0;
  // Pixels per metre along the text's own axes.
  const along = rot ? ppmB : ppmA;
  const across = rot ? ppmA : ppmB;
  const [cx, cy] = px(pl, a, b);
  g.save();
  g.translate(cx, cy);
  g.rotate(rot);
  const size = h * across;
  g.font = `${st.italic === false ? '' : 'italic '}${st.weight ?? '900'} ${size}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if ('letterSpacing' in g) (g as unknown as { letterSpacing: string }).letterSpacing = `${(st.spacing ?? 0.04) * size}px`;
  const w = g.measureText(s).width;
  const sx = Math.min(1, (maxW * along) / Math.max(w, 1));
  g.scale(sx * (along / across), 1);
  if (st.badge !== undefined) {
    const bw = w + size * 0.7;
    const bh = size * 1.25;
    g.fillStyle = css(st.badge);
    g.beginPath();
    g.roundRect(-bw / 2, -bh / 2, bw, bh, bh * 0.22);
    g.fill();
  }
  g.fillStyle = css(st.ink);
  g.fillText(s, 0, size * 0.04);
  g.restore();
}

/** Thin racing stripe / chevron accents. */
function bar(g: CanvasRenderingContext2D, pl: Plane, a0: number, b0: number, a1: number, b1: number, color: number): void {
  const [x0, y0] = px(pl, a0, b0);
  const [x1, y1] = px(pl, a1, b1);
  g.fillStyle = css(color);
  g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
}

// Projection extents (model space).
const Z0 = -3.0;
const Z1 = 2.6;
const YH = 1.2;
const XW = 1.0;

interface Decals {
  side: THREE.CanvasTexture;
  top: THREE.CanvasTexture;
  rear: THREE.CanvasTexture;
}
const decalCache = new Map<string, Decals>();

/** Sponsor and team decals, drawn once per team. */
function decalsFor(l: Livery): Decals {
  const key = `${l.name}|${l.sponsors.join()}`;
  const hit = decalCache.get(key);
  if (hit) return hit;
  const [inkPod, inkBody, inkWing] = l.inks;

  // Sides: left half on top of the canvas, right half below (mirrored placement, readable text).
  const side = document.createElement('canvas');
  side.width = 2048;
  side.height = 1024;
  let g = side.getContext('2d')!;
  for (const [i, mirror] of [[0, false], [1, true]] as const) {
    const pl: Plane = { x: 0, y: i * 512, w: 2048, h: 512, a0: Z0, a1: Z1, b0: 0, b1: YH, mirror };
    // Sidepod: main sponsor, small sponsor below it, team name on the engine cover.
    text(g, pl, l.sponsors[0], -0.28, 0.47, 0.1, 0.8, { ink: inkPod });
    text(g, pl, l.sponsors[1], -0.2, 0.345, 0.045, 0.42, { ink: inkPod, spacing: 0.12 });
    text(g, pl, l.name, 0.62, 0.5, 0.06, 0.62, { ink: inkBody, weight: '800', spacing: 0.1 });
    // Nose and cockpit sides.
    text(g, pl, l.sponsors[1], -2.08, 0.4, 0.055, 0.5, { ink: inkBody });
    text(g, pl, l.sponsors[2], -1.12, 0.52, 0.04, 0.3, { ink: inkBody, spacing: 0.1 });
    // Front wing endplate: tyre maker; rear wing endplate: wing sponsor + small team name.
    text(g, pl, TYRE_BRAND, -2.58, 0.19, 0.075, 0.62, { ink: 0xffd200, badge: 0x111111 });
    text(g, pl, l.sponsors[2], 2.15, 0.7, 0.12, 0.46, { ink: inkWing });
    text(g, pl, l.name, 2.15, 0.56, 0.04, 0.4, { ink: inkWing, weight: '800', spacing: 0.12 });
    // Fine print: chassis plate and safety markers.
    text(g, pl, 'FIA 2026', 1.35, 0.42, 0.025, 0.2, { ink: inkBody, italic: false, weight: '700' });
    bar(g, pl, -0.98, 0.28, -0.9, 0.31, 0xffd200);
  }
  const sideTex = canvasTexture(side);

  // Top: x across, z down the canvas (front at the top), text reads from behind the car.
  const top = document.createElement('canvas');
  top.width = 512;
  top.height = 1536;
  g = top.getContext('2d')!;
  const tp: Plane = { x: 0, y: 0, w: 512, h: 1536, a0: -XW, a1: XW, b0: Z0, b1: Z1, down: true };
  // Front wing mainplane, both halves.
  for (const s of [-1, 1]) text(g, tp, s < 0 ? l.sponsors[2] : TYRE_BRAND, s * 0.5, -2.62, 0.09, 0.62, { ink: inkWing });
  // Nose top: sponsor read from the cockpit.
  text(g, tp, l.sponsors[1], 0, -2.42, 0.07, 0.17, { ink: inkBody, spacing: 0.02 });
  // Sidepod tops and engine cover.
  for (const s of [-1, 1]) text(g, tp, l.sponsors[0], s * 0.55, -0.35, 0.08, 0.42, { ink: inkPod });
  text(g, tp, l.name, 0, 0.9, 0.05, 0.36, { ink: inkBody, weight: '800', rotate: -Math.PI / 2, spacing: 0.1 });
  // Rear wing: big sponsor read from the chase camera.
  text(g, tp, l.sponsors[2], 0, 2.2, 0.15, 0.95, { ink: inkWing });
  const topTex = canvasTexture(top);

  // Rear (looking forward from behind): +x to the right.
  const rear = document.createElement('canvas');
  rear.width = 1024;
  rear.height = 512;
  g = rear.getContext('2d')!;
  const rp: Plane = { x: 0, y: 0, w: 1024, h: 512, a0: -XW, a1: XW, b0: 0, b1: YH };
  text(g, rp, l.sponsors[2], 0, 0.8, 0.085, 0.95, { ink: inkWing });
  text(g, rp, l.name, 0, 0.57, 0.04, 0.5, { ink: inkWing, weight: '800', spacing: 0.12 });
  const rearTex = canvasTexture(rear);

  const d = { side: sideTex, top: topTex, rear: rearTex };
  decalCache.set(key, d);
  return d;
}

/** Race number in the team's number style: white with a dark outline, transparent background. */
/**
 * Race number decal: solid digits in a colour that contrasts with the paint
 * under them (dark on light cars, white on dark ones) with a thin keyline,
 * drawn large so it stays crisp on the sloped nose seen from the cockpit.
 */
export function numberTexture(n: number, paint = 0x000000): THREE.Texture {
  const c = new THREE.Color(paint);
  const light = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.45;
  const fill = light ? '#111111' : '#ffffff';
  const keyline = light ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.85)';
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const g = canvas.getContext('2d')!;
  g.font = `italic 900 220px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 10;
  g.strokeStyle = keyline;
  g.strokeText(String(n), 256, 136);
  g.fillStyle = fill;
  g.fillText(String(n), 256, 136);
  return canvasTexture(canvas, 16);
}

// ---- Shaders -------------------------------------------------------------------------------

/**
 * Wraps a material's onBeforeCompile so its final colour can never be NaN or
 * absurdly bright: post-processing (half-float buffers + bloom) would smear a
 * single bad pixel into a white blotch on the car.
 */
function guardOutput(material: THREE.Material): void {
  const inner = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    inner.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
      if (any(isnan(gl_FragColor)) || any(isinf(gl_FragColor))) gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor.rgb = clamp(gl_FragColor.rgb, vec3(0.0), vec3(32.0));
`,
    );
  };
}

/** 2x2 twill carbon weave in model space; returns 0..1 (0.5 where it would alias). */
export const WEAVE_GLSL = /* glsl */ `
float lvWeave(vec3 p, vec3 n) {
  vec3 an = abs(n);
  vec2 q = an.x > an.y && an.x > an.z ? p.zy : (an.y > an.z ? p.xz : p.xy);
  q *= 190.0;
  vec2 fw = fwidth(q);
  float fade = 1.0 - smoothstep(0.25, 0.7, max(fw.x, fw.y));
  vec2 c = floor(q);
  vec2 f = fract(q);
  float dir = step(2.0, mod(c.x + c.y, 4.0));
  float fibre = 0.55 + 0.45 * sin(3.14159 * (dir > 0.5 ? f.y : f.x));
  float v = mix(0.25, 0.85, dir) * fibre;
  return mix(0.45, v, fade);
}`;

export interface LiveryMaterialOptions {
  /** 0 = bodywork (livery regions), 1 = carbon parts (floor, suspension, halo; mirrors painted). */
  slot: 0 | 1;
  number: THREE.Texture | null;
}

/** Livery + carbon shader for the body's "paint"/"accent" and "carbon" slots. */
export function liveryMaterial(livery: Livery, opts: LiveryMaterialOptions): THREE.MeshPhysicalMaterial {
  const matte = !!livery.matte;
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: livery.metal ?? 0.05,
    roughness: matte ? 0.62 : 0.32,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
  });
  const decals = decalsFor(livery);
  const lower = livery.lower;
  const uniforms = {
    lvP: { value: new THREE.Color(livery.primary) },
    lvS: { value: new THREE.Color(livery.secondary) },
    lvA: { value: new THREE.Color(livery.accent) },
    lvLower: { value: new THREE.Vector4(lower.a, lower.b ?? 0, lower.c ?? 0, lower.mode === 'none' ? 0 : lower.mode === 'secondary' ? 1 : 2) },
    lvPin: { value: lower.pin ? 1 : 0 },
    lvFade: { value: new THREE.Vector3(livery.fade?.[0] ?? 0, livery.fade?.[1] ?? 1, livery.fade ? 1 : 0) },
    lvBand: { value: new THREE.Vector4(livery.band?.[0] ?? 0, livery.band?.[1] ?? 0, livery.band?.[2] ?? 0, livery.band ? 1 : 0) },
    lvBandCol: { value: new THREE.Color(livery.band?.[3] ?? 0) },
    lvSpine: { value: new THREE.Vector2(livery.spine?.[0] ?? 0, livery.spine ? 1 : 0) },
    lvSpineCol: { value: new THREE.Color(livery.spine?.[1] ?? 0) },
    lvNose: { value: new THREE.Color(livery.noseTip) },
    lvFlap: { value: new THREE.Color(livery.flap) },
    lvEnd: { value: new THREE.Color(livery.endplate) },
    lvCarbon: { value: new THREE.Color(0x15171b) },
    lvMatte: { value: matte ? 1 : 0 },
    lvSlot: { value: opts.slot },
    lvSide: { value: decals.side },
    lvTop: { value: decals.top },
    lvRear: { value: decals.rear },
    lvNumber: { value: opts.number },
    lvHasNumber: { value: opts.number ? 1 : 0 },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLivPos;\nvarying vec3 vLivNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLivPos = position;\nvLivNormal = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vLivPos;
        varying vec3 vLivNormal;
        uniform vec3 lvP, lvS, lvA, lvBandCol, lvSpineCol, lvNose, lvFlap, lvEnd, lvCarbon;
        uniform vec4 lvLower, lvBand;
        uniform vec3 lvFade;
        uniform vec2 lvSpine;
        uniform int lvPin, lvSlot, lvHasNumber;
        uniform float lvMatte;
        uniform sampler2D lvSide, lvTop, lvRear, lvNumber;
        ${WEAVE_GLSL}
        float lvIn(float v, float a, float b, float e) { return smoothstep(a - e, a + e, v) * (1.0 - smoothstep(b - e, b + e, v)); }
        float lvRect(vec2 uv) { return step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0); }
        vec4 lvOver(vec4 dst, vec4 src) { return vec4(dst.rgb * (1.0 - src.a) + src.rgb, max(dst.a, src.a)); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 p = vLivPos;
        // Degenerate triangles in the source model carry zero normals: keep them finite.
        vec3 n = normalize(vLivNormal + vec3(0.0, 1e-4, 0.0));
        float ax = abs(p.x);
        vec3 col = lvP;
        float carbon = 0.0;
        if (lvSlot == 0) {
          if (lvFade.z > 0.5) col = mix(col, lvS, smoothstep(lvFade.x, lvFade.y, p.z));
          if (lvBand.w > 0.5) col = mix(col, lvBandCol, lvIn(p.z, lvBand.x, lvBand.y, 0.012) * smoothstep(lvBand.z - 0.01, lvBand.z + 0.01, p.y) * step(0.12, ax));
          if (lvSpine.y > 0.5) col = mix(col, lvSpineCol, (1.0 - smoothstep(lvSpine.x - 0.004, lvSpine.x + 0.004, ax)) * step(0.4, n.y) * step(-2.4, p.z) * step(p.z, 1.7));
          // Lower body from the sidepods back (curved split line, optional pinstripe above it).
          float ly = lvLower.x + lvLower.y * p.z + lvLower.z * p.z * p.z;
          float body = smoothstep(-1.35, -1.05, p.z) * step(0.16, ax);
          float low = (1.0 - smoothstep(ly - 0.005, ly + 0.005, p.y)) * body;
          if (lvLower.w > 1.5) carbon = low;
          else if (lvLower.w > 0.5) col = mix(col, lvS, low);
          if (lvPin == 1) col = mix(col, lvA, lvIn(p.y, ly + 0.014, ly + 0.026, 0.003) * body * (1.0 - carbon));
          // Nose: tip colour, carbon underside.
          col = mix(col, lvNose, 1.0 - smoothstep(-2.66, -2.62, p.z));
          carbon = max(carbon, step(p.z, -1.2) * step(n.y, -0.55) * step(ax, 0.22));
          // Front wing: carbon elements, coloured upper flaps and endplates.
          if (p.z < -2.0 && p.y < 0.5 && ax > 0.15) {
            float flap = smoothstep(0.215, 0.235, p.y);
            float endp = smoothstep(0.84, 0.86, ax);
            carbon = 1.0 - max(flap, endp);
            col = mix(lvFlap, lvEnd, endp);
            col = mix(col, lvA, lvIn(p.y, 0.24, 0.252, 0.002) * (1.0 - endp));
          }
          // Rear wing: carbon planes, coloured top flap and endplates.
          if (p.z > 1.82 && p.y > 0.45) {
            float endp = smoothstep(0.5, 0.52, ax);
            float flap = smoothstep(0.76, 0.78, p.y) * (1.0 - endp);
            carbon = 1.0 - max(flap, endp);
            col = mix(lvFlap, lvEnd, endp);
            col = mix(col, lvA, lvIn(p.y, 0.86, 0.9, 0.003) * endp);
          }
        } else {
          // Carbon parts; painted mirror housings and halo top.
          carbon = 1.0;
          float mirror = step(0.45, ax) * step(0.62, p.y) * lvIn(p.z, -0.95, -0.4, 0.01);
          float halo = step(ax, 0.42) * step(0.79, p.y) * lvIn(p.z, -1.0, -0.1, 0.01) * step(0.3, n.y);
          float painted = max(mirror, halo);
          carbon -= painted;
          col = lvP;
        }
        // Decals (premultiplied), blended by the normal.
        vec3 w = pow(abs(n), vec3(4.0));
        w /= max(w.x + w.y + w.z, 1e-4);
        vec4 dec = vec4(0.0);
        vec2 uvS = vec2((p.z - ${Z0.toFixed(2)}) / ${(Z1 - Z0).toFixed(2)}, p.y / ${YH.toFixed(2)} * 0.5);
        if (n.x < 0.0) uvS.y += 0.5; else uvS.x = 1.0 - uvS.x;
        dec += texture2D(lvSide, uvS) * w.x;
        dec += texture2D(lvTop, vec2((p.x + ${XW.toFixed(2)}) / ${(2 * XW).toFixed(2)}, 1.0 - (p.z - ${Z0.toFixed(2)}) / ${(Z1 - Z0).toFixed(2)})) * w.y * step(0.0, n.y);
        if (n.z > 0.0 && p.z > 1.8) dec += texture2D(lvRear, vec2((p.x + ${XW.toFixed(2)}) / ${(2 * XW).toFixed(2)}, p.y / ${YH.toFixed(2)})) * w.z;
        if (lvHasNumber == 1 && lvSlot == 0) {
          // Engine-cover flanks, readable from either side.
          vec2 uvN = vec2((p.z - 0.36) / 0.52, (p.y - 0.64) / 0.25);
          if (n.x > 0.0) uvN.x = 1.0 - uvN.x;
          dec = lvOver(dec, texture2D(lvNumber, uvN) * lvRect(uvN) * smoothstep(0.5, 0.7, abs(n.x)));
          // Nose top, readable from the front.
          vec2 uvF = vec2((0.11 - p.x) / 0.22, (p.z + 2.24) / 0.13);
          dec = lvOver(dec, texture2D(lvNumber, uvF) * lvRect(uvF) * smoothstep(0.5, 0.7, n.y));
        }
        // Weave on bare carbon.
        float weave = lvWeave(p, n);
        vec3 cf = lvCarbon * (0.55 + 0.9 * weave);
        col = mix(col, cf, carbon);
        col = col * (1.0 - dec.a) + dec.rgb;
        carbon *= 1.0 - dec.a;
        diffuseColor.rgb *= col;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.3 + 0.25 * weave, carbon);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.0, max(carbon, dec.a));`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
        material.clearcoat = mix(1.0 - lvMatte, 1.0, carbon);
        material.clearcoatRoughness = mix(0.06, 0.12, carbon);
        #endif`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        // The sky-only HDRI has a bright lower half: surfaces facing the ground or tucked
        // under the bodywork must not mirror it (cheap stand-in for ground occlusion).
        float lvAO = mix(1.0, 0.1, smoothstep(0.3, -0.4, n.y)) * mix(0.25, 1.0, smoothstep(0.1, 0.5, p.y));
        reflectedLight.indirectDiffuse *= mix(0.4, 1.0, lvAO);
        reflectedLight.indirectSpecular *= lvAO;
        // Same for the sun: a mirror-smooth floor glinting it turns into white blotches.
        reflectedLight.directSpecular *= lvAO;
        #ifdef USE_CLEARCOAT
        clearcoatSpecularIndirect *= lvAO;
        clearcoatSpecularDirect *= lvAO;
        #endif`,
      );
  };
  guardOutput(material);
  material.customProgramCacheKey = () => 'f1-livery-v3';
  return material;
}

/**
 * Tyre: compound band and maker name on the sidewall (both in the compound
 * colour, like the real thing), worn grey tread, rougher than the sidewall.
 * Wheel space: x = axle, radius in y/z.
 */
export function tyreMaterial(band: { value: THREE.Color }): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82 });
  const uniforms = { bandColor: band, tyreText: { value: sidewallTexture() } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTyrePos;\nvarying vec3 vTyreN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTyrePos = position;\nvTyreN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTyrePos;\nvarying vec3 vTyreN;\nuniform vec3 bandColor;\nuniform sampler2D tyreText;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float r = length(vTyrePos.yz);
        float sidewall = smoothstep(0.55, 0.75, abs(normalize(vTyreN).x));
        vec3 rubber = mix(vec3(0.034), vec3(0.016), sidewall);
        float ring = smoothstep(0.287, 0.291, r) * (1.0 - smoothstep(0.303, 0.307, r)) * sidewall;
        float ang = atan(vTyrePos.z, vTyrePos.y) / 6.28318 + 0.5;
        if (vTyrePos.x < 0.0) ang = 1.0 - ang;
        float tv = (r - 0.31) / 0.034;
        float txt = texture2D(tyreText, vec2(ang * 2.0, clamp(tv, 0.0, 1.0))).a * step(0.0, tv) * step(tv, 1.0) * sidewall;
        diffuseColor.rgb = mix(rubber, bandColor, max(ring, txt));
        float tread = 1.0 - sidewall;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.62, 0.92, tread);`,
      );
  };
  guardOutput(material);
  material.customProgramCacheKey = () => 'f1-tyre-v3';
  return material;
}

let sidewall: THREE.CanvasTexture | null = null;
function sidewallTexture(): THREE.CanvasTexture {
  if (sidewall) return sidewall;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 64;
  const g = canvas.getContext('2d')!;
  g.font = `italic 900 50px ${FONT}`;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillStyle = '#fff';
  // Text runs around the wheel; the canvas is stretched twice around (ang * 2).
  g.save();
  g.translate(300, 32);
  g.scale(1, -1);
  g.fillText(TYRE_BRAND, 0, 0);
  g.restore();
  g.save();
  g.translate(760, 32);
  g.scale(1, -1);
  g.font = `700 30px ${FONT}`;
  g.fillText('RACE · 2026', 0, 0);
  g.restore();
  sidewall = canvasTexture(canvas, 4);
  sidewall.wrapS = THREE.RepeatWrapping;
  return sidewall;
}

/**
 * Wheel rim with a 2026-style wheel cover: satin carbon disc with a coloured
 * ring and printed spokes, machined outer lip, coloured wheel nut.
 */
export function rimMaterial(ringColor: number): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.6, roughness: 0.4 });
  // rimGlow: hot brakes seen through the gap between wheel cover and rim lip (set per frame by the car).
  const uniforms = { rimRing: { value: new THREE.Color(ringColor) }, rimGlow: { value: new THREE.Color(0, 0, 0) } };
  material.userData.rimGlow = uniforms.rimGlow;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRimPos;\nvarying vec3 vRimN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRimPos = position;\nvRimN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRimPos;\nvarying vec3 vRimN;\nuniform vec3 rimRing;\nuniform vec3 rimGlow;\n${WEAVE_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float r = length(vRimPos.yz);
        float face = smoothstep(0.6, 0.8, abs(normalize(vRimN).x));
        float ang = atan(vRimPos.z, vRimPos.y);
        float lip = smoothstep(0.236, 0.242, r);
        float nut = 1.0 - smoothstep(0.034, 0.038, r);
        float ring = smoothstep(0.19, 0.194, r) * (1.0 - smoothstep(0.206, 0.21, r));
        float spoke = smoothstep(0.75, 0.82, cos(ang * 5.0)) * smoothstep(0.05, 0.06, r) * (1.0 - smoothstep(0.18, 0.19, r));
        float wv = lvWeave(vRimPos, vec3(1.0, 0.0, 0.0));
        vec3 disc = vec3(0.018) * (0.6 + 0.8 * wv);
        disc = mix(disc, vec3(0.06), spoke * 0.6);
        vec3 c = mix(disc, rimRing, max(ring, nut));
        c = mix(vec3(0.03), c, face);
        c = mix(c, vec3(0.42, 0.43, 0.45), lip);
        diffuseColor.rgb = c;
        float rimMetal = max(lip, nut);
        float rimRough = mix(0.45, 0.28, rimMetal);
        // Brake glow: the open annulus between cover and lip, and faintly between the spokes.
        float glowGap = smoothstep(0.212, 0.218, r) * (1.0 - smoothstep(0.232, 0.238, r));
        float glowMask = (glowGap + 0.25 * (1.0 - spoke) * smoothstep(0.06, 0.08, r) * (1.0 - smoothstep(0.17, 0.19, r))) * face;`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rimGlow * glowMask;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = rimRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(0.1, 0.95, rimMetal);');
  };
  guardOutput(material);
  material.customProgramCacheKey = () => 'f1-rim-v4';
  return material;
}

/** Helmet paint (sphere UVs: u around, v from bottom to top): base, stripes, crown, number. */
export function helmetTexture(livery: Livery, number: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const g = canvas.getContext('2d')!;
  g.fillStyle = css(livery.helmet);
  g.fillRect(0, 0, 512, 256);
  // Crown (top of the sphere = top rows).
  g.fillStyle = css(livery.helmetTop);
  g.fillRect(0, 0, 512, 52);
  // Swooping side stripes (repeat around).
  g.fillStyle = css(livery.helmetStripe);
  for (let x = 0; x < 512; x += 2) {
    const y = 96 + 26 * Math.sin((x / 512) * Math.PI * 4);
    g.fillRect(x, y, 2, 18);
    g.fillRect(x, y + 26, 2, 6);
  }
  g.fillStyle = css(livery.accent);
  g.fillRect(0, 52, 512, 6);
  // Driver number on both sides (u = 0 / 0.5) and the back (u = 0.25); the visor is at u = 0.75.
  g.font = `italic 900 46px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = '#000';
  g.fillStyle = '#fff';
  for (const x of [0, 128, 256, 512]) {
    g.strokeText(String(number), x, 186);
    g.fillText(String(number), x, 186);
  }
  const tex = canvasTexture(canvas, 4);
  tex.premultiplyAlpha = false;
  return tex;
}
