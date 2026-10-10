import * as THREE from 'three';

/**
 * Loads an image texture decoded off the main thread (createImageBitmap); uploadTexture then
 * sends it to the GPU once its settings are final. A TextureLoader image is decoded on its first draw, inside the frame:
 * a 2048 px JPEG froze the race for a moment when the streamed textures arrived.
 * `flipY` as THREE.Texture.flipY (an ImageBitmap is flipped while decoding instead).
 */
export async function loadTexture(url: string, flipY = true): Promise<THREE.Texture> {
  if (typeof createImageBitmap === 'undefined') {
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.flipY = flipY;
    return tex;
  }
  const loader = new THREE.ImageBitmapLoader().setOptions({ imageOrientation: flipY ? 'flipY' : 'none', premultiplyAlpha: 'none' });
  const bitmap = await loader.loadAsync(url);
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** Uploads a texture now (after its settings are final) rather than on its first draw. */
export function uploadTexture(tex: THREE.Texture, renderer: THREE.WebGLRenderer): THREE.Texture {
  renderer.initTexture(tex);
  return tex;
}
