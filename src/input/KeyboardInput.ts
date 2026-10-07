import type { InputAction, InputSource, VehicleInput } from './VehicleInput';

const THROTTLE = ['KeyW', 'ArrowUp'];
const BRAKE = ['KeyS', 'ArrowDown'];
const LEFT = ['KeyA', 'ArrowLeft'];
const RIGHT = ['KeyD', 'ArrowRight'];
const HANDBRAKE = ['Space'];
const RESET = ['KeyR'];

const CAPTURED = new Set([...THROTTLE, ...BRAKE, ...LEFT, ...RIGHT, ...HANDBRAKE]);

/**
 * Digital keyboard → analog VehicleInput. Steering smoothing for digital
 * keys is done in VehicleController, not here, so every device gets
 * consistent feel tuning in one place.
 */
export class KeyboardInput implements InputSource {
  readonly id = 'keyboard';
  private readonly down = new Set<string>();
  private actions: InputAction[] = [];

  constructor(private readonly target: Window = window) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  read(): VehicleInput | null {
    if (this.down.size === 0) return null;
    const any = (codes: string[]) => (codes.some((c) => this.down.has(c)) ? 1 : 0);
    return {
      throttle: any(THROTTLE),
      brake: any(BRAKE),
      steer: any(RIGHT) - any(LEFT),
      handbrake: any(HANDBRAKE),
    };
  }

  consumeActions(): InputAction[] {
    const out = this.actions;
    this.actions = [];
    return out;
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (CAPTURED.has(e.code)) e.preventDefault();
    if (RESET.includes(e.code) && !e.repeat) this.actions.push('reset');
    this.down.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  /** Avoid stuck keys when the window loses focus mid-press. */
  private onBlur = (): void => {
    this.down.clear();
  };
}
