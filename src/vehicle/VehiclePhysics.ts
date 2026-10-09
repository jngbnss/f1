import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CHASSIS_GROUPS, SUSPENSION_RAY_GROUPS, type PhysicsWorld } from '../physics/PhysicsWorld';
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
  /** Brake torque beyond what the tyre can take: the wheel has stopped turning and slides. */
  locked: boolean;
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

/** Grip multiplier and extra deceleration (m/s²) of the ground under one wheel. */
export interface SurfaceSample {
  grip: number;
  drag: number;
}

/**
 * Raycast vehicle on top of a single Rapier rigid body.
 *
 * - Chassis = one dynamic box (collides with barriers, falls with gravity).
 * - Each wheel = a downward ray; a spring-damper pushes the chassis up.
 * - Engine = constant power (force = P / v) limited by a max tractive force,
 *   so acceleration and top speed come out of power, drag and mass.
 * - Tyre model = per-wheel impulses: cancel a fraction of lateral slip, plus
 *   drive/brake along the wheel, all inside a friction circle of μ·load —
 *   braking or flooring it while cornering eats into lateral grip.
 *   Load includes aero downforce, so fast corners hold more g.
 * - Surface sampled per wheel: two wheels on the grass pull the car around.
 * - Body forces = drag (½ρCdA·v²), downforce (½ρClA·v²), rev limiter.
 *
 * No wheel rigid bodies or joints: cheap, stable and easy to tune.
 */
export class VehiclePhysics {
  readonly body: RAPIER.RigidBody;
  /** Chassis collider (impacts are reported for it). */
  readonly collider: RAPIER.Collider;
  readonly wheels: WheelState[];
  private readonly ray: RAPIER.Ray;
  private readonly massPerWheel: number;
  private readonly drivenCount: number;
  /** Ground under a wheel contact (x, z). Unset = asphalt everywhere. */
  surfaceAt: ((x: number, z: number) => SurfaceSample) | null = null;
  /** Average surface grip under the grounded wheels in the last step (1 = asphalt). */
  surfaceGrip = 1;
  /** Tyre state (compound, wear, temperature) per axle, multiplies tyre friction. */
  readonly tyreGrip = { front: 1, rear: 1 };
  /** Aero efficiency per axle (1 = intact; damaged wings lose downforce on their end). */
  readonly aero = { front: 1, rear: 1 };
  /**
   * ABS-like brake assist: pedal pressure is trimmed to just below the lock-up
   * point per wheel (what a good driver does by feel). Off = stamping on the
   * pedal at low downforce locks the wheels (flat spots, no steering).
   */
  brakeAssist = true;

