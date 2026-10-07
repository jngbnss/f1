import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

export interface EnvironmentOptions {
  shadows: boolean;
  shadowMapSize: number;
}

const SKY_TOP = new THREE.Color(0x3d7cc9);
const SKY_HORIZON = new THREE.Color(0xc9e3f5);
const FOG_COLOR = 0xbcd9ef;

/**
 * Sky, lights, fog. The sun's shadow camera follows the player with a tight
 * frustum, so one modest shadow map stays sharp around the car regardless of
 * track size (cheap compared to covering the whole track).
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;
  private readonly sunOffset = new THREE.Vector3(-60, 90, 40);
  private readonly sky: THREE.Mesh;
  private readonly lights: THREE.Light[] = [];
  private readonly ambient: THREE.AmbientLight;
  private readonly hemi: THREE.HemisphereLight;
  private envMap: THREE.Texture | null = null;
  private skyTexture: THREE.Texture | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    options: EnvironmentOptions,
  ) {
    scene.background = SKY_HORIZON.clone();
    scene.fog = new THREE.Fog(FOG_COLOR, 250, 1100);

    this.sky = this.createSky();
    scene.add(this.sky);

    const ambient = (this.ambient = new THREE.AmbientLight(0xffffff, 0.35));
    const hemi = (this.hemi = new THREE.HemisphereLight(0xcfe6ff, 0x4f6b3a, 1.1));
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
    this.sun.position.copy(this.sunOffset);

    if (options.shadows) {
      this.sun.castShadow = true;
      const cam = this.sun.shadow.camera;
      const extent = 45;
      cam.left = -extent;
      cam.right = extent;
      cam.top = extent;
      cam.bottom = -extent;
      cam.near = 10;
      cam.far = 250;
      this.sun.shadow.mapSize.set(options.shadowMapSize, options.shadowMapSize);
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.03;
    }

    scene.add(ambient, hemi, this.sun, this.sun.target);
    this.lights.push(ambient, hemi, this.sun);
  }

  /**
   * Streams in an equirectangular HDRI (loaded after the game is already
   * running): becomes the visible sky, the image-based lighting for PBR
   * materials (car paint reflections), and drives sun direction + fog color.
   */
  async loadSky(url: string, renderer: THREE.WebGLRenderer): Promise<void> {
    const texture = await new HDRLoader().loadAsync(url);
    texture.mapping = THREE.EquirectangularReflectionMapping;

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envMap = pmrem.fromEquirectangular(texture).texture;
    pmrem.dispose();

    this.skyTexture = texture;
    this.scene.background = texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.9;
    this.sky.visible = false;
    // IBL now provides the ambient term.
    this.ambient.intensity = 0;
    this.hemi.intensity = 0.25;

    const { sunDir, horizon } = analyzeEquirect(texture);
    if (sunDir) this.sunOffset.copy(sunDir).multiplyScalar(130);
    if (horizon && this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(horizon);
  }

  /** Keep the shadow frustum and sky centred on the player. */
  update(focus: THREE.Vector3): void {
    // Snap to a grid to avoid shadow-edge shimmering while moving.
    const snap = 2;
    const fx = Math.round(focus.x / snap) * snap;
    const fz = Math.round(focus.z / snap) * snap;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx + this.sunOffset.x, this.sunOffset.y, fz + this.sunOffset.z);
    this.sky.position.set(focus.x, 0, focus.z);
  }

  dispose(): void {
    for (const l of this.lights) {
      l.removeFromParent();
      l.dispose();
    }
    this.sky.removeFromParent();
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.envMap?.dispose();
    this.skyTexture?.dispose();
  }

  /** Vertical-gradient sky dome; 1 draw call, no textures. */
  private createSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(900, 24, 12);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: SKY_TOP },
        horizon: { value: SKY_HORIZON },
      },
      vertexShader: /* glsl */ `
        varying float vHeight;
        void main() {
          vHeight = normalize(position).y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top;
        uniform vec3 horizon;
        varying float vHeight;
        void main() {
          float t = pow(clamp(vHeight, 0.0, 1.0), 0.6);
          gl_FragColor = vec4(mix(horizon, top, t), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.name = 'Sky';
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    return sky;
  }
}

/**
 * Finds the sun (brightest region) and the average horizon color in an
 * equirectangular HDR DataTexture (RGBA half-float, rows top->bottom, flipY).
 */
function analyzeEquirect(texture: THREE.Texture): { sunDir: THREE.Vector3 | null; horizon: THREE.Color | null } {
  const image = texture.image as { data?: ArrayLike<number>; width: number; height: number };
  const data = image.data;
  if (!data || !(data instanceof Uint16Array || data instanceof Float32Array)) return { sunDir: null, horizon: null };
  const half = data instanceof Uint16Array;
  const read = (i: number) => (half ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i]);
  const { width: w, height: h } = image;

  let best = -1;
  let bx = 0;
  let by = 0;
  const step = 2;
  // Only the upper hemisphere can hold the sun.
  for (let y = 0; y < h / 2; y += step)
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const lum = 0.2126 * read(i) + 0.7152 * read(i + 1) + 0.0722 * read(i + 2);
      if (lum > best) {
        best = lum;
        bx = x;
        by = y;
      }
    }

  // Three.js equirect convention: u = atan2(z, x) / 2π + 0.5, v = asin(y) / π + 0.5 (v = 1 at top row).
  const u = (bx + 0.5) / w;
  const v = 1 - (by + 0.5) / h;
  const phi = (u - 0.5) * Math.PI * 2;
  const lat = Math.max((v - 0.5) * Math.PI, 0.35); // keep shadows reasonable if the sun is very low
  const sunDir = new THREE.Vector3(Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)).normalize();

  // Horizon band: just above the horizon line.
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const y0 = Math.floor(h * 0.44);
  const y1 = Math.floor(h * 0.49);
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < w; x += 8) {
      const i = (y * w + x) * 4;
      r += read(i);
      g += read(i + 1);
      b += read(i + 2);
      n++;
    }
  const horizon = n > 0 ? new THREE.Color().setRGB(r / n, g / n, b / n) : null;
  return { sunDir, horizon };
}
