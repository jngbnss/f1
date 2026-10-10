import * as THREE from 'three';
import type { VehicleInput } from '../input/VehicleInput';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { VehicleConfig } from './VehicleConfig';
import { Gearbox, type GearboxConfig } from './Gearbox';
import { VehicleController } from './VehicleController';
import { VehiclePhysics, type Pose } from './VehiclePhysics';
import type { VehicleVisual } from './VehicleVisual';
import { TyreSet } from './Tyres';
import { DamageState } from './Damage';
import { Ers } from './Ers';

/** Grip left on a tyre rolling over carbon debris (it skates on the shards). */
const DEBRIS_SLIDE_GRIP = 0.5;
/** Active aero: seconds to open the flaps (straight mode) and to close them (braking). */
const AERO_OPEN_TIME = 0.5;
const AERO_CLOSE_TIME = 0.15;
/** Straight mode only with the wheel nearly straight (front wheel angle, rad). */
const AERO_MAX_STEER = 0.03;

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
  /** Fitted tyres (compound, wear, temperature). */
  readonly tyres = new TyreSet('medium');
  /** Bodywork damage (front wing, rear wing, floor). */
  readonly damage = new DamageState();
  /** Seconds of debris slide left per wheel (a carbon shard under the tyre). */
  readonly debrisSlide = [0, 0, 0, 0];
  /** 2026 hybrid: battery, deployment, overtake mode. */
  readonly ers: Ers;
  /** Inside an active-aero straight zone (set by the race rules each step). */
  straightZone = false;
  /** Active aero position: 0 = corner mode (flaps closed), 1 = straight mode. */
  aeroMode = 0;

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
    this.ers = new Ers(config);
    this.tyres.wearScale = config.tyreWear ?? 1;
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
    const speed = Math.max(this.physics.forwardSpeed, 0);
    this.physics.availablePower = this.ers.available(speed, cmd.drive);
    this.updateActiveAero(cmd.brake, cmd.steerAngle, dt);
    this.physics.step(cmd, dt);
    this.ers.step(dt, speed, this.physics.drivePower - (this.config.enginePower - this.config.mgukPower), cmd.drive, cmd.brake);
    this.tyres.update(this.physics, dt);
    const grip = this.physics.tyreGrip;
    for (let i = 0; i < grip.length; i++) {
      grip[i] = this.tyres.grip(i);
      if (this.debrisSlide[i] > 0) {
        grip[i] *= DEBRIS_SLIDE_GRIP;
        this.debrisSlide[i] = Math.max(0, this.debrisSlide[i] - dt);
      }
    }
    const aero = this.damage.aero();
    this.physics.aero.front = aero.front;
    this.physics.aero.rear = aero.rear;
    this.physics.bodyDrag = this.damage.drag();
    this.throttle = Math.abs(cmd.drive);
    this.gearbox?.update(this.physics.forwardSpeed, this.throttle, this.physics.groundedWheels > 0, dt);
  }

  /**
   * 2026 active aero: flaps open in a straight zone when the driver is flat out and
   * straight, close at once on the brakes or with steering.
   */
  private updateActiveAero(brake: number, steer: number, dt: number): void {
    const aa = this.config.activeAero;
    if (!aa) return;
    const open = this.straightZone && brake < 0.05 && Math.abs(steer) < AERO_MAX_STEER;
    this.aeroMode = open ? Math.min(1, this.aeroMode + dt / AERO_OPEN_TIME) : Math.max(0, this.aeroMode - dt / AERO_CLOSE_TIME);
    this.physics.activeAero.drag = 1 + (aa.drag - 1) * this.aeroMode;
    this.physics.activeAero.downforce = 1 + (aa.downforce - 1) * this.aeroMode;
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
    this.visual.setBrake?.(this.controller.commands.brake, this.physics.speed);
  }

  teleport(pose: Pose): void {
    this.physics.teleport(pose);
    this.controller.reset();
    this.debrisSlide.fill(0);
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
