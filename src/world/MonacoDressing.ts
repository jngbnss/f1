import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import raw from './tracks/data/Monaco_landmarks.json?raw';
import type { Track } from './Track';

/**
 * What makes the Circuit de Monaco read as Monaco on top of the generic
 * street-circuit build (walls at the kerb, OSM town, pit straight):
 *
 * - the sea and Port Hercule (OSM coastline polygon, at sea level) full of
 *   moored yachts beside the Tabac / Swimming Pool section and the pit straight,
 * - the tunnel under the Fairmont: walls, roof and a row of lights,
 * - the Casino de Monte-Carlo (Beaux-Arts block, copper roof, twin towers),
 * - corner name boards (Sainte Dévote ... Anthony Noghès).
 *
 * Distances along the lap are for the OSM-built centerline (Monaco.csv,
 * 3.29 km from the line).
 */

interface MonacoData {
  seaLevel: number | null;
  sea: number[];
  casino: [number, number] | null;
}
const DATA = JSON.parse(raw) as MonacoData;

/** Street-circuit run-off of Monaco (TrackLayout): the wall stands this far beyond the road edge. */
const RUNOFF = 1.6;
/** Tunnel: from after Portier to before the Nouvelle Chicane (m along the lap). */
const TUNNEL: [number, number] = [1480, 1885];
const TUNNEL_HEIGHT = 7;
/** Corner names at their apex (m along the lap). */
const CORNERS: [number, string][] = [
  [215, 'SAINTE DÉVOTE'],
  [470, 'BEAU RIVAGE'],
  [760, 'MASSENET'],
  [895, 'CASINO'],
  [1118, 'MIRABEAU'],
  [1248, 'GRAND HOTEL'],
  [1333, 'MIRABEAU BAS'],
  [1420, 'PORTIER'],
  [2068, 'NOUVELLE CHICANE'],
  [2350, 'TABAC'],
  [2548, 'PISCINE'],
  [2698, 'PISCINE'],
  [2893, 'RASCASSE'],
  [2980, 'ANTHONY NOGHÈS'],
];
/** Yachts are moored within this distance of these stretches (harbour side of the lap). */
const HARBOUR_STRETCHES: [number, number][] = [
  [1890, 3290],
  [0, 260],
];

