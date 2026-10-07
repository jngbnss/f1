import { emptyInput, type InputAction, type InputSource, type VehicleInput } from './VehicleInput';

/**
 * Merges any number of input sources into one VehicleInput.
 * Pedals take the max across devices, steering takes the input with the
 * largest magnitude — so keyboard + gamepad (or phone + wheel) can coexist.
 */
export class InputManager {
  private readonly sources: InputSource[] = [];
  private readonly state: VehicleInput = emptyInput();
  /** Id of the device that produced the latest non-idle input (for HUD/debug). */
  activeSource = 'none';

  add(source: InputSource): this {
    this.sources.push(source);
    return this;
  }

  remove(id: string): void {
    const i = this.sources.findIndex((s) => s.id === id);
    if (i >= 0) this.sources.splice(i, 1)[0].dispose();
  }

  /** Sample all devices. Call once per fixed step. */
  poll(): { input: Readonly<VehicleInput>; actions: InputAction[] } {
    const s = this.state;
    s.throttle = 0;
    s.brake = 0;
    s.steer = 0;
    s.handbrake = 0;
    const actions: InputAction[] = [];

    for (const source of this.sources) {
      actions.push(...source.consumeActions());
      const r = source.read();
      if (!r) continue;
      this.activeSource = source.id;
      s.throttle = Math.max(s.throttle, r.throttle);
      s.brake = Math.max(s.brake, r.brake);
      s.handbrake = Math.max(s.handbrake, r.handbrake);
      if (Math.abs(r.steer) > Math.abs(s.steer)) s.steer = r.steer;
    }
    return { input: s, actions };
  }

  dispose(): void {
    for (const s of this.sources) s.dispose();
    this.sources.length = 0;
  }
}
