import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TiledInstances } from './TiledInstances';
import { QUALITY } from '../performance/Quality';

/**
 * Spectators: instanced low-poly people that bounce ("cheer") in the vertex
 * shader, and stepped grandstands (tribunes) to seat them on.
 *
 * Shirt colors come from per-instance colors; skin/hair are vertex colors
 * that the instance tint does not touch (a `shirt` vertex attribute selects
 * which vertices get tinted), so one draw call per tile covers everything.
 */

export interface TribuneSpec {
  /** Center of the footprint on the ground. */
  x: number;
  z: number;
  /** Rotation about Y; after it, local -X faces the track. */
  yaw: number;
  /** Along the track (m). */
  length: number;
  /** Away from the track (m). */
  depth: number;
  /** Height of the top row (m). */
  height: number;
  /** Ground height under the stand (elevated circuits; default 0). */
  y?: number;
}

export interface CrowdSeat {
  matrix: THREE.Matrix4;
  color: THREE.Color;
}

const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
export const SHIRTS = [0xe10600, 0xffffff, 0x1e5bc6, 0xffd700, 0x00a19c, 0xff8700, 0x111111, 0xf596c8, 0x52e252, 0x9b59b6];

/** Shared material with the cheering animation; call `setTime` every frame. */
export class CrowdMaterial extends THREE.MeshStandardMaterial {
  private readonly uniforms = { uTime: { value: 0 } };

  constructor() {
    super({ vertexColors: true, roughness: 0.9 });
    this.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float shirt;
          uniform float uTime;`,
        )
        .replace(
          '#include <color_vertex>',
          // vColor is a vec4 since three r16x.
          `vColor = vec4(1.0);
          vColor.rgb *= color.rgb;
          #ifdef USE_INSTANCING_COLOR
            vColor.rgb *= mix(vec3(1.0), instanceColor.xyz, shirt);
          #endif`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            float id = float(gl_InstanceID);
            // Groups of fans jump at different moments; most of the time a small sway.
            float phase = uTime * (5.0 + mod(id, 3.0)) + id * 1.37;
            float jump = max(0.0, sin(phase)) * (0.06 + 0.14 * step(0.7, fract(sin(id * 12.9898) * 43758.5)));
            transformed.y += jump;
          #endif`,
        );
    };
    this.customProgramCacheKey = () => 'crowd-v1';
  }

  setTime(t: number): void {
    this.uniforms.uTime.value = t;
  }
}

