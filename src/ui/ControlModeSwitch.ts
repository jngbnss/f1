export type ControlMode = 'keyboard' | 'hand';

const LABELS: Record<ControlMode, string> = { keyboard: '⌨️ 키보드', hand: '✋ 손' };

/**
 * Desktop driving mode picker next to the sound button: keyboard (and
 * gamepad) only, or webcam hand steering on top. `onSelect` does the actual
 * switch; `set` reflects the current mode (also changed by the G key).
 */
export class ControlModeSwitch {
  private readonly root = document.createElement('div');
  private readonly buttons = {} as Record<ControlMode, HTMLButtonElement>;

  constructor(onSelect: (mode: ControlMode) => void) {
    this.root.className = 'control-mode';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', '조작 방식');
    for (const mode of ['keyboard', 'hand'] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = LABELS[mode];
      b.addEventListener('click', () => {
        // Drop focus, or Space (handbrake) would click the button again.
        b.blur();
        onSelect(mode);
      });
      this.buttons[mode] = b;
      this.root.append(b);
    }
    this.set('keyboard');
    document.body.append(this.root);
  }

  set(mode: ControlMode, busy = false): void {
    for (const [m, b] of Object.entries(this.buttons)) {
      b.classList.toggle('active', m === mode);
      b.setAttribute('aria-pressed', String(m === mode));
      b.disabled = busy;
    }
  }
}
