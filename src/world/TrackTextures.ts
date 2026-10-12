import * as THREE from 'three';
import { loadTexture, uploadTexture } from '../render/loadTexture';
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

/** Pale stone paving for street circuits (asphalt scan, lightened and tiled larger). */
const PAVING: TextureSet = { dir: 'textures/asphalt_02', tile: 5, normalScale: 0.5, tint: 0xc9c2b6 };

/** A 1x1 texture of one colour. */
function texel(r: number, g: number, b: number, colorSpace: THREE.ColorSpace): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.colorSpace = colorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Gives the track materials stand-in maps (white colour, flat normal, full roughness
 * scale: the same look as no map) in the slots applyTrackTextures fills later, so the
 * shaders are compiled with them up front and the photo textures arriving mid-race
 * only swap textures instead of recompiling the ground shaders (a visible stall).
 */
export function prepareTrackMaterials(materials: TrackMaterials, street = false): void {
  const white = texel(255, 255, 255, THREE.SRGBColorSpace);
  const flat = texel(128, 128, 255, THREE.NoColorSpace);
  const rough = texel(255, 255, 0, THREE.NoColorSpace);
  for (const key of Object.keys(SETS) as (keyof TrackMaterials)[]) {
    const m = materials[key];
    if (!(street && key === 'grass')) m.map = white;
    m.normalMap = flat;
    m.roughnessMap = rough;
    m.needsUpdate = true;
  }
}

export async function applyTrackTextures(
  materials: TrackMaterials,
  renderer: THREE.WebGLRenderer,
  grassTint?: number,
  baseUrl: string = import.meta.env.BASE_URL,
  /** Street circuit: the "grass" around the track is paving stone instead. */
  street = false,
): Promise<void> {
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const load = async (url: string, srgb: boolean, tile: number) => {
    const tex = await loadTexture(url);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / tile, 1 / tile);
    tex.anisotropy = anisotropy;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return uploadTexture(tex, renderer);
  };

  await Promise.all(
    (Object.keys(SETS) as (keyof TrackMaterials)[]).map(async (key) => {
      const set = street && key === 'grass' ? PAVING : SETS[key];
      const base = `${baseUrl}${set.dir}/`;
      const [diff, nor, arm] = await Promise.all([
        load(`${base}diff.jpg`, true, set.tile),
        load(`${base}nor_gl.jpg`, false, set.tile),
        load(`${base}arm.jpg`, false, set.tile), // R = AO, G = roughness, B = metalness
      ]);
      const m = materials[key];
      // Paving keeps the scan's relief but not its dark colour (light Monégasque stone).
      m.map = set === PAVING ? null : diff;
      m.normalMap = nor;
      m.normalScale.set(set.normalScale, set.normalScale);
      m.roughnessMap = arm;
      m.roughness = 1;
      m.color.set((key === 'grass' && !street ? grassTint : undefined) ?? set.tint ?? 0xffffff);
      // After prepareTrackMaterials this finds the same (already compiled) program.
      m.needsUpdate = true;
    }),
  );
}
