import * as THREE from 'three';
import type { VehicleInput } from '../input/VehicleInput';
import { CHASSIS_GROUPS, PIT_GHOST_GROUPS } from '../physics/PhysicsWorld';
import type { Compound } from '../vehicle/Tyres';
import type { Vehicle } from '../vehicle/Vehicle';
import { BOX_LANE_SHIFT, FAST_LANE_SHIFT, PIT_SPEED_LIMIT, type PitLaneData } from '../world/PitLane';
import type { Track } from '../world/Track';

/**
 * Automatic pit stops, F1-game style: once a car with a pit request reaches
 * the pit entry it is driven down the fast lane at the speed limit, swings
 * into its team's box in the working lane, gets the requested tyres (and
 * repairs), waits for a safe release and is driven back out; at the end of
 * the exit ramp control returns to the driver / AI.
 *
 * Cars in the lane keep their distance (a teammate queues behind a car still
 * in the box) and pass through other cars (as in the F1 games), so a knock
 * from behind can never leave a car stuck short of its box.
 */
export type PitPhase = 'requested' | 'in' | 'stopped' | 'out';

interface PitState {
  phase: PitPhase;
  compound: Compound;
  box: number;
  /** Progress along the pit path (index). */
  k: number;
  timer: number;
  service: number;
  /** Seconds crawling without anything ahead (recovery after a spin). */
  stuck: number;
}

export interface PitService {
  /** Called when the car stops: fit tyres, repair; returns the stationary time (s). */
  (vehicle: Vehicle, compound: Compound): number;
}

/** Path sample spacing (m). */
const STEP = 2.5;
/** Path samples over which a car swings between the fast lane and its box (~15 m). */
const SWING = 6;
/** Bumper-to-bumper distance kept in the lane (m) and the car length used for it. */
const GAP = 2;
const CAR_LENGTH = 5.6;

