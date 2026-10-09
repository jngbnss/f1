import * as THREE from 'three';
import type { Vehicle } from '../vehicle/Vehicle';

/**
 * Tyre smoke: a puff from every locked wheel (flat-spotting under braking)
 * and from big slides. One instanced mesh of camera-facing soft discs
 * (a few hundred at most); each puff grows, rises a little and fades.
 */
const MAX = 320;

interface Puff {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  size: number;
}

export class TyreSmoke {
  readonly mesh: THREE.InstancedMesh;
  private readonly puffs: Puff[] = [];
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly texture: THREE.DataTexture;
  private readonly carry = new WeakMap<Vehicle, number>();
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _s = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();

  constructor() {
    this.texture = softDisc(64);
    const geo = new THREE.PlaneGeometry(1, 1);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    geo.setAttribute('puffAlpha', this.alpha);
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, color: 0xd8d8d4, transparent: true, depthWrite: false, fog: true });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float puffAlpha;\nvarying float vPuffAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPuffAlpha = puffAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vPuffAlpha;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vPuffAlpha;');
    };
    mat.customProgramCacheKey = () => 'tyre-smoke';
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.name = 'TyreSmoke';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 2;
  }

  /** Emits from the cars' locked / sliding wheels and moves every puff. */
  update(dt: number, cars: readonly Vehicle[], camera: THREE.Camera): void {
    for (const car of cars) {
      const wheels = car.physics.wheels;
      const cfg = car.config.wheels;
      const speed = car.physics.speed;
      let budget = this.carry.get(car) ?? 0;
      for (let i = 0; i < wheels.length; i++) {
        const w = wheels[i];
        if (!w.grounded) continue;
        const sliding = w.locked ? Math.max(speed, 6) : Math.abs(w.slip) > 7 ? Math.abs(w.slip) : 0;
        if (sliding <= 0) continue;
        // ~25 puffs/s per wheel at a full lock-up.
        budget += dt * Math.min(25, sliding);
        while (budget >= 1) {
          budget -= 1;
          const c = cfg[i].position;
          this._p.set(c.x, c.y - car.config.suspensionRestLength - car.config.wheelRadius * 0.6, c.z);
          this._p.applyQuaternion(car.quaternion).add(car.position);
          this.spawn(this._p, car);
        }
      }
      this.carry.set(car, Math.min(budget, 3));
    }

    // Integrate, fade, write instances.
    this._q.copy(camera.quaternion);
    let n = 0;
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.puffs.splice(i, 1);
        continue;
      }
      p.vel.multiplyScalar(Math.exp(-2.5 * dt));
      p.vel.y += 0.6 * dt;
      p.pos.addScaledVector(p.vel, dt);
      const t = p.age / p.life;
      const size = p.size * (0.6 + 2.2 * t);
      this._s.set(size, size, size);
      this._m.compose(p.pos, this._q, this._s);
      this.mesh.setMatrixAt(n, this._m);
      this.alpha.setX(n, 0.55 * (1 - t) * Math.min(1, p.age * 12));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }

  private spawn(at: THREE.Vector3, car: Vehicle): void {
    if (this.puffs.length >= MAX) this.puffs.shift();
    const v = car.physics.body.linvel();
    this.puffs.push({
      pos: at.clone(),
      // Smoke leaves the tyre with part of the car's speed and drifts behind it.
      vel: new THREE.Vector3(v.x * 0.35 + (Math.random() - 0.5), 0.4 + Math.random() * 0.4, v.z * 0.35 + (Math.random() - 0.5)),
      age: 0,
      life: 1.1 + Math.random() * 0.6,
      size: 0.55 + Math.random() * 0.3,
    });
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}

/** Radial soft-edged white disc (alpha only), no canvas needed. */
function softDisc(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const a = Math.max(0, 1 - r) ** 1.6;
      data.set([255, 255, 255, Math.round(a * 255)], (y * size + x) * 4);
    }
  const tex = new THREE.DataTexture(data, size, size);
  tex.needsUpdate = true;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}
