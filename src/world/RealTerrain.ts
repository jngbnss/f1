import * as THREE from 'three';

/**
 * Baked real-world surroundings of a circuit (scripts/fetch-terrain.ts):
 * Copernicus DEM heights + Sentinel-2 cloudless imagery, in world meters.
 */
type Rect = [number, number, number, number];
interface HeightGrid {
  rect: Rect;
  size: number;
  scale: number;
}

export interface RealTerrainMeta {
  attribution: string;
  baseHeight: number;
  /** Per-channel median color of the near image (sRGB 0..1). */
  near: { rect: Rect; median: [number, number, number] };
  far: { rect: Rect };
  dem: HeightGrid;
  /** Finer grid around the track (optional). */
  demNear?: HeightGrid;
}

export interface RealTerrain {
  id: string;
  meta: RealTerrainMeta;
  heights: Int16Array;
  nearHeights: Int16Array | null;
}

/** Short credit line for the HUD (full text in terrain.json / README). */
export const REAL_TERRAIN_CREDIT = 'Imagery: EOxCloudless 2016 by EOX (Copernicus Sentinel data, CC BY 4.0) · DEM: Copernicus GLO-30';

/** Loads heights + metadata; null when the circuit has no baked terrain. */
export async function loadRealTerrain(baseUrl: string, id: string): Promise<RealTerrain | null> {
  const dir = `${baseUrl}terrain/${id}/`;
  try {
    const [metaRes, demRes, nearRes] = await Promise.all([fetch(`${dir}terrain.json`), fetch(`${dir}dem.bin`), fetch(`${dir}dem_near.bin`)]);
    // Vite's dev server answers unknown paths with index.html: check the type too.
    if (!metaRes.ok || !demRes.ok || !(metaRes.headers.get('content-type') ?? '').includes('json')) return null;
    const meta = (await metaRes.json()) as RealTerrainMeta;
    const nearHeights = meta.demNear && nearRes.ok ? new Int16Array(await nearRes.arrayBuffer()) : null;
    return { id, meta, heights: new Int16Array(await demRes.arrayBuffer()), nearHeights };
  } catch {
    return null;
  }
}

/** Bilinear sample of a row-major grid spanning `rect` (clamped at the edges). */
function sampleGrid(values: ArrayLike<number>, rect: Rect, n: number, x: number, z: number): number {
  const [x0, z0, x1, z1] = rect;
  const fx = Math.min(Math.max(((x - x0) / (x1 - x0)) * (n - 1), 0), n - 1.001);
  const fz = Math.min(Math.max(((z - z0) / (z1 - z0)) * (n - 1), 0), n - 1.001);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  return (values[j * n + i] * (1 - u) + values[j * n + i + 1] * u) * (1 - v) + (values[(j + 1) * n + i] * (1 - u) + values[(j + 1) * n + i + 1] * u) * v;
}

/** Satellite image as a texture whose UV (0..1) maps straight onto its world rect (no flip). */
export async function loadSatellite(baseUrl: string, t: RealTerrain, which: 'near' | 'far', renderer: THREE.WebGLRenderer): Promise<THREE.Texture> {
  const tex = await new THREE.TextureLoader().loadAsync(`${baseUrl}terrain/${t.id}/${which}.jpg`);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}

/** Ground stays flat (track height) this close to the centerline (m)... */
const DRAPE_START = 130;
/** ...and follows the real relief fully from here on. */
const DRAPE_FULL = 450;
/** Resolution of the precomputed grids around the track. */
const GRID = 257;

const smoothstep = (e0: number, e1: number, x: number) => {
  const k = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return k * k * (3 - 2 * k);
};

/**
 * Distance (m) from every cell of a grid over `rect` to the nearest
 * centerline point: exact for the cells the line passes, then a two-pass
 * chamfer transform (a few % off true Euclidean — plenty for blending).
 */
