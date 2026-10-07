import * as THREE from 'three';
import type { PhysicsWorld } from './PhysicsWorld';

/** Draws Rapier's collider wireframes (enable with ?debug=1). */
export class PhysicsDebugRenderer {
  readonly lines: THREE.LineSegments;

  constructor(private readonly physics: PhysicsWorld) {
    const material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), material);
    this.lines.frustumCulled = false;
  }

  update(): void {
    const { vertices, colors } = this.physics.world.debugRender();
    const geometry = this.lines.geometry;
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  }
}
