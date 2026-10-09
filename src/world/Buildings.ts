import * as THREE from 'three';

/**
 * OSM footprints -> buildings that read as architecture, not boxes:
 * hipped tile roofs on houses, flat roofs with parapets and rooftop plant on
 * bigger blocks, and facades drawn procedurally in the shader (Italian
 * plaster with shutters and shopfronts, brick, curtain-wall offices,
 * corrugated sheds) with doors, sills, string courses and cornices.
 *
 * Every building is triangle soup with three per-vertex attributes:
 *   color  wall/roof tint
 *   aFuv   facade coordinates (walls: bays x floors, roofs: metres)
 *   aFac   (facade kind, roofline in floors, seed)
 * so a whole tile of buildings is one mesh and one draw call.
 */

export const enum Facade {
  Plaster = 0,
  PlasterShops = 1,
  Office = 2,
  Brick = 3,
  Industrial = 4,
  RoofTiles = 5,
  FlatRoof = 6,
  Plain = 7,
}

const PLASTER = [0xe8c48c, 0xe2ab8e, 0xf0e4c8, 0xf2dca0, 0xe4b08f, 0xefebe2, 0xd9c4a0, 0xf3d2b0];
const BRICK = [0xb0603f, 0xa4553a, 0xb86d4c];
const OFFICE = [0xc9cdd1, 0xb7bcc2, 0xdedfe0];
const INDUSTRIAL = [0xd5d8da, 0xb9c3ca, 0x93a6b6, 0xcac3b2, 0xa7b29f];
const TILES = [0xb35d3d, 0xa65036, 0xc06a48, 0x9e5a42];
const FLAT_ROOF = [0x8d8c88, 0x7c7d7c, 0x9a958c];

/** Triangle soup for buildings; quads are wound to face `facing`. */
export class BuildingSoup {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly fuv: number[] = [];
  readonly fac: number[] = [];

  private vert(p: THREE.Vector3, c: THREE.Color, u: number, v: number, f: [number, number, number]): void {
    this.pos.push(p.x, p.y, p.z);
    this.col.push(c.r, c.g, c.b);
    this.fuv.push(u, v);
    this.fac.push(f[0], f[1], f[2]);
  }

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, uv: number[], facing: THREE.Vector3, color: THREE.Color, f: [number, number, number]): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const v = [a, b, c];
    const order = n.dot(facing) < 0 ? [0, 2, 1] : [0, 1, 2];
    for (const i of order) this.vert(v[i], color, uv[i * 2], uv[i * 2 + 1], f);
  }

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uv: number[], facing: THREE.Vector3, color: THREE.Color, f: [number, number, number]): void {
    this.tri(a, b, c, [uv[0], uv[1], uv[2], uv[3], uv[4], uv[5]], facing, color, f);
    this.tri(a, c, d, [uv[0], uv[1], uv[4], uv[5], uv[6], uv[7]], facing, color, f);
  }

  /** Box on the ground (or at y0) in a local frame: x, z axes in the ground plane. */
  box(center: THREE.Vector3, x: THREE.Vector3, z: THREE.Vector3, w: number, h: number, d: number, y0: number, color: THREE.Color, kind = Facade.Plain): void {
    const up = new THREE.Vector3(0, 1, 0);
    const corner = (sx: number, sy: number, sz: number) =>
      center.clone().addScaledVector(x, (sx * w) / 2).addScaledVector(z, (sz * d) / 2).setY(y0 + sy * h);
    const f: [number, number, number] = [kind, 99, 0];
    const uv = [0, 0, 1, 0, 1, 1, 0, 1];
    const faces: [number[][], THREE.Vector3][] = [
      [[[1, 0, -1], [1, 0, 1], [1, 1, 1], [1, 1, -1]], x],
      [[[-1, 0, 1], [-1, 0, -1], [-1, 1, -1], [-1, 1, 1]], x.clone().negate()],
      [[[-1, 0, -1], [1, 0, -1], [1, 1, -1], [-1, 1, -1]], z.clone().negate()],
      [[[1, 0, 1], [-1, 0, 1], [-1, 1, 1], [1, 1, 1]], z],
      [[[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]], up],
    ];
    for (const [q, n] of faces) {
      const v = q.map((c) => corner(c[0], c[1], c[2]));
      this.quad(v[0], v[1], v[2], v[3], uv, n, color, f);
    }
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('aFuv', new THREE.Float32BufferAttribute(this.fuv, 2));
    geo.setAttribute('aFac', new THREE.Float32BufferAttribute(this.fac, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }
}

function area2(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    a += x0 * z1 - x1 * z0;
  }
  return a;
}

