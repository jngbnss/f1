import * as THREE from 'three';
import { BARRIER_GROUPS, CHASSIS_GROUPS, type PhysicsWorld } from '../physics/PhysicsWorld';
import type { Vehicle } from '../vehicle/Vehicle';

const _force = new THREE.Vector3();

/**
 * Turns the last physics step's contact-force events into wing damage.
 * Only barriers / pit wall and other cars count (the chassis touching the
 * ground on a kerb or landing is not an impact). Calls `onChange` for every
 * car whose damage changed.
 */
export function applyImpacts(physics: PhysicsWorld, byCollider: ReadonlyMap<number, Vehicle>, dt: number, onChange: (v: Vehicle) => void): void {
  physics.drainContactForces((h1, h2, force) => {
    const v1 = byCollider.get(h1);
    const v2 = byCollider.get(h2);
    if (!v1 && !v2) return;
    const other = (h: number) => physics.world.getCollider(h)?.collisionGroups();
    const counts = (h: number) => {
      const g = other(h);
      return g === BARRIER_GROUPS || g === CHASSIS_GROUPS;
    };
    // Rapier reports the force collider 1 applies on collider 2 (checked in scripts/damage-test.ts):
    // collider 1 gets the opposite. Impulse = force x step.
    if (v1 && counts(h2)) {
      _force.set(-force.x, -force.y, -force.z).multiplyScalar(dt);
      if (v1.damage.hit(_force, v1.quaternion)) onChange(v1);
    }
    if (v2 && counts(h1)) {
      _force.set(force.x, force.y, force.z).multiplyScalar(dt);
      if (v2.damage.hit(_force, v2.quaternion)) onChange(v2);
    }
  });
}
