import * as THREE from 'three';
import type { TerrainStyle } from './themes';

/** Flat land kept around the circuit (m beyond the track bounds): OSM buildings and the grass plane live here. */
const FLAT_MARGIN = 900;
/** How far the landscape reaches beyond the flat zone (m). */
const EXTENT = 14000;
const GRID = 220;
/** Flat part sits just under the grass plane so the plane wins near the track. */
const FLAT_Y = -0.4;

function hash(x: number, z: number, seed: number): number {
  let h = (x * 374761393 + z * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash(xi, zi, seed);
  const b = hash(xi + 1, zi, seed);
  const c = hash(xi, zi + 1, seed);
  const d = hash(xi + 1, zi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal noise in 0..1; ridged = sharp crests (mountain ranges). */
function fbm(x: number, z: number, seed: number, ridged: boolean): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < 5; o++) {
    let n = valueNoise(x * f, z * f, seed + o * 17);
    if (ridged) n = 1 - Math.abs(2 * n - 1);
    sum += n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Distant landscape around a circuit: flat where the track and its real
 * surroundings are, rising into hills or mountains towards the horizon.
 * One vertex-colored mesh (meadows, woods, rock), no textures, no shadows —
 * replaces the flat green plane that used to meet the sky at the horizon.
 */
export function buildTerrain(bounds: THREE.Box3, style: TerrainStyle, seed = 7): THREE.Mesh {
  const minX = bounds.min.x - FLAT_MARGIN;
  const maxX = bounds.max.x + FLAT_MARGIN;
  const minZ = bounds.min.z - FLAT_MARGIN;
  const maxZ = bounds.max.z + FLAT_MARGIN;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const w = maxX - minX + EXTENT * 2;
  const d = maxZ - minZ + EXTENT * 2;

  const geo = new THREE.PlaneGeometry(w, d, GRID, GRID);
  geo.rotateX(-Math.PI / 2);
  geo.translate(cx, 0, cz);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const heights = new Float32Array(pos.count);
  const woods = new Float32Array(pos.count);
  const s = 1 / style.scale;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Distance outside the flat rectangle (0 inside).
    const dx = Math.max(minX - x, 0, x - maxX);
    const dz = Math.max(minZ - z, 0, z - maxZ);
    const dist = Math.hypot(dx, dz);
    const rise = smooth(0, style.ramp, dist);
    // Low base swell + detailed relief; far ranges a bit taller.
    const relief = fbm(x * s, z * s, seed, style.ridged);
    const swell = valueNoise(x * s * 0.25, z * s * 0.25, seed + 99);
    const h = style.height * rise * (0.25 + 0.75 * relief) * (0.6 + 0.6 * swell);
    heights[i] = h;
    pos.setY(i, rise > 0 ? FLAT_Y + h : FLAT_Y);
    woods[i] = fbm(x / 420, z / 420, seed + 50, false);
  }
  geo.computeVertexNormals();

  const normal = geo.attributes.normal as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const meadow = new THREE.Color(style.meadow);
  const wood = new THREE.Color(style.woods);
  const rock = new THREE.Color(style.rock);
  const c = new THREE.Color();
  const forestCut = 1 - style.forest;
  for (let i = 0; i < pos.count; i++) {
    const hf = style.height > 0 ? heights[i] / style.height : 0;
    const slope = 1 - normal.getY(i);
    // Woods: noise patches, more likely on slopes, thinning out near the tree line.
    const woodAmount = smooth(forestCut * 0.55 - 0.05, forestCut * 0.55 + 0.08, woods[i] * 0.6 + slope * 1.2) * (1 - smooth(style.rockLine - 0.15, style.rockLine, hf));
    c.copy(meadow).lerp(wood, woodAmount);
    const rockAmount = Math.max(smooth(style.rockLine - 0.08, style.rockLine + 0.08, hf), smooth(0.35, 0.6, slope) * 0.8);
    c.lerp(rock, rockAmount);
    // Slight brightness variation breaks up flat color.
    c.multiplyScalar(0.9 + hash(i, 3, seed) * 0.15);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.deleteAttribute('uv');

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  mesh.name = 'Terrain';
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