function distanceGrid(rect: Rect, n: number, centerline: readonly THREE.Vector3[]): Float32Array {
  const [x0, z0, x1, z1] = rect;
  const cx = (x1 - x0) / (n - 1);
  const cz = (z1 - z0) / (n - 1);
  const d = new Float32Array(n * n).fill(1e9);
  for (const p of centerline) {
    const i = Math.round((p.x - x0) / cx);
    const j = Math.round((p.z - z0) / cz);
    for (let b = j - 1; b <= j + 1; b++)
      for (let a = i - 1; a <= i + 1; a++) {
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        const dist = Math.hypot(x0 + a * cx - p.x, z0 + b * cz - p.z);
        if (dist < d[b * n + a]) d[b * n + a] = dist;
      }
  }
  const diag = Math.hypot(cx, cz);
  const relax = (k: number, other: number, w: number) => {
    if (d[other] + w < d[k]) d[k] = d[other] + w;
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (i > 0) relax(k, k - 1, cx);
      if (j > 0) relax(k, k - n, cz);
      if (i > 0 && j > 0) relax(k, k - n - 1, diag);
      if (i < n - 1 && j > 0) relax(k, k - n + 1, diag);
    }
  for (let j = n - 1; j >= 0; j--)
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      if (i < n - 1) relax(k, k + 1, cx);
      if (j < n - 1) relax(k, k + n, cz);
      if (i < n - 1 && j < n - 1) relax(k, k + n + 1, diag);
      if (i > 0 && j < n - 1) relax(k, k + n - 1, diag);
    }
  return d;
}

export interface Ground {
  /** Ground height (m) relative to the flat track at a world position. */
  height(x: number, z: number): number;
  /** Distance (m) to the track, valid inside the near rect (capped outside). */
  distance(x: number, z: number): number;
}

/**
 * Ground around a flat track. The game's track has no elevation, but the
 * real one does (Spa: ±50 m), so the landscape is placed relative to the
 * *nearby* track height: a smooth field interpolated from the real heights
 * along the centerline. Next to the track the ground is flat; from
 * DRAPE_START to DRAPE_FULL meters it blends into the real relief.
 * Everything around the track is precomputed on grids, so sampling is cheap.
 */
export function groundField(t: RealTerrain, centerline: readonly THREE.Vector3[]): Ground {
  const far = t.meta.dem;
  const nearGrid = t.meta.demNear && t.nearHeights ? t.meta.demNear : null;
  const raw = (x: number, z: number) => {
    if (nearGrid) {
      const [x0, z0, x1, z1] = nearGrid.rect;
      if (x > x0 && x < x1 && z > z0 && z < z1) return sampleGrid(t.nearHeights!, nearGrid.rect, nearGrid.size, x, z) * nearGrid.scale;
    }
    return sampleGrid(t.heights, far.rect, far.size, x, z) * far.scale;
  };

  // Track height field: inverse-distance weights over centerline samples, on a coarse grid.
  const samples = centerline.filter((_, i) => i % 8 === 0).map((p) => ({ x: p.x, z: p.z, h: raw(p.x, p.z) }));
  const N = 64;
  const farRect = t.meta.far.rect;
  const base = new Float32Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = farRect[0] + (i / (N - 1)) * (farRect[2] - farRect[0]);
      const z = farRect[1] + (j / (N - 1)) * (farRect[3] - farRect[1]);
      let sw = 0;
      let sh = 0;
      for (const s of samples) {
        const w = 1 / ((s.x - x) ** 2 + (s.z - z) ** 2 + 250 * 250);
        sw += w;
        sh += w * s.h;
      }
      base[j * N + i] = sh / sw;
    }
  const relief = (x: number, z: number) => raw(x, z) - sampleGrid(base, farRect, N, x, z);

  // Near the track: distance + final height on one grid (DRAPE_FULL < the near margin).
  const nearRect = t.meta.near.rect;
  const dist = distanceGrid(nearRect, GRID, centerline);
  const height = new Float32Array(GRID * GRID);
  for (let j = 0; j < GRID; j++)
    for (let i = 0; i < GRID; i++) {
      const k = j * GRID + i;
      const x = nearRect[0] + (i / (GRID - 1)) * (nearRect[2] - nearRect[0]);
      const z = nearRect[1] + (j / (GRID - 1)) * (nearRect[3] - nearRect[1]);
      height[k] = smoothstep(DRAPE_START, DRAPE_FULL, dist[k]) * relief(x, z);
    }
  const inNear = (x: number, z: number) => x > nearRect[0] && x < nearRect[2] && z > nearRect[1] && z < nearRect[3];
  return {
    height: (x, z) => (inNear(x, z) ? sampleGrid(height, nearRect, GRID, x, z) : relief(x, z)),
    distance: (x, z) => (inNear(x, z) ? sampleGrid(dist, nearRect, GRID, x, z) : DRAPE_FULL * 4),
  };
}