  constructor(
    private readonly physics: PhysicsWorld,
    readonly config: VehicleConfig,
    spawn: Pose,
  ) {
    const { rapier, world } = physics;
    const c = config;

    const bodyDesc = rapier.RigidBodyDesc.dynamic()
      .setTranslation(spawn.position.x, spawn.position.y, spawn.position.z)
      .setRotation(spawn.quaternion)
      .setLinearDamping(0)
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
      .setRestitution(0.1)
      .setCollisionGroups(CHASSIS_GROUPS)
      // Report hits harder than ~2 g (barriers, other cars) for damage.
      .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(c.mass * 9.81 * 2);
    this.collider = world.createCollider(colliderDesc, this.body);

    this.ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.massPerWheel = c.mass / c.wheels.length;
    this.drivenCount = c.wheels.filter((wc) => wc.driven).length || 1;
    this.wheels = c.wheels.map(() => ({
      grounded: false,
      suspensionLength: c.suspensionRestLength,
      spin: 0,
      steerAngle: 0,
      slip: 0,
      locked: false,
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

    // Constant power above the traction-limited launch force; rev limiter at maxSpeed.
    let driveForce = 0;
    if (cmd.drive > 0) {
      const v = Math.max(forwardSpeed, 1);
      const limiter = 1 - Math.min(Math.max((forwardSpeed - c.maxSpeed * 0.985) / (c.maxSpeed * 0.015), 0), 1);
      driveForce = cmd.drive * Math.min(c.engineForce, c.enginePower / v) * limiter;
    } else if (cmd.drive < 0) {
      const r = Math.min(Math.max(-forwardSpeed, 0) / c.maxReverseSpeed, 1);
      driveForce = cmd.drive * c.reverseForce * (1 - r * r);
    }
    const maxRay = c.suspensionRestLength + c.wheelRadius;
    let grounded = 0;
    let gripSum = 0;
    let dragSum = 0;

    for (let i = 0; i < c.wheels.length; i++) {
      const wc = c.wheels[i];
      const ws = this.wheels[i];
      ws.steerAngle = wc.steerable ? cmd.steerAngle : 0;

      _origin.set(wc.position.x, wc.position.y, wc.position.z).applyQuaternion(_quat).add(_pos);
      this.ray.origin = _origin;
      this.ray.dir = _down;
      const hit = world.castRayAndGetNormal(this.ray, maxRay, true, undefined, SUSPENSION_RAY_GROUPS, undefined, body);

      if (!hit) {
        ws.grounded = false;
        ws.suspensionLength = c.suspensionRestLength;
        ws.slip = 0;
        ws.locked = false;
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

      // --- surface under this wheel -----------------------------------
      let surfGrip = 1;
      let surfDrag = 0;
      if (this.surfaceAt) {
        const sf = this.surfaceAt(_origin.x, _origin.z);
        surfGrip = sf.grip;
        surfDrag = sf.drag;
      }
      gripSum += surfGrip;
      dragSum += surfDrag;

      // --- tyre forces inside the friction circle -----------------------
      const isFront = wc.steerable;
      const tyre = isFront ? this.tyreGrip.front : this.tyreGrip.rear;
      let grip = (isFront ? c.frontGrip : c.rearGrip) * Math.min(1, 0.35 + 0.65 * surfGrip) * Math.min(1, tyre);
      let mu = (isFront ? c.frontFriction : c.rearFriction) * surfGrip * tyre;
      if (wc.handbrake && cmd.handbrake > 0) {
        const f = 1 - (1 - c.handbrakeGripFactor) * cmd.handbrake;
        grip *= f;
        mu *= f;
      }
      let maxForce = mu * load; // N
      // Lateral: cancel a fraction of the sideways slip this step.
      let lateralF = (-vLat * this.massPerWheel * grip) / dt;
      // Longitudinal: engine (driven wheels) minus brakes, signed against travel.
      let driveF = wc.driven ? driveForce / this.drivenCount : 0;
      // Brake bias: the front axle takes the larger share (weight transfers forward under
      // braking). The assist works like an ideal (load-proportional) split + ABS instead.
      const bias = this.brakeAssist ? 0.5 : (c.brakeBias ?? 0.5);
      const axleWheels = c.wheels.length / 2;
      let brakeF = (cmd.brake * c.brakeForce * (isFront ? bias : 1 - bias)) / axleWheels;
      // Lock-up: brake torque beyond the tyre's grip stops the wheel; a sliding tyre
      // brakes less (kinetic friction) and can hardly steer. With the assist (ABS) the
      // friction circle below just trims the excess and the wheel keeps turning.
      // Tyres give ~10 % more peak grip in a straight line before they lock.
      const locked = !this.brakeAssist && brakeF > maxForce * 1.1 && Math.abs(vLong) > 2;
      ws.locked = locked;
      if (locked) {
        // A sliding tyre scrubs (wear, heat, screech): report the slide like a slip.
        ws.slip = Math.sign(vLat || 1) * Math.min(Math.hypot(vLat, vLong * 0.4), 12);
        maxForce *= 0.8;
        lateralF *= 0.25;
        brakeF = maxForce;
      }
      if (wc.handbrake) brakeF += (cmd.handbrake * c.handbrakeForce) / 2;
      if (!locked) ws.spin += (vLong / c.wheelRadius) * dt;
      // Friction circle: what the tyre can't transmit is lost (wheelspin / lock-up).
      const longF = driveF - brakeF * Math.sign(vLong || 1);
      const total = Math.hypot(lateralF, longF);
      if (total > maxForce) {
        const k = maxForce / total;
        lateralF *= k;
        driveF *= k;
        brakeF *= k;
      }

      let longitudinal = driveF * dt;
      // Brakes + rolling resistance never push the car backwards.
      const resist = (brakeF + c.rollingResistance * load) * dt;
      if (resist > 0 && vLong !== 0) {
        const stop = Math.abs(vLong) * this.massPerWheel;
        longitudinal -= Math.sign(vLong) * Math.min(resist, stop);
      }

      _impulse.copy(_wheelRight).multiplyScalar(lateralF * dt).addScaledVector(_wheelFwd, longitudinal);
      body.applyImpulseAtPoint(_impulse, _origin, true);
    }
    this.surfaceGrip = grounded > 0 ? gripSum / grounded : 1;
    const surfaceDrag = grounded > 0 ? dragSum / c.wheels.length : 0;

    // --- body forces -----------------------------------------------
    if (speed > 0.01) {
      // Aerodynamic drag opposing velocity: F = -c * |v| * v.
      _impulse.copy(_linvel).multiplyScalar(-c.dragCoefficient * speed * dt);
      body.applyImpulse(_impulse, true);
    }
    if (surfaceDrag > 0 && speed > 0.1) {
      // Grass / gravel: speed-scrubbing drag, never reversing the car.
      const dv = Math.min(surfaceDrag * (0.4 + speed / 30) * dt, speed);
      _impulse.copy(_linvel).multiplyScalar((-dv / speed) * c.mass);
      body.applyImpulse(_impulse, true);
    }
    if (grounded > 0) {
      const down = c.downforce * speed * speed * dt;
      _impulse.copy(_up).multiplyScalar(-down);
      body.applyImpulse(_impulse, true);
      // Wing damage: half of the downforce works on each axle; give back the lost share there.
      for (const [axle, z] of [['front', -1], ['rear', 1]] as const) {
        const lost = 1 - this.aero[axle];
        if (lost <= 0) continue;
        const mount = c.wheels[z < 0 ? 0 : c.wheels.length - 1].position;
        _origin.set(0, mount.y, mount.z);
        _origin.applyQuaternion(_quat).add(_pos);
        _impulse.copy(_up).multiplyScalar(down * 0.5 * lost);
        body.applyImpulseAtPoint(_impulse, _origin, true);
      }
    }

    // Hard speed cap (safety net; the limiter normally keeps us under).
    const cap = forwardSpeed >= 0 ? c.maxSpeed * 1.12 : c.maxReverseSpeed * 1.2;
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
