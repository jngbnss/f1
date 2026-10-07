import * as THREE from 'three';

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

  constructor(
    scene: THREE.Scene,
    options: EnvironmentOptions,
  ) {
    scene.background = SKY_HORIZON.clone();
    scene.fog = new THREE.Fog(FOG_COLOR, 150, 650);

    this.sky = this.createSky();
    scene.add(this.sky);

    const ambient = new THREE.AmbientLight(0xffffff, 0.35);
    const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x4f6b3a, 1.1);
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