function part(geo: THREE.BufferGeometry, color: number, shirt: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new THREE.Color(color);
  const colors = new Float32Array(n * 3);
  const shirts = new Float32Array(n).fill(shirt);
  for (let i = 0; i < n; i++) c.toArray(colors, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('shirt', new THREE.BufferAttribute(shirts, 1));
  return g;
}

/** A seated fan facing -Z, origin at the seat. Detailed and far versions. */
export function personGeometries(skin = SKIN[1]): { hi: THREE.BufferGeometry; lo: THREE.BufferGeometry } {
  const hi = mergeGeometries([
    part(new THREE.BoxGeometry(0.42, 0.5, 0.26).translate(0, 0.42, 0), 0xffffff, 1), // torso (shirt)
    part(new THREE.IcosahedronGeometry(0.12, 0).translate(0, 0.82, -0.02), skin, 0), // head
    part(new THREE.BoxGeometry(0.4, 0.14, 0.42).translate(0, 0.1, -0.12), 0x2b2f3a, 0), // legs (jeans)
    part(new THREE.BoxGeometry(0.1, 0.42, 0.1).translate(-0.27, 0.78, -0.05), 0xffffff, 1), // raised arms
    part(new THREE.BoxGeometry(0.1, 0.42, 0.1).translate(0.27, 0.78, -0.05), 0xffffff, 1),
  ])!;
  const lo = mergeGeometries([
    part(new THREE.BoxGeometry(0.42, 0.62, 0.3).translate(0, 0.45, 0), 0xffffff, 1),
    part(new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(0, 0.86, 0), skin, 0),
  ])!;
  return { hi, lo };
}

/**
 * Builds a stepped grandstand mesh (seating + back wall + roof) and returns
 * the seat transforms (world space) for the crowd.
 */
export function buildTribune(
  spec: TribuneSpec,
  materials: { concrete: THREE.Material; seats: THREE.Material; roof: THREE.Material },
  rand: () => number,
  occupancy = 0.8,
): { group: THREE.Group; seats: CrowdSeat[]; disposables: { dispose(): void }[] } {
  const group = new THREE.Group();
  group.name = 'Tribune';
  const disposables: { dispose(): void }[] = [];
  const rows = Math.max(3, Math.min(18, Math.floor(spec.depth / 0.9)));
  const stepDepth = spec.depth / rows;
  const stepRise = Math.max(0.35, Math.min(0.6, spec.height / rows));

  // Stepped profile in the (x = away from track, y = up) plane, extruded along Z (length).
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  for (let k = 0; k < rows; k++) {
    shape.lineTo(k * stepDepth, (k + 1) * stepRise);
    shape.lineTo((k + 1) * stepDepth, (k + 1) * stepRise);
  }
  shape.lineTo(rows * stepDepth, 0);
  shape.lineTo(0, 0);
  const seating = new THREE.ExtrudeGeometry(shape, { depth: spec.length, bevelEnabled: false });
  seating.translate(-spec.depth / 2, 0, -spec.length / 2);
  disposables.push(seating);
  // Row shading: treads (seats) alternate light/dark per row, risers are darker,
  // so the stand reads as rows of seats instead of one block.
  {
    const pos = seating.attributes.position as THREE.BufferAttribute;
    const nrm = seating.attributes.normal as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i += 3) {
      const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
      const row = Math.floor(y / stepRise - 0.01);
      const tread = Math.abs(nrm.getY(i)) > 0.5;
      const shade = tread ? (row % 2 === 0 ? 1 : 0.86) : 0.55;
      for (let k = 0; k < 3; k++) colors.set([shade, shade, shade], (i + k) * 3);
    }
    seating.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const seatMesh = new THREE.Mesh(seating, materials.seats);
  seatMesh.castShadow = seatMesh.receiveShadow = true;
  group.add(seatMesh);

  const top = rows * stepRise;
  const wall = new THREE.BoxGeometry(0.4, top + 3, spec.length).translate(spec.depth / 2, (top + 3) / 2, 0);
  const roof = new THREE.BoxGeometry(spec.depth + 2, 0.25, spec.length + 1).translate(-0.5, top + 3.2, 0);
  disposables.push(wall, roof);
  const wallMesh = new THREE.Mesh(wall, materials.concrete);
  const roofMesh = new THREE.Mesh(roof, materials.roof);
  roofMesh.rotation.z = -0.05;
  wallMesh.castShadow = roofMesh.castShadow = true;
  group.add(wallMesh, roofMesh);
  // Steel columns along the front edge, a fascia board under the roof edge
  // and closed ends: the details that make it read as a building.
  const parts: THREE.BufferGeometry[] = [];
  const colH = top + 3.2;
  const columns = Math.max(2, Math.round(spec.length / 9) + 1);
  for (let c = 0; c < columns; c++) {
    const z = -spec.length / 2 + 0.3 + (c / (columns - 1)) * (spec.length - 0.6);
    parts.push(new THREE.CylinderGeometry(0.12, 0.14, colH, 8).translate(-spec.depth / 2 - 0.6, colH / 2, z));
  }
  parts.push(new THREE.BoxGeometry(0.15, 0.8, spec.length + 1).translate(-spec.depth / 2 - 1.45, top + 3.0, 0));
  const steel = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  const ends = mergeGeometries([-1, 1].map((side) => {
    const g = new THREE.ShapeGeometry(shape);
    g.translate(-spec.depth / 2, 0, side * (spec.length / 2 + 0.01));
    return g;
  }))!;
  disposables.push(steel, ends);
  const steelMesh = new THREE.Mesh(steel, materials.roof);
  steelMesh.castShadow = true;
  const endMesh = new THREE.Mesh(ends, materials.concrete);
  (endMesh.material as THREE.Material).side = THREE.DoubleSide;
  group.add(steelMesh, endMesh);

  group.position.set(spec.x, spec.y ?? 0, spec.z);
  group.rotation.y = spec.yaw;
  group.updateMatrixWorld(true);

  // Seats: one row per step, facing the track (local -X).
  const seats: CrowdSeat[] = [];
  const faceTrack = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2); // -Z -> -X
  const local = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const spacing = 0.62;
  const perRow = Math.floor((spec.length - 1) / spacing);
  for (let k = 0; k < rows; k++) {
    for (let i = 0; i < perRow; i++) {
      if (rand() > occupancy) continue;
      pos.set(-spec.depth / 2 + (k + 0.55) * stepDepth, (k + 1) * stepRise, -spec.length / 2 + 0.5 + i * spacing + (rand() - 0.5) * 0.1);
      local.compose(pos, faceTrack, one);
      const shirt = new THREE.Color(SHIRTS[Math.floor(rand() * SHIRTS.length)]);
      seats.push({ matrix: new THREE.Matrix4().multiplyMatrices(group.matrixWorld, local), color: shirt });
    }
  }
  return { group, seats, disposables };
}

