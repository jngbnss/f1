import * as THREE from 'three';
import { PIT_GHOST_GROUPS, type PhysicsWorld } from '../physics/PhysicsWorld';
import { SAFETY_CAR_DEF } from '../vehicle/cars';
import { Vehicle } from '../vehicle/Vehicle';
import { RacingLine } from '../world/RacingLine';
import { racingLineFor } from '../world/RacingLineOptimizer';
import type { Track } from '../world/Track';
import { AIDriver } from './AIDriver';

/**
 * The safety car: a GT car with a light bar that joins the track ahead of the
 * leader, runs at a steady pace on the racing line (the field queues behind
 * it through the AI's car following) and, once race control calls "safety car
 * in this lap", peels off at the pit entry and is gone.
 *
 * It passes through the cars (no collisions: it must never cause a crash),
 * and is built only when it is needed.
 */
/** Distance ahead of the leader where it joins (m). */
const JOIN_AHEAD = 160;
/** Share of its own racing pace (a safety car is quick, but well below an F1 car). */
const PACE = 0.85;
/** Where it leaves when it comes in: this far before the start line (m) without a pit lane. */
const IN_BEFORE_LINE = 300;

export class SafetyCar {
  vehicle: Vehicle | null = null;
  private ai: AIDriver | null = null;
  private line: RacingLine | null = null;
  private readonly lightBar: THREE.Group;
  private readonly lamps: THREE.MeshStandardMaterial[] = [];
  private blink = 0;
  /** Set when race control calls it in: it leaves at the pit entry. */
  private comingIn = false;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly track: Track,
    private readonly scene: THREE.Object3D,
  ) {
    // Amber light bar on the roof (two lamps blinking in turn).
    this.lightBar = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.22), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5 }));
    this.lightBar.add(base);
    for (const x of [-0.32, 0.32]) {
      const mat = new THREE.MeshStandardMaterial({ color: 0xffa200, emissive: 0xff9000, emissiveIntensity: 2, roughness: 0.3 });
      this.lamps.push(mat);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.09, 0.18), mat);
      lamp.position.set(x, 0.07, 0);
      this.lightBar.add(lamp);
    }
    this.lightBar.position.set(0, 0.62, 0.25);
  }

  get out(): boolean {
    return this.vehicle !== null;
  }

  /** Brings the safety car out ahead of the car at `leaderPosition`. */
  deploy(leaderPosition: THREE.Vector3): void {
    if (this.vehicle) return;
    const center = this.track.getCenterline();
    const n = center.length;
    const i = (this.track.nearestIndex(leaderPosition) + Math.round((JOIN_AHEAD / this.track.length) * n)) % n;
    const def = SAFETY_CAR_DEF;
    const v = new Vehicle(this.physics, def.physics, def.createVisual(), this.track.getResetPose(center[i]), def.gearbox);
    v.physics.collider.setCollisionGroups(PIT_GHOST_GROUPS);
    v.physics.aeroInAir = this.track.elevated;
    v.object3D.add(this.lightBar);
    this.scene.add(v.object3D);
    if (!this.line) {
      const path = racingLineFor(this.track);
      this.line = new RacingLine(path, def.physics, { heights: this.track.heightsFor(path) });
    }
    this.ai = new AIDriver(v, this.line, this.track, { pace: PACE, lane: 0, aggression: 0 });
    this.ai.rules.noPassing = true;
    this.vehicle = v;
    this.comingIn = false;
  }

  /** Race control called "safety car in this lap". */
  callIn(): void {
    this.comingIn = true;
  }

  /** Before the physics step. Returns true when it has just left the track. */
  fixedUpdate(dt: number): boolean {
    const v = this.vehicle;
    if (!v || !this.ai) return false;
    v.fixedUpdate(this.ai.update(dt, [v]), dt);
    if (this.comingIn) {
      const n = this.track.getCenterline().length;
      const i = this.track.nearestIndex(v.position);
      const exit = this.track.pit ? this.track.pit.entryIndex : (n - Math.round((IN_BEFORE_LINE / this.track.length) * n)) % n;
      const d = (i - exit + n) % n;
      if (d < 8) {
        this.withdraw();
        return true;
      }
    }
    return false;
  }

  afterStep(): void {
    this.vehicle?.snapshot();
  }

  render(alpha: number, dt: number): void {
    if (!this.vehicle) return;
    this.vehicle.render(alpha);
    this.blink += dt;
    const on = Math.floor(this.blink * 3) % 2;
    this.lamps.forEach((m, k) => (m.emissiveIntensity = k === on ? 3 : 0.2));
  }

  withdraw(): void {
    const v = this.vehicle;
    if (!v) return;
    v.object3D.remove(this.lightBar);
    v.object3D.removeFromParent();
    v.dispose();
    this.vehicle = null;
    this.ai = null;
  }

  dispose(): void {
    this.withdraw();
    this.lightBar.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
