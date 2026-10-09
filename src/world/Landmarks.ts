import * as THREE from 'three';
import monzaRaw from './tracks/data/Monza_landmarks.json?raw';
import { buildCrowd, buildTribune, CrowdMaterial } from './Crowd';
import { PIT_BUILDING_FRONT } from './PitBuilding';
import type { Track } from './Track';

/**
 * Monza's landmarks (from OpenStreetMap, baked by scripts/fetch-landmarks.ts):
 *  - the 1955 high-speed oval's concrete bankings (Sopraelevata Nord / Sud),
 *    steep, weathered, standing on arches beside the modern circuit,
 *  - the podium overhanging the pit lane at the start/finish line,
 *  - corner name boards (Variante del Rettifilo, Curva Grande, Roggia,
 *    Lesmo, Ascari, Parabolica),
 *  - a big MONZA sign at the Parabolica and a grandstand on the outside of
 *    the Curva Grande.
 */
interface LandmarkData {
  banking: number[][];
  podium: number[];
  corners: { name: string; points: number[] }[];
}

const MONZA = JSON.parse(monzaRaw) as LandmarkData;

/** Display names (OSM uses the official ones; TV uses the classic ones). */
const CORNER_NAMES: Record<string, [string, string]> = {
  'Variante del Rettifilo': ['VARIANTE DEL RETTIFILO', 'PRIMA VARIANTE'],
  'Curva Biassono': ['CURVA GRANDE', 'BIASSONO'],
  'Variante della Roggia': ['VARIANTE DELLA ROGGIA', 'SECONDA VARIANTE'],
  'Lesmo 1': ['PRIMA CURVA DI LESMO', 'LESMO 1'],
  'Lesmo 2': ['SECONDA CURVA DI LESMO', 'LESMO 2'],
  'Curva del Serraglio': ['CURVA DEL SERRAGLIO', 'SERRAGLIO'],
  'Variante Ascari': ['VARIANTE ASCARI', 'ALBERTO ASCARI'],
  'Curva Alboreto': ['CURVA ALBORETO', 'PARABOLICA'],
};

export function buildLandmarks(trackId: string, track: Track, groundY: (x: number, z: number) => number): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  group.name = 'Landmarks';
  const disposables: { dispose(): void }[] = [];
  if (trackId !== 'monza' || typeof document === 'undefined') return { group, dispose: () => {} };
  const ctx = new Ctx(track, groundY, group, disposables);
  buildBanking(ctx, MONZA.banking);
  if (MONZA.podium.length >= 6) buildPodium(ctx, MONZA.podium);
  buildCornerSigns(ctx, MONZA.corners);
  return {
    group,
    dispose: () => {
      group.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
}

/**
 * Forest filter: false where a landmark stands (the bankings' corridor), so
 * the park's trees don't grow through the old concrete. Null when the
 * circuit has no landmarks.
 */
export function landmarkClear(trackId: string): ((x: number, z: number) => boolean) | null {
  if (trackId !== 'monza') return null;
  const cell = 16;
  const cells = new Set<string>();
  const reach = BANK_WIDTH * 0.8 + 6;
  for (const piece of MONZA.banking) {
    for (let k = 0; k + 3 < piece.length; k += 2) {
      const ax = piece[k];
      const az = piece[k + 1];
      const bx = piece[k + 2];
      const bz = piece[k + 3];
      const len = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s <= len; s += 3) {
        const x = ax + ((bx - ax) * s) / Math.max(len, 1e-6);
        const z = az + ((bz - az) * s) / Math.max(len, 1e-6);
        for (let dx = -reach; dx <= reach; dx += cell / 2)
          for (let dz = -reach; dz <= reach; dz += cell / 2) {
            if (dx * dx + dz * dz > reach * reach) continue;
            cells.add(`${Math.floor((x + dx) / cell)},${Math.floor((z + dz) / cell)}`);
          }
      }
    }
  }
  return (x, z) => !cells.has(`${Math.floor(x / cell)},${Math.floor(z / cell)}`);
}

