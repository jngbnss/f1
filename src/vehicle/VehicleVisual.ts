import * as THREE from 'three';
import type { VehicleConfig } from './VehicleConfig';
import type { WheelState } from './VehiclePhysics';

/**
 * Render-side representation of a car, fully separate from the physics body.
 * A GLB car only needs to implement this interface (see README:
 * "GLB 차량 넣기") — VehiclePhysics never touches meshes.
 */
export interface VehicleVisual {
  /** Root placed at the (interpolated) chassis transform each frame. */
  readonly root: THREE.Object3D;
  /** Update wheel suspension travel / steering / spin. */
  updateWheels(wheels: readonly WheelState[]): void;
  dispose(): void;
}

/**
 * Placeholder car built from primitives. Wheel hierarchy per wheel:
 *   mount (fixed at suspension top) -> steer (yaw) -> spin (roll) -> mesh
 */
export class ProceduralCarVisual implements VehicleVisual {
  readonly root = new THREE.Group();
  private readonly mounts: THREE.Object3D[] = [];
  private readonly steers: THREE.Object3D[] = [];
  private readonly spins: THREE.Object3D[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  constructor(config: VehicleConfig, color = 0xd7263d) {
    this.root.name = 'ProceduralCar';
    const c = config;
    const paint = this.track(new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.4 }));
    const dark = this.track(new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.8 }));
    const glass = this.track(new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.1, metalness: 0.6 }));
    const light = this.track(new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff2c0, emissiveIntensity: 1.2 }));
    const tail = this.track(new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2200, emissiveIntensity: 0.8 }));

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      this.track(geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      this.root.add(mesh);
      return mesh;
    };

    const hx = c.halfExtents.x;
    const hz = c.halfExtents.z;
    // Lower body
    add(new THREE.BoxGeometry(hx * 1.7, 0.42, hz * 2), paint, 0, -0.05, 0);
    // Fenders over the wheels
    add(new THREE.BoxGeometry(hx * 2.1, 0.16, 0.95), paint, 0, 0.1, -1.35);
    add(new THREE.BoxGeometry(hx * 2.1, 0.16, 0.95), paint, 0, 0.1, 1.3);
    // Cabin (slightly rearward), glass + roof
    add(new THREE.BoxGeometry(hx * 1.6, 0.38, hz * 0.95), glass, 0, 0.35, 0.25);
    add(new THREE.BoxGeometry(hx * 1.55, 0.06, hz * 0.8), paint, 0, 0.56, 0.3);
    // Hood scoop / spoiler
    add(new THREE.BoxGeometry(hx * 1.9, 0.06, 0.35), dark, 0, 0.42, hz - 0.2);
    add(new THREE.BoxGeometry(0.08, 0.25, 0.08), dark, -hx * 0.7, 0.28, hz - 0.2);
    add(new THREE.BoxGeometry(0.08, 0.25, 0.08), dark, hx * 0.7, 0.28, hz - 0.2);
    // Lights (front = -Z)
    add(new THREE.BoxGeometry(0.4, 0.1, 0.05), light, -hx + 0.35, 0.02, -hz - 0.01).castShadow = false;
    add(new THREE.BoxGeometry(0.4, 0.1, 0.05), light, hx - 0.35, 0.02, -hz - 0.01).castShadow = false;
    add(new THREE.BoxGeometry(0.5, 0.1, 0.05), tail, -hx + 0.4, 0.05, hz + 0.01).castShadow = false;
    add(new THREE.BoxGeometry(0.5, 0.1, 0.05), tail, hx - 0.4, 0.05, hz + 0.01).castShadow = false;

    // Wheels
    const r = c.wheelRadius;
    const tyreGeo = this.track(new THREE.CylinderGeometry(r, r, 0.3, 18));
    tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = this.track(new THREE.BoxGeometry(0.32, r * 1.1, 0.12));
    const tyreMat = this.track(new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 }));
    const rimMat = this.track(new THREE.MeshStandardMaterial({ color: 0xbfc5cc, metalness: 0.8, roughness: 0.3 }));

    for (const wc of c.wheels) {
      const mount = new THREE.Object3D();
      mount.position.set(wc.position.x, wc.position.y, wc.position.z);
      const steer = new THREE.Object3D();
      const spin = new THREE.Object3D();
      const tyre = new THREE.Mesh(tyreGeo, tyreMat);
      tyre.castShadow = true;
      const rim = new THREE.Mesh(rimGeo, rimMat); // visible spoke to show rotation
      spin.add(tyre, rim);
      steer.add(spin);
      mount.add(steer);
      this.root.add(mount);
      this.mounts.push(mount);
      this.steers.push(steer);
      this.spins.push(spin);
    }
  }

  updateWheels(wheels: readonly WheelState[]): void {
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      this.steers[i].position.y = -w.suspensionLength;
      this.steers[i].rotation.y = -w.steerAngle;
      // Rolling forward (-Z) = negative rotation about +X.
      this.spins[i].rotation.x = -w.spin;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }
}
