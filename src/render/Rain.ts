import { Effect } from 'postprocessing';
import * as THREE from 'three';
import type { Vehicle } from '../vehicle/Vehicle';

/**
 * Rain, all cheap and GPU-side where possible:
 *  - RainStreaks: thousands of falling streaks in a box that wraps around the
 *    camera (world-anchored, so they don't swim when the camera moves), each
 *    stretched along the drop's motion relative to the camera (motion blur).
 *  - Spray: the rooster tail of water every car throws up at speed.
 *  - RainLens: drops on the lens for onboard cameras (UV distortion pass).
 */

const STREAKS = 6000;
const BOX = new THREE.Vector3(44, 24, 44);
/** Drop velocity (m/s): ~9 m/s fall plus a light breeze. */
const FALL = new THREE.Vector3(1.4, -9.5, 0.8);
/** "Shutter" time for the streak length (s). */
const SHUTTER = 0.011;

export class RainStreaks {
  readonly mesh: THREE.Mesh;
  private readonly uniforms: {
    uCam: { value: THREE.Vector3 };
    uTime: { value: number };
    uRel: { value: THREE.Vector3 };
    uColor: { value: THREE.Color };
  };
  private readonly lastCam = new THREE.Vector3();
  private readonly camVel = new THREE.Vector3();
  private time = 0;

  constructor(color: number) {
    const base = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    const seeds = new Float32Array(STREAKS * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    geo.instanceCount = STREAKS;
    this.uniforms = {
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uRel: { value: new THREE.Vector3(0, -0.2, 0) },
      uColor: { value: new THREE.Color(color) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uBox: { value: BOX }, uFall: { value: FALL } },
      transparent: true,
      depthWrite: false,
      // Streak quads are built in the shader; their winding depends on the drop direction.
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec3 aSeed;
        uniform vec3 uCam;
        uniform float uTime;
        uniform vec3 uBox;
        uniform vec3 uFall;
        uniform vec3 uRel;
        varying float vA;
        void main() {
          vec3 p = aSeed * uBox + uFall * uTime;
          p = mod(p - uCam + uBox * 0.5, uBox) + uCam - uBox * 0.5;
          vec3 head = (viewMatrix * vec4(p, 1.0)).xyz;
          vec3 tail = (viewMatrix * vec4(p - uRel, 1.0)).xyz;
          vec3 v = mix(head, tail, position.y);
          vec2 d = tail.xy / max(-tail.z, 0.1) - head.xy / max(-head.z, 0.1);
          d = length(d) > 1e-5 ? normalize(d) : vec2(0.0, 1.0);
          v.xy += vec2(-d.y, d.x) * position.x * 0.016 * (1.0 + 0.05 * -v.z);
          gl_Position = projectionMatrix * vec4(v, 1.0);
          float dist = length(head);
          // Long (fast) streaks spread the same light over more pixels: fainter.
          vA = clamp(0.25 / max(length(uRel), 0.05), 0.35, 1.0) * (1.0 - 0.6 * position.y) * smoothstep(0.4, 1.6, dist) * (1.0 - smoothstep(uBox.x * 0.28, uBox.x * 0.5, dist));
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vA;
        void main() {
          gl_FragColor = vec4(uColor, 0.45 * vA);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'Rain';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.time = (this.time + dt) % 600;
    const cam = camera.position;
    if (dt > 0) {
      const v = cam.clone().sub(this.lastCam).divideScalar(dt);
      // Teleports (resets, camera switches) must not smear the rain across the screen.
      if (v.length() < 120) this.camVel.lerp(v, 1 - Math.exp(-10 * dt));
    }
    this.lastCam.copy(cam);
    this.uniforms.uCam.value.copy(cam);
    this.uniforms.uTime.value = this.time;
    const rel = FALL.clone().sub(this.camVel).multiplyScalar(SHUTTER);
    if (rel.length() > 0.9) rel.setLength(0.9);
    this.uniforms.uRel.value.copy(rel);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// --------------------------------------------------------------------------

const SPRAY_MAX = 700;

interface Puff {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  size: number;
}

/** Water thrown up by the tyres and the diffuser: big soft grey puffs behind every fast car. */
export class Spray {
  readonly mesh: THREE.InstancedMesh;
  private readonly puffs: Puff[] = [];
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly texture: THREE.DataTexture;
  private readonly carry = new WeakMap<Vehicle, number>();
  private readonly _m = new THREE.Matrix4();
  private readonly _s = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();

  constructor(color: number) {
    this.texture = cloudTexture(64);
    const geo = new THREE.PlaneGeometry(1, 1);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(SPRAY_MAX), 1);
    geo.setAttribute('sprayAlpha', this.alpha);
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, color, transparent: true, depthWrite: false, fog: true });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float sprayAlpha;\nvarying float vSprayAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSprayAlpha = sprayAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vSprayAlpha;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vSprayAlpha;');
    };
    mat.customProgramCacheKey = () => 'rain-spray';
    this.mesh = new THREE.InstancedMesh(geo, mat, SPRAY_MAX);
    this.mesh.name = 'Spray';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 2;
  }

  update(dt: number, cars: readonly Vehicle[], camera: THREE.Camera): void {
    const cam = camera.position;
    for (const car of cars) {
      const speed = car.physics.speed;
      let budget = this.carry.get(car) ?? 0;
      // Far-away cars: nobody sees their spray.
      if (speed > 10 && car.position.distanceToSquared(cam) < 220 * 220) {
        budget += dt * 34 * Math.min(1, (speed - 10) / 45);
        const back = car.config.halfExtents.z;
        while (budget >= 1) {
          budget -= 1;
          // Rear tyres and the diffuser.
          const x = (Math.random() - 0.5) * 1.6;
          this._p.set(x, 0.25 + Math.random() * 0.3, back + 0.2).applyQuaternion(car.quaternion).add(car.position);
          this.spawn(this._p, car, speed);
        }
      }
      this.carry.set(car, Math.min(budget, 3));
    }

    const q = camera.quaternion;
    let n = 0;
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.puffs.splice(i, 1);
        continue;
      }
      p.vel.multiplyScalar(Math.exp(-1.8 * dt));
      p.vel.y -= 1.2 * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.3) p.pos.y = 0.3;
      const t = p.age / p.life;
      const size = p.size * (0.5 + 2.6 * t);
      this._s.set(size * 1.4, size, size);
      this._m.compose(p.pos, q, this._s);
      this.mesh.setMatrixAt(n, this._m);
      this.alpha.setX(n, 0.26 * (1 - t) * Math.min(1, p.age * 8));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }

