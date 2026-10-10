import type { InputAction, InputSource, VehicleInput } from './VehicleInput';
import { driveSettings } from '../ui/DriveSettings';

/**
 * Touch / phone driving, Asphalt-style: the car accelerates by itself (or
 * with a gas pedal button), steering comes from on-screen buttons or from
 * tilting the phone like a steering wheel, and a big brake button stops it.
 * TouchControls (the on-screen buttons) writes `pressed`; this source turns
 * it into a VehicleInput.
 */
export class TouchInput implements InputSource {
  readonly id = 'touch';
  /** Buttons currently held (set by TouchControls). */
  readonly pressed = { left: false, right: false, brake: false, gas: false, drift: false };
  /** Driving is suspended (race not started / paused / menu): no auto-throttle. */
  enabled = true;
  private actions: InputAction[] = [];
  /** Steering-wheel angle of the phone (deg, + = turned right) and its neutral. */
  private tilt = 0;
  private neutral: number | null = null;
  private listening = false;
  /** Smoothed steering from the buttons (a held button ramps in, like a thumb on a pad). */
  private buttonSteer = 0;
  private lastRead = performance.now();

  constructor() {
    driveSettings.watch((s) => {
      if (s.steer === 'tilt') this.listenTilt();
    });
  }

  read(): VehicleInput | null {
    const now = performance.now();
    const dt = Math.min((now - this.lastRead) / 1000, 0.1);
    this.lastRead = now;
    const s = driveSettings.get();
    const p = this.pressed;
    let steer: number;
    if (s.steer === 'tilt' && this.listening) {
      const angle = this.tilt - (this.neutral ?? this.tilt);
      // Small dead zone, then linear up to full lock at tiltRange degrees.
      const dz = 2;
      const a = Math.abs(angle) < dz ? 0 : angle - Math.sign(angle) * dz;
      steer = Math.max(-1, Math.min(1, a / s.tiltRange));
    } else {
      const target = (p.right ? 1 : 0) - (p.left ? 1 : 0);
      const rate = target === 0 ? 8 : 5;
      this.buttonSteer += Math.max(-rate * dt, Math.min(rate * dt, target - this.buttonSteer));
      steer = this.buttonSteer;
    }
    if (!this.enabled) return null;
    const throttle = p.brake ? 0 : s.throttle === 'auto' ? 1 : p.gas ? 1 : 0;
    return { throttle, brake: p.brake ? 1 : 0, steer, handbrake: p.drift ? 1 : 0 };
  }

  /** Current tilt angle becomes straight ahead. */
  recenter(): void {
    this.neutral = this.tilt;
  }

  requestReset(): void {
    this.actions.push('reset');
  }

  requestOvertake(): void {
    this.actions.push('overtake');
  }

  consumeActions(): InputAction[] {
    const out = this.actions;
    this.actions = [];
    return out;
  }

  /**
   * iOS asks for motion permission, and only from a tap: call from a click
   * handler. Resolves true when tilt steering can work.
   */
  static async requestTiltPermission(): Promise<boolean> {
    const DOE = (globalThis as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try {
        return (await DOE.requestPermission()) === 'granted';
      } catch {
        return false;
      }
    }
    return true;
  }

  dispose(): void {
    window.removeEventListener('deviceorientation', this.onOrientation);
  }

  private listenTilt(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('deviceorientation', this.onOrientation);
  }

  /**
   * The phone's "up" direction (from beta/gamma, same on every browser),
   * projected on the screen: its angle from the screen's up axis is how far
   * the phone is turned like a steering wheel, in any screen orientation.
   */
  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;
    const b = (e.beta * Math.PI) / 180;
    const g = (e.gamma * Math.PI) / 180;
    const ux = -Math.cos(b) * Math.sin(g);
    const uy = Math.sin(b);
    const angleDeg = (screen.orientation?.angle ?? (window as { orientation?: number }).orientation ?? 0) as number;
    const a = (angleDeg * Math.PI) / 180;
    // Screen axes expressed in device coordinates.
    const right = ux * Math.cos(a) - uy * Math.sin(a);
    const up = ux * Math.sin(a) + uy * Math.cos(a);
    // Turning the phone clockwise (right) leans its up vector to the screen's left.
    this.tilt = (-Math.atan2(right, up) * 180) / Math.PI;
    if (this.neutral === null) this.neutral = this.tilt;
  };
}
