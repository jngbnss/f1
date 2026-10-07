import * as THREE from 'three';
import type { VehicleConfig } from './VehicleConfig';
import type { WheelState } from './VehiclePhysics';
import { tyreGeometry } from './cars/shapes';

/**
 * Render-side representation of a car, fully separate from the physics body.
 * A GLB car only needs to implement this interface (see GltfCarVisual) —
 * VehiclePhysics never touches meshes.
 */
export interface VehicleVisual {
  /** Root placed at the (interpolated) chassis transform each frame. */
  readonly root: THREE.Object3D;
  /** Update wheel suspension travel / steering / spin. */
  updateWheels(wheels: readonly WheelState[]): void;
  dispose(): void;
}

export interface WheelStyle {
  width: number;
  segments: number;
  tyreColor: number;
  rimColor: number;
  /** Rim radius / tyre radius (low-profile tyres = larger). */
  rimRatio?: number;
  spokes?: number;
}

/**
 * Base for cars built from primitives. Subclasses add body parts with
 * `part()`; wheels are generated from VehicleConfig. Wheel hierarchy:
 *   mount (suspension top) -> steer (yaw) -> spin (roll) -> meshes
 */
export abstract class PrimitiveCarVisual implements VehicleVisual {
  readonly root = new THREE.Group();
  private readonly steers: THREE.Object3D[] = [];
  private readonly spins: THREE.Object3D[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  protected constructor(config: VehicleConfig, wheelStyle: WheelStyle) {
    this.buildWheels(config, wheelStyle);
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

  protected material(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    return this.track(new THREE.MeshStandardMaterial(params));
  }

  /** Metallic car paint with a glossy clearcoat (reflects the HDRI sky). */
  protected paint(color: number, metalness = 0.55, roughness = 0.35): THREE.MeshPhysicalMaterial {
    return this.track(
      new THREE.MeshPhysicalMaterial({ color, metalness, roughness, clearcoat: 1, clearcoatRoughness: 0.06 }),
    );
  }

  /** Dark tinted window glass. */
  protected glass(): THREE.MeshPhysicalMaterial {
    return this.track(
      new THREE.MeshPhysicalMaterial({ color: 0x0b1118, metalness: 0.2, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02 }),
    );
  }

  /** Clear-coated carbon fibre / satin black. */
  protected carbon(): THREE.MeshPhysicalMaterial {
    return this.track(
      new THREE.MeshPhysicalMaterial({ color: 0x16181b, metalness: 0.3, roughness: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.2 }),
    );
  }

  /** Adds a prepared geometry as a shadow-casting part at the origin. */
  protected mesh(geometry: THREE.BufferGeometry, material: THREE.Material, castShadow = true): THREE.Mesh {
    return this.part(geometry, material, 0, 0, 0, castShadow);
  }

  /** Adds a mesh in car-local space (+X right, +Y up, -Z forward). */
  protected part(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    castShadow = true,
  ): THREE.Mesh {
    this.track(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = castShadow;
    this.root.add(mesh);
    return mesh;
  }

  protected box(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    return this.part(new THREE.BoxGeometry(w, h, d), material, x, y, z);
  }

  protected track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  private buildWheels(c: VehicleConfig, style: WheelStyle): void {
    const r = c.wheelRadius;
    const w = style.width;
    const rimR = r * (style.rimRatio ?? 0.68);
    const tyreGeo = this.track(tyreGeometry(r, w, r - rimR, style.segments));
    // Rim: dished barrel + face disc + spokes + hub, built facing +X (mirrored per side).
    const barrelGeo = this.track(new THREE.CylinderGeometry(rimR, rimR, w * 0.9, style.segments, 1, true).rotateZ(Math.PI / 2));
    const faceGeo = this.track(new THREE.CylinderGeometry(rimR * 0.98, rimR * 0.98, 0.02, style.segments).rotateZ(Math.PI / 2));
    const spokeGeo = this.track(new THREE.BoxGeometry(0.035, rimR * 0.95, 0.05).translate(0, rimR * 0.48, 0));
    const hubGeo = this.track(new THREE.CylinderGeometry(rimR * 0.2, rimR * 0.24, 0.06, 12).rotateZ(Math.PI / 2));
    const discGeo = this.track(new THREE.CylinderGeometry(rimR * 0.8, rimR * 0.8, 0.03, 20).rotateZ(Math.PI / 2));
    const tyreMat = this.material({ color: style.tyreColor, roughness: 0.92 });
    const rimMat = this.track(new THREE.MeshPhysicalMaterial({ color: style.rimColor, metalness: 0.9, roughness: 0.25, clearcoat: 0.5 }));
    const darkMat = this.material({ color: 0x15171a, roughness: 0.6, metalness: 0.4 });
    const discMat = this.material({ color: 0x6b6f75, roughness: 0.45, metalness: 0.8 });

    for (const wc of c.wheels) {
      const mount = new THREE.Object3D();
      mount.position.set(wc.position.x, wc.position.y, wc.position.z);
      const steer = new THREE.Object3D();
      const spin = new THREE.Object3D();
      const tyre = new THREE.Mesh(tyreGeo, tyreMat);
      tyre.castShadow = true;
      const rim = new THREE.Group();
      rim.add(new THREE.Mesh(barrelGeo, darkMat));
      const face = new THREE.Mesh(faceGeo, darkMat);
      face.position.x = w * 0.3;
      rim.add(face);
      const spokes = style.spokes ?? 5;
      for (let k = 0; k < spokes; k++) {
        const spoke = new THREE.Mesh(spokeGeo, rimMat);
        spoke.position.x = w * 0.33;
        spoke.rotation.x = (k / spokes) * Math.PI * 2;
        rim.add(spoke);
      }
      const hub = new THREE.Mesh(hubGeo, rimMat);
      hub.position.x = w * 0.34;
      rim.add(hub);
      // Outer face points away from the car.
      rim.scale.x = Math.sign(wc.position.x) || 1;
      spin.add(tyre, rim);
      // Brake disc doesn't spin.
      const disc = new THREE.Mesh(discGeo, discMat);
      disc.position.x = -Math.sign(wc.position.x) * w * 0.1;
      steer.add(disc);
      steer.add(spin);
      mount.add(steer);
      this.root.add(mount);
      this.steers.push(steer);
      this.spins.push(spin);
    }
  }
}