class Ctx {
  readonly pts: readonly THREE.Vector3[];
  readonly rights: readonly THREE.Vector3[];
  constructor(
    readonly track: Track,
    readonly groundY: (x: number, z: number) => number,
    readonly group: THREE.Group,
    readonly disposables: { dispose(): void }[],
  ) {
    this.pts = track.getCenterline();
    this.rights = track.getRights();
  }

  add<T extends THREE.Object3D>(o: T): T {
    this.group.add(o);
    return o;
  }

  own<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  /** Distance (m) to the nearest centerline sample (brute force over a coarse stride, then refined). */
  nearest(x: number, z: number): { index: number; dist: number } {
    let best = Infinity;
    let bi = 0;
    const n = this.pts.length;
    for (let i = 0; i < n; i += 4) {
      const d = (this.pts[i].x - x) ** 2 + (this.pts[i].z - z) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    for (let k = -4; k <= 4; k++) {
      const i = (bi + k + n) % n;
      const d = (this.pts[i].x - x) ** 2 + (this.pts[i].z - z) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    return { index: bi, dist: Math.sqrt(best) };
  }

  /** +1 if the circuit turns left at i (outside = right), -1 if right. */
  turn(i: number): number {
    const n = this.pts.length;
    const a = this.pts[(i - 6 + n) % n];
    const b = this.pts[i];
    const c = this.pts[(i + 6) % n];
    const t1x = b.x - a.x;
    const t1z = b.z - a.z;
    const t2x = c.x - b.x;
    const t2z = c.z - b.z;
    return t1z * t2x - t1x * t2z > 0 ? 1 : -1;
  }

  /** First lateral offset (m) on `side` at sample i that lies clearly outside the barriers. */
  outside(i: number, side: number): number {
    const p = new THREE.Vector3();
    for (let o = this.track.halfWidth + 4; o < this.track.halfWidth + 80; o += 1.5) {
      p.copy(this.pts[i]).addScaledVector(this.rights[i], side * o);
      if (this.track.isOutOfBounds(p)) return o;
    }
    return this.track.halfWidth + 30;
  }
}

// ---- bankings --------------------------------------------------------------

/** Joins OSM pieces whose ends meet into continuous chains. */
function chains(pieces: number[][]): THREE.Vector2[][] {
  const lines = pieces.map((p) => {
    const out: THREE.Vector2[] = [];
    for (let i = 0; i < p.length; i += 2) out.push(new THREE.Vector2(p[i], p[i + 1]));
    return out;
  });
  const result: THREE.Vector2[][] = [];
  while (lines.length) {
    let chain = lines.shift()!;
    let grown = true;
    while (grown) {
      grown = false;
      for (let k = 0; k < lines.length; k++) {
        const l = lines[k];
        const end = chain[chain.length - 1];
        const start = chain[0];
        if (l[0].distanceTo(end) < 2) chain = chain.concat(l.slice(1));
        else if (l[l.length - 1].distanceTo(start) < 2) chain = l.concat(chain.slice(1));
        else if (l[l.length - 1].distanceTo(end) < 2) chain = chain.concat(l.slice(0, -1).reverse());
        else if (l[0].distanceTo(start) < 2) chain = l.slice(1).reverse().concat(chain);
        else continue;
        lines.splice(k, 1);
        grown = true;
        break;
      }
    }
    result.push(chain);
  }
  return result;
}

function resample(line: THREE.Vector2[], step: number): THREE.Vector2[] {
  const out = [line[0].clone()];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const len = a.distanceTo(b);
    let t = step - carry;
    while (t <= len) {
      out.push(a.clone().lerp(b, t / len));
      t += step;
    }
    carry = len - (t - step);
  }
  return out;
}

const BANK_WIDTH = 13;
const BANK_HEIGHT = 8;

function buildBanking(ctx: Ctx, pieces: number[][]): void {
  const keep = ctx.track.halfWidth + 22;
  const deck = new Soup();
  const wall = new Soup();
  const parapet = new Soup();
  for (const raw of chains(pieces)) {
    if (raw.length < 2) continue;
    const line = resample(raw, 4);
    const n = line.length;
    if (n < 4) continue;
    // Curvature per point (over ±5 samples) -> how steep the banking is, and which side is outside.
    const bank: number[] = [];
    const outer: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = line[Math.max(0, i - 5)];
      const b = line[i];
      const c = line[Math.min(n - 1, i + 5)];
      const t1 = b.clone().sub(a);
      const t2 = c.clone().sub(b);
      const cross = t1.y * t2.x - t1.x * t2.y;
      const ang = Math.asin(Math.max(-1, Math.min(1, cross / Math.max(t1.length() * t2.length(), 1e-6))));
      const k = Math.abs(ang) / Math.max((t1.length() + t2.length()) / 2, 1);
      bank.push(THREE.MathUtils.smoothstep(k, 1 / 1400, 1 / 420));
      outer.push(cross > 0 ? 1 : -1);
    }
    // Smooth the bank factor so the climb into the banking is gradual.
    for (let pass = 0; pass < 6; pass++) for (let i = 1; i < n - 1; i++) bank[i] = (bank[i - 1] + bank[i] * 2 + bank[i + 1]) / 4;
    let dist = 0;
    const across = 6;
    for (let i = 0; i < n - 1; i++) {
      const segLen = line[i].distanceTo(line[i + 1]);
      const mid = line[i].clone().add(line[i + 1]).multiplyScalar(0.5);
      // Where the oval meets today's circuit, the circuit wins.
      if (ctx.nearest(mid.x, mid.y).dist < keep) {
        dist += segLen;
        continue;
      }
      const frame = (j: number) => {
        const p = line[j];
        const q = line[Math.min(n - 1, j + 1)];
        const o = line[Math.max(0, j - 1)];
        const t = q.clone().sub(o).normalize();
        // Right of travel in the xz plane (t = (x, z)).
        const r = new THREE.Vector2(-t.y, t.x).multiplyScalar(outer[j]);
        return { p, r, h: bank[j] * BANK_HEIGHT, g: ctx.groundY(p.x, p.y) };
      };
      const A = frame(i);
      const B = frame(i + 1);
      const at = (f: ReturnType<typeof frame>, s: number) => {
        // s = 0 inner edge .. 1 outer edge; the profile steepens towards the top like the real one.
        const x = f.p.x + f.r.x * (s - 0.35) * BANK_WIDTH;
        const z = f.p.y + f.r.y * (s - 0.35) * BANK_WIDTH;
        return new THREE.Vector3(x, f.g + 0.15 + f.h * Math.pow(s, 2.2), z);
      };
      for (let k = 0; k < across; k++) {
        const s0 = k / across;
        const s1 = (k + 1) / across;
        deck.quad(at(A, s0), at(B, s0), at(B, s1), at(A, s1), [dist / 8, s0, (dist + segLen) / 8, s0, (dist + segLen) / 8, s1, dist / 8, s1]);
      }
      // Outer face down to the ground (arches drawn in its texture) and a parapet on top.
      const topA = at(A, 1);
      const topB = at(B, 1);
      const botA = topA.clone().setY(A.g);
      const botB = topB.clone().setY(B.g);
      const hA = topA.y - A.g;
      const hB = topB.y - B.g;
      wall.quad(botB, botA, topA, topB, [(dist + segLen) / 8, 0, dist / 8, 0, dist / 8, hA / 8, (dist + segLen) / 8, hB / 8]);
      const up = new THREE.Vector3(0, 1.1, 0);
      parapet.quad(topB, topA, topA.clone().add(up), topB.clone().add(up), [(dist + segLen) / 3, 0, dist / 3, 0, dist / 3, 1, (dist + segLen) / 3, 1]);
      dist += segLen;
    }
  }
  const concrete = ctx.own(concreteTexture());
  const arches = ctx.own(archTexture());
  const deckMat = ctx.own(new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.92, side: THREE.DoubleSide }));
  const wallMat = ctx.own(new THREE.MeshStandardMaterial({ map: arches, roughness: 0.95, side: THREE.DoubleSide, alphaTest: 0.5 }));
  const parMat = ctx.own(new THREE.MeshStandardMaterial({ color: 0xb9b6ad, roughness: 0.9, side: THREE.DoubleSide }));
  for (const [soup, mat, name] of [
    [deck, deckMat, 'BankingDeck'],
    [wall, wallMat, 'BankingArches'],
    [parapet, parMat, 'BankingParapet'],
  ] as const) {
    const geo = soup.build();
    if (!geo) continue;
    ctx.own(geo);
    const mesh = ctx.add(new THREE.Mesh(geo, mat));
    mesh.name = name;
    mesh.castShadow = name !== 'BankingDeck';
    mesh.receiveShadow = true;
  }
}

