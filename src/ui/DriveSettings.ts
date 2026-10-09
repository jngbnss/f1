/**
 * Driver aids and touch layout, remembered per browser (localStorage).
 *  - brake assist (ABS-like, never locks): default on for touch, on for
 *    keyboard too (a digital key cannot modulate the pedal); B toggles it
 *  - touch steering: on-screen buttons or tilting the phone
 *  - touch throttle: automatic (Asphalt-style) or a gas pedal button
 */
export type SteerMode = 'buttons' | 'tilt';
export type ThrottleMode = 'auto' | 'manual';

export interface DriveSettingsState {
  brakeAssist: boolean;
  steer: SteerMode;
  throttle: ThrottleMode;
  /** Tilt sensitivity: degrees of tilt for full lock. */
  tiltRange: number;
}

const KEY = 'drive-settings';
const DEFAULTS: DriveSettingsState = { brakeAssist: true, steer: 'buttons', throttle: 'auto', tiltRange: 28 };

type Listener = (s: Readonly<DriveSettingsState>) => void;

class DriveSettingsStore {
  private state: DriveSettingsState;
  private readonly listeners = new Set<Listener>();

  constructor() {
    let saved: Partial<DriveSettingsState> = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DriveSettingsState>;
    } catch {
      /* storage blocked or corrupt: defaults */
    }
    this.state = { ...DEFAULTS, ...saved };
  }

  get(): Readonly<DriveSettingsState> {
    return this.state;
  }

  set(patch: Partial<DriveSettingsState>): void {
    this.state = { ...this.state, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* not remembered, still applied */
    }
    for (const l of this.listeners) l(this.state);
  }

  /** Calls `fn` now and on every change; returns an unsubscribe function. */
  watch(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }
}

export const driveSettings = new DriveSettingsStore();
