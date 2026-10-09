import * as THREE from 'three';
import type { VehicleInput } from '../input/VehicleInput';
import type { Compound } from '../vehicle/Tyres';
import type { Vehicle } from '../vehicle/Vehicle';
import { PIT_SPEED_LIMIT, type PitLaneData } from '../world/PitLane';
import type { Track } from '../world/Track';

/**
 * Automatic pit stops, F1-game style: once a car with a pit request reaches
 * the pit entry it is driven down the lane at the speed limit, stops in its
 * team's box, gets the requested tyres (and repairs) and is driven back out;
 * at the end of the exit ramp control returns to the driver / AI.
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
}

export interface PitService {
  /** Called when the car stops: fit tyres, repair; returns the stationary time (s). */
  (vehicle: Vehicle, compound: Compound): number;
}

const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();

export class PitStops {
  private readonly states = new Map<Vehicle, PitState>();
  private readonly input: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

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
    this.states.set(v, { phase: 'requested', compound, box: Math.min(box, this.pit.boxes.length - 1), k: 0, timer: 0, service: 0 });
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

  /** True while the pit controller drives this car (ignore driver / AI input). */
  driving(v: Vehicle): boolean {
    const p = this.phase(v);
    return p === 'in' || p === 'stopped' || p === 'out';
  }

  /**
   * Per fixed step for a car: switches requested cars into the lane at the
   * entry and returns the pit driver's input while it drives.
   */
  update(v: Vehicle, dt: number): VehicleInput | null {
    const s = this.states.get(v);
    if (!s) return null;
    const pit = this.pit;
    if (s.phase === 'requested') {
      // Enter when passing the first metres of the entry ramp.
      const i = this.track.nearestIndex(v.position);
      const k = pit.pathIndex.indexOf(i);
      if (k < 0 || k > 6) return null;
      s.phase = 'in';
      s.k = k;
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
      if (s.timer >= s.service) s.phase = 'out';
      return this.input;
    }
    if (s.phase === 'in') {
      // Brake into the limiter zone, then crawl to the box.
      const toBox = (box - s.k) * 2.5;
      const stopSpeed = Math.sqrt(Math.max(0, 2 * 6 * (toBox - 1.5)));
      const beforeLimiter = (pit.limiterStart - s.k) * 2.5;
      const entrySpeed = Math.sqrt(PIT_SPEED_LIMIT ** 2 + 2 * 25 * Math.max(0, beforeLimiter));
      target = Math.min(stopSpeed, s.k < pit.limiterStart ? entrySpeed : PIT_SPEED_LIMIT);
      if (toBox < 1.5 && Math.abs(speed) < 0.8) {
        s.phase = 'stopped';
        s.timer = 0;
        s.service = this.service(v, s.compound);
      }
    } else {
      // Leaving: limiter until the line, then full speed down the exit ramp.
      target = s.k < pit.limiterEnd ? PIT_SPEED_LIMIT : 90;
      if (s.k >= pit.path.length - 3) {
        this.states.delete(v);
        return null;
      }
    }
    // Pure pursuit on the lane.
    const look = pit.path[Math.min(s.k + Math.max(3, Math.round(Math.abs(speed) * 0.35)), pit.path.length - 1)];
    _fwd.set(0, 0, -1).applyQuaternion(v.quaternion).setY(0).normalize();
    _to.subVectors(look, v.position).setY(0);
    const right = -_fwd.z * _to.x + _fwd.x * _to.z;
    const ahead = _fwd.dot(_to);
    this.input.steer = THREE.MathUtils.clamp(Math.atan2(right, Math.max(ahead, 0.1)) * 2.2, -1, 1);
    const err = target - speed;
    this.input.throttle = err > 0.5 ? Math.min(1, err * 0.25) : 0;
    this.input.brake = err < -0.5 ? Math.min(1, -err * 0.12) : 0;
    this.input.handbrake = 0;
    return this.input;
  }
}
