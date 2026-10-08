import * as THREE from 'three';
import type { TrackMaterials } from './Track';

/**
 * Photo-scanned PBR textures (Poly Haven, CC0) streamed in after the game
 * has started: the track is drivable immediately with flat colors and
 * upgrades itself when the images arrive (asset-streaming experiment hook).
 *
 * Track UVs are in meters, so repeat = 1 / tileSize.
 */
interface TextureSet {
  dir: string;
  /** Real-world size of one texture tile (m). */
  tile: number;
  normalScale: number;
  /** Multiplies the texture color (e.g. make dry grass greener). */
  tint?: number;
}

const SETS: Record<keyof TrackMaterials, TextureSet> = {
  asphalt: { dir: 'textures/asphalt_02', tile: 3, normalScale: 0.6 },
  grass: { dir: 'textures/leafy_grass', tile: 4, normalScale: 0.8, tint: 0x8fc46a },
  gravel: { dir: 'textures/gravelly_sand', tile: 2.5, normalScale: 1 },
};

export async function applyTrackTextures(
  materials: TrackMaterials,
  renderer: THREE.WebGLRenderer,
  grassTint?: number,
  baseUrl: string = import.meta.env.BASE_URL,
): Promise<void> {
  const loader = new THREE.TextureLoader();
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const load = async (url: string, srgb: boolean, tile: number) => {
    const tex = await loader.loadAsync(url);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / tile, 1 / tile);
    tex.anisotropy = anisotropy;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return tex;
  };

  await Promise.all(
    (Object.keys(SETS) as (keyof TrackMaterials)[]).map(async (key) => {
      const set = SETS[key];
      const base = `${baseUrl}${set.dir}/`;
      const [diff, nor, arm] = await Promise.all([
        load(`${base}diff.jpg`, true, set.tile),
        load(`${base}nor_gl.jpg`, false, set.tile),
        load(`${base}arm.jpg`, false, set.tile), // R = AO, G = roughness, B = metalness
      ]);
      const m = materials[key];
      m.map = diff;
      m.normalMap = nor;
      m.normalScale.set(set.normalScale, set.normalScale);
      m.roughnessMap = arm;
      m.roughness = 1;
      m.color.set((key === 'grass' ? grassTint : undefined) ?? set.tint ?? 0xffffff);
      m.needsUpdate = true;
    }),
  );
}
