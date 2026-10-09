import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VehicleConfig } from '../VehicleConfig';
import type { WheelState } from '../VehiclePhysics';
import type { VehicleVisual } from '../VehicleVisual';
import { applyLivery, applyTyreBand, numberTexture, type Livery } from './F1Livery';

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

/** Driver's helmet in model space (open cockpit between z -0.45 and -0.05). */
const HELMET = new THREE.Vector3(0, 0.8, -0.22);
/** Tyre compound sidewall colours (Pirelli: soft red, medium yellow, hard white). */
export const COMPOUND_COLORS = { soft: 0xe10600, medium: 0xffd200, hard: 0xf0f0f0 } as const;

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
    // Undo KHR_mesh_quantization once: float positions in model meters (relative
    // to each LOD's parent: the scene for the body, the wheel centre for wheels)
    // with identity transforms below, so shaders can paint by model-space position.
    // Multi-material nodes are Groups: the dequantization transform sits on them.
    gltf.scene.updateMatrixWorld(true);
    const lods: THREE.Object3D[] = [];
    gltf.scene.traverse((o) => {
      if (/_LOD[0-9]$/.test(o.name) && !/_LOD[0-9]$/.test(o.parent?.name ?? '')) lods.push(o);
    });
    const inv = new THREE.Matrix4();
    for (const lod of lods) {
      inv.copy(lod.parent!.matrixWorld).invert();
      lod.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const src = o.geometry.attributes.position as THREE.BufferAttribute;
        const pos = new THREE.Float32BufferAttribute(src.count * 3, 3);
        for (let i = 0; i < src.count; i++) pos.setXYZ(i, src.getX(i), src.getY(i), src.getZ(i));
        o.geometry.setAttribute('position', pos);
        o.geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      });
      lod.traverse((o) => {
        o.position.set(0, 0, 0);
        o.quaternion.identity();
        o.scale.set(1, 1, 1);
      });
    }
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
  private readonly geometries: THREE.BufferGeometry[] = [];
  private near = true;
  private readonly textures: THREE.Texture[] = [];
  /** Sidewall band colour (tyre compound). */
  private readonly band = { value: new THREE.Color(COMPOUND_COLORS.medium) };

  constructor(config: VehicleConfig, livery: Livery, driver = 0) {
    if (!template) throw new Error('F1 model not loaded');
    const paint = this.own(new THREE.MeshPhysicalMaterial({ metalness: 0.1, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.08 }));
    const number = numberTexture(livery.numbers[driver % 2]);
    this.textures.push(number);
    applyLivery(paint, livery, number);
    const tyre = this.own(new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }));
    applyTyreBand(tyre, this.band);
    const slots: Record<string, THREE.Material> = {
      paint,
      // Wings: the livery's second colour reads best against the body.
      accent: this.own(new THREE.MeshPhysicalMaterial({ color: livery.style === 0 ? livery.accent : livery.secondary, metalness: 0.1, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.1 })),
      carbon: this.own(new THREE.MeshPhysicalMaterial({ color: 0x141619, metalness: 0.3, roughness: 0.45, clearcoat: 0.7, clearcoatRoughness: 0.25 })),
      tyre,
      rim: this.own(new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.85, roughness: 0.3 })),
    };
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
    // Driver: team-coloured helmet with a dark visor band.
    const helmetMat = this.own(new THREE.MeshPhysicalMaterial({ color: livery.helmet, roughness: 0.25, clearcoat: 1 }));
    const visorMat = this.own(new THREE.MeshPhysicalMaterial({ color: 0x0a0c10, roughness: 0.05, metalness: 0.6, clearcoat: 1 }));
    const helmetGeo = new THREE.SphereGeometry(0.135, 20, 14);
    const visorGeo = new THREE.SphereGeometry(0.137, 20, 6, -Math.PI * 0.35, Math.PI * 0.7, Math.PI * 0.38, Math.PI * 0.16).rotateY(Math.PI);
    this.geometries.push(helmetGeo, visorGeo);
    const helmet = new THREE.Mesh(helmetGeo, helmetMat);
    const visor = new THREE.Mesh(visorGeo, visorMat);
    helmet.position.copy(HELMET);
    visor.position.copy(HELMET);
    helmet.castShadow = true;
    body.add(helmet, visor);
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

  /** Sidewall colour of the fitted compound. */
  setCompound(color: number): void {
    this.band.value.set(color);
  }

  dispose(): void {
    this.root.removeFromParent();
    // Body geometry belongs to the shared template; only per-car resources go.
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    for (const g of this.geometries) g.dispose();
  }

  private own<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }
}
