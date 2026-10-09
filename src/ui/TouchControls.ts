import './responsive.css';
import { TouchInput } from '../input/TouchInput';
import { driveSettings, type DriveSettingsState } from './DriveSettings';

/** What the touch UI needs from the running game (kept small on purpose). */
export interface TouchHost {
  /** Pause / resume the simulation (and its sound). */
  setPaused(paused: boolean): void;
  /** True while the player's front wheels are locked (for haptics). */
  playerLocked(): boolean;
}

/**
 * On-screen controls for phones and tablets, laid out like mobile racing
 * games: steering arrows bottom-left (unless tilt steering), a big brake
 * pedal bottom-right with drift above it, a gas pedal in manual-throttle
 * mode, and small buttons for pause, camera, reset, timing tower and
 * settings. Multi-touch via Pointer Events; each button captures its own
 * pointer so sliding a thumb off does not leave it stuck.
 */
export class TouchControls {
  readonly input = new TouchInput();
  private readonly root: HTMLDivElement;
  private readonly pauseEl: HTMLDivElement;
  private readonly settingsEl: HTMLDivElement;
  private readonly unwatch: () => void;
  private paused = false;
  private raf = 0;
  private lastBuzz = 0;

  constructor(private readonly host: TouchHost) {
    document.body.classList.add('touch');
    const root = (this.root = div('touch-ui'));

    const left = button('tc-steer tc-left', '◀', '왼쪽');
    const right = button('tc-steer tc-right', '▶', '오른쪽');
    const brake = button('tc-pedal tc-brake', '<b>BRAKE</b>', '브레이크');
    const drift = button('tc-pedal tc-drift', 'DRIFT', '드리프트');
    const gas = button('tc-pedal tc-gas', '<b>GAS</b>', '가속');
    this.hold(left, 'left');
    this.hold(right, 'right');
    this.hold(brake, 'brake', () => buzz(12));
    this.hold(drift, 'drift', () => buzz(8));
    this.hold(gas, 'gas');

    const bar = div('tc-bar');
    const pause = button('tc-small', '⏸', '일시정지');
    const cam = button('tc-small', '🎥', '시점');
    const reset = button('tc-small', '↺', '리셋');
    const board = button('tc-small', '☰', '순위표');
    const gear = button('tc-small', '⚙', '설정');
    tap(pause, () => this.setPaused(true));
    tap(cam, () => key('KeyC'));
    tap(reset, () => this.input.requestReset());
    tap(board, () => document.body.classList.toggle('board-full'));
    tap(gear, () => this.openSettings());
    bar.append(pause, cam, reset, board, gear);

    root.append(left, right, gas, brake, drift, bar);

    // Pause overlay.
    this.pauseEl = div('tc-overlay');
    const pausePanel = div('tc-panel');
    pausePanel.innerHTML = '<h2>일시정지</h2>';
    const resume = button('tc-wide primary', '계속하기', '계속하기');
    const settings = button('tc-wide', '조작 설정', '조작 설정');
    const menu = button('tc-wide', '메뉴로', '메뉴로');
    tap(resume, () => this.setPaused(false));
    tap(settings, () => this.openSettings());
    tap(menu, () => key('Escape'));
    pausePanel.append(resume, settings, menu);
    this.pauseEl.append(pausePanel);

    this.settingsEl = div('tc-overlay');
    const rotate = div('tc-rotate');
    rotate.innerHTML = '<div>📱↻</div><p>가로로 돌리면 더 넓게 볼 수 있어요</p>';

    document.body.append(root, this.pauseEl, this.settingsEl, rotate);
    this.unwatch = driveSettings.watch((s) => this.apply(s));

    // Haptic "judder" while the fronts are locked.
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      if (!this.paused && this.host.playerLocked()) {
        const now = performance.now();
        if (now - this.lastBuzz > 120) {
          this.lastBuzz = now;
          buzz(25);
        }
      }
    };
    this.raf = requestAnimationFrame(tick);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.unwatch();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.root.remove();
    this.pauseEl.remove();
    this.settingsEl.remove();
    this.input.dispose();
  }

  private onVisibility = (): void => {
    if (document.hidden) this.setPaused(true);
  };

  private setPaused(paused: boolean): void {
    this.paused = paused;
    this.host.setPaused(paused);
    this.input.enabled = !paused;
    this.pauseEl.classList.toggle('show', paused);
    if (!paused) this.settingsEl.classList.remove('show');
  }

  private apply(s: Readonly<DriveSettingsState>): void {
    this.root.classList.toggle('tilt', s.steer === 'tilt');
    this.root.classList.toggle('manual', s.throttle === 'manual');
  }

  private openSettings(): void {
    if (!this.paused) this.setPaused(true);
    const s = driveSettings.get();
    const el = this.settingsEl;
    el.innerHTML = '';
    const panel = div('tc-panel');
    panel.innerHTML = '<h2>조작 설정</h2>';
    const row = (label: string, options: [string, string][], current: string, pick: (v: string) => void) => {
      const r = div('tc-row');
      const l = document.createElement('span');
      l.textContent = label;
      const seg = div('tc-seg');
      for (const [value, text] of options) {
        const b = button(value === current ? 'on' : '', text, text);
        tap(b, () => {
          pick(value);
          this.openSettings();
        });
        seg.append(b);
      }
      r.append(l, seg);
      panel.append(r);
    };
    row('조향', [['buttons', '버튼'], ['tilt', '기울기']], s.steer, async (v) => {
      if (v === 'tilt' && !(await TouchInput.requestTiltPermission())) {
        alert('기울기 센서를 쓸 수 없어요 (권한이 거부됐거나 지원하지 않는 기기).');
        return;
      }
      driveSettings.set({ steer: v as DriveSettingsState['steer'] });
      this.openSettings();
    });
    row('가속', [['auto', '자동'], ['manual', '페달']], s.throttle, (v) => driveSettings.set({ throttle: v as DriveSettingsState['throttle'] }));
    row('브레이크 보조', [['on', '켬'], ['off', '끔']], s.brakeAssist ? 'on' : 'off', (v) => driveSettings.set({ brakeAssist: v === 'on' }));
    if (s.steer === 'tilt') {
      row('기울기 감도', [['40', '낮음'], ['28', '보통'], ['18', '높음']], String(s.tiltRange), (v) => driveSettings.set({ tiltRange: Number(v) }));
      const center = button('tc-wide', '지금 각도를 정면으로', '정면 맞추기');
      tap(center, () => this.input.recenter());
      panel.append(center);
    }
    const done = button('tc-wide primary', '완료', '완료');
    tap(done, () => this.setPaused(false));
    panel.append(done);
    el.append(panel);
    el.classList.add('show');
  }

  /** Held button -> pressed flag (multi-touch safe). */
  private hold(el: HTMLElement, flag: keyof TouchInput['pressed'], onDown?: () => void): void {
    const set = (v: boolean) => {
      this.input.pressed[flag] = v;
      el.classList.toggle('down', v);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      set(true);
      onDown?.();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) el.addEventListener(type, () => set(false));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

function div(className: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  return d;
}

function button(className: string, html: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.innerHTML = html;
  b.setAttribute('aria-label', label);
  return b;
}

function tap(el: HTMLElement, fn: () => void): void {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    fn();
  });
}

/** Game shortcuts live on the keyboard handler: reuse them. */
function key(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code }));
}

function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported (iOS) */
  }
}
