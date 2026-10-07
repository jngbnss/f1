import * as THREE from 'three';
import type { VehicleInput } from '../input/VehicleInput';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { VehicleConfig } from './VehicleConfig';
import { Gearbox, type GearboxConfig } from './Gearbox';
import { VehicleController } from './VehicleController';
import { VehiclePhysics, type Pose } from './VehiclePhysics';
import type { VehicleVisual } from './VehicleVisual';

/**
 * One car = controller (intent -> commands) + physics (rigid body) + visual (meshes).
 * The visual is interpolated between the last two physics states so motion is
 * smooth on any refresh rate even though physics runs at a fixed rate.
 */
export class Vehicle {
  readonly controller: VehicleController;
  readonly physics: VehiclePhysics;
  readonly gearbox: Gearbox | null;
  /** Throttle applied in the last fixed step (0..1), for audio. */
  throttle = 0;

  private readonly prevPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly currPos = new THREE.Vector3();
  private readonly currQuat = new THREE.Quaternion();

  constructor(
    physicsWorld: PhysicsWorld,
    readonly config: VehicleConfig,
    readonly visual: VehicleVisual,
    spawn: Pose,
    gearbox?: GearboxConfig,
  ) {
    this.controller = new VehicleController(config);
    this.physics = new VehiclePhysics(physicsWorld, config, spawn);
    this.gearbox = gearbox ? new Gearbox(gearbox) : null;
    this.snapshot();
    this.snapshot();
  }

  /** Root object to add to the scene / follow with the camera. */
  get object3D(): THREE.Object3D {
    return this.visual.root;
  }

  /** km/h, signed (negative when reversing). */
  get speedKmh(): number {
    return this.physics.forwardSpeed * 3.6;
  }

  get position(): THREE.Vector3 {
    return this.currPos;
  }

  get quaternion(): THREE.Quaternion {
    return this.currQuat;
  }

  /** Before world.step(): turn input into forces. */
  fixedUpdate(input: Readonly<VehicleInput>, dt: number): void {
    const cmd = this.controller.update(input, this.physics.forwardSpeed, dt);
    this.physics.step(cmd, dt);
    this.throttle = Math.abs(cmd.drive);
    this.gearbox?.update(this.physics.forwardSpeed, this.throttle, this.physics.groundedWheels > 0, dt);
  }

  /** After world.step(): record state for interpolation. */
  snapshot(): void {
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.physics.getPose(this.currPos, this.currQuat);
  }

  /** Per render frame: place the visual between the last two physics states. */
  render(alpha: number): void {
    const root = this.visual.root;
    root.position.lerpVectors(this.prevPos, this.currPos, alpha);
    root.quaternion.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
    this.visual.updateWheels(this.physics.wheels);
  }

  teleport(pose: Pose): void {
    this.physics.teleport(pose);
    this.controller.reset();
    this.physics.getPose(this.currPos, this.currQuat);
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }

  /** Upside down or on its side. */
  isFlipped(): boolean {
    // Y of the local up axis, without allocating: 1 - 2(x² + z²).
    const q = this.currQuat;
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    return upY < 0.3;
  }

  dispose(): void {
    this.physics.dispose();
    this.visual.dispose();
  }
}