export function buildMonaco(track: Track, groundY: (x: number, z: number) => number): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  group.name = 'Monaco';
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };
  const pts = track.getCenterline();
  const rights = track.getRights();
  const n = pts.length;
  const spacing = (() => {
    let s = 0;
    for (let i = 0; i < n; i++) s += pts[i].distanceTo(pts[(i + 1) % n]);
    return s / n;
  })();
  const at = (m: number) => ((Math.round(m / spacing) % n) + n) % n;
  const wall = track.halfWidth + RUNOFF;

  if (DATA.seaLevel !== null && DATA.sea.length > 6) buildSea(group, own, DATA.sea, DATA.seaLevel, pts, at, groundY, track.halfWidth);
  buildTunnel(group, own, pts, rights, at, wall);
  if (DATA.casino) buildCasino(group, own, DATA.casino, pts, groundY);
  buildCornerBoards(group, own, pts, rights, at, wall, groundY);

  return {
    group,
    dispose: () => {
      group.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
}

type Own = <T extends { dispose(): void }>(d: T) => T;

// ---- sea and yachts -----------------------------------------------------------

function buildSea(
  group: THREE.Group,
  own: Own,
  flat: number[],
  level: number,
  pts: readonly THREE.Vector3[],
  at: (m: number) => number,
  groundY: (x: number, z: number) => number,
  half: number,
): void {
  const poly: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) poly.push([flat[i], flat[i + 1]]);
  const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geo = own(new THREE.ShapeGeometry(shape));
  geo.rotateX(-Math.PI / 2);
  const surface = level + 0.6;
  const water = new THREE.Mesh(
    geo,
    own(new THREE.MeshPhysicalMaterial({ color: 0x0f4f7a, roughness: 0.08, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.12, normalMap: own(waveTexture()), normalScale: new THREE.Vector2(0.35, 0.35) })),
  );
  // World-space tiling of the ripple texture: UVs of a ShapeGeometry are its x / y in metres.
  (water.material as THREE.MeshPhysicalMaterial).normalMap!.repeat.set(1 / 9, 1 / 9);
  water.position.y = surface;
  water.receiveShadow = true;
  water.name = 'Sea';
  group.add(water);

  // --- moored yachts: rows in the harbour beside the circuit ---
  const inside = (x: number, z: number) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i];
      const [xj, zj] = poly[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const near: number[] = [];
  for (const [a, b] of HARBOUR_STRETCHES) for (let m = a; m < b; m += 10) near.push(at(m));
  const nearest = (x: number, z: number) => {
    let best = Infinity;
    let bi = -1;
    for (const i of near) {
      const d = (pts[i].x - x) ** 2 + (pts[i].z - z) ** 2;
      if (d < best) [best, bi] = [d, i];
    }
    // Closer to any other part of the lap (the tunnel, Beau Rivage...) -> not the harbour.
    for (let i = 0; i < pts.length; i += 6) if ((pts[i].x - x) ** 2 + (pts[i].z - z) ** 2 < best * 0.8) return { d: Infinity, i: -1 };
    return { d: Math.sqrt(best), i: bi };
  };
  let rand = 1234567;
  const rnd = () => {
    rand = (rand * 1103515245 + 12345) & 0x7fffffff;
    return rand / 0x7fffffff;
  };
  const xs = near.map((i) => pts[i].x);
  const zs = near.map((i) => pts[i].z);
  const box = { x0: Math.min(...xs) - 280, x1: Math.max(...xs) + 280, z0: Math.min(...zs) - 280, z1: Math.max(...zs) + 280 };
  const matrices: THREE.Matrix4[] = [];
  const colors: THREE.Color[] = [];
  const hulls = [0xf4f4f2, 0xf4f4f2, 0xeef0f2, 0x1d2430, 0xf4f4f2, 0x23364f, 0xd9d6cf];
  // Pontoons parallel to the pit straight (Port Hercule's layout): boats moored side by
  // side, stern-to, in double rows with a fairway between every pair.
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const sf = pts[0];
  const ahead = pts[8];
  const axis = Math.atan2(ahead.x - sf.x, ahead.z - sf.z); // along the straight
  const ca = Math.cos(axis);
  const sa = Math.sin(axis);
  const dists: number[] = [];
  const BEAM = 6.5; // spacing along a pontoon
  const ROW = 19; // boat length + gap
  const FAIRWAY = 26;
  const cx = (box.x0 + box.x1) / 2;
  const cz = (box.z0 + box.z1) / 2;
  const span = Math.max(box.x1 - box.x0, box.z1 - box.z0);
  for (let v = -span / 2, row = 0; v < span / 2; row++, v += row % 2 === 0 ? FAIRWAY : ROW) {
    // Pairs of rows face each other across their pontoon.
    const facing = row % 2 === 0 ? 0 : Math.PI;
    for (let u = -span / 2; u < span / 2; u += BEAM) {
      // Local (u along the straight, v across) -> world.
      const px = cx + u * sa + v * ca;
      const pz = cz + u * ca - v * sa;
      if (rnd() > 0.72) continue;
      const { d, i } = nearest(px, pz);
      if (i < 0 || d < half + 18 || d > 230) continue;
      if (!inside(px, pz)) continue;
      // Only where the water really shows (quays and piers stand above it).
      if (groundY(px, pz) > surface - 0.8) continue;
      const scale = 0.65 + rnd() ** 3 * 1.4;
      q.setFromAxisAngle(up, axis + Math.PI / 2 + facing + (rnd() - 0.5) * 0.06);
      matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(px, surface - 0.35, pz), q, new THREE.Vector3(scale, scale, scale)));
      dists.push(d);
      colors.push(new THREE.Color(hulls[Math.floor(rnd() * hulls.length)]));
    }
  }
  // The boats nearest the circuit are the ones anyone sees: keep those.
  const keep = dists.map((d, k) => [d, k]).sort((a, b) => a[0] - b[0]).slice(0, 280).map(([, k]) => k);
  const kept = keep.map((k) => matrices[k]);
  const keptColors = keep.map((k) => colors[k]);
  matrices.length = 0;
  colors.length = 0;
  matrices.push(...kept);
  colors.push(...keptColors);
  if (!matrices.length) return;
  const yacht = own(yachtGeometry());
  const mat = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.1 }));
  const mesh = new THREE.InstancedMesh(yacht, mat, matrices.length);
  matrices.forEach((m, k) => {
    mesh.setMatrixAt(k, m);
    mesh.setColorAt(k, colors[k]);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'Yachts';
  group.add(mesh);
}

/** A ~15 m motor yacht along +Z (bow at +Z): white hull (tinted per instance), superstructure, dark glazing. */
function yachtGeometry(): THREE.BufferGeometry {
  const L = 15;
  const B = 4.2;
  const outline = new THREE.Shape();
  outline.moveTo(-B / 2, -L / 2);
  outline.lineTo(B / 2, -L / 2);
  outline.lineTo(B / 2, L * 0.15);
  outline.quadraticCurveTo(B / 2, L * 0.4, 0, L / 2);
  outline.quadraticCurveTo(-B / 2, L * 0.4, -B / 2, L * 0.15);
  outline.closePath();
  const hull = new THREE.ExtrudeGeometry(outline, { depth: 2.2, bevelEnabled: false, curveSegments: 6 });
  hull.rotateX(Math.PI / 2); // extrude along -Y -> hull from y=0 down... flip to stand on the water
  hull.translate(0, 2.2, 0);
  const deck = new THREE.BoxGeometry(B * 0.78, 1.6, L * 0.45).translate(0, 3.0, -L * 0.08);
  const flybridge = new THREE.BoxGeometry(B * 0.62, 1.1, L * 0.24).translate(0, 4.35, -L * 0.04);
  const glass = new THREE.BoxGeometry(B * 0.8, 0.55, L * 0.36).translate(0, 3.15, -L * 0.04);
  const tint = (g: THREE.BufferGeometry, c: number) => {
    const col = new THREE.Color(c);
    const a = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3) col.toArray(a, i);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g.index ? g.toNonIndexed() : g;
  };
  // Instance colour multiplies everything: superstructure white, glazing near black stay readable.
  const merged = mergeGeometries([tint(hull, 0xffffff), tint(deck, 0xf6f6f6), tint(flybridge, 0xf0f0f0), tint(glass, 0x101820)])!;
  for (const g of [hull, deck, flybridge, glass]) g.dispose();
  merged.computeVertexNormals();
  return merged;
}