function inside(pts: [number, number][], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** Oriented box along the longest edge: centre, unit axes, half extents. */
function orientedBox(pts: [number, number][]) {
  let ux = 1;
  let uz = 0;
  let longest = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    const l = Math.hypot(x1 - x0, z1 - z0);
    if (l > longest) {
      longest = l;
      ux = (x1 - x0) / l;
      uz = (z1 - z0) / l;
    }
  }
  const vx = -uz;
  const vz = ux;
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const [x, z] of pts) {
    const u = x * ux + z * uz;
    const v = x * vx + z * vz;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  let u = new THREE.Vector3(ux, 0, uz);
  let v = new THREE.Vector3(vx, 0, vz);
  let hu = (u1 - u0) / 2;
  let hv = (v1 - v0) / 2;
  const c = new THREE.Vector3(ux * (u0 + u1) * 0.5 + vx * (v0 + v1) * 0.5, 0, uz * (u0 + u1) * 0.5 + vz * (v0 + v1) * 0.5);
  if (hv > hu) {
    [u, v] = [v, u];
    [hu, hv] = [hv, hu];
  }
  return { c, u, v, hu, hv };
}

/**
 * Adds one building. `kind`: OSM class (0 generic, 1 grandstand-ish, 2 house).
 * Returns false when the footprint is unusable.
 */
