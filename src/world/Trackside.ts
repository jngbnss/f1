import * as THREE from 'three';

/**
 * What makes a real circuit read as a race track on TV: sponsor banners on
 * the debris fence, big billboards, ad bridges over the straights, Tecpro
 * crash barriers in the run-offs, braking distance boards and marshal posts.
 *
 * Everything is merged into a handful of meshes (one per material). The
 * sponsor names are invented; no real brands or logos. Needs a canvas, so it
 * is skipped in Node (tests).
 */
export interface TracksideContext {
  points: readonly THREE.Vector3[];
  tangents: readonly THREE.Vector3[];
  rights: readonly THREE.Vector3[];
  curvature: Float32Array;
  /** Per sample: +1/-1 = gravel trap on that side, 0 = none. */
  gravelSide: Int8Array;
  half: number;
  sampleSpacing: number;
  /** Lateral offset of the guardrail on `side` at sample i (pit lane aware). */
  barrierAt(side: number, i: number): number;
  /** Distance from (x, z) to the nearest centerline sample. */
  clearance(x: number, z: number): number;
  /** Nothing goes on this side at sample i (e.g. the pit building stands there). */
  blocked(side: number, i: number): boolean;
  /** Start gantry beam over sample 0 (half span, centre height, beam height and depth). */
  startGantry?: { halfSpan: number; y: number; height: number; depth: number };
}

interface Brand {
  name: string;
  tag: string;
  bg: string;
  fg: string;
  accent: string;
  italic?: boolean;
}

const BRANDS: Brand[] = [
  { name: 'VELOCE', tag: 'ENERGY', bg: '#c8102e', fg: '#ffffff', accent: '#ffd200', italic: true },
  { name: 'ORBITA', tag: 'TELECOM', bg: '#0b1f4a', fg: '#ffffff', accent: '#2ec4ff' },
  { name: 'NOVAX', tag: 'LUBRICANTS', bg: '#ffd200', fg: '#111111', accent: '#d0021b', italic: true },
  { name: 'KAIROS', tag: 'WATCHES', bg: '#0f4d2e', fg: '#f3e6b3', accent: '#f3e6b3' },
  { name: 'STRATA', tag: 'CLOUD', bg: '#ffffff', fg: '#1a1a1a', accent: '#6a2cff' },
  { name: 'LUMEN', tag: 'TYRES', bg: '#111111', fg: '#ffd200', accent: '#ffd200', italic: true },
  { name: 'AURELIA', tag: 'AIRWAYS', bg: '#7a0019', fg: '#ffffff', accent: '#d9b25f' },
  { name: 'TERRANO', tag: 'LOGISTICS', bg: '#ff6a00', fg: '#ffffff', accent: '#111111', italic: true },
];

