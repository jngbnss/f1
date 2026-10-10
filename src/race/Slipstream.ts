import * as THREE from 'three';
import type { Vehicle } from '../vehicle/Vehicle';

/**
 * Slipstream and dirty air: every car leaves a wake, a cone behind it that
 * widens and fades with distance. A car inside it
 *  - has less drag (towed along: higher speed down the straight), and
 *  - loses downforce, the front wing most (understeer when following closely
 *    through a corner).
 *
 * Numbers from the public FIA / F1 CFD figures on following cars: pre-2022
 * cars lost ~35 % of their downforce 20 m behind and ~44-47 % at 10 m; the
 * 2022 rules aimed at 4 % / 18 %, and by 2025 the loss was back above 30 %.
 * The 2026 rules aim lower again, so we use the 2022 targets (~17 % at 10 m,
 * ~8 % at 20 m); more than that made cars run wide in every corner behind another. The drag reduction
 * (up to ~35 % right behind, ~18 % at 20 m) gives the 10-15 km/h end-of-
 * straight tow seen in races. The model is the usual game one (a decaying
 * region behind each car), as no open-source sim exposes a better one.
 */
/** Car length: gaps are measured from the leader's gearbox to the follower's nose (m). */
const CAR_LENGTH = 5.4;
/** Wake reach (m of gap) and its decay lengths. */
const REACH = 60;
const DRAG_DECAY = 25;
const DOWNFORCE_DECAY = 12;
const MAX_DRAG_CUT = 0.35;
const MAX_DOWNFORCE_LOSS = 0.35;
/** The front wing works in the wake, the rear sits higher in cleaner air. */
const FRONT_SHARE = 1.15;
const REAR_SHARE = 0.85;
/** The wake builds with the leader's speed (full above ~150 km/h). */
const FULL_WAKE_SPEED = 42;

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _rel = new THREE.Vector3();

export interface WakeState {
  /** 0..1: share of drag removed (for the HUD). */
  tow: number;
  /** 0..1: share of downforce lost. */
  dirty: number;
}

/** Wake strength (0..1) of `leader` at `follower`, and the bumper gap (m). */
function wakeAt(leader: Vehicle, follower: Vehicle): { strength: number; gap: number } | null {
  const vL = leader.physics.forwardSpeed;
  if (vL < 10) return null;
  _fwd.set(0, 0, -1).applyQuaternion(leader.quaternion).setY(0).normalize();
  _right.set(-_fwd.z, 0, _fwd.x);
  _rel.subVectors(follower.position, leader.position).setY(0);
  const behind = -_rel.dot(_fwd);
  const gap = behind - CAR_LENGTH;
  if (gap < -1 || gap > REACH) return null;
  // The cone widens behind the car (~1.1 m half width at the gearbox, ~3 m at 60 m).
  const half = 1.1 + 0.032 * Math.max(gap, 0);
  const lat = Math.abs(_rel.dot(_right));
  if (lat >= half + 0.8) return null;
  const across = 1 - THREE.MathUtils.smoothstep(lat, half - 0.4, half + 0.8);
  const speed = Math.min(1, (vL / FULL_WAKE_SPEED) ** 2);
  return { strength: across * speed, gap: Math.max(gap, 0) };
}

/**
 * Per fixed step, before the cars step: sets every car's `physics.wake`
 * from the cars ahead of it (the strongest wake counts). Returns each car's
 * tow / dirty-air share for the HUD.
 */
export function updateSlipstream(vehicles: readonly Vehicle[], out?: Map<Vehicle, WakeState>): void {
  for (const f of vehicles) {
    let tow = 0;
    let dirty = 0;
    for (const l of vehicles) {
      if (l === f) continue;
      const w = wakeAt(l, f);
      if (!w) continue;
      tow = Math.max(tow, Math.min(MAX_DRAG_CUT, 0.4 * Math.exp(-w.gap / DRAG_DECAY)) * w.strength);
      dirty = Math.max(dirty, Math.min(MAX_DOWNFORCE_LOSS, 0.4 * Math.exp(-w.gap / DOWNFORCE_DECAY)) * w.strength);
    }
    const wake = f.physics.wake;
    wake.drag = 1 - tow;
    wake.front = 1 - Math.min(0.9, dirty * FRONT_SHARE);
    wake.rear = 1 - dirty * REAR_SHARE;
    if (out) {
      const s = out.get(f);
      if (s) {
        s.tow = tow;
        s.dirty = dirty;
      } else out.set(f, { tow, dirty });
    }
  }
}