export function addBuilding(soup: BuildingSoup, pts: [number, number][], height: number, kind: number, rand: () => number): boolean {
  if (pts.length < 3) return false;
  const a2 = area2(pts);
  const area = Math.abs(a2) / 2;
  if (area < 4) return false;
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length) % list.length];
  const seed = Math.floor(rand() * 997);

  // --- character ------------------------------------------------------------
  let facade: Facade;
  let tint: number;
  if (kind === 2) {
    facade = rand() < 0.78 ? Facade.Plaster : Facade.Brick;
  } else if (kind === 1) {
    facade = Facade.Industrial;
  } else if (area > 1400 && height <= 13) {
    facade = Facade.Industrial;
  } else if (height >= 13) {
    facade = rand() < 0.45 ? Facade.Office : Facade.PlasterShops;
  } else if (area > 500) {
    const r = rand();
    facade = r < 0.3 ? Facade.Office : r < 0.6 ? Facade.Industrial : Facade.PlasterShops;
  } else {
    const r = rand();
    facade = r < 0.55 ? Facade.Plaster : r < 0.8 ? Facade.PlasterShops : Facade.Brick;
  }
  switch (facade) {
    case Facade.Brick:
      tint = pick(BRICK);
      break;
    case Facade.Office:
      tint = pick(OFFICE);
      break;
    case Facade.Industrial:
      tint = pick(INDUSTRIAL);
      break;
    default:
      tint = pick(PLASTER);
  }
  const floorH = facade === Facade.Industrial ? 4.5 + rand() * 1.5 : facade === Facade.Office ? 3.6 + rand() * 0.3 : 3.0 + rand() * 0.4;
  const bay = facade === Facade.Office ? 1.8 + rand() * 0.6 : facade === Facade.Industrial ? 3 + rand() : 3.2 + rand() * 0.8;
  // Whole floors (with at least one), so cornices sit on a floor line.
  const floors = Math.max(1, Math.round(height / floorH));
  const h = floors * floorH;

  const box = orientedBox(pts);
  const fill = area / (4 * box.hu * box.hv);
  const pitched = (kind === 2 || (facade !== Facade.Industrial && facade !== Facade.Office && area < 260)) && fill > 0.7 && box.hv < 11;
  const parapet = pitched ? 0 : facade === Facade.Industrial ? 0.6 : 0.9;
  const wallTop = h + parapet;
  const wallColor = new THREE.Color(tint);
  const fac: [number, number, number] = [facade, floors, seed];

  // --- walls ----------------------------------------------------------------
  const ccw = a2 > 0;
  let along = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.05) continue;
    const dx = (x1 - x0) / len;
    const dz = (z1 - z0) / len;
    const out = ccw ? new THREE.Vector3(dz, 0, -dx) : new THREE.Vector3(-dz, 0, dx);
    // Bays snap to whole numbers per wall so windows never get cut at corners.
    const bays = Math.max(1, Math.round(len / bay));
    const u0 = along;
    const u1 = along + bays;
    along = Math.ceil(u1);
    const v1 = wallTop / floorH;
    soup.quad(
      new THREE.Vector3(x0, 0, z0),
      new THREE.Vector3(x1, 0, z1),
      new THREE.Vector3(x1, wallTop, z1),
      new THREE.Vector3(x0, wallTop, z0),
      [u0, 0, u1, 0, u1, v1, u0, v1],
      out,
      wallColor,
      fac,
    );
  }

  const up = new THREE.Vector3(0, 1, 0);
  if (pitched) {
    // --- hipped tile roof over the oriented box (with eaves overhang) --------
    const { c, u, v } = box;
    const L = box.hu + 0.5;
    const S = box.hv + 0.5;
    const rise = S * (0.42 + rand() * 0.12);
    const eave = h - 0.12;
    const roofColor = new THREE.Color(pick(TILES));
    const rf: [number, number, number] = [Facade.RoofTiles, 0, seed];
    const P = (a: number, b: number, y: number) => c.clone().addScaledVector(u, a).addScaledVector(v, b).setY(y);
    const ridge = Math.max(0, L - S);
    const slope = Math.hypot(S, rise);
    for (const s of [-1, 1]) {
      const n = v.clone().multiplyScalar(s).add(new THREE.Vector3(0, 1, 0));
      soup.quad(P(-L, s * S, eave), P(L, s * S, eave), P(ridge, 0, eave + rise), P(-ridge, 0, eave + rise), [0, 0, 2 * L, 0, L + ridge, slope, L - ridge, slope], n, roofColor, rf);
      const m = u.clone().multiplyScalar(s).add(new THREE.Vector3(0, 1, 0));
      soup.tri(P(s * L, -S, eave), P(s * L, S, eave), P(s * ridge, 0, eave + rise), [0, 0, 2 * S, 0, S, slope], m, roofColor, rf);
    }
    // Soffit under the eaves.
    const soffit = new THREE.Color(0x6b4a36);
    soup.quad(P(-L, -S, eave), P(L, -S, eave), P(L, S, eave), P(-L, S, eave), [0, 0, 1, 0, 1, 1, 0, 1], up.clone().negate(), soffit, [Facade.Plain, 99, 0]);
  } else {
    // --- flat roof, parapet inner faces, rooftop plant ------------------------
    const roofColor = new THREE.Color(pick(FLAT_ROOF));
    const contour = pts.map(([x, z]) => new THREE.Vector2(x, z));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const rf: [number, number, number] = [Facade.FlatRoof, 0, seed];
    for (const [i0, i1, i2] of tris) {
      const p = [i0, i1, i2].map((k) => new THREE.Vector3(pts[k][0], h, pts[k][1]));
      soup.tri(p[0], p[1], p[2], [pts[i0][0], pts[i0][1], pts[i1][0], pts[i1][1], pts[i2][0], pts[i2][1]], up, roofColor, rf);
    }
    if (parapet > 0) {
      // Inner face of the parapet (seen from the far camera / above) and a light coping.
      const inner = wallColor.clone().multiplyScalar(0.85);
      const coping = new THREE.Color(0xe6e2da);
      for (let i = 0; i < pts.length; i++) {
        const [x0, z0] = pts[i];
        const [x1, z1] = pts[(i + 1) % pts.length];
        const len = Math.hypot(x1 - x0, z1 - z0);
        if (len < 0.05) continue;
        const dx = (x1 - x0) / len;
        const dz = (z1 - z0) / len;
        const inward = ccw ? new THREE.Vector3(-dz, 0, dx) : new THREE.Vector3(dz, 0, -dx);
        const t = 0.25;
        soup.quad(new THREE.Vector3(x0, h, z0), new THREE.Vector3(x1, h, z1), new THREE.Vector3(x1, wallTop, z1), new THREE.Vector3(x0, wallTop, z0), [0, 0, 1, 0, 1, 1, 0, 1], inward, inner, [Facade.Plain, 99, 0]);
        const a = new THREE.Vector3(x0, wallTop, z0);
        const b = new THREE.Vector3(x1, wallTop, z1);
        soup.quad(a, b, b.clone().addScaledVector(inward, t), a.clone().addScaledVector(inward, t), [0, 0, 1, 0, 1, 1, 0, 1], up, coping, [Facade.Plain, 99, 0]);
      }
    }
    if (area > 180) {
      // Air handlers, a stair/lift housing on larger blocks.
      const { c, u, v, hu, hv } = box;
      const n = Math.min(5, 1 + Math.floor(area / 500));
      const metal = new THREE.Color(0xb9bdc1);
      for (let k = 0; k < n; k++) {
        const w = 1.6 + rand() * 2.2;
        const d = 1.2 + rand() * 1.8;
        const hh = 0.9 + rand() * 1.3;
        const p = c.clone().addScaledVector(u, (rand() - 0.5) * 1.6 * Math.max(0, hu - w)).addScaledVector(v, (rand() - 0.5) * 1.6 * Math.max(0, hv - d));
        if (!inside(pts, p.x, p.z)) continue;
        soup.box(p, u, v, w, hh, d, h, metal);
      }
      if (facade !== Facade.Industrial && area > 350) {
        const p = c.clone().addScaledVector(u, hu * 0.35);
        if (inside(pts, p.x, p.z)) soup.box(p, u, v, 3.2, 2.6, 3.2, h, wallColor.clone().multiplyScalar(0.92));
      }
    }
  }
  return true;
}

