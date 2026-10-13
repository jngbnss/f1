import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { InputAction, InputSource, VehicleInput } from './VehicleInput';
import { OneEuro, oneHandAngle, openness, toView, twoHandAngle, type Point } from './handFeatures';

/** Runtime + model, pinned to the installed @mediapipe/tasks-vision version. */
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** Wheel angle (deg) for full lock, and the dead zone around straight ahead. */
const FULL_LOCK_DEG = 45;
const STEER_DEADZONE_DEG = 3;
/** Openness below this is still a grip (relaxed fist) — no brake. */
const BRAKE_DEADZONE = 0.15;
/** Keep the last command through short tracking dropouts (ms). */
const HOLD_MS = 150;

/**
 * Webcam hand driving (desktop): both fists hold an invisible steering wheel,
 * the tilt of the line between them steers, opening the hands brakes (the
 * more open, the harder). Throttle is automatic while not braking. One hand
 * in view still steers by its own lean.
 *
 * Detection runs on its own animation-frame loop at camera rate; read() only
 * returns the latest filtered values, so the physics step never waits on it.
 */
export class HandInput implements InputSource {
  readonly id = 'hand';
  /** Hands from the latest frame in selfie view space (see toView), for the preview. */
  hands: Point[][] = [];
  /** Camera frame width / height. */
  aspect = 4 / 3;
  steer = 0;
  brake = 0;
  private lastSeen = -Infinity;
  private lastVideoTime = -1;
  private raf = 0;
  private readonly steerFilter = new OneEuro(1.2, 0.8);
  private readonly brakeFilter = new OneEuro(2, 1);

  private constructor(
    readonly video: HTMLVideoElement,
    private readonly stream: MediaStream,
    private readonly landmarker: HandLandmarker,
  ) {
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Asks for the camera and loads the model. Rejects if the camera is denied or missing. */
  static async create(): Promise<HandInput> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      const options = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO' as const,
        numHands: 2,
      });
      // GPU is much faster; some drivers/browsers refuse it, the CPU path always works.
      const landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU')).catch(() =>
        HandLandmarker.createFromOptions(fileset, options('CPU')),
      );
      return new HandInput(video, stream, landmarker);
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      throw err;
    }
  }

  /** Hands seen recently enough to drive. */
  get tracking(): boolean {
    return performance.now() - this.lastSeen <= HOLD_MS;
  }

  read(): VehicleInput | null {
    if (!this.tracking) return null;
    return { throttle: this.brake > 0 ? 0 : 1, brake: this.brake, steer: this.steer, handbrake: 0 };
  }

  consumeActions(): InputAction[] {
    return [];
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const t of this.stream.getTracks()) t.stop();
    this.video.srcObject = null;
    this.landmarker.close();
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    const v = this.video;
    // One detection per new camera frame (camera rate, typically 30 fps).
    if (v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const now = performance.now();
    const result = this.landmarker.detectForVideo(v, now);
    if (v.videoWidth && v.videoHeight) this.aspect = v.videoWidth / v.videoHeight;
    const hands = result.landmarks.map((lm) => toView(lm, this.aspect));
    this.hands = hands;
    if (!hands.length) return;

    // After a dropout start the filters fresh instead of easing from stale values.
    if (!this.tracking) {
      this.steerFilter.reset();
      this.brakeFilter.reset();
    }
    const dt = Math.min((now - this.lastSeen) / 1000, 0.1);
    this.lastSeen = now;

    const angle = hands.length >= 2 ? twoHandAngle(hands[0], hands[1]) : oneHandAngle(hands[0]);
    const a = Math.abs(angle) < STEER_DEADZONE_DEG ? 0 : angle - Math.sign(angle) * STEER_DEADZONE_DEG;
    const rawSteer = Math.max(-1, Math.min(1, a / (FULL_LOCK_DEG - STEER_DEADZONE_DEG)));
    this.steer = Math.max(-1, Math.min(1, this.steerFilter.filter(rawSteer, dt)));

    let open = 0;
    for (const h of hands) open += openness(h);
    open /= hands.length;
    const rawBrake = open < BRAKE_DEADZONE ? 0 : (open - BRAKE_DEADZONE) / (1 - BRAKE_DEADZONE);
    const brake = this.brakeFilter.filter(rawBrake, dt);
    this.brake = brake < 0.02 ? 0 : Math.min(1, brake);
  };
}
