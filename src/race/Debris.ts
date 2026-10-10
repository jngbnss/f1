import * as THREE from 'three';
import { DETACH } from '../vehicle/Damage';
import type { Vehicle } from '../vehicle/Vehicle';

/**
 * Debris left on the track by crashes. Every damaging impact sheds carbon
 * shards; a wing that comes off stays on the track as a big piece. Pieces skid
 * to a stop and stay until they are cleared (a couple of minutes; a safety car
 * will clear them sooner once there is one).
 *
 * Driving over debris:
 * - a shard under a tyre: the tyre skates for a moment (grip loss on that
 *   wheel) and sometimes it cuts the tyre: a puncture;
 * - a wing lying on the track: both tyres of the axle skate, the floor is
 *   damaged and the puncture risk is higher.
 * Pieces that are hit get kicked along the track.
 *
 * Deterministic for a given seed (race tests compare runs).
 */
export type DebrisKind = 'shard' | 'wing';

export interface DebrisPiece {
  kind: DebrisKind;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Heading on the ground (rad) and spin rate (rad/s). */
  yaw: number;
  spin: number;
  age: number;
  /** Cars that already ran over it (each car is affected once). */
  hitBy: Set<Vehicle>;
  /** Team colour of the car it came from (wings are painted). */
  color: number;
  /** The real wing mesh, when the car model handed it over (drawn instead of a plank). */
  object?: THREE.Object3D;
}

export type DebrisEvent = { car: Vehicle; kind: 'puncture'; wheel: number } | { car: Vehicle; kind: 'slide'; wheel: number } | { car: Vehicle; kind: 'floor' };

/** Contact radius of a piece (m): a shard is a hand-sized bit, a wing ~1.8 m wide. */
const RADIUS: Record<DebrisKind, number> = { shard: 0.35, wing: 0.95 };
/** Seconds a piece stays before it is cleared. */
const LIFE: Record<DebrisKind, number> = { shard: 150, wing: 240 };
/** Chance that running over it cuts the tyre. */
const PUNCTURE_CHANCE: Record<DebrisKind, number> = { shard: 0.05, wing: 0.25 };
/** Seconds a tyre skates after running over it. */
const SLIDE_TIME: Record<DebrisKind, number> = { shard: 0.3, wing: 0.6 };
/** Floor damage from running over a wing. */
const WING_FLOOR_DAMAGE = 0.15;
/** Carbon skidding on asphalt (m/s²). */
const SKID_DECEL = 7;
const MAX_PIECES = 80;
const TYRE_RADIUS = 0.35;