/**
 * Mask for the satellite tint: 0 near the track, 1 from `far` meters away.
 * At 10 m per satellite pixel the track's surroundings are a blur of asphalt,
 * gravel and car parks, which would turn the verge beige; the theme's grass
 * color stays there and real ground colors take over further out.
 */
export function trackMask(t: RealTerrain, ground: Ground, near = 60, far = 200, size = 256): THREE.DataTexture {
  const [x0, z0, x1, z1] = t.meta.near.rect;
  const data = new Uint8Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const d = ground.distance(x0 + ((i + 0.5) / size) * (x1 - x0), z0 + ((j + 0.5) / size) * (z1 - z0));
      data[j * size + i] = Math.round(smoothstep(near, far, d) * 255);
    }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Tints a detail-textured ground material with satellite colors: the tiling
 * photo texture and the theme tint keep the close-up look, the satellite
 * image shifts every patch towards its real color (meadow, field, forest
 * floor, dry grass...) relative to the area's median color.
 */
export function applySatelliteTint(material: THREE.MeshStandardMaterial, satellite: THREE.Texture, mask: THREE.Texture, t: RealTerrain): void {
  const [x0, z0, x1, z1] = t.meta.near.rect;
  const median = new THREE.Vector3(...t.meta.near.median.map((c) => Math.max(Math.pow(c, 2.2), 1e-3)));
  // Chain onto any existing patch (GroundShading's mowing stripes / patches) instead of replacing it.
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.satMap = { value: satellite };
    shader.uniforms.satMask = { value: mask };
    shader.uniforms.satRect = { value: new THREE.Vector4(x0, z0, x1 - x0, z1 - z0) };
    shader.uniforms.satMedian = { value: median };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 satRect;\nvarying vec2 vSatUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSatUv = ((modelMatrix * vec4(transformed, 1.0)).xz - satRect.xy) / satRect.zw;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D satMap;\nuniform sampler2D satMask;\nuniform vec3 satMedian;\nvarying vec2 vSatUv;')
      .replace(
        '#include <map_fragment>',
        '#include <map_fragment>\nvec3 satRatio = clamp(texture2D(satMap, vSatUv).rgb / satMedian, 0.45, 1.7);\ndiffuseColor.rgb *= mix(vec3(1.0), satRatio, texture2D(satMask, vSatUv).r * 0.85);',
      );
  };
  material.customProgramCacheKey = () => `${previousKey}+satellite-tint`;
  material.needsUpdate = true;
}

/** Lays flat scenery (ground plane, OSM buildings, roads, water) onto the ground. */
export function drapeOnGround(root: THREE.Object3D, height: (x: number, z: number) => number): void {
  root.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
    const pos = o.geometry.attributes.position as THREE.BufferAttribute;
    // Scenery meshes are only translated, so a world y offset is the same local y offset.
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      pos.setY(i, pos.getY(i) + height(p.x, p.z));
    }
    pos.needsUpdate = true;
    o.geometry.computeVertexNormals();
    o.geometry.computeBoundingSphere();
    o.geometry.computeBoundingBox();
  });
}
