import RAPIER from '@dimforge/rapier3d-compat';

export type Rapier = typeof RAPIER;

/**
 * Thin owner of the Rapier world. Everything physics-related receives this
 * instead of importing Rapier globals, so a Web Worker physics backend can
 * be swapped in later behind the same surface.
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;

  private constructor(
    readonly rapier: Rapier,
    fixedDt: number,
  ) {
    this.world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = fixedDt;
  }

  /** Loads the WASM module (embedded in the -compat build, no bundler plugin needed). */
  static async create(fixedDt: number): Promise<PhysicsWorld> {
    await RAPIER.init();
    return new PhysicsWorld(RAPIER, fixedDt);
  }

  step(): void {
    this.world.step();
  }
}
