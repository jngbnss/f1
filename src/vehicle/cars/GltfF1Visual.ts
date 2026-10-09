import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VehicleConfig } from '../VehicleConfig';
import type { WheelState } from '../VehiclePhysics';
import type { VehicleVisual } from '../VehicleVisual';

/**
 * 2026 F1 car from public/models/f1-2026.glb (built by scripts/build-f1-model.ts
 * from "F1 2026 concept (polygon model)" by Qvist_designs, CC-BY-4.0).
 *
 * The GLB holds two body LODs and four wheels (each with two LODs), already in
 * car space with the ground at y = 0. Material slots are named "paint",
 * "accent", "carbon", "tyre" and "rim"; every car gets its own team-colored
 * materials while all cars share the geometry.
 */

export const F1_MODEL_CREDIT = 'F1 car: "F1 2026 concept" by Qvist_designs (CC-BY-4.0)';

/** Tyre centre height in the model (the CAD tyres sink 3 cm into the ground). */
const MODEL_WHEEL_Y = 0.33;
const G = 9.81;
/**
 * The CAD tyres are 2022-25 size (front 330 / rear 430 mm wide incl. bulge).
 * 2026 tyres are 25 / 30 mm narrower than those: 280 / 375 mm.
 */
const TYRE_WIDTH_SCALE = { front: 0.28 / 0.33, rear: 0.375 / 0.43 };

let template: THREE.Group | null = null;
let loading: Promise<void> | null = null;

/** Loads the shared model once. Cars created before it is ready fall back to primitives. */
export function loadF1Model(baseUrl: string): Promise<void> {
  loading ??= new GLTFLoader().loadAsync(`${baseUrl}models/f1-2026.glb`).then((gltf) => {
    template = gltf.scene;
  });
  return loading;
}

export function f1ModelReady(): boolean {
  return template !== null;
}

interface Lods {
  near: THREE.Object3D;
  far: THREE.Object3D;
}

export class GltfF1Visual implements VehicleVisual {
  readonly root = new THREE.Group();
  private readonly steers: THREE.Object3D[] = [];
  private readonly spins: THREE.Object3D[] = [];
  private readonly lods: Lods[] = [];
  private readonly materials: THREE.Material[] = [];
  private near = true;

  constructor(config: VehicleConfig, color: number, accent: number) {
    if (!template) throw new Error('F1 model not loaded');
    const slots: Record<string, THREE.Material> = {
      paint: this.own(new THREE.MeshPhysicalMaterial({ color, metalness: 0.1, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.08 })),
      accent: this.own(new THREE.MeshPhysicalMaterial({ color: accent, metalness: 0.1, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.1 })),
      carbon: this.own(new THREE.MeshPhysicalMaterial({ color: 0x141619, metalness: 0.3, roughness: 0.45, clearcoat: 0.7, clearcoatRoughness: 0.25 })),
      tyre: this.own(new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 })),
      rim: this.own(new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.85, roughness: 0.3 })),
    };
    // Keep each LOD node's own transform: KHR_mesh_quantization stores the
    // dequantization offset/scale there (dropping it shifts the mesh).
    const instance = (src: THREE.Object3D): THREE.Object3D => {
      const copy = src.clone();
      copy.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.material = slots[(o.material as THREE.Material).name] ?? slots.paint;
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      return copy;
    };

    // Body sits so the model's wheel centres meet the physics wheels at static load.
    const wheelY = config.wheels[0]?.position.y ?? 0;
    const staticSag = (config.mass * G) / config.wheels.length / config.suspensionStiffness;
    const bodyY = wheelY - (config.suspensionRestLength - staticSag) - MODEL_WHEEL_Y;
    const body = new THREE.Group();
    body.position.y = bodyY;
    const near = instance(template.getObjectByName('Body_LOD0')!);
    const far = instance(template.getObjectByName('Body_LOD1')!);
    far.visible = false;
    body.add(near, far);
    this.lods.push({ near, far });
    this.root.add(body);

    // Wheels: mount (model x/z, physics height) -> steer -> spin -> mesh.
    const names = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'];
    for (const wc of config.wheels) {
      const name = names[(wc.position.z > 0 ? 2 : 0) + (wc.position.x > 0 ? 1 : 0)];
      const src = template.getObjectByName(name)!;
      const mount = new THREE.Object3D();
      mount.position.set(src.position.x, wc.position.y, src.position.z);
      const steer = new THREE.Object3D();
      const spin = new THREE.Object3D();
      spin.scale.x = wc.position.z > 0 ? TYRE_WIDTH_SCALE.rear : TYRE_WIDTH_SCALE.front;
      const wheelNear = instance(src.getObjectByName(`${name}_LOD0`)!);
      const wheelFar = instance(src.getObjectByName(`${name}_LOD1`)!);
      wheelFar.visible = false;
      spin.add(wheelNear, wheelFar);
      this.lods.push({ near: wheelNear, far: wheelFar });
      steer.add(spin);
      mount.add(steer);
      this.root.add(mount);
      this.steers.push(steer);
      this.spins.push(spin);
    }
  }

  updateWheels(wheels: readonly WheelState[]): void {
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      this.steers[i].position.y = -w.suspensionLength;
      this.steers[i].rotation.y = -w.steerAngle;
      this.spins[i].rotation.x = -w.spin;
    }
  }

  setDetail(near: boolean): void {
    if (near === this.near) return;
    this.near = near;
    for (const l of this.lods) {
      l.near.visible = near;
      l.far.visible = !near;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    // Geometry belongs to the shared template; only the per-car materials go.
    for (const m of this.materials) m.dispose();
  }

  private own<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }
}