/** All spectators as tiled, LOD'd instances (near: detailed, far: blocks, very far: none). */
export function buildCrowd(all: CrowdSeat[], material: CrowdMaterial): { group: THREE.Group; disposables: { dispose(): void }[] } {
  const { hi, lo } = personGeometries();
  // Weaker devices fill fewer seats (evenly spread: golden-ratio sampling keeps every stand populated).
  const seats = QUALITY.crowd >= 1 ? all : all.filter((_, i) => ((i * 0.6180339887) % 1) < QUALITY.crowd);
  const tiles = new TiledInstances(
    [
      { geometry: hi, material, distance: 0 },
      { geometry: lo, material, distance: 90 },
      { geometry: null, material: null, distance: 450 },
    ],
    seats.map((s) => s.matrix),
    seats.map((s) => s.color),
    { name: 'Crowd', tileSize: 120 },
  );
  return { group: tiles.group, disposables: [hi, lo] };
}

/**
 * F1 fans wear their team's colours and sit together: seats are grouped in
 * ~7 m blocks, each block mostly one team (a few neutral or other shirts mixed
 * in). The home crowd gets extra weight: tifosi at Monza, the Dutch orange
 * army at Spa, Honda / Red Bull fans at Suzuka.
 */
const FAN_TEAMS: { id: string; colors: number[]; weight: number }[] = [
  { id: 'ferrari', colors: [0xdc0000, 0xdc0000, 0xffd200], weight: 18 },
  { id: 'mclaren', colors: [0xff8000, 0xff8000, 0x111111], weight: 12 },
  { id: 'redbull', colors: [0x1e2a5a, 0x1e2a5a, 0xd0021b], weight: 11 },
  { id: 'mercedes', colors: [0x111111, 0x00d2be, 0xc0c4c8], weight: 11 },
  { id: 'aston', colors: [0x00594f, 0x00594f, 0xcedc00], weight: 6 },
  { id: 'alpine', colors: [0x0a5cd6, 0xff5fae], weight: 5 },
  { id: 'williams', colors: [0x0d2a62, 0x00a3e0], weight: 5 },
  { id: 'haas', colors: [0xf4f4f4, 0xd0021b, 0x1a1a1a], weight: 3 },
  { id: 'racingbulls', colors: [0xf3f3f5, 0x1d3fa6], weight: 3 },
  { id: 'audi', colors: [0x8e959c, 0xe2003c, 0x141518], weight: 4 },
  { id: 'dutch', colors: [0xff6a00, 0xff6a00, 0xff8a1a], weight: 0 },
  { id: 'neutral', colors: [0xf2f2f2, 0x1b1b1b, 0x6b6f75, 0x3b5a8a, 0xb9a27c], weight: 14 },
];
const HOME_CROWD: Record<string, Record<string, number>> = {
  monza: { ferrari: 4 },
  spa: { dutch: 14, redbull: 1.4 },
  zandvoort: { dutch: 30 },
  suzuka: { redbull: 1.6, racingbulls: 2.5, aston: 1.5 },
  silverstone: { mercedes: 1.6, mclaren: 1.8, williams: 1.8 },
  melbourne: { mclaren: 2.2 },
  montreal: { aston: 2, ferrari: 1.3 },
  catalunya: { aston: 2.5, williams: 2 },
  spielberg: { redbull: 2.5, dutch: 8 },
  budapest: { dutch: 6 },
  mexicocity: { redbull: 1.5 },
  saopaulo: { audi: 3 },
  austin: { haas: 3 },
  madrid: { aston: 2.5, williams: 2.5 },
};

export function dressFans(seats: CrowdSeat[], trackId: string, seed = 7): void {
  const boost = HOME_CROWD[trackId] ?? {};
  const teams = FAN_TEAMS.map((t) => ({ ...t, weight: t.id in boost ? (t.weight || 1) * boost[t.id] : t.weight }));
  const total = teams.reduce((a, t) => a + t.weight, 0);
  const pick = (r: number) => {
    let x = r * total;
    for (const t of teams) if ((x -= t.weight) <= 0) return t;
    return teams[teams.length - 1];
  };
  const hash = (a: number, b: number) => {
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ seed) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  };
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (const seat of seats) {
    const e = seat.matrix.elements;
    const block = pick(hash(Math.floor(e[12] / 7), Math.floor(e[14] / 7)));
    const team = rand() < 0.72 ? block : pick(rand());
    seat.color.setHex(team.colors[Math.floor(rand() * team.colors.length)]);
  }
}
