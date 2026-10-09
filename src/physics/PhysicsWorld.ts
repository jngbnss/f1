import RAPIER from '@dimforge/rapier3d-compat';

export type Rapier = typeof RAPIER;

/**
 * Rapier collision groups (upper 16 bits = member of, lower 16 = interacts with).
 * Barriers and other cars are not ground: suspension rays skip them, otherwise
 * a car leaning on a barrier drives up its face and over the top, and a wheel
 * that overlaps a rival's chassis climbs onto it and flips both cars.
 */
export const BARRIER_GROUPS = 0x0002_ffff;
export const CHASSIS_GROUPS = 0x0004_ffff;
export const SUSPENSION_RAY_GROUPS = 0xffff_fff9;

/**
 * Thin owner of the Rapier world. Everything physics-related receives this
 * instead of importing Rapier globals, so a Web Worker physics backend can
 * be swapped in later behind the same surface.
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  /** Contact-force events of the last step (car impacts). */
  readonly events: RAPIER.EventQueue;

  private constructor(
    readonly rapier: Rapier,
    fixedDt: number,
  ) {
    this.world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = fixedDt;
    this.events = new rapier.EventQueue(true);
  }

  /** Loads the WASM module (embedded in the -compat build, no bundler plugin needed). */
  static async create(fixedDt: number): Promise<PhysicsWorld> {
    await RAPIER.init();
    return new PhysicsWorld(RAPIER, fixedDt);
  }

  step(): void {
    this.world.step(this.events);
  }

  /** Impacts of the last step: both collider handles and the total force between them (N, acting on collider 2). */
  drainContactForces(f: (collider1: number, collider2: number, force: RAPIER.Vector) => void): void {
    this.events.drainContactForceEvents((e) => f(e.collider1(), e.collider2(), e.totalForce()));
  }
}
