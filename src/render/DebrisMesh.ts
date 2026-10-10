import * as THREE from 'three';
import type { DebrisField } from '../race/Debris';

/**
 * Draws the debris on the track: carbon shards as small dark slivers, broken
 * wings as flat team-coloured planks. Two instanced meshes, rebuilt every
 * frame from the field (a few dozen pieces at most).
 */
const MAX_SHARDS = 80;
const MAX_WINGS = 24;

export class DebrisMesh {
  readonly group = new THREE.Group();
  private readonly shards: THREE.InstancedMesh;
  private readonly wings: THREE.InstancedMesh;
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3(1, 1, 1);
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _c = new THREE.Color();
  private readonly _yaw = new THREE.Quaternion();
  /** Real wing meshes placed on the track, with their orientation when they landed. */
  private readonly placed = new Map<THREE.Object3D, { base: THREE.Quaternion; yaw0: number }>();
  private readonly seen = new Set<THREE.Object3D>();

  constructor(private readonly field: DebrisField) {
    const carbon = new THREE.MeshStandardMaterial({ color: 0x26262a, roughness: 0.25, metalness: 0.4 });
    this.shards = new THREE.InstancedMesh(new THREE.BoxGeometry(0.45, 0.04, 0.24), carbon, MAX_SHARDS);
    // Main plane and endplate stub of a wing: ~1.8 m span, 0.45 m chord.
    const wing = new THREE.BoxGeometry(1.8, 0.06, 0.45);
    this.wings = new THREE.InstancedMesh(wing, new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 }), MAX_WINGS);
    for (const m of [this.shards, this.wings]) {
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      this.group.add(m);
    }
    this.group.name = 'Debris';
  }

  /** Per render frame. */
  update(): void {
    let s = 0;
    let w = 0;
    this.seen.clear();
    for (const p of this.field.pieces) {
      if (p.object) {
        // The car model's own wing: keep its tilt from the tumble, slide and spin it with the piece.
        let pose = this.placed.get(p.object);
        if (!pose) this.placed.set(p.object, (pose = { base: p.object.quaternion.clone(), yaw0: p.yaw }));
        this.seen.add(p.object);
        p.object.position.set(p.position.x, p.position.y + 0.08, p.position.z);
        p.object.quaternion.copy(pose.base).premultiply(this._yaw.setFromAxisAngle(this._up, p.yaw - pose.yaw0));
        continue;
      }
      this._q.setFromAxisAngle(this._up, p.yaw);
      if (p.kind === 'shard') {
        if (s >= MAX_SHARDS) continue;
        this._p.set(p.position.x, p.position.y + 0.02, p.position.z);
        this.shards.setMatrixAt(s++, this._m.compose(this._p, this._q, this._s));
      } else {
        if (w >= MAX_WINGS) continue;
        this._p.set(p.position.x, p.position.y + 0.04, p.position.z);
        this.wings.setMatrixAt(w, this._m.compose(this._p, this._q, this._s));
        this.wings.setColorAt(w++, this._c.setHex(p.color));
      }
    }
    // Cleared pieces (or a field reset): take their meshes off the track.
    for (const object of this.placed.keys()) {
      if (this.seen.has(object)) continue;
      object.removeFromParent();
      this.placed.delete(object);
    }
    this.shards.count = s;
    this.wings.count = w;
    this.shards.instanceMatrix.needsUpdate = true;
    this.wings.instanceMatrix.needsUpdate = true;
    if (this.wings.instanceColor) this.wings.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const m of [this.shards, this.wings]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
  }
}
