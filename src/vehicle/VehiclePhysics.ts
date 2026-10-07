import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { VehicleConfig } from './VehicleConfig';
import type { VehicleCommands } from './VehicleController';

export interface WheelState {
  grounded: boolean;
  /** Current spring length (rest length when airborne). */
  suspensionLength: number;
  /** Accumulated rolling angle (rad), for visuals. */
  spin: number;
  steerAngle: number;
  /** Lateral slip speed at the contact patch (m/s); useful for skid FX/audio. */
  slip: number;
}

export interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

// Scratch objects (no per-step allocations).
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3();
const _wheelFwd = new THREE.Vector3();
const _wheelRight = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _impulse = new THREE.Vector3();
const _linvel = new THREE.Vector3();
const _angvel = new THREE.Vector3();
const _com = new THREE.Vector3();
const _steerQuat = new THREE.Quaternion();

/**
 * Arcade raycast vehicle on top of a single Rapier rigid body.
 *
 * - Chassis = one dynamic box (collides with barriers, falls with gravity).
 * - Each wheel = a downward ray; a spring-damper pushes the chassis up.
 * - Tyre model = per-wheel impulses: cancel a fraction of lateral slip
 *   (capped by mu * load -> natural sliding), plus drive/brake along the wheel.
 * - Body forces = drag, downforce, speed cap.
 *
 * No wheel rigid bodies or joints: cheap, stable and easy to tune.
 */