const FACADE_GLSL = /* glsl */ `
varying vec3 vFac;
varying vec2 vFuv;
float fh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float fbox(vec2 p, vec2 a, vec2 b, float e) {
  vec2 s = smoothstep(a - e, a + e, p) * (1.0 - smoothstep(b - e, b + e, p));
  return s.x * s.y;
}
`;

/** One material for every building tile. */
export function buildingMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aFac;\nattribute vec2 aFuv;\nvarying vec3 vFac;\nvarying vec2 vFuv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFac = aFac;\nvFuv = aFuv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_GLSL}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        vec3 base = vColor.rgb;
        float kind = vFac.x;
        float topV = vFac.y;
        float seed = vFac.z;
        vec2 f = vFuv;
        vec2 c = fract(f);
        vec2 id = floor(f);
        vec2 fw = fwidth(f);
        float e = max(fw.x, fw.y) * 0.7 + 0.004;
        float detail = 1.0 - smoothstep(0.16, 0.42, max(fw.x, fw.y));
        // Patterns 10-40x finer than a bay (ribs, bricks, tiles) fade much earlier.
        float fine = 1.0 - smoothstep(0.02, 0.06, max(fw.x, fw.y) * (kind > 4.5 ? 0.3 : 1.0));
        float rnd = fh(id + seed * 0.37);
        vec3 glassCol = mix(vec3(0.045, 0.06, 0.075), vec3(0.15, 0.18, 0.2), rnd);
        vec3 col = base;
        vec3 avg = base;
        float glass = 0.0;
        float avgGlass = 0.0;
        bool wall = kind < 4.5;
        if (wall && f.y > topV) {
          // Parapet above the roofline: plain, with a light coping line at its top.
          col = base * 0.94;
        } else if (kind < 1.5) {
          // Italian plaster: shuttered windows, doors / shopfronts, string courses.
          if (id.y < 0.5 && kind > 0.5) {
            float win = fbox(c, vec2(0.07, 0.06), vec2(0.93, 0.78), e);
            vec3 awning = mix(vec3(0.55, 0.12, 0.1), vec3(0.12, 0.3, 0.2), step(0.5, fh(vec2(id.x, seed))));
            col = mix(base * 0.6, glassCol * 1.6 + vec3(0.06, 0.05, 0.03), win);
            glass = win;
            col = mix(col, awning, fbox(c, vec2(0.03, 0.8), vec2(0.97, 0.93), e));
          } else if (id.y < 0.5 && rnd < 0.28) {
            col = mix(base, vec3(0.24, 0.15, 0.09), fbox(c, vec2(0.3, -0.1), vec2(0.7, 0.74), e));
          } else {
            float win = fbox(c, vec2(0.37, 0.22), vec2(0.63, 0.8), e);
            float sh = fbox(c, vec2(0.22, 0.22), vec2(0.37, 0.8), e) + fbox(c, vec2(0.63, 0.22), vec2(0.78, 0.8), e);
            vec3 shCol = mix(vec3(0.17, 0.28, 0.17), vec3(0.42, 0.25, 0.14), step(0.5, fh(vec2(seed, 3.0))));
            shCol *= 0.85 + 0.15 * step(0.5, fract(c.y * 16.0));
            float open = step(0.3, rnd);
            col = mix(col, glassCol, win * open);
            glass = win * open;
            col = mix(col, shCol, clamp(sh * open + win * (1.0 - open), 0.0, 1.0));
            col = mix(col, base * 1.12, fbox(c, vec2(0.34, 0.17), vec2(0.66, 0.22), e));
          }
          col *= 1.0 - 0.14 * (1.0 - smoothstep(0.0, 0.05 + e, c.y)) * step(0.5, id.y);
          col *= 1.0 - 0.25 * step(f.y, 0.12);
          col = mix(col, base * 0.78, step(topV - 0.1, f.y));
          avg = base * 0.8;
          avgGlass = 0.12;
        } else if (kind < 2.5) {
          // Curtain wall: glass bands, mullions, spandrel panels; full-height glass lobby.
          float lobby = step(id.y, 0.5);
          float g = mix(fbox(c, vec2(-0.1, 0.16), vec2(1.1, 0.92), e), fbox(c, vec2(-0.1, -0.1), vec2(1.1, 0.95), e), lobby);
          float mull = 1.0 - fbox(c, vec2(0.035, -1.0), vec2(0.965, 2.0), e);
          glass = g * (1.0 - mull);
          col = mix(base, glassCol * 1.3 + vec3(0.02, 0.05, 0.08), glass);
          col = mix(col, vec3(0.32, 0.34, 0.36), g * mull);
          col = mix(col, base * 0.75, step(topV - 0.06, f.y));
          avg = mix(base, glassCol, 0.55);
          avgGlass = 0.55;
        } else if (kind < 3.5) {
          // Brick: running bond, white-framed windows, doors.
          vec2 bp = vec2(f.x * 14.0, f.y * 40.0);
          bp.x += 0.5 * step(0.5, fract(bp.y * 0.5));
          float mortar = 1.0 - fbox(fract(bp), vec2(0.05, 0.12), vec2(0.95, 0.88), 0.02);
          col = base * (0.86 + 0.28 * fh(floor(bp)));
          col = mix(col, vec3(0.78, 0.74, 0.68), mortar * 0.6 * fine);
          if (id.y < 0.5 && rnd < 0.3) {
            col = mix(col, vec3(0.2, 0.13, 0.08), fbox(c, vec2(0.32, -0.1), vec2(0.68, 0.74), e));
          } else {
            col = mix(col, vec3(0.9, 0.9, 0.88), fbox(c, vec2(0.3, 0.2), vec2(0.7, 0.8), e));
            float win = fbox(c, vec2(0.34, 0.24), vec2(0.66, 0.76), e);
            col = mix(col, glassCol, win);
            glass = win;
          }
          col = mix(col, vec3(0.82, 0.8, 0.76), step(topV - 0.07, f.y));
          avg = base * 0.92;
          avgGlass = 0.1;
        } else if (kind < 4.5) {
          // Sheds: corrugated cladding, high window strip, roller doors.
          col = base * (0.9 + 0.1 * sin(f.x * 6.2832 * 10.0) * fine);
          float top = step(topV - 1.0, id.y);
          float strip = fbox(c, vec2(-0.1, 0.45), vec2(1.1, 0.72), e) * top;
          col = mix(col, glassCol * 1.2, strip);
          glass = strip;
          if (id.y < 0.5 && mod(id.x + seed, 3.0) < 1.0) {
            float door = fbox(c, vec2(0.1, -0.1), vec2(0.9, 0.78), e);
            col = mix(col, vec3(0.55, 0.57, 0.58) * (0.93 + 0.07 * sin(f.y * 150.0) * fine), door);
          }
          col *= 1.0 - 0.2 * step(f.y, 0.06);
          avg = base * 0.92;
          avgGlass = 0.05;
        } else if (kind < 5.5) {
          // Roman tiles: courses up the slope, per-tile shade, gaps.
          vec2 tp = vec2(f.x / 0.28, f.y / 0.36);
          tp.x += 0.5 * step(0.5, fract(tp.y * 0.5));
          vec2 tc = fract(tp);
          float shade = 0.82 + 0.3 * fh(floor(tp) + seed);
          float course = smoothstep(0.0, 0.25, tc.y) * (0.75 + 0.25 * sin(tc.x * 3.1416));
          col = base * mix(0.88, shade * mix(0.7, 1.05, course), fine);
          avg = base * 0.85;
        } else if (kind < 6.5) {
          col = base * (0.88 + 0.18 * fh(floor(f * 2.5) + seed));
          avg = base * 0.95;
        }
        col = mix(avg, col, detail);
        glass = mix(avgGlass, glass, detail);
        diffuseColor.rgb *= col;
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.06, glass);',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.55, glass);',
      );
  };
  material.customProgramCacheKey = () => 'osm-buildings-v1';
  return material;
}