  private spawn(at: THREE.Vector3, car: Vehicle, speed: number): void {
    if (this.puffs.length >= SPRAY_MAX) this.puffs.shift();
    const v = car.physics.body.linvel();
    const up = 1 + Math.random() * 2.5;
    this.puffs.push({
      pos: at.clone(),
      // Thrown up and back with a good part of the car's speed, it hangs in the air behind the car.
      vel: new THREE.Vector3(v.x * 0.5 + (Math.random() - 0.5) * 2, up, v.z * 0.5 + (Math.random() - 0.5) * 2),
      age: 0,
      life: 0.8 + Math.random() * 0.6,
      size: 1.1 + Math.random() * 0.6 + speed * 0.01,
    });
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}

/** Soft, lumpy cloud puff (alpha), no canvas needed. */
function cloudTexture(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const ang = Math.atan2(dy, dx);
      const r = Math.sqrt(dx * dx + dy * dy) * 2 * (1 + 0.12 * Math.sin(ang * 5) + 0.08 * Math.sin(ang * 9 + 1));
      const a = Math.max(0, 1 - r) ** 1.4;
      data.set([255, 255, 255, Math.round(a * 255)], (y * size + x) * 4);
    }
  const tex = new THREE.DataTexture(data, size, size);
  tex.needsUpdate = true;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

// --------------------------------------------------------------------------

/**
 * Water drops on the lens (onboard cameras): each drop refracts a flipped,
 * magnified bit of the scene behind it; drops slowly run down the glass and
 * get blown back at speed. Pure UV distortion, so it costs one texture fetch.
 */
export class RainLens extends Effect {
  constructor() {
    super(
      'RainLens',
      /* glsl */ `
      uniform float uAmount;
      uniform float uTime;
      uniform float uAspect;
      float lh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      vec2 drops(vec2 uv, float scale, float seed) {
        vec2 g = uv * vec2(uAspect, 1.0) * scale;
        g.y += uTime * 0.06 * (seed + 1.0);
        vec2 id = floor(g);
        vec2 f = fract(g) - 0.5;
        float h = lh(id + seed * 17.0);
        if (h > 0.45) return vec2(0.0);
        vec2 c = (vec2(lh(id + 3.1 + seed), lh(id + 7.7 + seed)) - 0.5) * 0.55;
        // Some drops slide down their cell.
        c.y -= fract(uTime * 0.07 * (h + 0.3) + h) * 0.4 * step(0.25, h);
        float r = 0.1 + 0.16 * fract(h * 13.0);
        vec2 d = (f - c) / vec2(1.0, 1.25);
        float l = length(d);
        float m = smoothstep(r, r * 0.7, l);
        return -d * m * (1.2 / scale);
      }
      void mainUv(inout vec2 uv) {
        if (uAmount <= 0.0) return;
        vec2 o = drops(uv, 6.0, 0.0) + drops(uv, 11.0, 1.0) * 0.8 + drops(uv, 19.0, 2.0) * 0.6;
        uv += o * uAmount;
      }`,
      {
        uniforms: new Map<string, THREE.Uniform>([
          ['uAmount', new THREE.Uniform(0)],
          ['uTime', new THREE.Uniform(0)],
          ['uAspect', new THREE.Uniform(16 / 9)],
        ]),
      },
    );
  }

  set amount(v: number) {
    this.uniforms.get('uAmount')!.value = v;
  }

  tick(dt: number, aspect: number): void {
    const t = this.uniforms.get('uTime')!;
    t.value = (t.value + dt) % 1000;
    this.uniforms.get('uAspect')!.value = aspect;
  }
}