export class VehiclePhysics {
  readonly body: RAPIER.RigidBody;
  readonly wheels: WheelState[];
  private readonly ray: RAPIER.Ray;
  private readonly massPerWheel: number;
  private readonly drivenCount: number;
  /** Set by the game from the ground under the car: grip multiplier and extra deceleration (m/s²). */
  surfaceGrip = 1;
  surfaceDrag = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly config: VehicleConfig,
    spawn: Pose,
  ) {
    const { rapier, world } = physics;
    const c = config;

    const bodyDesc = rapier.RigidBodyDesc.dynamic()
      .setTranslation(spawn.position.x, spawn.position.y, spawn.position.z)
      .setRotation(spawn.quaternion)
      .setLinearDamping(0.05)
      .setAngularDamping(1.5)
      .setCcdEnabled(true)
      .setCanSleep(false);
    this.body = world.createRigidBody(bodyDesc);

    // Box inertia, scaled up a bit for arcade stability (less twitchy rolls).
    const w = c.halfExtents.x * 2;
    const h = c.halfExtents.y * 2;
    const d = c.halfExtents.z * 2;
    const k = (c.mass / 12) * 1.6;
    const colliderDesc = rapier.ColliderDesc.cuboid(c.halfExtents.x, c.halfExtents.y, c.halfExtents.z)
      .setMassProperties(
        c.mass,
        c.centerOfMass,
        { x: k * (h * h + d * d), y: k * (w * w + d * d), z: k * (w * w + h * h) },
        { x: 0, y: 0, z: 0, w: 1 },
      )
      .setFriction(0.3)
      .setRestitution(0.1);
    world.createCollider(colliderDesc, this.body);

    this.ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.massPerWheel = c.mass / c.wheels.length;
    this.drivenCount = c.wheels.filter((wc) => wc.driven).length || 1;
    this.wheels = c.wheels.map(() => ({
      grounded: false,
      suspensionLength: c.suspensionRestLength,
      spin: 0,
      steerAngle: 0,
      slip: 0,
    }));
  }

  /** Signed speed along the car's forward axis (m/s, + = forward). */
  get forwardSpeed(): number {
    this.getPose(_pos, _quat);
    _fwd.set(0, 0, -1).applyQuaternion(_quat);
    const v = this.body.linvel();
    return v.x * _fwd.x + v.y * _fwd.y + v.z * _fwd.z;
  }

  get speed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  /** Largest lateral slip (m/s) among grounded wheels — drives skid sound/FX. */
  get maxSlip(): number {
    let s = 0;
    for (const w of this.wheels) if (w.grounded) s = Math.max(s, Math.abs(w.slip));
    return s;
  }

  get groundedWheels(): number {
    let n = 0;
    for (const w of this.wheels) if (w.grounded) n++;
    return n;
  }

  /** Apply forces for one fixed step. Call before world.step(). */
  step(cmd: Readonly<VehicleCommands>, dt: number): void {
    const c = this.config;
    const body = this.body;
    const world = this.physics.world;

    this.getPose(_pos, _quat);
    _up.set(0, 1, 0).applyQuaternion(_quat);
    _down.copy(_up).negate();
    _fwd.set(0, 0, -1).applyQuaternion(_quat);

    // Snapshot velocities once: applyImpulse changes them immediately, and every
    // wheel must see the same pre-step state or wheel order biases the car.
    const lv = body.linvel();
    const av = body.angvel();
    const com = body.worldCom();
    _linvel.set(lv.x, lv.y, lv.z);
    _angvel.set(av.x, av.y, av.z);
    _com.set(com.x, com.y, com.z);
    const forwardSpeed = _linvel.dot(_fwd);
    const speed = _linvel.length();

    // Engine force fades out quadratically towards top speed.
    let driveForce = 0;
    if (cmd.drive > 0) {
      const r = Math.min(Math.max(forwardSpeed, 0) / c.maxSpeed, 1);
      driveForce = cmd.drive * c.engineForce * (1 - r * r);
    } else if (cmd.drive < 0) {
      const r = Math.min(Math.max(-forwardSpeed, 0) / c.maxReverseSpeed, 1);
      driveForce = cmd.drive * c.reverseForce * (1 - r * r);
    }
    const maxRay = c.suspensionRestLength + c.wheelRadius;
    let grounded = 0;

    for (let i = 0; i < c.wheels.length; i++) {
      const wc = c.wheels[i];
      const ws = this.wheels[i];
      ws.steerAngle = wc.steerable ? cmd.steerAngle : 0;

      _origin.set(wc.position.x, wc.position.y, wc.position.z).applyQuaternion(_quat).add(_pos);
      this.ray.origin = _origin;
      this.ray.dir = _down;
      const hit = world.castRayAndGetNormal(this.ray, maxRay, true, undefined, undefined, undefined, body);

      if (!hit) {
        ws.grounded = false;
        ws.suspensionLength = c.suspensionRestLength;
        ws.slip = 0;
        continue;
      }

      grounded++;
      ws.grounded = true;
      const springLength = Math.max(hit.timeOfImpact - c.wheelRadius, 0);
      ws.suspensionLength = springLength;
      _normal.set(hit.normal.x, hit.normal.y, hit.normal.z);

      // --- suspension (spring-damper along chassis up) --------------
      // v = v_lin + w x (p - com)
      _vel.subVectors(_origin, _com).crossVectors(_angvel, _vel).add(_linvel);
      const compression = c.suspensionRestLength - springLength;
      const compressionVel = -_vel.dot(_up);
      const load = Math.max(c.suspensionStiffness * compression + c.suspensionDamping * compressionVel, 0);
      _impulse.copy(_up).multiplyScalar(load * dt);
      body.applyImpulseAtPoint(_impulse, _origin, true);

      // --- tyre frame on the ground plane --------------------------
      _wheelFwd.copy(_fwd);
      if (ws.steerAngle !== 0) {
        // + steer = right = clockwise seen from above = negative rotation about up.
        _steerQuat.setFromAxisAngle(_up, -ws.steerAngle);
        _wheelFwd.applyQuaternion(_steerQuat);
      }
      _wheelFwd.addScaledVector(_normal, -_wheelFwd.dot(_normal)).normalize();
      _wheelRight.crossVectors(_wheelFwd, _normal).normalize();

      const vLong = _vel.dot(_wheelFwd);
      const vLat = _vel.dot(_wheelRight);
      ws.slip = vLat;
      ws.spin += (vLong / c.wheelRadius) * dt;

      // --- lateral grip --------------------------------------------
      const isFront = wc.steerable;
      let grip = (isFront ? c.frontGrip : c.rearGrip) * this.surfaceGrip;
      let mu = (isFront ? c.frontFriction : c.rearFriction) * this.surfaceGrip;
      if (wc.handbrake && cmd.handbrake > 0) {
        const f = 1 - (1 - c.handbrakeGripFactor) * cmd.handbrake;
        grip *= f;
        mu *= f;
      }
      const maxLateral = mu * load * dt;
      let lateral = -vLat * this.massPerWheel * grip;
      lateral = Math.max(-maxLateral, Math.min(maxLateral, lateral));

      // --- longitudinal: drive + brakes + rolling resistance --------
      let longitudinal = 0;
      if (wc.driven) longitudinal += ((driveForce * (0.5 + 0.5 * this.surfaceGrip)) / this.drivenCount) * dt;

      let brake = (cmd.brake * c.brakeForce) / c.wheels.length;
      if (wc.handbrake) brake += (cmd.handbrake * c.handbrakeForce) / 2;
      brake += c.rollingResistance * Math.abs(vLong);
      if (brake > 0 && vLong !== 0) {
        // Never brake past zero (braking must not push the car backwards).
        const stop = Math.abs(vLong) * this.massPerWheel;
        longitudinal -= Math.sign(vLong) * Math.min(brake * dt, stop);
      }

      _impulse.copy(_wheelRight).multiplyScalar(lateral).addScaledVector(_wheelFwd, longitudinal);
      body.applyImpulseAtPoint(_impulse, _origin, true);
    }

    // --- body forces -----------------------------------------------
    if (speed > 0.01) {
      // Aerodynamic drag opposing velocity: F = -c * |v| * v.
      _impulse.copy(_linvel).multiplyScalar(-c.dragCoefficient * speed * dt);
      body.applyImpulse(_impulse, true);
    }
    if (grounded > 0 && this.surfaceDrag > 0 && speed > 0.1) {
      // Grass / gravel: speed-scrubbing drag, never reversing the car.
      const dv = Math.min(this.surfaceDrag * (0.4 + speed / 30) * dt, speed);
      _impulse.copy(_linvel).multiplyScalar((-dv / speed) * c.mass);
      body.applyImpulse(_impulse, true);
    }
    if (grounded > 0) {
      _impulse.copy(_up).multiplyScalar(-c.downforce * speed * speed * dt);
      body.applyImpulse(_impulse, true);
    }

    // Hard speed cap (safety net; the engine curve normally keeps us under).
    const cap = forwardSpeed >= 0 ? c.maxSpeed * 1.08 : c.maxReverseSpeed * 1.2;
    if (speed > cap) {
      const s = cap / speed;
      body.setLinvel({ x: lv.x * s, y: lv.y * s, z: lv.z * s }, true);
    }
  }

  /** Current physics pose (written into the given targets). */
  getPose(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    position.set(t.x, t.y, t.z);
    quaternion.set(r.x, r.y, r.z, r.w);
  }

  teleport(pose: Pose): void {
    const b = this.body;
    b.setTranslation(pose.position, true);
    b.setRotation(pose.quaternion, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const w of this.wheels) {
      w.grounded = false;
      w.suspensionLength = this.config.suspensionRestLength;
      w.slip = 0;
    }
  }

  dispose(): void {
    this.physics.world.removeRigidBody(this.body);
  }
}
