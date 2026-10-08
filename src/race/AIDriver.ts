import * as THREE from 'three';
import type { VehicleInput } from '../input/VehicleInput';
import type { Vehicle } from '../vehicle/Vehicle';
import type { RacingLine } from '../world/RacingLine';
import type { Track } from '../world/Track';

export interface AIProfile {
  /** Fraction of the racing-line target speed this driver dares (0.8–1). */
  pace: number;
  /** Preferred lateral offset from the racing line (m) — spreads the field. */
  lane: number;
  /** 0..1: how eagerly it dives for overtakes instead of following. */
  aggression: number;
}

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _to = new THREE.Vector3();
const _target = new THREE.Vector3();
const _tan = new THREE.Vector3();

/**
 * Computer driver. Produces a VehicleInput (same as a keyboard or gamepad
 * would), so AI cars go through the exact same controller + physics as the
 * player:
 *  - steering: pure pursuit on the racing line, with a lateral offset
 *  - speed: the racing line's per-car speed profile scaled by `pace`, braking
 *    early enough for the slowest point within braking distance
 *  - traffic: cars ahead in its path make it pick a side to pass, or lift
 *  - recovery: reverses out when stuck, resets to the track as a last resort
 */
export class AIDriver {
  readonly input: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  private index = -1;
  private offset: number;
  private stuckTime = 0;
  private reverseTime = 0;

  constructor(
    readonly vehicle: Vehicle,
    private readonly line: RacingLine,
    private readonly track: Track,
    readonly profile: AIProfile,
  ) {
    this.offset = profile.lane;
  }

  /** @param others every other car on track (player included) */
  update(dt: number, others: readonly Vehicle[]): VehicleInput {
    const v = this.vehicle;
    const line = this.line;
    const count = line.points.length;
    const pos = v.position;
    const speed = v.physics.forwardSpeed;
    const inp = this.input;
    this.index = line.nearestFrom(pos, this.index);

    _fwd.set(0, 0, -1).applyQuaternion(v.quaternion).setY(0).normalize();
    _right.set(-_fwd.z, 0, _fwd.x);

    // --- recovery ---------------------------------------------------
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      inp.throttle = 0;
      inp.brake = 1;
      inp.handbrake = 0;
      inp.steer = -Math.sign(this.steerTowards(this.lookaheadPoint(speed)) || 1);
      return inp;
    }

    // --- traffic: anyone in our path? ----------------------------------
    let desiredOffset = this.profile.lane;
    let followSpeed = Infinity;
    // Racing line position across the track, to express other cars relative to it.
    const lineLateral = this.track.lateral(this.line.points[this.index]);
    for (const o of others) {
      if (o === v) continue;
      _to.subVectors(o.position, pos).setY(0);
      const ahead = _to.dot(_fwd);
      const side = _to.dot(_right);
      if (ahead < -2 || ahead > 35 || Math.abs(side) > 3.2) continue;
      const otherSpeed = o.physics.forwardSpeed;
      if (otherSpeed > speed + 2 && ahead > 6) continue; // pulling away, ignore
      // Pass on the side with more room (asphalt edge minus margin).
      const half = this.track.halfWidth - 1.6;
      const otherLat = this.track.lateral(o.position);
      const roomRight = half - otherLat;
      const roomLeft = otherLat + half;
      const passSide = roomRight > roomLeft ? 1 : -1;
      const room = Math.max(roomRight, roomLeft);
      if (room > 3.2 && ahead > 3) {
        desiredOffset = otherLat - lineLateral + passSide * 3.4;
      }
      // Closing in with no room to pass (or a cautious driver): match speed
      // with a ~5 m gap instead of ramming.
      const closing = speed - otherSpeed;
      if (ahead < 10 && closing > 0 && (room < 3.2 || this.profile.aggression < 0.25)) {
        followSpeed = Math.min(followSpeed, otherSpeed + (ahead - 5) * 0.5);
      }
    }
    this.offset += (desiredOffset - this.offset) * (1 - Math.exp(-1.5 * dt));

    // --- steering: pure pursuit to a point ahead on the (offset) line ---
    inp.steer = THREE.MathUtils.clamp(this.steerTowards(this.lookaheadPoint(speed)) * 2.6, -1, 1);

    // --- speed: brake for the slowest point within braking distance ----
    // Braking grip is planned at the (lower) target speed: conservative with aero.
    let target = line.speeds[this.index] * this.profile.pace;
    let dist = 0;
    for (let k = 1; k < 160 && dist < 320; k++) {
      dist += line.segmentLength(this.index + k - 1);
      const j = (this.index + k) % count;
      const vj = line.speeds[j] * this.profile.pace;
      const allowed = Math.sqrt(vj * vj + 2 * line.brakeAt(vj) * 0.9 * dist);
      if (allowed < target) target = allowed;
    }
    target = Math.min(target, followSpeed);
    const err = target - speed;
    inp.handbrake = 0;
    if (err > 0.5) {
      inp.throttle = Math.min(1, err / 4);
      inp.brake = 0;
    } else if (err < -1) {
      inp.throttle = 0;
      inp.brake = Math.min(1, -err / 5);
    } else {
      inp.throttle = 0.15;
      inp.brake = 0;
    }

    // --- stuck? ---------------------------------------------------------
    if (Math.abs(speed) < 1 && inp.throttle > 0.3) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt);
    if (this.stuckTime > 2) {
      this.stuckTime = 0;
      this.reverseTime = 1.3;
      this.unstuckCount++;
    }
    return inp;
  }

  /** Times it had to back out; the race manager resets cars that keep failing. */
  unstuckCount = 0;

  /** Starting the race / after a reset. */
  resetState(): void {
    this.index = -1;
    this.stuckTime = 0;
    this.reverseTime = 0;
    this.offset = this.profile.lane;
    this.input.throttle = this.input.brake = this.input.steer = this.input.handbrake = 0;
  }

  private lookaheadPoint(speed: number): THREE.Vector3 {
    const line = this.line;
    const count = line.points.length;
    const ahead = 7 + Math.max(speed, 0) * 0.55;
    let d = 0;
    let j = this.index;
    for (let k = 0; k < 200 && d < ahead; k++) {
      d += line.segmentLength(j);
      j = (j + 1) % count;
    }
    const p = line.points[j];
    _tan.subVectors(line.points[(j + 1) % count], line.points[(j - 1 + count) % count]).setY(0).normalize();
    // Offset perpendicular to the line (+ = right), clamped to stay on the asphalt.
    const half = this.track.halfWidth - 1.3;
    _target.set(p.x - _tan.z * this.offset, 0, p.z + _tan.x * this.offset);
    const lat = this.track.lateral(_target);
    if (Math.abs(lat) > half) {
      const fix = lat - Math.sign(lat) * half;
      _target.x -= -_tan.z * fix;
      _target.z -= _tan.x * fix;
    }
    return _target;
  }

  /** Signed angle (rad) from the car's heading to `p` (+ = right). */
  private steerTowards(p: THREE.Vector3): number {
    _to.subVectors(p, this.vehicle.position).setY(0).normalize();
    const cross = _fwd.x * _to.z - _fwd.z * _to.x; // + = target to the right
    const dot = _fwd.dot(_to);
    return Math.atan2(cross, dot);
  }
}
