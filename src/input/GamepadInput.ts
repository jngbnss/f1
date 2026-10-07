import type { InputAction, InputSource, VehicleInput } from './VehicleInput';

const DEADZONE = 0.12;

function deadzone(v: number): number {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  return Math.sign(v) * ((a - DEADZONE) / (1 - DEADZONE));
}

/**
 * Standard-mapping gamepad (Xbox/PlayStation layout):
 * left stick X = steer, RT = throttle, LT = brake, A/Cross = handbrake, Y/Triangle = reset.
 * Also a reference implementation for future devices (gyro, wheel, WebSocket).
 */
export class GamepadInput implements InputSource {
  readonly id = 'gamepad';
  private prevReset = false;
  private actions: InputAction[] = [];

  read(): VehicleInput | null {
    const pad = this.activePad();
    if (!pad) return null;

    const resetPressed = pad.buttons[3]?.pressed ?? false;
    if (resetPressed && !this.prevReset) this.actions.push('reset');
    this.prevReset = resetPressed;

    const input: VehicleInput = {
      steer: deadzone(pad.axes[0] ?? 0),
      throttle: pad.buttons[7]?.value ?? 0,
      brake: pad.buttons[6]?.value ?? 0,
      handbrake: pad.buttons[0]?.value ?? 0,
    };
    const active = input.throttle > 0.02 || input.brake > 0.02 || input.handbrake > 0.02 || input.steer !== 0;
    return active ? input : null;
  }

  consumeActions(): InputAction[] {
    const out = this.actions;
    this.actions = [];
    return out;
  }

  dispose(): void {}

  private activePad(): Gamepad | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    for (const pad of navigator.getGamepads()) {
      if (pad && pad.connected && pad.mapping === 'standard') return pad;
    }
    return null;
  }
}
