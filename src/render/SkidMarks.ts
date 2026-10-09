import * as THREE from 'three';
import type { Vehicle } from '../vehicle/Vehicle';

/**
 * Black rubber marks left on the tarmac by locked or sliding tyres. One mesh
 * for every car: a ring buffer of quads (the oldest segment is overwritten
 * when it is full), each fading out over half a minute in the shader.
 */
const MAX_SEGMENTS = 4000;
const MIN_STEP = 0.35;
const MAX_STEP = 4;
const FADE_START = 20;
const FADE_END = 45;

interface Trail {
  last: THREE.Vector3;
  active: boolean;
}

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly data: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly dataAttr: THREE.BufferAttribute;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly trails = new WeakMap<Vehicle, Trail[]>();
  private readonly time = { value: 0 };
  private next = 0;
  private dirty = false;
  private readonly _p = new THREE.Vector3();
  private readonly _side = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();

  /** `onTarmac(x, z)`: marks are only left on asphalt and kerbs. */
  constructor(private readonly onTarmac: (x: number, z: number) => boolean) {
    this.positions = new Float32Array(MAX_SEGMENTS * 4 * 3);
    // Per vertex: birth time, strength (a never-written vertex is born at -1e9: invisible).
    this.data = new Float32Array(MAX_SEGMENTS * 4 * 2).fill(-1e9);
    const index = new Uint32Array(MAX_SEGMENTS * 6);
    for (let i = 0; i < MAX_SEGMENTS; i++) index.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.dataAttr = new THREE.BufferAttribute(this.data, 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('skid', this.dataAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.material = new THREE.MeshBasicMaterial({
      color: 0x0b0b0b,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.skidTime = this.time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 skid;\nuniform float skidTime;\nvarying float vSkidAlpha;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vSkidAlpha = skid.y * (1.0 - smoothstep(${FADE_START.toFixed(1)}, ${FADE_END.toFixed(1)}, skidTime - skid.x));`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vSkidAlpha;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vSkidAlpha;');
    };
    this.material.customProgramCacheKey = () => 'skid-marks';
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'SkidMarks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  update(dt: number, cars: readonly Vehicle[]): void {
    this.time.value += dt;
    for (const car of cars) {
      const wheels = car.physics.wheels;
      const cfg = car.config;
      let trails = this.trails.get(car);
      if (!trails) this.trails.set(car, (trails = wheels.map(() => ({ last: new THREE.Vector3(), active: false }))));
      const speed = car.physics.speed;
      for (let i = 0; i < wheels.length; i++) {
        const w = wheels[i];
        const trail = trails[i];
        const slide = Math.abs(w.slip);
        const strength = !w.grounded || speed < 3 ? 0 : w.locked ? 0.75 : slide > 3.5 ? Math.min(0.7, (slide - 3.5) / 6 + 0.25) : 0;
        if (strength <= 0) {
          trail.active = false;
          continue;
        }
        const c = cfg.wheels[i].position;
        this._p.set(c.x, c.y - w.suspensionLength - cfg.wheelRadius, c.z).applyQuaternion(car.quaternion).add(car.position);
        if (!this.onTarmac(this._p.x, this._p.z)) {
          trail.active = false;
          continue;
        }
        if (!trail.active) {
          trail.last.copy(this._p);
          trail.active = true;
          continue;
        }
        const d = trail.last.distanceTo(this._p);
        if (d < MIN_STEP) continue;
        if (d > MAX_STEP) {
          trail.last.copy(this._p);
          continue;
        }
        const width = c.z > 0 ? 0.36 : 0.3;
        this.addSegment(trail.last, this._p, width, strength);
        trail.last.copy(this._p);
      }
    }
    if (this.dirty) {
      this.posAttr.needsUpdate = true;
      this.dataAttr.needsUpdate = true;
      this.dirty = false;
    }
  }

  private addSegment(a: THREE.Vector3, b: THREE.Vector3, width: number, strength: number): void {
    this._dir.subVectors(b, a).normalize();
    this._up.set(0, 1, 0);
    this._side.crossVectors(this._dir, this._up).normalize().multiplyScalar(width / 2);
    const i = this.next;
    this.next = (this.next + 1) % MAX_SEGMENTS;
    const lift = 0.02;
    const pts = [
      [a.x - this._side.x, a.y + lift, a.z - this._side.z],
      [a.x + this._side.x, a.y + lift, a.z + this._side.z],
      [b.x - this._side.x, b.y + lift, b.z - this._side.z],
      [b.x + this._side.x, b.y + lift, b.z + this._side.z],
    ];
    for (let k = 0; k < 4; k++) {
      this.positions.set(pts[k], (i * 4 + k) * 3);
      this.data[(i * 4 + k) * 2] = this.time.value;
      this.data[(i * 4 + k) * 2 + 1] = strength;
    }
    this.dirty = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