const _wheel = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class DebrisField {
  readonly pieces: DebrisPiece[] = [];
  /** Punctures and floor damage caused so far (race tests report them). */
  punctures = 0;
  private seed: number;

  constructor(seed = 1) {
    this.seed = seed >>> 0 || 1;
  }

  /** Deterministic 0..1 (mulberry32). */
  private random(): number {
    let t = (this.seed = (this.seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * A damaging impact on `car` (damage before the hit given): shards for any new
   * damage, plus the wing itself when it just came off.
   */
  onDamage(car: Vehicle, before: { front: number; rear: number; floor: number }, color = 0x222222): DebrisPiece[] {
    const d = car.damage;
    const added = Math.max(0, d.front - before.front) + Math.max(0, d.rear - before.rear) + Math.max(0, d.floor - before.floor);
    const out: DebrisPiece[] = [];
    if (added <= 0) return out;
    const shards = Math.min(6, Math.max(1, Math.round(added * 10)));
    for (let k = 0; k < shards; k++) out.push(this.spawn(car, 'shard', (this.random() - 0.5) * 3, color));
    if (before.front < DETACH && d.front >= DETACH) out.push(this.spawn(car, 'wing', -2.6, color));
    if (before.rear < DETACH && d.rear >= DETACH) out.push(this.spawn(car, 'wing', 2.4, color));
    return out;
  }

  /** A piece leaving `car` at `along` m along it (+ = behind the car). */
  private spawn(car: Vehicle, kind: DebrisKind, along: number, color: number): DebrisPiece {
    _fwd.set(0, 0, 1).applyQuaternion(car.quaternion).setY(0).normalize();
    const p = car.position.clone().addScaledVector(_fwd, along);
    p.y = groundY(car);
    const v = car.physics.body.linvel();
    // Thrown with part of the car's speed, scattered sideways.
    const keep = kind === 'wing' ? 0.5 : 0.35 + 0.3 * this.random();
    const velocity = new THREE.Vector3(v.x * keep + (this.random() - 0.5) * 6, 0, v.z * keep + (this.random() - 0.5) * 6);
    const piece: DebrisPiece = { kind, position: p, velocity, yaw: this.random() * Math.PI * 2, spin: (this.random() - 0.5) * 12, age: 0, hitBy: new Set(), color };
    this.pieces.push(piece);
    if (this.pieces.length > MAX_PIECES) {
      const oldest = this.pieces.findIndex((x) => x.kind === 'shard');
      this.pieces.splice(oldest >= 0 ? oldest : 0, 1);
    }
    return piece;
  }

  /** One fixed step: pieces skid, age and get cleared; cars run over them. */
  step(cars: readonly Vehicle[], dt: number, onEvent?: (e: DebrisEvent) => void): void {
    for (let k = this.pieces.length - 1; k >= 0; k--) {
      const p = this.pieces[k];
      p.age += dt;
      if (p.age > LIFE[p.kind]) {
        this.pieces.splice(k, 1);
        continue;
      }
      const speed = Math.hypot(p.velocity.x, p.velocity.z);
      if (speed > 0) {
        const slow = Math.max(0, speed - SKID_DECEL * dt) / speed;
        p.velocity.multiplyScalar(slow);
        p.position.addScaledVector(p.velocity, dt);
        p.yaw += p.spin * dt;
        p.spin *= slow;
      }
    }
    if (!this.pieces.length) return;
    for (const car of cars) {
      if (car.physics.speed < 3) continue;
      const pos = car.position;
      for (const p of this.pieces) {
        if (p.hitBy.has(car)) continue;
        const dx = p.position.x - pos.x;
        const dz = p.position.z - pos.z;
        if (dx * dx + dz * dz > 16 || Math.abs(p.position.y - pos.y) > 2) continue;
        const wheel = this.wheelOver(car, p);
        if (wheel < 0) continue;
        p.hitBy.add(car);
        this.runOver(car, p, wheel, onEvent);
      }
    }
  }

  /** Index of a grounded wheel whose contact patch is on the piece, or -1. */
  private wheelOver(car: Vehicle, p: DebrisPiece): number {
    const wheels = car.config.wheels;
    const reach = RADIUS[p.kind] + TYRE_RADIUS;
    for (let i = 0; i < wheels.length; i++) {
      if (!car.physics.wheels[i].grounded) continue;
      const w = wheels[i].position;
      _wheel.set(w.x, 0, w.z).applyQuaternion(car.quaternion).add(car.position);
      const dx = _wheel.x - p.position.x;
      const dz = _wheel.z - p.position.z;
      if (dx * dx + dz * dz < reach * reach) return i;
    }
    return -1;
  }

  private runOver(car: Vehicle, p: DebrisPiece, wheel: number, onEvent?: (e: DebrisEvent) => void): void {
    // Wheels on the same axle as the one that hit (a wing spans the car's width).
    const axle = p.kind === 'wing' ? [wheel & ~1, (wheel & ~1) + 1] : [wheel];
    for (const i of axle) {
      car.debrisSlide[i] = Math.max(car.debrisSlide[i], SLIDE_TIME[p.kind]);
      onEvent?.({ car, kind: 'slide', wheel: i });
    }
    if (!car.tyres.punctured[wheel] && this.random() < PUNCTURE_CHANCE[p.kind]) {
      car.tyres.puncture(wheel);
      this.punctures++;
      onEvent?.({ car, kind: 'puncture', wheel });
    }
    if (p.kind === 'wing') {
      car.damage.floor = Math.min(1, car.damage.floor + WING_FLOOR_DAMAGE);
      onEvent?.({ car, kind: 'floor' });
    }
    // Kicked along: part of the car's velocity, flicked sideways.
    const v = car.physics.body.linvel();
    const kick = p.kind === 'wing' ? 0.3 : 0.5;
    p.velocity.set(v.x * kick + (this.random() - 0.5) * 8, 0, v.z * kick + (this.random() - 0.5) * 8);
    p.spin = (this.random() - 0.5) * 20;
  }

  /** Every piece cleared (new session). */
  clear(): void {
    this.pieces.length = 0;
  }
}

/** Road height under a car: its wheel mounts minus spring and tyre. */
function groundY(car: Vehicle): number {
  const c = car.config;
  const w = car.physics.wheels;
  let drop = 0;
  let n = 0;
  for (const s of w) {
    if (!s.grounded) continue;
    drop += s.suspensionLength + c.wheelRadius;
    n++;
  }
  const mount = c.wheels[0].position.y;
  return car.position.y + mount - (n ? drop / n : c.suspensionRestLength + c.wheelRadius);
}
