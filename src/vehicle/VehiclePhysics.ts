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
  /** Vertical load on the tyre in the last step (N); 0 in the air. */
  load: number;
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
/** Longitudinal (braking) grip relative to lateral grip. */
export const BRAKE_GRIP = 1.2;
/**
 * Pacejka magic formula (lateral) as a share of the peak force:
 * sin(C·atan(B·α − E·(B·α − atan(B·α)))). Racing slick: ~0.6 of the peak at 1°
 * of slip, ~0.98 by 4°, a broad top and only ~3 % lost when sliding at 30°. A sharper
 * fall past the peak made the rear snap away on corner exit (the AI spun and
 * crashed in every race), as a real car only does on cold or worn tyres.
 */
const MF_B = 36;
const MF_C = 1.2;
const MF_E = 0.3;
export function magicFormula(alpha: number): number {
  const x = MF_B * alpha;
  return Math.sin(MF_C * Math.atan(x - MF_E * (x - Math.atan(x))));
}
/** tan of the slip angle where the contact patch starts to slide (~2.5°; ~0.9 of the peak force). */
const SLIDE_START = Math.tan((2.5 * Math.PI) / 180);
/**
 * Friction lost per unit of load above the car's mean wheel load. TUMFTM's F1 tyres:
 * dμ/dFz = -5e-5 /N at a 3 kN nominal load and μ ≈ 1.85, i.e. ~0.08.
 */
const LOAD_SENSITIVITY = 0.08;
const _impulse = new THREE.Vector3();
const _linvel = new THREE.Vector3();
const _angvel = new THREE.Vector3();
const _com = new THREE.Vector3();
const _steerQuat = new THREE.Quaternion();
const _contact = new THREE.Vector3();
const _invQuat = new THREE.Quaternion();
const _localW = new THREE.Vector3();
/**
 * Roll / pitch damping rate (1/s), and the smaller yaw damping on the ground: the
 * tyres do most of that work, this keeps a car from snapping into a spin.
 */
const ANGULAR_DAMPING = 1.5;
const YAW_DAMPING = 0.8;

/** Grip multiplier and extra deceleration (m/s²) of the ground under one wheel. */
export interface SurfaceSample {
  grip: number;
  drag: number;
}

