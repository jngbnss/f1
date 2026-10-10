import * as THREE from 'three';

/**
 * Bodywork damage from impacts, F1-game style: hits on the nose break the
 * front wing (less front downforce = understeer), hits from behind the rear
 * wing (less rear downforce = oversteer), hits from the side and running over
 * a wing lying on the track break the floor / sidepod (the 2026 cars make a
 * big share of their downforce under the floor: less grip on both axles).
 * Broken parts flap in the air: more drag, lower top speed.
 * 0 = intact, 1 = part gone; past DETACH a wing falls off. Repaired in the pits.
 */
export const DETACH = 0.6;
/**
 * Impulses below this (N·s) are racing contact: no damage. Measured in a
 * 20-car Monza lap: median contact 350, 95th percentile 2300, 99th 12800.
 */
const MIN_IMPULSE = 4500;
/** Impulse above the minimum for a full write-off of the hit end (N·s). */
const FULL_IMPULSE = 16000;

const _local = new THREE.Vector3();
const _inv = new THREE.Quaternion();

export class DamageState {
  front = 0;
  rear = 0;
  floor = 0;

  get any(): boolean {
    return this.front > 0.02 || this.rear > 0.02 || this.floor > 0.02;
  }

  /**
   * One contact: `force` = impulse vector applied to this car (world, N·s),
   * `orientation` = the car's rotation. Returns true if damage changed.
   */
  hit(force: THREE.Vector3, orientation: THREE.Quaternion): boolean {
    const impulse = force.length();
    if (impulse < MIN_IMPULSE) return false;
    _local.copy(force).divideScalar(impulse).applyQuaternion(_inv.copy(orientation).invert());
    const amount = (impulse - MIN_IMPULSE) / FULL_IMPULSE;
    // Car forward is local -Z: pushed backwards (+Z) = something hit the nose.
    if (_local.z > 0.45) this.front = Math.min(1, this.front + amount * _local.z);
    else if (_local.z < -0.45) this.rear = Math.min(1, this.rear - amount * _local.z);
    // Side impact (T-bone, squeezed into the wall): sidepod and floor edge.
    else if (Math.abs(_local.x) > 0.7) this.floor = Math.min(1, this.floor + amount * 0.6 * Math.abs(_local.x));
    else return false;
    return true;
  }

  /** Downforce left on each axle (the floor feeds both, a little more at the rear). */
  aero(): { front: number; rear: number } {
    return { front: (1 - 0.5 * this.front) * (1 - 0.3 * this.floor), rear: (1 - 0.55 * this.rear) * (1 - 0.35 * this.floor) };
  }

  /** Drag multiplier: a dangling wing, broken endplates or a torn floor catch the air. */
  drag(): number {
    return 1 + 0.06 * this.front + 0.05 * this.rear + 0.08 * this.floor;
  }

  repair(): void {
    this.front = this.rear = this.floor = 0;
  }
}