// ---- podium -------------------------------------------------------------------

/**
 * The podium cantilevered from the pit building out over the pit lane and the
 * edge of the main straight (where fans flood the track below it). Placed
 * where OSM has it along the straight; its depth follows the game's (wider)
 * road and synthetic pit lane so it always reaches over the track.
 */
function buildPodium(ctx: Ctx, flat: number[]): void {
  const pit = ctx.track.pit;
  if (!pit) return;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < flat.length; i += 2) {
    cx += flat[i];
    cz += flat[i + 1];
  }
  const n = flat.length / 2;
  const i = ctx.nearest(cx / n, cz / n).index;
  const P = ctx.pts;
  const t = P[(i + 1) % P.length].clone().sub(P[(i - 1 + P.length) % P.length]).setY(0).normalize();
  const r = ctx.rights[i].clone().multiplyScalar(pit.side);
  const lane = pit.lateralAt(i) || pit.laneOffset;
  // From behind the garage front out to 3 m over the track edge.
  const inner = ctx.track.halfWidth - 3;
  const outer = lane + PIT_BUILDING_FRONT + 3;
  const length = 26;
  const bottom = 11.2;
  const thick = 1.1;
  const mid = (inner + outer) / 2;
  const depth = outer - inner;
  const center = P[i].clone().addScaledVector(r, mid).setY(0);

  const group = new THREE.Group();
  group.name = 'Podium';
  group.position.copy(center);
  // Local axes: x = along the straight, z = out from the building (towards the track = -z).
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, new THREE.Vector3(0, 1, 0), r));
  const white = ctx.own(new THREE.MeshStandardMaterial({ color: 0xf3f3f0, roughness: 0.5 }));
  const steelMat = ctx.own(new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 }));
  const bandTex = ctx.own(fasciaTexture());
  const bandMat = ctx.own(new THREE.MeshStandardMaterial({ map: bandTex, roughness: 0.6 }));
  const glassMat = ctx.own(new THREE.MeshStandardMaterial({ color: 0xbfd6e4, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material | THREE.Material[]) => {
    const m = new THREE.Mesh(ctx.own(new THREE.BoxGeometry(w, h, d)), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  // Deck with the red fascia on the track-facing edge and both ends (box faces: +x, -x, +y, -y, +z, -z).
  box(length, thick, depth, 0, bottom + thick / 2, 0, [bandMat, bandMat, white, white, white, bandMat]);
  // Glass balustrade on three sides.
  box(length, 1.2, 0.05, 0, bottom + thick + 0.6, -depth / 2 + 0.1, glassMat);
  for (const s of [-1, 1]) box(0.05, 1.2, depth - 0.2, (s * length) / 2 - s * 0.1, bottom + thick + 0.6, 0, glassMat);
  // Steel ties up to a mast on the building: the deck hangs from them.
  for (const s of [-0.35, 0.35]) {
    box(0.6, 9, 0.6, s * length, bottom + 4.5, depth / 2 - 0.5, steelMat);
    const tie = box(0.18, 0.18, 1, s * length, 0, 0, steelMat);
    const a = new THREE.Vector3(s * length, bottom + 9, depth / 2 - 0.5);
    const b = new THREE.Vector3(s * length, bottom + thick, -depth / 2 + 0.8);
    tie.position.copy(a).add(b).multiplyScalar(0.5);
    tie.scale.z = a.distanceTo(b);
    tie.lookAt(group.localToWorld(b.clone()));
  }
  // P1-P3 steps near the front edge, a backdrop wall with the trophy-ceremony banner.
  for (const [k, h] of [
    [0, 1.0],
    [-1, 0.7],
    [1, 0.5],
  ] as const)
    box(1.8, h, 1.6, k * 2, bottom + thick + h / 2, -depth / 2 + 3, white);
  const back = document.createElement('canvas');
  back.width = 1024;
  back.height = 256;
  const g = back.getContext('2d')!;
  g.fillStyle = '#c8102e';
  g.fillRect(0, 0, 1024, 256);
  g.fillStyle = '#ffffff';
  g.font = 'italic 900 120px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('GRAN PREMIO', 512, 96);
  g.font = '700 54px Arial, sans-serif';
  g.fillText("D'ITALIA · MONZA", 512, 200);
  const backTex = ctx.own(new THREE.CanvasTexture(back));
  backTex.colorSpace = THREE.SRGBColorSpace;
  const backMat = ctx.own(new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.6 }));
  box(16, 4, 0.3, 0, bottom + thick + 2, depth / 2 - 1.2, [white, white, white, white, white, backMat]);
  // Seen from the track the deck must read as an overhang, so it casts its shadow on the pit lane.
  ctx.add(group);
}

// ---- corner boards and the MONZA sign ---------------------------------------

function buildCornerSigns(ctx: Ctx, corners: LandmarkData['corners']): void {
  const named = corners.filter((c) => CORNER_NAMES[c.name]);
  if (!named.length) return;
  const rows = named.length + 1;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 160 * rows;
  const g = canvas.getContext('2d')!;
  named.forEach((c, k) => {
    const [title, sub] = CORNER_NAMES[c.name];
    const y = k * 160;
    g.fillStyle = '#111317';
    g.fillRect(0, y, 1024, 160);
    // Tricolore stripe on the left.
    for (const [i, col] of ['#009246', '#f1f2f1', '#ce2b37'].entries()) {
      g.fillStyle = col;
      g.fillRect(18 + i * 22, y + 18, 22, 124);
    }
    g.fillStyle = '#ffffff';
    g.font = '900 64px "Arial Black", Arial, sans-serif';
    g.textBaseline = 'middle';
    const w = g.measureText(title).width;
    const sx = Math.min(1, 880 / w);
    g.save();
    g.translate(110, y + 70);
    g.scale(sx, 1);
    g.fillText(title, 0, 0);
    g.restore();
    g.fillStyle = '#ffcc00';
    g.font = '700 32px Arial, sans-serif';
    g.fillText(sub, 112, y + 128);
  });
  // Last row: the big MONZA sign face.
  {
    const y = named.length * 160;
    g.fillStyle = '#c8102e';
    g.fillRect(0, y, 1024, 160);
    g.fillStyle = '#ffffff';
    g.font = 'italic 900 128px "Arial Black", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('MONZA', 512, y + 84);
    g.textAlign = 'left';
    for (const [i, col] of ['#009246', '#f1f2f1', '#ce2b37'].entries()) {
      g.fillStyle = col;
      g.fillRect(i * 341, y + 146, 342, 14);
    }
  }
  const tex = ctx.own(new THREE.CanvasTexture(canvas));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const faceMat = ctx.own(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
  const steel = ctx.own(new THREE.MeshStandardMaterial({ color: 0x4a4f56, metalness: 0.6, roughness: 0.5 }));
  const faces = new Soup();
  const frame = new Soup();
  const up = new THREE.Vector3(0, 1, 0);

  const board = (center: THREE.Vector3, facing: THREE.Vector3, w: number, h: number, y0: number, row: number) => {
    const along = new THREE.Vector3().crossVectors(up, facing).normalize();
    const v0 = 1 - (row + 1) / rows;
    const v1 = 1 - row / rows;
    const p = (s: number, y: number) => center.clone().addScaledVector(along, s * w * 0.5).setY(center.y + y);
    faces.quad(p(-1, y0), p(1, y0), p(1, y0 + h), p(-1, y0 + h), [0, v0, 1, v0, 1, v1, 0, v1]);
    const back = center.clone().addScaledVector(facing, -0.15);
    frame.box(back, along, facing, w + 0.3, h + 0.3, 0.25, y0 - 0.15);
    for (const s of [-0.38, 0.38]) frame.box(back.clone().addScaledVector(along, s * w), along, facing, Math.max(0.25, w * 0.012), y0, 0.25, 0);
  };

  let monzaAt: { center: THREE.Vector3; facing: THREE.Vector3 } | null = null;
  named.forEach((c, row) => {
    const m = Math.floor(c.points.length / 4) * 2;
    const near = ctx.nearest(c.points[m], c.points[m + 1]);
    const i = near.index;
    // Outside of the corner: right when the circuit turns left.
    const side = ctx.turn(i);
    const off = ctx.outside(i, side) + 4;
    const center = ctx.pts[i].clone().addScaledVector(ctx.rights[i], side * off);
    center.y = ctx.groundY(center.x, center.z);
    const n = ctx.pts.length;
    const t = ctx.pts[(i + 1) % n].clone().sub(ctx.pts[(i - 1 + n) % n]).setY(0).normalize();
    // Readable by drivers on the approach: faces back down the track and a bit towards it.
    const facing = t.clone().multiplyScalar(-0.7).addScaledVector(ctx.rights[i], -side).normalize();
    board(center, facing, 9, 1.4, 2.2, row);
    if (c.name === 'Curva Alboreto') monzaAt = { center: center.clone().addScaledVector(ctx.rights[i], side * 26), facing };
    if (c.name === 'Curva Biassono') buildCurvaGrandeStand(ctx, i, side, off);
  });
  if (monzaAt) {
    const { center, facing } = monzaAt as { center: THREE.Vector3; facing: THREE.Vector3 };
    board(center, facing, 34, 5.3, 7, named.length);
  }
  for (const [soup, mat, cast] of [
    [faces, faceMat, false],
    [frame, steel, true],
  ] as const) {
    const geo = soup.build();
    if (!geo) continue;
    ctx.own(geo);
    const mesh = ctx.add(new THREE.Mesh(geo, mat));
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.name = mat === faceMat ? 'CornerBoards' : 'CornerBoardFrames';
  }
}

/** Covered grandstand on the outside of the Curva Grande, full of fans. */
function buildCurvaGrandeStand(ctx: Ctx, i: number, side: number, off: number): void {
  const depth = 14;
  const length = 110;
  const center = ctx.pts[i].clone().addScaledVector(ctx.rights[i], side * (off + 10 + depth / 2));
  // Keep clear of every part of the circuit.
  const clear = ctx.nearest(center.x, center.z).dist > off + depth / 2;
  if (!clear) return;
  const fx = -side * ctx.rights[i].x;
  const fz = -side * ctx.rights[i].z;
  const materials = {
    concrete: ctx.own(new THREE.MeshStandardMaterial({ color: 0xbdb8ae, roughness: 0.9 })),
    seats: ctx.own(new THREE.MeshStandardMaterial({ color: 0xd8262e, roughness: 0.7, vertexColors: true })),
    roof: ctx.own(new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5, metalness: 0.3 })),
  };
  let s = 4242;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const tribune = buildTribune({ x: center.x, z: center.z, yaw: Math.atan2(fz, -fx), length, depth, height: 9 }, materials, rand, 0.85);
  tribune.group.position.y = ctx.groundY(center.x, center.z);
  ctx.disposables.push(...tribune.disposables);
  ctx.add(tribune.group);
  const crowdMat = ctx.own(new CrowdMaterial());
  const crowd = buildCrowd(tribune.seats, crowdMat);
  crowd.group.position.y = tribune.group.position.y;
  ctx.disposables.push(...crowd.disposables);
  ctx.add(crowd.group);
}