function waveTexture(): THREE.Texture {
  const s = 128;
  const data = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const a = (x / s) * Math.PI * 2;
      const b = (y / s) * Math.PI * 2;
      const dx = 0.5 * Math.cos(a * 3 + b) + 0.3 * Math.cos(a * 5 - b * 2) + 0.2 * Math.sin(b * 7 + a * 2);
      const dy = 0.5 * Math.cos(b * 4 - a) + 0.3 * Math.sin(b * 2 + a * 5) + 0.2 * Math.cos(a * 6 + b * 3);
      const k = (y * s + x) * 4;
      data[k] = Math.round(128 + dx * 60);
      data[k + 1] = Math.round(128 + dy * 60);
      data[k + 2] = 255;
      data[k + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, s, s);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---- tunnel -----------------------------------------------------------------------

function buildTunnel(
  group: THREE.Group,
  own: Own,
  pts: readonly THREE.Vector3[],
  rights: readonly THREE.Vector3[],
  at: (m: number) => number,
  wall: number,
): void {
  const i0 = at(TUNNEL[0]);
  const i1 = at(TUNNEL[1]);
  const idx: number[] = [];
  for (let i = i0; i !== i1; i = (i + 1) % pts.length) idx.push(i);
  const off = wall + 0.5;
  const pos: number[] = [];
  const nor: number[] = [];
  const lightPos: number[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, facing: THREE.Vector3, out = pos, normals = nor) => {
    const nrm = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
    const order = nrm.dot(facing) >= 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
    if (nrm.dot(facing) < 0) nrm.negate();
    for (const v of order) {
      out.push(v.x, v.y, v.z);
      normals.push(nrm.x, nrm.y, nrm.z);
    }
  };
  const lightNor: number[] = [];
  const P = (i: number, lateral: number, h: number) => pts[i].clone().addScaledVector(rights[i], lateral).add(new THREE.Vector3(0, h, 0));
  for (let k = 0; k + 1 < idx.length; k++) {
    const i = idx[k];
    const j = idx[k + 1];
    for (const side of [-1, 1]) {
      // Wall face looking into the tunnel.
      const inward = rights[i].clone().multiplyScalar(-side);
      quad(P(i, side * off, -0.5), P(j, side * off, -0.5), P(j, side * off, TUNNEL_HEIGHT), P(i, side * off, TUNNEL_HEIGHT), inward);
      // Outer skin (seen from outside / above).
      quad(P(i, side * (off + 1.2), -0.5), P(j, side * (off + 1.2), -0.5), P(j, side * (off + 1.2), TUNNEL_HEIGHT + 1.2), P(i, side * (off + 1.2), TUNNEL_HEIGHT + 1.2), inward.clone().negate());
    }
    // Ceiling (facing down) and roof slab top (facing up).
    quad(P(i, -off, TUNNEL_HEIGHT), P(j, -off, TUNNEL_HEIGHT), P(j, off, TUNNEL_HEIGHT), P(i, off, TUNNEL_HEIGHT), new THREE.Vector3(0, -1, 0));
    quad(P(i, -off - 1.2, TUNNEL_HEIGHT + 1.2), P(j, -off - 1.2, TUNNEL_HEIGHT + 1.2), P(j, off + 1.2, TUNNEL_HEIGHT + 1.2), P(i, off + 1.2, TUNNEL_HEIGHT + 1.2), new THREE.Vector3(0, 1, 0));
    // Two rows of light strips under the ceiling, every other sample.
    if (k % 2 === 0)
      for (const lat of [-2.2, 2.2]) {
        const a = P(i, lat - 0.3, TUNNEL_HEIGHT - 0.05);
        const b = P(j, lat - 0.3, TUNNEL_HEIGHT - 0.05);
        const c = P(j, lat + 0.3, TUNNEL_HEIGHT - 0.05);
        const d = P(i, lat + 0.3, TUNNEL_HEIGHT - 0.05);
        quad(a, b, c, d, new THREE.Vector3(0, -1, 0), lightPos, lightNor);
      }
  }
  // Portals: the facade above the openings at both ends.
  for (const [i, dir] of [
    [idx[0], -1],
    [idx[idx.length - 1], 1],
  ] as const) {
    const t = pts[(i + 1) % pts.length].clone().sub(pts[(i - 1 + pts.length) % pts.length]).normalize().multiplyScalar(dir);
    quad(P(i, -off - 1.2, TUNNEL_HEIGHT - 1.4), P(i, off + 1.2, TUNNEL_HEIGHT - 1.4), P(i, off + 1.2, TUNNEL_HEIGHT + 1.2), P(i, -off - 1.2, TUNNEL_HEIGHT + 1.2), t);
  }
  const make = (p: number[], nm: number[]) => {
    const g = own(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nm, 3));
    g.computeBoundingSphere();
    return g;
  };
  const concrete = new THREE.Mesh(make(pos, nor), own(new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.92, side: THREE.DoubleSide })));
  concrete.castShadow = true;
  concrete.receiveShadow = true;
  concrete.name = 'Tunnel';
  const lights = new THREE.Mesh(make(lightPos, lightNor), own(new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffe2a8, emissiveIntensity: 3 })));
  lights.name = 'TunnelLights';
  group.add(concrete, lights);
}

