import * as THREE from 'three';
import { PIT_LANE_WIDTH, type PitLaneData } from './PitLane';

/**
 * Pit building along the garage side of the pit lane, modelled on modern F1
 * paddocks: open team garages (lit interiors in team colours) on the ground
 * floor, a cantilevered glass hospitality floor above, and a deep roof with
 * the circuit's name on the fascia. Replaces the rails/fence along its
 * length (the guardrail collider stays) and the plain OSM box behind it.
 *
 * One canvas is painted for the whole length (garages + fascia), so every
 * bay can differ without an atlas. Skipped in Node (no canvas).
 */

/** Distance from the lane centre to the garage fronts (m). */
export const PIT_BUILDING_FRONT = PIT_LANE_WIDTH / 2 + 1.6;
export const PIT_BUILDING_DEPTH = 20;

const PX_PER_M = 20;
const GROUND_H = 4.6;
const UPPER_Y0 = 4.9;
const UPPER_Y1 = 8.9;
const ROOF_Y = 9.3;
const FASCIA_H = 1.6;
const CANTILEVER = 1.8;
const ROOF_OVERHANG = 3.2;
const GARAGE_W = 12;

export function buildPitBuilding(
  pit: PitLaneData,
  rights: readonly THREE.Vector3[],
  teamColors: number[],
  title: string,
): { group: THREE.Group; disposables: { dispose(): void }[] } {
  const group = new THREE.Group();
  group.name = 'PitBuilding';
  const disposables: { dispose(): void }[] = [];
  if (typeof document === 'undefined') return { group, disposables };

  const k0 = pit.limiterStart;
  const k1 = pit.limiterEnd;
  // Cumulative distance along the lane (u coordinate, m).
  const dist: number[] = [0];
  for (let k = k0 + 1; k <= k1; k++) dist.push(dist[dist.length - 1] + pit.path[k].distanceTo(pit.path[k - 1]));
  const length = dist[dist.length - 1];
  // Text and garages must read left to right from the lane: along -t when the pits are on the right.
  const uOf = (d: number) => (pit.side > 0 ? length - d : d) / length;
  const at = (k: number, depth: number, y: number) =>
    pit.path[k].clone().addScaledVector(rights[pit.pathIndex[k]], pit.side * (PIT_BUILDING_FRONT + depth)).setY(y);

  // --- facade canvas: row 0 = garages (GROUND_H), row 1 = roof fascia ---------
  const W = Math.min(8192, Math.ceil(length * PX_PER_M));
  const sx = W / length;
  const gH = Math.round(GROUND_H * PX_PER_M);
  const fH = Math.round(FASCIA_H * PX_PER_M);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = gH + fH;
  const g = canvas.getContext('2d')!;
  // Concrete frame with closed shutters everywhere...
  g.fillStyle = '#d9d9d4';
  g.fillRect(0, 0, W, gH);
  const bay = 6;
  for (let x = 0; x < length; x += bay) {
    const px = x * sx;
    g.fillStyle = '#9ea3a8';
    g.fillRect(px + 0.4 * sx, 0.6 * PX_PER_M, (bay - 0.8) * sx, gH - 0.6 * PX_PER_M);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0.7 * PX_PER_M; y < gH; y += 4) g.fillRect(px + 0.4 * sx, y, (bay - 0.8) * sx, 1);
  }
  // ...and an open, lit garage for every team at its box.
  pit.boxes.forEach((k, t) => {
    const d = dist[Math.max(0, Math.min(dist.length - 1, k - k0))];
    const center = pit.side > 0 ? length - d : d;
    const color = `#${new THREE.Color(teamColors[t % teamColors.length]).getHexString()}`;
    const x0 = (center - GARAGE_W / 2) * sx;
    const w = GARAGE_W * sx;
    g.fillStyle = '#e8e8e4';
    g.fillRect(x0 - 0.5 * sx, 0, w + sx, gH);
    // Interior: bright floor-to-ceiling gradient, team back wall, overhead lights.
    const grad = g.createLinearGradient(0, 0.5 * PX_PER_M, 0, gH);
    grad.addColorStop(0, '#f6f6f2');
    grad.addColorStop(1, '#8c8f94');
    g.fillStyle = grad;
    g.fillRect(x0, 0.5 * PX_PER_M, w, gH - 0.5 * PX_PER_M);
    g.fillStyle = color;
    g.fillRect(x0 + 0.08 * w, 1.0 * PX_PER_M, w * 0.84, gH * 0.5);
    g.fillStyle = '#ffffff';
    g.fillRect(x0 + 0.08 * w, 1.0 * PX_PER_M + gH * 0.5, w * 0.84, 3);
    for (let j = 0; j < 5; j++) g.fillRect(x0 + (0.1 + j * 0.18) * w, 0.62 * PX_PER_M, 0.12 * w, 3);
    // Team colour header above the opening.
    g.fillStyle = color;
    g.fillRect(x0 - 0.5 * sx, 0, w + sx, 0.5 * PX_PER_M);
  });
  // Fascia: white band with the circuit name repeated and coloured rules.
  g.fillStyle = '#f4f4f2';
  g.fillRect(0, gH, W, fH);
  g.fillStyle = '#c8102e';
  g.fillRect(0, gH + fH - 4, W, 4);
  g.fillStyle = '#00843d';
  g.fillRect(0, gH, W, 3);
  g.fillStyle = '#1a1a1a';
  g.font = `900 ${Math.round(fH * 0.62)}px "Arial Black", Arial, sans-serif`;
  g.textBaseline = 'middle';
  const label = `${title.toUpperCase()}     `;
  const step = g.measureText(label).width;
  for (let x = 20; x < W; x += step) g.fillText(label, x, gH + fH / 2 + 1);
  const facadeTex = new THREE.CanvasTexture(canvas);
  facadeTex.colorSpace = THREE.SRGBColorSpace;
  facadeTex.anisotropy = 8;
  const vGround = [fH / (gH + fH), 1];
  const vFascia = [0, fH / (gH + fH)];

  // Glass: dark reflective panes with light mullions every 2 m.
  const gc = document.createElement('canvas');
  gc.width = 64;
  gc.height = 128;
  const gg = gc.getContext('2d')!;
  const glassGrad = gg.createLinearGradient(0, 0, 0, 128);
  glassGrad.addColorStop(0, '#3a4a5c');
  glassGrad.addColorStop(1, '#16202b');
  gg.fillStyle = glassGrad;
  gg.fillRect(0, 0, 64, 128);
  gg.fillStyle = '#c9ccd0';
  gg.fillRect(0, 0, 3, 128);
  gg.fillRect(0, 0, 64, 4);
  gg.fillRect(0, 84, 64, 3);
  const glassTex = new THREE.CanvasTexture(gc);
  glassTex.colorSpace = THREE.SRGBColorSpace;
  glassTex.wrapS = THREE.RepeatWrapping;
  glassTex.anisotropy = 8;

  // --- geometry ------------------------------------------------------------
  const soups = { facade: new Soup(), glass: new Soup(), white: new Soup(), concrete: new Soup() };
  const outward = (k: number) => rights[pit.pathIndex[k]].clone().multiplyScalar(pit.side);
  const lane = (k: number) => outward(k).negate();
  const down = new THREE.Vector3(0, -1, 0);
  const upV = new THREE.Vector3(0, 1, 0);
  for (let k = k0; k < k1; k++) {
    const u0 = dist[k - k0];
    const u1 = dist[k - k0 + 1];
    const f0 = uOf(u0);
    const f1 = uOf(u1);
    const face = lane(k);
    // Ground floor garages.
    soups.facade.quad(at(k, 0, 0), at(k + 1, 0, 0), at(k + 1, 0, GROUND_H), at(k, 0, GROUND_H), [f0, vGround[0], f1, vGround[0], f1, vGround[1], f0, vGround[1]], face);
    // Slab between floors, cantilevered over the lane.
    soups.white.quad(at(k, -CANTILEVER, GROUND_H), at(k + 1, -CANTILEVER, GROUND_H), at(k + 1, -CANTILEVER, UPPER_Y0), at(k, -CANTILEVER, UPPER_Y0), FULL, face);
    soups.white.quad(at(k, -CANTILEVER, GROUND_H), at(k + 1, -CANTILEVER, GROUND_H), at(k + 1, 0, GROUND_H), at(k, 0, GROUND_H), FULL, down);
    // Glass hospitality floor (uv u in panes of 2 m).
    soups.glass.quad(at(k, -CANTILEVER, UPPER_Y0), at(k + 1, -CANTILEVER, UPPER_Y0), at(k + 1, -CANTILEVER, UPPER_Y1), at(k, -CANTILEVER, UPPER_Y1), [u0 / 2, 0, u1 / 2, 0, u1 / 2, 1, u0 / 2, 1], face);
    soups.white.quad(at(k, -CANTILEVER, UPPER_Y1), at(k + 1, -CANTILEVER, UPPER_Y1), at(k + 1, -CANTILEVER, ROOF_Y), at(k, -CANTILEVER, ROOF_Y), FULL, face);
    // Roof: overhang soffit, fascia with the circuit name, top.
    soups.white.quad(at(k, -ROOF_OVERHANG, ROOF_Y), at(k + 1, -ROOF_OVERHANG, ROOF_Y), at(k + 1, -CANTILEVER, ROOF_Y), at(k, -CANTILEVER, ROOF_Y), FULL, down);
    soups.facade.quad(at(k, -ROOF_OVERHANG, ROOF_Y), at(k + 1, -ROOF_OVERHANG, ROOF_Y), at(k + 1, -ROOF_OVERHANG, ROOF_Y + FASCIA_H), at(k, -ROOF_OVERHANG, ROOF_Y + FASCIA_H), [f0, vFascia[0], f1, vFascia[0], f1, vFascia[1], f0, vFascia[1]], face);
    soups.white.quad(at(k, -ROOF_OVERHANG, ROOF_Y + FASCIA_H), at(k + 1, -ROOF_OVERHANG, ROOF_Y + FASCIA_H), at(k + 1, PIT_BUILDING_DEPTH, ROOF_Y + FASCIA_H), at(k, PIT_BUILDING_DEPTH, ROOF_Y + FASCIA_H), FULL, upV);
    // Back wall.
    soups.concrete.quad(at(k, PIT_BUILDING_DEPTH, 0), at(k + 1, PIT_BUILDING_DEPTH, 0), at(k + 1, PIT_BUILDING_DEPTH, ROOF_Y + FASCIA_H), at(k, PIT_BUILDING_DEPTH, ROOF_Y + FASCIA_H), FULL, outward(k));
  }
  // End walls.
  for (const [k, dir] of [
    [k0, -1],
    [k1, 1],
  ] as const) {
    const t = pit.path[Math.min(k + 1, pit.path.length - 1)].clone().sub(pit.path[Math.max(k - 1, 0)]).normalize().multiplyScalar(dir);
    soups.concrete.quad(at(k, -ROOF_OVERHANG, 0), at(k, PIT_BUILDING_DEPTH, 0), at(k, PIT_BUILDING_DEPTH, ROOF_Y + FASCIA_H), at(k, -ROOF_OVERHANG, ROOF_Y + FASCIA_H), FULL, t);
  }

  const facadeMat = new THREE.MeshStandardMaterial({ map: facadeTex, roughness: 0.75, emissive: 0xffffff, emissiveMap: facadeTex, emissiveIntensity: 0.12 });
  const glassMat = new THREE.MeshStandardMaterial({ map: glassTex, roughness: 0.06, metalness: 0.85, envMapIntensity: 1.4 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf1f1ee, roughness: 0.6 });
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.9 });
  disposables.push(facadeTex, glassTex, facadeMat, glassMat, whiteMat, concreteMat);
  const add = (soup: Soup, mat: THREE.Material, name: string) => {
    const geo = soup.build();
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(geo);
  };
  add(soups.facade, facadeMat, 'PitGarages');
  add(soups.glass, glassMat, 'PitGlass');
  add(soups.white, whiteMat, 'PitWhite');
  add(soups.concrete, concreteMat, 'PitConcrete');
  return { group, disposables };
}

const FULL = [0, 0, 1, 0, 1, 1, 0, 1];

/** Triangle soup whose quads are wound to face a given direction. */
class Soup {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uv: number[], facing: THREE.Vector3): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
    let order = [0, 1, 2, 0, 2, 3];
    if (n.dot(facing) < 0) {
      order = [0, 2, 1, 0, 3, 2];
      n.negate();
    }
    const v = [a, b, c, d];
    for (const i of order) {
      this.pos.push(v[i].x, v[i].y, v[i].z);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(uv[i * 2], uv[i * 2 + 1]);
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