// ---- textures --------------------------------------------------------------

/** Weathered banking concrete: slabs (8 m along, uv across 0..1), stains, moss. */
function concreteTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8f8c84';
  g.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 1400; i++) {
    const v = 110 + Math.random() * 60;
    g.fillStyle = `rgba(${v},${v - 4},${v - 10},0.25)`;
    g.fillRect(Math.random() * 256, Math.random() * 512, 2 + Math.random() * 10, 2 + Math.random() * 10);
  }
  // Dark rain streaks down the slope and green-brown moss near the bottom.
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(40,42,38,${0.08 + Math.random() * 0.1})`;
    g.fillRect(Math.random() * 256, 0, 2 + Math.random() * 6, 512 * Math.random());
  }
  for (let i = 0; i < 220; i++) {
    g.fillStyle = `rgba(${70 + Math.random() * 30},${85 + Math.random() * 30},45,0.25)`;
    g.beginPath();
    g.arc(Math.random() * 256, 300 + Math.random() * 212, 3 + Math.random() * 14, 0, Math.PI * 2);
    g.fill();
  }
  // Slab joints.
  g.fillStyle = 'rgba(30,30,28,0.7)';
  g.fillRect(0, 0, 256, 3);
  g.fillRect(0, 0, 3, 512);
  g.fillRect(0, 255, 256, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Outer face of the banking: concrete piers and open arches (alpha), 8 m per repeat. */
function archTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#9a978f';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(45,45,40,${0.06 + Math.random() * 0.1})`;
    g.fillRect(Math.random() * 256, 0, 2 + Math.random() * 5, 256);
  }
  // Arch opening: cut out (transparent), so the piers stand on their own.
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.moveTo(40, 256);
  g.lineTo(40, 110);
  g.arc(128, 110, 88, Math.PI, 0);
  g.lineTo(216, 256);
  g.closePath();
  g.fill();
  g.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Podium edge: red band with the circuit's name. */
function fasciaTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 80;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c8102e';
  g.fillRect(0, 0, 1024, 80);
  g.fillStyle = '#ffffff';
  g.font = 'italic 900 50px "Arial Black", Arial, sans-serif';
  g.textBaseline = 'middle';
  g.fillText('AUTODROMO NAZIONALE MONZA', 40, 42);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Triangle soup (position, normal, uv). */
class Soup {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uv: number[]): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const v = [a, b, c, d][i];
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(uv[i * 2], uv[i * 2 + 1]);
    }
  }

  /** Box in a local frame (x across, z = facing), y0 = bottom height above o. */
  box(o: THREE.Vector3, x: THREE.Vector3, z: THREE.Vector3, w: number, h: number, d: number, y0: number): void {
    const up = new THREE.Vector3(0, 1, 0);
    const corner = (sx: number, sy: number, sz: number) =>
      o.clone().addScaledVector(x, (sx * w) / 2).addScaledVector(z, (sz * d) / 2).addScaledVector(up, y0 + sy * h);
    const faces = [
      [[1, 0, -1], [1, 0, 1], [1, 1, 1], [1, 1, -1]],
      [[-1, 0, 1], [-1, 0, -1], [-1, 1, -1], [-1, 1, 1]],
      [[-1, 0, -1], [1, 0, -1], [1, 1, -1], [-1, 1, -1]],
      [[1, 0, 1], [-1, 0, 1], [-1, 1, 1], [1, 1, 1]],
      [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]],
    ];
    const flip = new THREE.Vector3().crossVectors(x, up).dot(z) > 0;
    for (const f of faces) {
      const q = f.map((v) => corner(v[0], v[1], v[2]));
      if (flip) this.quad(q[3], q[2], q[1], q[0], [0, 0, 1, 0, 1, 1, 0, 1]);
      else this.quad(q[0], q[1], q[2], q[3], [0, 0, 1, 0, 1, 1, 0, 1]);
    }
  }

  build(): THREE.BufferGeometry | null {
    if (!this.pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.computeBoundingSphere();
    return geo;
  }
}