/**
 * Raycast vehicle on top of a single Rapier rigid body.
 *
 * - Chassis = one dynamic box (collides with barriers, falls with gravity).
 * - Each wheel = a downward ray; a spring-damper (plus an anti-roll bar per axle)
 *   pushes the chassis up. Tyre forces act at the road (cgHeight below the centre
 *   of mass), so the body rolls and pitches and the load moves where it should.
 * - Engine = constant power (force = P / v) limited by a max tractive force,
 *   so acceleration and top speed come out of power, drag and mass.
 * - Tyre model = per-wheel forces: lateral from the slip angle (Pacejka magic
 *   formula, μ falling a little with load), plus drive/brake along the wheel, all
 *   inside a friction ellipse of μ·load —
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
  /** Ground normal under each wheel from this step's suspension ray. */
  private readonly normals: THREE.Vector3[];
  /** Principal moments of inertia (chassis local axes). */
  private readonly inertia: { x: number; y: number; z: number };
  /** Ground under a wheel contact (x, z). Unset = asphalt everywhere. */
  surfaceAt: ((x: number, z: number, y?: number) => SurfaceSample) | null = null;
  /** Average surface grip under the grounded wheels in the last step (1 = asphalt). */
  surfaceGrip = 1;
  /** Tyre state (compound, wear, temperature) per wheel, multiplies tyre friction. */
  readonly tyreGrip: number[];
  /**
   * Another car's wake (Slipstream): drag multiplier (< 1 = towed along) and downforce
   * multiplier per axle (< 1 = dirty air, the front wing suffers most).
   */
  readonly wake = { drag: 1, front: 1, rear: 1 };
  /** Drag multiplier from broken bodywork (1 = intact). */
  bodyDrag = 1;
  /** 2026 active aero: drag and downforce multipliers (1 = corner mode, below 1 on straights). */
  readonly activeAero = { drag: 1, downforce: 1 };
  /** Power at the wheels the power unit can give this step (W; the battery may limit it). */
  availablePower: number;
  /** Drive power actually asked of the power unit in the last step (W). */
  drivePower = 0;
  /** Aero efficiency per axle (1 = intact; damaged wings lose downforce on their end). */
  readonly aero = { front: 1, rear: 1 };
  /**
   * ABS-like brake assist: pedal pressure is trimmed to just below the lock-up
   * point per wheel (what a good driver does by feel). Off = stamping on the
   * pedal at low downforce locks the wheels (flat spots, no steering).
   */
  brakeAssist = true;
  /**
   * Braking grip relative to cornering grip (friction ellipse). Human drivers get
   * the stronger stop; AI keeps 1 (their braking points and spacing are tuned for it).
   */
  brakeGrip = BRAKE_GRIP;
  /** Brake pedal force multiplier (human drivers; AI keeps 1). */
  brakeForceScale = 1.5;
  /**
   * Front tyre cornering grip multiplier. With the slip-angle tyre model the car is
   * already close to neutral; more front grip than the rear's small margin (~6 %)
   * makes it snap into a spin at 250 km/h, so it stays 1.
   */
  frontGripScale = 1;
  /**
   * Keep the downforce while all four wheels are off the ground (circuits with real
   * crests: Spa, Suzuka). On flat circuits a car only takes off in a crash, where
   * pressing it down would just make the crash worse.
   */
  aeroInAir = false;

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
      // Angular damping is applied per axis in step(): roll/pitch only (yaw comes from the tyres).
      .setAngularDamping(0)
      .setCcdEnabled(true)
      .setCanSleep(false);
    this.body = world.createRigidBody(bodyDesc);

    // Box inertia, scaled up a bit for arcade stability (less twitchy rolls).
    const w = c.halfExtents.x * 2;
    const h = c.halfExtents.y * 2;
    const d = c.halfExtents.z * 2;
    const k = (c.mass / 12) * 1.6;
    this.inertia = { x: k * (h * h + d * d), y: k * (w * w + d * d), z: k * (w * w + h * h) };
    const colliderDesc = rapier.ColliderDesc.cuboid(c.halfExtents.x, c.halfExtents.y, c.halfExtents.z)
      .setMassProperties(c.mass, c.centerOfMass, this.inertia, { x: 0, y: 0, z: 0, w: 1 })
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
    this.tyreGrip = c.wheels.map(() => 1);
    this.availablePower = c.enginePower;
    this.normals = c.wheels.map(() => new THREE.Vector3(0, 1, 0));
    this.wheels = c.wheels.map(() => ({
      grounded: false,
      suspensionLength: c.suspensionRestLength,
      spin: 0,
      steerAngle: 0,
      slip: 0,
      locked: false,
      load: 0,
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
      // Spinning up the engine, gearbox and wheels takes part of the force: more in the
      // low gears (rotating-mass factor ~1.16 in first, ~1.07 in top, TUMFTM F1 data).
      const rotating = 1.07 + 0.09 * Math.max(0, 1 - forwardSpeed / (c.maxSpeed * 0.3));
      driveForce = (cmd.drive * Math.min(c.engineForce, this.availablePower / v) * limiter) / rotating;
    } else if (cmd.drive < 0) {
      const r = Math.min(Math.max(-forwardSpeed, 0) / c.maxReverseSpeed, 1);
      driveForce = cmd.drive * c.reverseForce * (1 - r * r);
    }
    this.drivePower = Math.max(0, driveForce) * Math.max(forwardSpeed, 0);
    const maxRay = c.suspensionRestLength + c.wheelRadius;
    let grounded = 0;
    let gripSum = 0;
    // Mechanical grip (team trait) scales only the weight-borne share of the grip.
    const weight = c.mass * 9.81;
    const mech = 1 + ((c.mechGrip ?? 1) - 1) * (weight / (weight + c.downforce * speed * speed));
    // Brake assist: an ideal split follows the axle loads (last step's), so under braking,
    // with the weight on the nose, the light rear is never asked for more than it can take.
    let frontLoad = 0;
    let totalLoad = 0;
    this.wheels.forEach((w, i) => {
      totalLoad += w.load;
      if (c.wheels[i].steerable) frontLoad += w.load;
    });
    const loadBias = totalLoad > 0 ? THREE.MathUtils.clamp(frontLoad / totalLoad, 0.45, 0.75) : 0.5;
    let dragSum = 0;

    // Pass 1: suspension rays (the anti-roll bars need both wheels of an axle).
    const n = c.wheels.length;
    for (let i = 0; i < n; i++) {
      const wc = c.wheels[i];
      const ws = this.wheels[i];
      _origin.set(wc.position.x, wc.position.y, wc.position.z).applyQuaternion(_quat).add(_pos);
      this.ray.origin = _origin;
      this.ray.dir = _down;
      const hit = world.castRayAndGetNormal(this.ray, maxRay, true, undefined, SUSPENSION_RAY_GROUPS, undefined, body);
      ws.grounded = !!hit;
      ws.suspensionLength = hit ? Math.max(hit.timeOfImpact - c.wheelRadius, 0) : c.suspensionRestLength;
      if (hit) this.normals[i].set(hit.normal.x, hit.normal.y, hit.normal.z);
    }

    // Pass 2: spring + damper + anti-roll bar = vertical load per wheel.
    let loadSum = 0;
    for (let i = 0; i < n; i++) {
      const wc = c.wheels[i];
      const ws = this.wheels[i];
      ws.load = 0;
      if (!ws.grounded) continue;
      _origin.set(wc.position.x, wc.position.y, wc.position.z).applyQuaternion(_quat).add(_pos);
      // v = v_lin + w x (p - com)
      _vel.subVectors(_origin, _com).crossVectors(_angvel, _vel).add(_linvel);
      const compression = c.suspensionRestLength - ws.suspensionLength;
      const compressionVel = -_vel.dot(_up);
      let spring = c.suspensionStiffness * compression + c.suspensionDamping * compressionVel;
      // Anti-roll bar: the more compressed side of the axle pushes up harder, the other less.
      const mate = i ^ 1; // wheels come in left/right pairs per axle
      if (mate < n && this.wheels[mate].grounded) {
        const arb = wc.steerable ? c.antiRollFront : c.antiRollRear;
        spring += arb * (this.wheels[mate].suspensionLength - ws.suspensionLength);
      }
      ws.load = Math.max(spring, 0);
      loadSum += ws.load;
    }
    let groundedCount = 0;
    for (const w of this.wheels) if (w.grounded) groundedCount++;
    const meanLoad = groundedCount > 0 ? loadSum / groundedCount : 0;

    for (let i = 0; i < n; i++) {
      const wc = c.wheels[i];
      const ws = this.wheels[i];
      ws.steerAngle = wc.steerable ? cmd.steerAngle : 0;

      if (!ws.grounded) {
        ws.slip = 0;
        ws.locked = false;
        ws.load = 0;
        continue;
      }

      grounded++;
      _origin.set(wc.position.x, wc.position.y, wc.position.z).applyQuaternion(_quat).add(_pos);
      _normal.copy(this.normals[i]);
      _vel.subVectors(_origin, _com).crossVectors(_angvel, _vel).add(_linvel);
      const load = ws.load;
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
      // Sliding speed: below ~2.5° of slip angle the contact patch mostly grips (the
      // tyre just deflects), so only the lateral speed beyond that counts as a slide
      // (heat, wear, skid marks, squeal).
      ws.slip = Math.sign(vLat) * Math.max(0, Math.abs(vLat) - Math.abs(vLong) * SLIDE_START);

      // --- surface under this wheel -----------------------------------
      let surfGrip = 1;
      let surfDrag = 0;
      if (this.surfaceAt) {
        const sf = this.surfaceAt(_origin.x, _origin.z, _origin.y);
        surfGrip = sf.grip;
        surfDrag = sf.drag;
      }
      gripSum += surfGrip;
      dragSum += surfDrag;

      // --- tyre forces inside the friction circle -----------------------
      const isFront = wc.steerable;
      const tyre = this.tyreGrip[i];
      let grip = (isFront ? c.frontGrip : c.rearGrip) * Math.min(1, 0.35 + 0.65 * surfGrip) * Math.min(1, tyre);
      let mu = (isFront ? c.frontFriction * this.frontGripScale : c.rearFriction) * surfGrip * tyre * mech;
      if (wc.handbrake && cmd.handbrake > 0) {
        const f = 1 - (1 - c.handbrakeGripFactor) * cmd.handbrake;
        grip *= f;
        mu *= f;
      }
      // Load sensitivity: a tyre's friction coefficient falls as it is loaded harder, so a
      // car that piles its load onto the outside tyres has less grip than one sharing it
      // evenly. Measured against the car's own mean wheel load, so the total downforce
      // still adds grip as before (the racing line plans with that).
      const loadRatio = meanLoad > 0 ? Math.min(load / meanLoad, 2.5) : 1;
      mu *= 1 - LOAD_SENSITIVITY * (loadRatio - 1);
      let maxForce = mu * load; // N
      // Lateral: Pacejka "magic formula" force from the slip angle (near its peak by
      // ~4°, hardly falling past it), never more than what would cancel the sideways slip in this
      // step: at parking speed the slip angle means little and the force must not overshoot.
      const alpha = Math.atan2(vLat, Math.max(Math.abs(vLong), 1.5));
      const cancel = (Math.abs(vLat) * this.massPerWheel * grip) / dt;
      let lateralF = -Math.sign(vLat) * Math.min(maxForce * magicFormula(Math.abs(alpha)), cancel);
      // Longitudinal: engine (driven wheels) minus brakes, signed against travel.
      let driveF = wc.driven ? driveForce / this.drivenCount : 0;
      // Brake bias: the front axle takes the larger share (weight transfers forward under
      // braking). The assist works like an ideal (load-proportional) split + ABS instead.
      const bias = this.brakeAssist ? loadBias : (c.brakeBias ?? 0.5);
      const axleWheels = c.wheels.length / 2;
      let brakeF = (cmd.brake * c.brakeForce * this.brakeForceScale * (isFront ? bias : 1 - bias)) / axleWheels;
      // Lock-up: brake torque beyond the tyre's grip stops the wheel; a sliding tyre
      // brakes less (kinetic friction) and can hardly steer. With the assist (ABS) the
      // friction circle below just trims the excess and the wheel keeps turning.
      // Tyres give ~10 % more peak grip in a straight line before they lock.
      // Under braking the tyre transmits more force along the wheel than sideways
      // (friction ellipse): a long-stretched contact patch, like real slick tyres.
      const maxBrake = maxForce * this.brakeGrip * (c.braking ?? 1);
      const locked = !this.brakeAssist && brakeF > maxBrake * 1.1 && Math.abs(vLong) > 2;
      ws.locked = locked;
      if (locked) {
        // A sliding tyre scrubs (wear, heat, screech): report the slide like a slip.
        ws.slip = Math.sign(vLat || 1) * Math.min(Math.hypot(vLat, vLong * 0.4), 12);
        maxForce *= 0.8;
        lateralF *= 0.25;
        brakeF = maxBrake * 0.8;
      }
      if (wc.handbrake) brakeF += (cmd.handbrake * c.handbrakeForce) / 2;
      if (!locked) ws.spin += (vLong / c.wheelRadius) * dt;
      // Friction circle: what the tyre can't transmit is lost (wheelspin / lock-up).
      const longF = driveF - brakeF * Math.sign(vLong || 1);
      // Friction ellipse: braking may use up to brakeGrip x the lateral limit.
      // Traction (team trait) only limits the drive force (wheelspin), never cornering grip.
      const longLimit = brakeF > driveF ? maxBrake : maxForce * (c.traction ?? 1);
      const total = Math.hypot(lateralF / maxForce, longF / longLimit);
      if (total > 1) {
        const k = 1 / total;
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

      // Tyre forces act cgHeight below the centre of mass (at the road, as on a real car), so
      // they roll the body outwards and load the outside wheels; braking pitches it forward.
      _impulse.copy(_wheelRight).multiplyScalar(lateralF * dt).addScaledVector(_wheelFwd, longitudinal);
      _contact.set(wc.position.x, c.centerOfMass.y - c.cgHeight, wc.position.z).applyQuaternion(_quat).add(_pos);
      body.applyImpulseAtPoint(_impulse, _contact, true);
    }
    this.surfaceGrip = grounded > 0 ? gripSum / grounded : 1;
    const surfaceDrag = grounded > 0 ? dragSum / c.wheels.length : 0;

    // --- body forces -----------------------------------------------
    if (speed > 0.01) {
      // Aerodynamic drag opposing velocity: F = -c * |v| * v.
      _impulse.copy(_linvel).multiplyScalar(-c.dragCoefficient * this.wake.drag * this.bodyDrag * this.activeAero.drag * speed * dt);
      body.applyImpulse(_impulse, true);
    }
    if (surfaceDrag > 0 && speed > 0.1) {
      // Grass / gravel: speed-scrubbing drag, never reversing the car.
      const dv = Math.min(surfaceDrag * (0.4 + speed / 30) * dt, speed);
      _impulse.copy(_linvel).multiplyScalar((-dv / speed) * c.mass);
      body.applyImpulse(_impulse, true);
    }
    // Aero works in the air too (an F1 car stays planted over a crest like Eau Rouge / Raidillon).
    // Not for a car on its side or roof, nor one riding on another car (pressing it down there
    // would only turn a touch into a crash).
    if (grounded > 0 || (this.aeroInAir && _up.y > 0.5 && !this.onAnotherCar())) {
      // Downforce acts on each axle by the aero balance (front share); wing damage and
      // dirty air take away that axle's part.
      const down = c.downforce * this.activeAero.downforce * speed * speed * dt;
      for (const axle of ['front', 'rear'] as const) {
        const share = axle === 'front' ? c.aeroBalance : 1 - c.aeroBalance;
        const mount = c.wheels[axle === 'front' ? 0 : c.wheels.length - 1].position;
        _origin.set(0, mount.y, mount.z).applyQuaternion(_quat).add(_pos);
        _impulse.copy(_up).multiplyScalar(-down * share * this.aero[axle] * this.wake[axle]);
        body.applyImpulseAtPoint(_impulse, _origin, true);
      }
    }

    // Roll / pitch damping (dampers, stiff chassis) plus a little yaw damping in the air;
    // on the ground the tyres damp the yaw themselves (front and rear slip angles oppose
    // a yaw rate the corner does not ask for).
    _invQuat.copy(_quat).invert();
    _localW.copy(_angvel).applyQuaternion(_invQuat);
    const yawDamp = grounded > 0 ? YAW_DAMPING : ANGULAR_DAMPING;
    const ix = ANGULAR_DAMPING * dt;
    const iy = yawDamp * dt;
    _impulse
      .set(-this.inertia.x * _localW.x * (ix / (1 + ix)), -this.inertia.y * _localW.y * (iy / (1 + iy)), -this.inertia.z * _localW.z * (ix / (1 + ix)))
      .applyQuaternion(_quat);
    body.applyTorqueImpulse(_impulse, true);

    // Hard speed cap (safety net; the limiter normally keeps us under).
    const cap = forwardSpeed >= 0 ? c.maxSpeed * 1.12 : c.maxReverseSpeed * 1.2;
    if (speed > cap) {
      const s = cap / speed;
      body.setLinvel({ x: lv.x * s, y: lv.y * s, z: lv.z * s }, true);
    }
  }

  /** Another car's chassis right below this one (all wheels in the air on top of it)? */
  private onAnotherCar(): boolean {
    const t = this.body.translation();
    this.ray.origin = { x: t.x, y: t.y, z: t.z };
    this.ray.dir = { x: 0, y: -1, z: 0 };
    const hit = this.physics.world.castRay(this.ray, 2.5, true, undefined, undefined, undefined, this.body);
    return !!hit && hit.collider.collisionGroups() === CHASSIS_GROUPS;
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
      w.load = 0;
    }
  }

  dispose(): void {
    this.physics.world.removeRigidBody(this.body);
  }
}