const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class PitStops {
  private readonly states = new Map<Vehicle, PitState>();
  private readonly input: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  /** Cars passing through other cars (pit lane, and until clear of traffic after it). */
  private readonly ghosts = new Set<Vehicle>();
  /** Every car that is stepped (to check the exit is clear before a ghost turns solid). */
  private readonly all = new Set<Vehicle>();
  private readonly released = new Map<number, { vehicle: Vehicle; seconds: number }>();

  constructor(
    private readonly pit: PitLaneData,
    private readonly track: Track,
    private readonly service: PitService,
  ) {}

  /** Requests (or cancels, when already requested) a stop for this car. */
  request(v: Vehicle, compound: Compound, box: number): void {
    const s = this.states.get(v);
    if (s && s.phase !== 'requested') return;
    if (s) {
      this.states.delete(v);
      return;
    }
    this.states.set(v, { phase: 'requested', compound, box: Math.min(box, this.pit.boxes.length - 1), k: 0, timer: 0, service: 0, stuck: 0 });
  }

  setCompound(v: Vehicle, compound: Compound): void {
    const s = this.states.get(v);
    if (s?.phase === 'requested') s.compound = compound;
  }

  phase(v: Vehicle): PitPhase | null {
    return this.states.get(v)?.phase ?? null;
  }

  state(v: Vehicle): Readonly<PitState> | null {
    return this.states.get(v) ?? null;
  }

  /** Cars in the pit lane (for the pit crews). */
  *snapshots(): Generator<{ vehicle: Vehicle; phase: 'in' | 'stopped' | 'out'; box: number; k: number; timer: number; service: number }> {
    for (const [vehicle, s] of this.states) if (s.phase !== 'requested') yield { vehicle, phase: s.phase, box: s.box, k: s.k, timer: s.timer, service: s.service };
  }

  /** The last car released from a box and how long it stood there (s). */
  lastService(box: number): { vehicle: Vehicle; seconds: number } | null {
    return this.released.get(box) ?? null;
  }

  /** True while the pit controller drives this car (ignore driver / AI input). */
  driving(v: Vehicle): boolean {
    const p = this.phase(v);
    return p === 'in' || p === 'stopped' || p === 'out';
  }

  /** 0 = fast lane, 1 = in the box line: swing in before the box, and back out after it when leaving. */
  private boxBlend(s: PitState, k: number): number {
    const box = this.pit.boxes[s.box];
    const d = k - box;
    const t = d <= 0 ? 1 + d / SWING : s.phase === 'out' ? 1 - d / SWING : 1;
    const c = THREE.MathUtils.clamp(t, 0, 1);
    return c * c * (3 - 2 * c);
  }

  /** The line this car follows at path index k. */
  private linePoint(s: PitState, k: number, out: THREE.Vector3): THREE.Vector3 {
    const pit = this.pit;
    const i = THREE.MathUtils.clamp(Math.round(k), 0, pit.path.length - 1);
    return out.copy(pit.fastPath[i]).addScaledVector(pit.outward[i], (BOX_LANE_SHIFT - FAST_LANE_SHIFT) * this.boxBlend(s, i));
  }

  /** Lateral distance of `p` from the fast lane at path index k. */
  private offFastLane(p: THREE.Vector3, k: number): number {
    const i = THREE.MathUtils.clamp(k, 0, this.pit.path.length - 1);
    return Math.abs(_to.subVectors(p, this.pit.fastPath[i]).dot(this.pit.outward[i]));
  }

  private setGhost(v: Vehicle, ghost: boolean): void {
    if (ghost === this.ghosts.has(v)) return;
    v.physics.collider.setCollisionGroups(ghost ? PIT_GHOST_GROUPS : CHASSIS_GROUPS);
    if (ghost) this.ghosts.add(v);
    else this.ghosts.delete(v);
  }

  /** A ghost turns solid again only once no other car overlaps it. */
  private settleGhost(v: Vehicle): void {
    for (const o of this.all) if (o !== v && o.position.distanceToSquared(v.position) < 7 * 7) return;
    this.setGhost(v, false);
  }

  /** Speed that stops this car a safe gap behind the nearest pit car ahead on its line. */
  private followSpeed(v: Vehicle, s: PitState): number {
    let limit = Infinity;
    for (const [o, os] of this.states) {
      if (o === v || os.phase === 'requested' || os.k <= s.k || os.k - s.k > 30) continue;
      const line = this.linePoint(s, os.k, _p);
      const i = THREE.MathUtils.clamp(os.k, 0, this.pit.path.length - 1);
      if (Math.abs(_to.subVectors(o.position, line).dot(this.pit.outward[i])) > 2.4) continue;
      const gap = (os.k - s.k) * STEP - CAR_LENGTH - GAP;
      limit = Math.min(limit, Math.sqrt(2 * 6 * Math.max(0, gap)));
    }
    return limit;
  }

  /** Unsafe release check: a car coming down the fast lane just behind the box. */
  private laneBusy(v: Vehicle, s: PitState): boolean {
    for (const [o, os] of this.states) {
      if (o === v || (os.phase !== 'in' && os.phase !== 'out')) continue;
      if (os.k < s.k - 12 || os.k > s.k + 2) continue;
      if (this.offFastLane(o.position, os.k) < 2.4) return true;
    }
    return false;
  }

  /**
   * Per fixed step for a car: switches requested cars into the lane at the
   * entry and returns the pit driver's input while it drives.
   */
  update(v: Vehicle, dt: number): VehicleInput | null {
    this.all.add(v);
    const s = this.states.get(v);
    if (!s) {
      if (this.ghosts.has(v)) this.settleGhost(v);
      return null;
    }
    const pit = this.pit;
    if (s.phase === 'requested') {
      // Enter when passing the first metres of the entry ramp.
      const i = this.track.nearestIndex(v.position);
      const k = pit.pathIndex.indexOf(i);
      if (k < 0 || k > 12) return null;
      s.phase = 'in';
      s.k = k;
      this.setGhost(v, true);
    }
    // Advance along the path to the nearest point ahead.
    while (s.k < pit.path.length - 1 && pit.path[s.k + 1].distanceToSquared(v.position) < pit.path[s.k].distanceToSquared(v.position)) s.k++;
    const speed = v.physics.forwardSpeed;
    const box = pit.boxes[s.box];
    let target: number;
    if (s.phase === 'stopped') {
      s.timer += dt;
      this.input.throttle = 0;
      this.input.brake = 1;
      this.input.steer = 0;
      this.input.handbrake = 1;
      // Lollipop up only when the fast lane behind is clear.
      if (s.timer >= s.service && !this.laneBusy(v, s)) {
        s.phase = 'out';
        this.released.set(s.box, { vehicle: v, seconds: s.timer });
      }
      return this.input;
    }
    if (s.phase === 'in') {
      // Brake into the limiter zone, then crawl to the box.
      const toBox = (box - s.k) * STEP;
      const stopSpeed = Math.sqrt(Math.max(0, 2 * 6 * (toBox - 1.5)));
      const beforeLimiter = (pit.limiterStart - s.k) * STEP;
      const entrySpeed = Math.sqrt(PIT_SPEED_LIMIT ** 2 + 2 * 25 * Math.max(0, beforeLimiter));
      target = Math.min(stopSpeed, s.k < pit.limiterStart ? entrySpeed : PIT_SPEED_LIMIT);
      if (toBox < 1.5 && Math.abs(speed) < 0.8) {
        s.phase = 'stopped';
        s.timer = 0;
        s.stuck = 0;
        s.service = this.service(v, s.compound);
      }
    } else {
      // Leaving: limiter until the line, then full speed down the exit ramp.
      target = s.k < pit.limiterEnd ? PIT_SPEED_LIMIT : 90;
      if (s.k >= pit.path.length - 3) {
        this.states.delete(v);
        this.settleGhost(v);
        return null;
      }
    }
    const free = target;
    target = Math.min(target, this.followSpeed(v, s));
    this.recover(v, s, speed, free > 1 && target > 1, dt);
    // Pure pursuit on the lane.
    const look = this.linePoint(s, Math.min(s.k + Math.max(3, Math.round(Math.abs(speed) * 0.35)), pit.path.length - 1), _p);
    _fwd.set(0, 0, -1).applyQuaternion(v.quaternion).setY(0).normalize();
    _to.subVectors(look, v.position).setY(0);
    const right = -_fwd.z * _to.x + _fwd.x * _to.z;
    const ahead = _fwd.dot(_to);
    this.input.steer = THREE.MathUtils.clamp(Math.atan2(right, Math.max(ahead, 0.1)) * 2.2, -1, 1);
    const err = target - speed;
    this.input.throttle = err > 0.5 ? Math.min(1, err * 0.25) : 0;
    this.input.brake = err < -0.5 ? Math.min(1, -err * 0.12) : target < 0.3 && Math.abs(speed) < 1 ? 1 : 0;
    this.input.handbrake = 0;
    return this.input;
  }

  /** A car that should be moving but sits still for 3 s (spun, wedged on the wall) is put back on its line. */
  private recover(v: Vehicle, s: PitState, speed: number, shouldMove: boolean, dt: number): void {
    s.stuck = shouldMove && Math.abs(speed) < 0.5 ? s.stuck + dt : 0;
    if (s.stuck < 3) return;
    s.stuck = 0;
    const pit = this.pit;
    const k = Math.min(s.k, pit.path.length - 2);
    const pos = this.linePoint(s, k, new THREE.Vector3());
    _to.subVectors(pit.path[k + 1], pit.path[k]);
    // Car forward is -Z (as Track.poseAt).
    _q.setFromAxisAngle(UP, Math.atan2(-_to.x, -_to.z));
    v.teleport({ position: pos.setY(pos.y + 0.6), quaternion: _q.clone() });
  }
}