// ---- Casino de Monte-Carlo -----------------------------------------------------------

function buildCasino(group: THREE.Group, own: Own, at: [number, number], pts: readonly THREE.Vector3[], groundY: (x: number, z: number) => number): void {
  const [cx, cz] = at;
  // Facade towards the nearest stretch of the circuit (the square in front of it).
  let best = Infinity;
  let np = pts[0];
  for (const p of pts) {
    const d = (p.x - cx) ** 2 + (p.z - cz) ** 2;
    if (d < best) [best, np] = [d, p];
  }
  const yaw = Math.atan2(np.x - cx, np.z - cz);
  const g = new THREE.Group();
  g.name = 'Casino';
  g.position.set(cx, groundY(cx, cz) - 0.5, cz);
  g.rotation.y = yaw;
  const W = 56;
  const D = 30;
  const H = 17;
  const facade = own(casinoFacadeTexture());
  const stone = own(new THREE.MeshStandardMaterial({ color: 0xf1e3c6, roughness: 0.8 }));
  const front = own(new THREE.MeshStandardMaterial({ map: facade, roughness: 0.75 }));
  const copper = own(new THREE.MeshStandardMaterial({ color: 0x5f9c86, roughness: 0.55, metalness: 0.35 }));
  const gold = own(new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.3, metalness: 0.9 }));
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], x: number, y: number, z: number) => {
    own(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  // Main block: facade texture on the front (+Z faces the circuit), plain stone elsewhere.
  add(new THREE.BoxGeometry(W, H, D), [stone, stone, stone, stone, front, stone], 0, H / 2, 0);
  // Mansard roof (copper) and the central lantern.
  const roof = new THREE.CylinderGeometry(1, 1.35, 6, 4, 1);
  roof.rotateY(Math.PI / 4);
  roof.scale(W / 2 / 1.0 / 1.414, 1, D / 2 / 1.0 / 1.414);
  add(roof, copper, 0, H + 3, 0);
  add(new THREE.CylinderGeometry(4.5, 5.5, 5, 16), copper, 0, H + 8, 2);
  add(new THREE.SphereGeometry(4.6, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), copper, 0, H + 10.5, 2);
  // The two towers framing the facade, with domed caps and finials.
  for (const sx of [-1, 1]) {
    const x = sx * (W / 2 - 3.5);
    add(new THREE.BoxGeometry(8, H + 12, 8), stone, x, (H + 12) / 2, D / 2 - 3);
    add(new THREE.CylinderGeometry(3.2, 4.4, 6, 4).rotateY(Math.PI / 4), copper, x, H + 15, D / 2 - 3);
    add(new THREE.ConeGeometry(0.4, 4, 6), gold, x, H + 20, D / 2 - 3);
  }
  // Marquee / entrance canopy and the gardens' fountain in front.
  add(new THREE.BoxGeometry(14, 0.6, 5), gold, 0, 5.2, D / 2 + 2.5);
  add(new THREE.CylinderGeometry(6, 6.5, 0.8, 24), stone, 0, 0.4, D / 2 + 22);
  add(new THREE.CylinderGeometry(5.3, 5.3, 0.3, 24), own(new THREE.MeshStandardMaterial({ color: 0x2d6f96, roughness: 0.1 })), 0, 0.75, D / 2 + 22);
  group.add(g);
}

function casinoFacadeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 320;
  const g = c.getContext('2d')!;
  g.fillStyle = '#efe0c2';
  g.fillRect(0, 0, 1024, 320);
  // Cornices.
  g.fillStyle = '#d9c7a2';
  g.fillRect(0, 120, 1024, 10);
  g.fillRect(0, 300, 1024, 20);
  g.fillRect(0, 0, 1024, 14);
  // Arched windows, two floors, columns between.
  for (let k = 0; k < 14; k++) {
    const x = 40 + k * 70;
    for (const [y, h] of [
      [150, 120],
      [34, 70],
    ] as const) {
      g.fillStyle = '#3a3227';
      g.beginPath();
      g.moveTo(x, y + h);
      g.lineTo(x, y + 18);
      g.arc(x + 18, y + 18, 18, Math.PI, 0);
      g.lineTo(x + 36, y + h);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(255,214,140,0.35)';
      g.fillRect(x + 4, y + 22, 28, h - 26);
    }
    g.fillStyle = '#e6d3ad';
    g.fillRect(x + 48, 140, 8, 160);
  }
  // Clock above the entrance.
  g.fillStyle = '#c9a54a';
  g.beginPath();
  g.arc(512, 70, 30, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#f7f1e3';
  g.beginPath();
  g.arc(512, 70, 24, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ---- corner boards -----------------------------------------------------------------

function buildCornerBoards(
  group: THREE.Group,
  own: Own,
  pts: readonly THREE.Vector3[],
  rights: readonly THREE.Vector3[],
  at: (m: number) => number,
  wall: number,
  groundY: (x: number, z: number) => number,
): void {
  const names = [...new Set(CORNERS.map(([, name]) => name))];
  const rowH = 96;
  const c = document.createElement('canvas');
  c.width = 768;
  c.height = rowH * names.length;
  const g = c.getContext('2d')!;
  names.forEach((name, k) => {
    const y = k * rowH;
    g.fillStyle = '#c8102e';
    g.fillRect(0, y, 768, rowH);
    g.fillStyle = '#ffffff';
    g.fillRect(0, y + rowH - 12, 768, 6);
    g.font = '900 54px "Arial Black", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, 384, y + rowH / 2 - 4, 740);
  });
  const tex = own(new THREE.CanvasTexture(c));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const pos: number[] = [];
  const uv: number[] = [];
  const nor: number[] = [];
  const posts: THREE.BufferGeometry[] = [];
  const n = pts.length;
  for (const [m, name] of CORNERS) {
    const i = at(m - 25); // just before the turn-in, facing the drivers
    const a = pts[(i - 3 + n) % n];
    const b = pts[(i + 3) % n];
    const t = b.clone().sub(a).setY(0).normalize();
    // Outside of the corner.
    const k = at(m);
    const t2 = pts[(k + 6) % n].clone().sub(pts[(k - 6 + n) % n]);
    const turnRight = t.x * t2.z - t.z * t2.x > 0;
    const side = turnRight ? -1 : 1;
    const base = pts[i].clone().addScaledVector(rights[i], side * (wall + 0.8));
    const y0 = Math.max(groundY(base.x, base.z), pts[i].y) + 3.2;
    const w = 6;
    const h = 0.75;
    const along = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), t.clone().negate()).normalize();
    const row = names.indexOf(name);
    const v0 = 1 - (row + 1) / names.length;
    const v1 = 1 - row / names.length;
    const p = (s: number, y: number) => base.clone().addScaledVector(along, s * w * 0.5).setY(y);
    const quad = [p(-1, y0), p(1, y0), p(1, y0 + h), p(-1, y0 + h)];
    const uvq = [0, v0, 1, v0, 1, v1, 0, v1];
    // Front faces the oncoming cars (-t); wind it that way, single-sided (the back gets a plain plate).
    const nrm = new THREE.Vector3().subVectors(quad[1], quad[0]).cross(new THREE.Vector3().subVectors(quad[3], quad[0]));
    const order = nrm.x * -t.x + nrm.z * -t.z >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (const ix of order) {
      pos.push(quad[ix].x, quad[ix].y, quad[ix].z);
      uv.push(uvq[ix * 2], uvq[ix * 2 + 1]);
      nor.push(-t.x, 0, -t.z);
    }
    const back = new THREE.BoxGeometry(w, h + 0.1, 0.06);
    back.lookAt(t);
    back.translate(base.x + t.x * 0.05, y0 + h / 2, base.z + t.z * 0.05);
    posts.push(back);
    for (const s of [-0.8, 0.8]) {
      const q = base.clone().addScaledVector(along, s * w * 0.5);
      posts.push(new THREE.CylinderGeometry(0.07, 0.07, y0 + h - groundY(q.x, q.z) + 0.3, 6).translate(q.x, (y0 + h + groundY(q.x, q.z)) / 2, q.z));
    }
  }
  const geo = own(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.computeBoundingSphere();
  const boards = new THREE.Mesh(geo, own(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 })));
  boards.name = 'CornerBoards';
  const postGeo = own(mergeGeometries(posts)!);
  posts.forEach((p) => p.dispose());
  const postMesh = new THREE.Mesh(postGeo, own(new THREE.MeshStandardMaterial({ color: 0x5b6168, roughness: 0.5, metalness: 0.6 })));
  postMesh.castShadow = true;
  group.add(boards, postMesh);
}