/** One atlas row per brand; `aspect` = width / height of a cell. */
function brandAtlas(aspect: number, cellW = 1024): { texture: THREE.CanvasTexture; rows: number } {
  const cellH = Math.round(cellW / aspect);
  const canvas = document.createElement('canvas');
  canvas.width = cellW;
  canvas.height = cellH * BRANDS.length;
  const g = canvas.getContext('2d')!;
  BRANDS.forEach((b, row) => {
    const y = row * cellH;
    g.fillStyle = b.bg;
    g.fillRect(0, y, cellW, cellH);
    // Accent: slanted stripe at the left, thin rule at the bottom.
    g.fillStyle = b.accent;
    g.beginPath();
    g.moveTo(cellH * 0.25, y + cellH);
    g.lineTo(cellH * 0.55, y);
    g.lineTo(cellH * 0.8, y);
    g.lineTo(cellH * 0.5, y + cellH);
    g.fill();
    g.fillRect(0, y + cellH * 0.9, cellW, cellH * 0.1);
    g.fillStyle = b.fg;
    g.textBaseline = 'middle';
    const big = Math.round(cellH * 0.62);
    g.font = `${b.italic ? 'italic ' : ''}900 ${big}px "Arial Black", Arial, sans-serif`;
    const nameW = g.measureText(b.name).width;
    const small = Math.round(cellH * 0.22);
    g.font = `700 ${small}px Arial, sans-serif`;
    const tagW = g.measureText(b.tag).width;
    const total = nameW + small * 0.6 + tagW;
    const x0 = Math.max(cellH * 0.95, (cellW - total) / 2);
    g.font = `${b.italic ? 'italic ' : ''}900 ${big}px "Arial Black", Arial, sans-serif`;
    g.fillText(b.name, x0, y + cellH * 0.47);
    g.font = `700 ${small}px Arial, sans-serif`;
    g.fillText(b.tag, x0 + nameW + small * 0.6, y + cellH * 0.55);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { texture, rows: BRANDS.length };
}

/** Square white boards with the braking distance in black (300 / 200 / 100). */
function distanceAtlas(): THREE.CanvasTexture {
  const s = 256;
  const canvas = document.createElement('canvas');
  canvas.width = s * 3;
  canvas.height = s;
  const g = canvas.getContext('2d')!;
  ['300', '200', '100'].forEach((label, k) => {
    const x = k * s;
    g.fillStyle = '#f4f4f4';
    g.fillRect(x, 0, s, s);
    g.strokeStyle = '#111';
    g.lineWidth = 14;
    g.strokeRect(x + 10, 10, s - 20, s - 20);
    g.fillStyle = '#111';
    g.font = '900 120px "Arial Black", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, x + s / 2, s / 2 + 6);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Growable non-indexed triangle soup (position, normal, uv, color). */
class Soup {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];

  /** Quad a-b-c-d (counter-clockwise seen from the front) with per-corner uv. */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uv: number[], color = WHITE): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
    const corners = [a, b, c, a, c, d];
    const uvIdx = [0, 1, 2, 0, 2, 3];
    corners.forEach((p, k) => {
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(uv[uvIdx[k] * 2], uv[uvIdx[k] * 2 + 1]);
      this.col.push(color.r, color.g, color.b);
    });
  }

  /** Axis-aligned box in a local frame (origin, x = right, z = forward), all faces. */
  box(o: THREE.Vector3, x: THREE.Vector3, z: THREE.Vector3, w: number, h: number, d: number, y0: number, color = WHITE): void {
    const up = new THREE.Vector3(0, 1, 0);
    const corner = (sx: number, sy: number, sz: number) =>
      o.clone()
        .addScaledVector(x, (sx * w) / 2)
        .addScaledVector(z, (sz * d) / 2)
        .addScaledVector(up, y0 + sy * h);
    const uv = [0, 0, 1, 0, 1, 1, 0, 1];
    const v = (a: number[]) => corner(a[0], a[1], a[2]);
    const faces = [
      [[1, 0, -1], [1, 0, 1], [1, 1, 1], [1, 1, -1]],
      [[-1, 0, 1], [-1, 0, -1], [-1, 1, -1], [-1, 1, 1]],
      [[-1, 0, -1], [1, 0, -1], [1, 1, -1], [-1, 1, -1]],
      [[1, 0, 1], [-1, 0, 1], [-1, 1, 1], [1, 1, 1]],
      [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]],
    ];
    // Winding depends on the handedness of (x, up, z): flip when needed so normals point out.
    const flip = new THREE.Vector3().crossVectors(x, up).dot(z) > 0;
    for (const f of faces) {
      const q = f.map(v);
      if (flip) this.quad(q[3], q[2], q[1], q[0], uv, color);
      else this.quad(q[0], q[1], q[2], q[3], uv, color);
    }
  }

  build(): THREE.BufferGeometry | null {
    if (!this.pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.computeBoundingSphere();
    return geo;
  }
}
const WHITE = new THREE.Color(1, 1, 1);

export function buildTrackside(ctx: TracksideContext): { group: THREE.Group; disposables: { dispose(): void }[] } {
  const group = new THREE.Group();
  group.name = 'Trackside';
  const disposables: { dispose(): void }[] = [];
  if (typeof document === 'undefined') return { group, disposables };

  const { points, tangents, rights, curvature, gravelSide, half, sampleSpacing: ds } = ctx;
  const n = points.length;
  const at = (i: number) => (i + n) % n;
  const absCurv = (i: number) => Math.abs(curvature[at(i)]);
  const up = new THREE.Vector3(0, 1, 0);
  const rand = mulberry32(4242);

  const banners = new Soup();
  const billboards = new Soup();
  const steel = new Soup();
  const tecpro = new Soup();
  const boards = new Soup();
  const huts = new Soup();

  // --- sponsor banners on the debris fence along every (mostly) straight run ---
  const bannerSamples = Math.max(2, Math.round(7.5 / ds));
  const rowsV = (row: number, rows: number) => [1 - (row + 1) / rows, 1 - row / rows];
  for (const side of [-1, 1]) {
    let brand = side === 1 ? 0 : 3;
    for (let i = 0; i < n; i += bannerSamples) {
      if (absCurv(i) > 1 / 350) continue;
      brand = (brand + 1 + (rand() < 0.3 ? 1 : 0)) % BRANDS.length;
      const [v0, v1] = rowsV(brand, BRANDS.length);
      for (let k = 0; k < bannerSamples; k++) {
        const a = at(i + k);
        const b = at(i + k + 1);
        if (ctx.blocked(side, a)) continue;
        const offA = ctx.barrierAt(side, a) + 0.08;
        const offB = ctx.barrierAt(side, b) + 0.08;
        const pa = points[a].clone().addScaledVector(rights[a], side * offA);
        const pb = points[b].clone().addScaledVector(rights[b], side * offB);
        const mid = pa.clone().add(pb).multiplyScalar(0.5);
        if (ctx.clearance(mid.x, mid.z) < Math.min(offA, offB) - 1.5) continue;
        const u0 = k / bannerSamples;
        const u1 = (k + 1) / bannerSamples;
        const y0 = 1.12;
        const y1 = 2.2;
        const lo = [pa.clone().setY(y0), pb.clone().setY(y0), pb.clone().setY(y1), pa.clone().setY(y1)];
        // Text must read left to right from the track: along +t on the left side, along -t on the right.
        if (side === -1) banners.quad(lo[0], lo[1], lo[2], lo[3], [u0, v0, u1, v0, u1, v1, u0, v1]);
        else banners.quad(lo[1], lo[0], lo[3], lo[2], [1 - u1, v0, 1 - u0, v0, 1 - u0, v1, 1 - u1, v1]);
      }
    }
  }

  // --- big billboards on posts behind the fence, and ad bridges over long straights ---
  const straightRun = (i: number, meters: number) => {
    const k = Math.round(meters / ds);
    for (let j = -k; j <= k; j++) if (absCurv(i + j) > 1 / 500) return false;
    return true;
  };
  const steelColor = new THREE.Color(0x5b6168);
  const bbStep = Math.round(140 / ds);
  for (let i = 0; i < n; i += bbStep) {
    if (!straightRun(i, 12)) continue;
    const side = rand() < 0.5 ? -1 : 1;
    if (ctx.blocked(side, i)) continue;
    const off = ctx.barrierAt(side, i) + 7;
    const r = rights[i].clone().multiplyScalar(side);
    const c = points[i].clone().addScaledVector(r, off);
    if (ctx.clearance(c.x, c.z) < off - 1) continue;
    const t = tangents[i];
    const w = 14;
    const h = 3.5;
    const y0 = 2.6;
    // Face towards oncoming cars and the track: normal = -(t + r) mix.
    const face = t.clone().multiplyScalar(-0.55).addScaledVector(r, -1).normalize();
    const along = new THREE.Vector3().crossVectors(up, face).normalize(); // left -> right seen from the front
    const brand = Math.floor(rand() * BRANDS.length);
    const [v0, v1] = rowsV(brand, BRANDS.length);
    const p = (s: number, y: number) => c.clone().addScaledVector(along, s * w * 0.5).setY(y);
    billboards.quad(p(-1, y0), p(1, y0), p(1, y0 + h), p(-1, y0 + h), [0, v0, 1, v0, 1, v1, 0, v1]);
    // Back panel and two legs.
    const back = c.clone().addScaledVector(face, -0.12);
    steel.box(back, along, face, w + 0.3, h + 0.3, 0.2, y0 - 0.15, steelColor);
    for (const s of [-0.35, 0.35]) steel.box(back.clone().addScaledVector(along, s * w), along, face, 0.3, y0, 0.3, 0, steelColor);
  }

  const bridges: number[] = [];
  for (let i = 0; i < n && bridges.length < 4; i += Math.round(20 / ds)) {
    if (i < Math.round(250 / ds) || i > n - Math.round(120 / ds)) continue; // keep clear of the start gantry
    if (!straightRun(i, 70)) continue;
    if (bridges.some((b) => Math.abs(b - i) < Math.round(700 / ds))) continue;
    if (ctx.blocked(-1, i) || ctx.blocked(1, i)) continue;
    const span = Math.max(ctx.barrierAt(-1, i), ctx.barrierAt(1, i)) + 2.5;
    const ok = [-1, 1].every((s) => {
      const q = points[i].clone().addScaledVector(rights[i], s * span);
      return ctx.clearance(q.x, q.z) >= span - 0.5;
    });
    if (!ok) continue;
    bridges.push(i);
    const t = tangents[i];
    const r = rights[i];
    const c = points[i];
    const deckY = 6.4;
    const deckH = 2.4;
    for (const s of [-1, 1]) steel.box(c.clone().addScaledVector(r, s * span), r, t, 1.2, deckY, 1.6, 0, steelColor);
    steel.box(c, r, t, span * 2 + 1.2, deckH, 1.4, deckY, steelColor);
    // Banners on both faces: three brands across the span.
    for (const face of [-1, 1]) {
      const fc = c.clone().addScaledVector(t, face * 0.72);
      const segs = 3;
      for (let k = 0; k < segs; k++) {
        const brand = (bridges.length * 3 + k + (face > 0 ? 1 : 0)) % BRANDS.length;
        const [v0, v1] = rowsV(brand, BRANDS.length);
        const s0 = -span + (2 * span * k) / segs;
        const s1 = -span + (2 * span * (k + 1)) / segs;
        const a = fc.clone().addScaledVector(r, s0);
        const b = fc.clone().addScaledVector(r, s1);
        const y0 = deckY + 0.15;
        const y1 = deckY + deckH - 0.15;
        // face = -1 looks at oncoming cars (normal = -t): left->right is +r.
        if (face < 0) billboards.quad(a.clone().setY(y0), b.clone().setY(y0), b.clone().setY(y1), a.clone().setY(y1), [0, v0, 1, v0, 1, v1, 0, v1]);
        else billboards.quad(b.clone().setY(y0), a.clone().setY(y0), a.clone().setY(y1), b.clone().setY(y1), [0, v0, 1, v0, 1, v1, 0, v1]);
      }
    }
  }

  // --- start gantry: sponsor panels either side of the start lights (gantry built by the track) ---
  if (ctx.startGantry) {
    const { halfSpan, y, height, depth } = ctx.startGantry;
    const t = tangents[0];
    const r = rights[0];
    const fc = points[0].clone().addScaledVector(t, -depth / 2 - 0.02);
    for (const [s0, s1, brand] of [
      [-halfSpan, -2.6, 0],
      [2.6, halfSpan, 6],
    ] as const) {
      const [v0, v1] = rowsV(brand, BRANDS.length);
      const a = fc.clone().addScaledVector(r, s0);
      const b = fc.clone().addScaledVector(r, s1);
      const y0 = y - height / 2 + 0.1;
      const y1 = y + height / 2 - 0.1;
      billboards.quad(a.clone().setY(y0), b.clone().setY(y0), b.clone().setY(y1), a.clone().setY(y1), [0, v0, 1, v0, 1, v1, 0, v1]);
    }
  }

  // --- Tecpro blocks in front of the rails along gravel traps (alternating colours) ---
  const tpColors = [new THREE.Color(0xd21f26), new THREE.Color(0xf2f2f2), new THREE.Color(0x1d4fb8), new THREE.Color(0xf2f2f2)];
  const blockLen = 1.5;
  for (const side of [-1, 1]) {
    let k = 0;
    let carry = 0;
    for (let i = 0; i < n; i++) {
      if (gravelSide[i] !== side || ctx.blocked(side, i)) continue;
      const j = at(i + 1);
      const offI = ctx.barrierAt(side, i) - 0.32;
      const a = points[i].clone().addScaledVector(rights[i], side * offI);
      const b = points[j].clone().addScaledVector(rights[j], side * offI);
      if (ctx.clearance(a.x, a.z) < offI - 1.5) continue;
      const seg = a.distanceTo(b);
      const dir = b.clone().sub(a).normalize();
      const x = new THREE.Vector3().crossVectors(dir, up).normalize();
      for (let s = carry; s < seg; s += blockLen) {
        const center = a.clone().addScaledVector(dir, s + blockLen / 2);
        tecpro.box(center, x, dir, 0.6, 1.0, blockLen - 0.06, 0, tpColors[k++ % tpColors.length]);
        carry = s + blockLen - seg;
      }
    }
  }

  // --- braking distance boards (300 / 200 / 100 m) before every big stop ---
  const boardGap = Math.round(250 / ds);
  for (let i = 0; i < n; i++) {
    if (absCurv(i) < 1 / 120 || absCurv(i - 1) >= 1 / 120) continue;
    let straight = true;
    for (let j = 1; j <= boardGap; j++) if (absCurv(i - Math.round(60 / ds) - j) > 1 / 400) straight = false;
    if (!straight) continue;
    const side = curvature[at(i)] > 0 ? 1 : -1; // outside of the coming corner
    [300, 200, 100].forEach((d, k) => {
      const idx = at(i - Math.round(d / ds));
      const off = Math.min(ctx.barrierAt(side, idx) - 1.2, half + 4);
      const c = points[idx].clone().addScaledVector(rights[idx], side * off);
      const t = tangents[idx];
      const face = t.clone().negate();
      const along = new THREE.Vector3().crossVectors(up, face).normalize();
      const sz = 1.1;
      const y0 = 0.6;
      const p = (s: number, y: number) => c.clone().addScaledVector(along, s * sz * 0.5).setY(y);
      boards.quad(p(-1, y0), p(1, y0), p(1, y0 + sz), p(-1, y0 + sz), [k / 3, 0, (k + 1) / 3, 0, (k + 1) / 3, 1, k / 3, 1]);
      steel.box(c.clone().addScaledVector(face, -0.06), along, face, 0.1, y0, 0.1, 0, steelColor);
    });
  }

  // --- marshal posts: small white huts with an orange band behind the fence ---
  const hutStep = Math.round(330 / ds);
  const white = new THREE.Color(0xeeeeea);
  const orange = new THREE.Color(0xff7a00);
  for (let i = Math.round(90 / ds); i < n; i += hutStep) {
    const side = (i / hutStep) % 2 < 1 ? 1 : -1;
    if (ctx.blocked(side, i)) continue;
    const off = ctx.barrierAt(side, i) + 3.2;
    const c = points[i].clone().addScaledVector(rights[i], side * off);
    if (ctx.clearance(c.x, c.z) < off - 1) continue;
    const t = tangents[i];
    const x = rights[i];
    huts.box(c, x, t, 2.2, 2.3, 2.2, 0, white);
    huts.box(c, x, t, 2.3, 0.35, 2.3, 2.3, orange);
    huts.box(c, x, t, 2.6, 0.12, 2.6, 2.65, new THREE.Color(0x4a4f55));
  }

  // --- TV camera towers: scaffold towers on the outside of every big corner ---
  const scaffold = new THREE.Color(0x9aa1a8);
  const dark = new THREE.Color(0x1e2124);
  let lastTower = -1e9;
  for (let i = 0; i < n; i++) {
    if (absCurv(i) < 1 / 140 || absCurv(i - 1) >= 1 / 140 || i - lastTower < Math.round(250 / ds)) continue;
    // Outside of the corner, a little before turn-in (looks into the braking zone and the apex).
    const side = curvature[at(i)] > 0 ? 1 : -1;
    const k = at(i - Math.round(25 / ds));
    if (ctx.blocked(side, k)) continue;
    const off = ctx.barrierAt(side, k) + 6;
    const c = points[k].clone().addScaledVector(rights[k], side * off);
    if (ctx.clearance(c.x, c.z) < off - 1) continue;
    lastTower = i;
    const t = tangents[k];
    const x = rights[k];
    const h = 8;
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ])
      steel.box(c.clone().addScaledVector(x, sx * 1.1).addScaledVector(t, sz * 1.1), x, t, 0.12, h, 0.12, 0, scaffold);
    // Cross braces every 2 m (thin slabs), platform, railing, roof and the camera.
    for (let y = 2; y < h; y += 2) steel.box(c, x, t, 2.35, 0.08, 2.35, y, scaffold);
    huts.box(c, x, t, 2.6, 0.15, 2.6, h, new THREE.Color(0x6e747a));
    huts.box(c, x, t, 2.6, 1.0, 0.06, h + 0.15, scaffold);
    huts.box(c, x, t, 2.8, 0.12, 2.8, h + 2.4, new THREE.Color(0x2b2f34));
    huts.box(c.clone().addScaledVector(x, -side * 0.6), x, t, 0.5, 0.45, 0.9, h + 1.2, dark);
    huts.box(c.clone().addScaledVector(x, -side * 0.6), x, t, 0.1, 1.05, 0.1, h + 0.15, dark);
  }

  // --- meshes ---------------------------------------------------------------
  const add = (soup: Soup, material: THREE.Material, name: string, castShadow: boolean) => {
    const geo = soup.build();
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(geo);
  };
  const fenceAtlas = brandAtlas(7.5 / 1.08);
  const boardAtlas = brandAtlas(4);
  const distTex = distanceAtlas();
  const bannerMat = new THREE.MeshStandardMaterial({ map: fenceAtlas.texture, roughness: 0.8, side: THREE.DoubleSide });
  const billboardMat = new THREE.MeshStandardMaterial({ map: boardAtlas.texture, roughness: 0.55 });
  const steelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.5 });
  const tecproMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45 });
  const boardMat = new THREE.MeshStandardMaterial({ map: distTex, roughness: 0.6 });
  const hutMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
  disposables.push(fenceAtlas.texture, boardAtlas.texture, distTex, bannerMat, billboardMat, steelMat, tecproMat, boardMat, hutMat);
  add(banners, bannerMat, 'FenceBanners', false);
  add(billboards, billboardMat, 'Billboards', false);
  add(steel, steelMat, 'TracksideSteel', true);
  add(tecpro, tecproMat, 'Tecpro', true);
  add(boards, boardMat, 'DistanceBoards', false);
  add(huts, hutMat, 'MarshalPosts', true);
  return { group, disposables };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
