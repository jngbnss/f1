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

/** Race start: grid lane kept until the first, fully on the line from the second (m); before the first corner of short run-ups (Monza T1 is ~350 m from the line). */
const START_MERGE = [60, 260];
/** Street circuits: the first corner comes quickly (Monaco's Sainte Devote), so be on the line before braking for it. */
const START_MERGE_STREET = [10, 90];
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _to = new THREE.Vector3();
const _target = new THREE.Vector3();
const _tan = new THREE.Vector3();

/** Car length and width used for gaps and overlap in traffic (m). */
const CAR_LENGTH = 5.6;
const OVERLAP = 2.6;

/** A car's place on the track: distance along the centreline and offset across it (shared by all AI, once per step). */
interface TrackPos {
  x: number;
  z: number;
  s: number;
  lat: number;
}
const trackPosCache = new WeakMap<Vehicle, TrackPos>();

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
  /**
   * Race start: keep the grid slot's lane (offset from the line where the car
   * stands) and merge onto the racing line between START_MERGE meters, like
   * real starts, instead of all 20 cars swerving onto one line at once.
   */
  private startOffset: number | null = null;
  private travelled = 0;

  constructor(
    readonly vehicle: Vehicle,
    private readonly line: RacingLine,
    private readonly track: Track,
    readonly profile: AIProfile,
  ) {
    this.offset = profile.lane;
    vehicle.controller.brakeRamp = false;
    vehicle.controller.agileSteering = false;
    vehicle.physics.brakeGrip = 1;
    vehicle.physics.brakeForceScale = 1;
    vehicle.physics.frontGripScale = 1;
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
    if (this.startOffset === null) {
      this.startOffset = this.track.lateral(pos) - this.track.lateral(line.points[this.index]);
      this.offset = this.startOffset;
    }
    this.travelled += Math.max(speed, 0) * dt;

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
    const [m0, m1] = this.track.street ? START_MERGE_STREET : START_MERGE;
    const merge = Math.min(Math.max((this.travelled - m0) / (m1 - m0), 0), 1);
    // Street circuits (Monaco): stay on the line in single file; lanes only on wide tracks.
    const lane = this.track.street ? this.profile.lane * 0.3 : this.profile.lane;
    let desiredOffset = this.startOffset + (lane - this.startOffset) * merge * merge * (3 - 2 * merge);
    let followSpeed = Infinity;
    let sideNudge = 0;
    // Slow corners just ahead (hairpins): single file. Lane changes there run cars into the
    // inside wall at the apex; on street circuits they stay on the line and a car half a
    // length behind yields instead of squeezing alongside.
    let slowest = Infinity;
    for (let k = 0; k < 16; k++) slowest = Math.min(slowest, line.speeds[(this.index + k) % count]);
    const street = this.track.street;
    const slowCorner = slowest < (street ? 30 : 22);
    const laneScale = slowCorner && street ? 0 : 1;
    // Racing line position across the track, to express other cars relative to it.
    const lineLateral = this.track.lateral(this.line.points[this.index]);
    // Traffic is measured along the track (distance along it, offset across it), as the
    // TORCS / Speed Dreams robots do: in a hairpin the car ahead is already round the
    // bend, far off our heading, but still right in front of us on the track.
    const me = this.trackPos(v);
    const length = this.track.length;
    const ph0 = v.physics;
    const tyre = ph0.tyreGrip;
    const gripNow = Math.min(1, ((tyre[0] + tyre[1] + tyre[2] + tyre[3]) / 4) * (0.5 + 0.5 * Math.min(ph0.aero.front * ph0.wake.front, ph0.aero.rear * ph0.wake.rear)));
    for (const o of others) {
      if (o === v) continue;
      const op = this.trackPos(o);
      let ahead = op.s - me.s;
      if (ahead > length / 2) ahead -= length;
      if (ahead < -length / 2) ahead += length;
      const side = op.lat - me.lat;
      // Alongside: make room instead of leaning on each other (wheel-to-wheel contact pushes cars off).
      if (Math.abs(ahead) < CAR_LENGTH && Math.abs(side) < 2.9) {
        if (street && slowCorner) {
          if (ahead > 0) followSpeed = Math.min(followSpeed, Math.max(0, o.physics.forwardSpeed - 2));
          continue;
        }
        sideNudge += (side > 0 ? -1 : 1) * (2.9 - Math.abs(side));
        continue;
      }
      // Look further ahead at speed: at 300 km/h a car 60 m ahead is under a second away.
      if (ahead < 2 || ahead > Math.max(40, speed * 1.6) || Math.abs(side) > 4.5) continue;
      const otherSpeed = Math.max(0, o.physics.forwardSpeed);
      // Pass on the side with more room (asphalt edge minus margin).
      const half = this.track.halfWidth - 1.6;
      const otherLat = op.lat;
      const roomRight = half - otherLat;
      const roomLeft = otherLat + half;
      const passSide = roomRight > roomLeft ? 1 : -1;
      const room = Math.max(roomRight, roomLeft);
      // Between walls a pass needs a real gap (Monaco is nearly impossible to pass on).
      const passRoom = this.track.street ? 5.5 : 3.2;
      if (room > passRoom && ahead > 3) {
        desiredOffset = otherLat - lineLateral + passSide * 3.4;
      }
      // In its lane: keep a gap from which we can still stop if the car ahead brakes as
      // hard as it can (the Gipps car-following model, as in the SUMO traffic simulator):
      //   v²/2a_me + v·τ + margin <= gap + v_ahead²/2a_ahead
      // Braking depends on speed (downforce: ~5 g at 300 km/h, ~1.5 g in a hairpin), and
      // in its dirty air we brake weaker than the car ahead. Moving out of its lane (a pass)
      // lifts the limit.
      if (Math.abs(side) < OVERLAP) {
        const aMe = this.line.brakeAt(Math.min(speed, otherSpeed)) * 0.8 * gripNow;
        const aAhead = this.line.brakeAt(otherSpeed);
        const tau = street ? 0.45 : 0.3;
        const reach = ahead - CAR_LENGTH - (street ? 3 : 2) + (otherSpeed * otherSpeed) / (2 * aAhead);
        const safe = reach > 0 ? aMe * (-tau + Math.sqrt(tau * tau + (2 * reach) / aMe)) : 0;
        followSpeed = Math.min(followSpeed, safe);
      }
    }
    desiredOffset = (desiredOffset + sideNudge) * laneScale;
    // Never aim off the asphalt (passing on the outside of a corner used to run cars into the barrier).
    const edge = this.track.halfWidth - 1.8;
    desiredOffset = THREE.MathUtils.clamp(lineLateral + desiredOffset, -edge, edge) - lineLateral;
    this.offset += (desiredOffset - this.offset) * (1 - Math.exp(-1.5 * dt));

    // --- steering: pure pursuit to a point ahead on the (offset) line ---
    inp.steer = THREE.MathUtils.clamp(this.steerTowards(this.lookaheadPoint(speed)) * 2.6, -1, 1);

    // --- speed: brake for the slowest point within braking distance ----
    // The line was planned on fresh tyres, intact wings and clean air. Grip = tyre x
    // (mechanical + aero share), and the aero share grows with speed (brakeAt(v) =
    // mu(g + aero v²)): a broken wing or another car's dirty air costs little in a
    // hairpin but a lot in a 300 km/h corner like Blanchimont. Corner speed scales with
    // sqrt(grip), braking with grip.
    const ph = v.physics;
    const g = ph.tyreGrip;
    const tyreGrip = Math.min(1, (g[0] + g[1]) / 2, (g[2] + g[3]) / 2);
    const aeroLeft = Math.min(ph.aero.front * ph.wake.front, ph.aero.rear * ph.wake.rear);
    const b0 = line.brakeAt(0);
    const gripAt = (s: number) => {
      const b = line.brakeAt(s);
      return (tyreGrip * (b0 + aeroLeft * (b - b0))) / b;
    };
    const pace = this.profile.pace;
    // The plan's speeds assume clean-air acceleration. In a tow the car really accelerates
    // harder, so it drives to the corner / braking limits instead (it can only go as fast
    // as the physics lets it). Flat-out straights stay flat out.
    const profile = ph.wake.drag < 0.97 ? line.limits : line.speeds;
    const vTop = v.config.maxSpeed * 0.999;
    const cornerAt = (j: number) => {
      const lim = profile[j];
      return lim >= vTop ? lim * pace : lim * pace * Math.sqrt(gripAt(lim * pace));
    };
    let target = cornerAt(this.index);
    let dist = 0;
    for (let k = 1; k < 160 && dist < 320; k++) {
      dist += line.segmentLength(this.index + k - 1);
      const j = (this.index + k) % count;
      const vj = cornerAt(j);
      const allowed = Math.sqrt(vj * vj + 2 * line.brakeAt(vj) * 0.9 * gripAt(vj) * dist);
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

  private trackPos(o: Vehicle): TrackPos {
    const p = o.position;
    let c = trackPosCache.get(o);
    if (c && c.x === p.x && c.z === p.z) return c;
    const i = this.track.nearestIndex(p);
    const s = (i / this.track.getCenterline().length) * this.track.length;
    c = { x: p.x, z: p.z, s, lat: this.track.lateral(p, i) };
    trackPosCache.set(o, c);
    return c;
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
    // Between walls the pursuit point stays closer (a long chord cuts tight corners into the wall).
    const ahead = this.track.street ? 5 + Math.max(speed, 0) * 0.32 : 7 + Math.max(speed, 0) * 0.55;
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
    _target.set(p.x - _tan.z * this.offset, p.y, p.z + _tan.x * this.offset);
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
