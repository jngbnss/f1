import type { InputAction, InputSource, VehicleInput } from './VehicleInput';
import { fingerCount, OneEuro, oneHandAngle, openness, palmCenter, toView, touchesHead, twoHandAngle, type Box, type Point } from './handFeatures';
import type { FaceBoxPx, HandWorkerRequest, HandWorkerResponse } from './handWorker';

/** Wheel angle (deg) for full lock, and the dead zone around straight ahead. */
const FULL_LOCK_DEG = 45;
const STEER_DEADZONE_DEG = 3;
/** Openness below this is still a grip (relaxed fist) — no brake. */
const BRAKE_DEADZONE = 0.15;
/** Keep the last command through short tracking dropouts (ms). */
const HOLD_MS = 150;
/** A hand must stay on the head this long to count (ms), so brushing past does nothing. */
const HEAD_HOLD_MS = 350;
/** After a pit call, how long finger counts pick the tyre (ms), and how long a count must hold. */
const TYRE_WINDOW_MS = 8000;
const TYRE_HOLD_MS = 700;
/** The face moves little: look for it every few detected frames. */
const FACE_EVERY = 3;

type Side = 'left' | 'right';

/**
 * Webcam hand driving (desktop): both fists hold an invisible steering wheel,
 * the tilt of the line between them steers, opening the hands brakes (the
 * more open, the harder). Throttle is automatic while not braking. One hand
 * in view still steers by its own lean.
 *
 * Gestures (need the face in view): left hand on the head = reset, right hand
 * on the head = pit call ("box this lap"); for a few seconds after a pit call
 * the number of raised fingers (1..6, both hands count) picks the tyre, as
 * the digit keys do. While a hand is on the head the wheel holds its last
 * position instead of steering with the other hand alone.
 *
 * Detection runs in a worker (handWorker.ts), one camera frame in flight at a
 * time; read() only returns the latest filtered values, so neither the
 * physics step nor the render loop ever waits on inference.
 */
export class HandInput implements InputSource {
  readonly id = 'hand';
  /** Hands from the latest frame in selfie view space (see toView), for the preview. */
  hands: Point[][] = [];
  /** Face from the latest face detection in view space, null when not seen. */
  face: Box | null = null;
  /** Camera frame width / height. */
  aspect = 4 / 3;
  steer = 0;
  brake = 0;
  /** Raised fingers while the tyre window is open (for the preview). */
  fingers = 0;
  private lastSeen = -Infinity;
  private lastResult = 0;
  /** Smoothed time between detections (ms): ~33 on a GPU, much more on the CPU path. */
  private interval = 33;
  private lastVideoTime = -1;
  private frame = 0;
  private raf = 0;
  /** A frame is with the worker (the next one waits: no queue building up). */
  private busy = false;
  private readonly steerFilter = new OneEuro(1.2, 0.8);
  private readonly brakeFilter = new OneEuro(2, 1);
  private actions: InputAction[] = [];
  /** Since when each hand has been on the head, and whether that touch already fired. */
  private readonly onHead: Record<Side, { since: number; fired: boolean } | null> = { left: null, right: null };
  private tyreWindowUntil = 0;
  private fingerSince = 0;
  private fingerValue = 0;

  private constructor(
    readonly video: HTMLVideoElement,
    private readonly stream: MediaStream,
    private readonly worker: Worker,
  ) {
    worker.onmessage = (e: MessageEvent<HandWorkerResponse>) => {
      if (e.data.type !== 'result') return;
      this.busy = false;
      this.onResult(e.data.landmarks, e.data.face, performance.now());
    };
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Asks for the camera and loads the models. Rejects if the camera is denied or missing. */
  static async create(): Promise<HandInput> {
    const stream = await navigator.mediaDevices.getUserMedia({
      // The models work at ~256 px: a VGA stream is plenty and cheap to copy each frame.
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    const worker = new Worker(new URL('./handWorker.ts', import.meta.url), { type: 'module' });
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<HandWorkerResponse>) => {
          if (e.data.type === 'ready') {
            console.info(`[hand] MediaPipe in a worker on the ${e.data.delegate}`);
            resolve();
          } else if (e.data.type === 'error') reject(new Error(e.data.message));
        };
        worker.onerror = (e) => reject(new Error(e.message || 'hand worker failed'));
        worker.postMessage({ type: 'init' } satisfies HandWorkerRequest);
      });
      return new HandInput(video, stream, worker);
    } catch (err) {
      worker.terminate();
      for (const t of stream.getTracks()) t.stop();
      throw err;
    }
  }

  /** Hands seen recently enough to drive (a couple of detections may be missed). */
  get tracking(): boolean {
    return performance.now() - this.lastSeen <= Math.max(HOLD_MS, this.interval * 2.5);
  }

  /** Finger counts pick the tyre right now. */
  get choosingTyre(): boolean {
    return performance.now() < this.tyreWindowUntil;
  }

  /** Let finger counts pick the tyre for a while (after a pit call from any source). */
  openTyreWindow(): void {
    this.tyreWindowUntil = performance.now() + TYRE_WINDOW_MS;
    this.fingerValue = -1;
  }

  read(): VehicleInput | null {
    if (!this.tracking) return null;
    return { throttle: this.brake > 0 ? 0 : 1, brake: this.brake, steer: this.steer, handbrake: 0 };
  }

  consumeActions(): InputAction[] {
    if (!this.actions.length) return this.actions;
    const out = this.actions;
    this.actions = [];
    return out;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.worker.terminate();
    for (const t of this.stream.getTracks()) t.stop();
    this.video.srcObject = null;
  }

  /** Each new camera frame goes to the worker when it is free (camera rate at most). */
  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    const v = this.video;
    if (this.busy || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    if (v.videoWidth && v.videoHeight) this.aspect = v.videoWidth / v.videoHeight;
    this.busy = true;
    const withFace = this.frame++ % FACE_EVERY === 0;
    createImageBitmap(v).then(
      (bitmap) => this.worker.postMessage({ type: 'frame', bitmap, ts: performance.now(), withFace } satisfies HandWorkerRequest, [bitmap]),
      () => {
        this.busy = false;
      },
    );
  };

  private onResult(landmarks: Point[][], face: FaceBoxPx | null | undefined, now: number): void {
    if (this.lastResult) this.interval += (Math.min(now - this.lastResult, 1000) - this.interval) * 0.2;
    this.lastResult = now;
    if (face !== undefined) this.face = face && this.faceToView(face);
    const hands = landmarks.map((lm) => toView(lm, this.aspect));
    this.hands = hands;
    if (!hands.length) {
      this.onHead.left = this.onHead.right = null;
      return;
    }

    // After a dropout start the filters fresh instead of easing from stale values.
    if (!this.tracking) {
      this.steerFilter.reset();
      this.brakeFilter.reset();
    }
    const dt = Math.min((now - this.lastSeen) / 1000, 0.1);
    this.lastSeen = now;

    const driving = this.headGestures(hands, now);
    // A hand on the head: keep the wheel where it was rather than steer with the other hand alone.
    if (driving.length < hands.length) return;
    if (this.choosingTyre) this.countFingers(hands, now);

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
  }

  /** Face box in camera pixels -> mirrored view space (x in [0, aspect], y in [0, 1]). */
  private faceToView(b: FaceBoxPx): Box {
    const W = this.video.videoWidth;
    const H = this.video.videoHeight;
    return {
      x0: (1 - (b.originX + b.width) / W) * this.aspect,
      x1: (1 - b.originX / W) * this.aspect,
      y0: b.originY / H,
      y1: (b.originY + b.height) / H,
    };
  }

  /**
   * Hands on the head fire their action once per touch (left = reset,
   * right = pit). Returns the hands that are not on the head.
   */
  private headGestures(hands: Point[][], now: number): Point[][] {
    const face = this.face;
    const touching: Record<Side, boolean> = { left: false, right: false };
    const driving: Point[][] = [];
    for (const h of hands) {
      if (!face || !touchesHead(h, face)) {
        driving.push(h);
        continue;
      }
      // Selfie view: the player's left hand is on the left of their face.
      touching[palmCenter(h).x < (face.x0 + face.x1) / 2 ? 'left' : 'right'] = true;
    }
    for (const side of ['left', 'right'] as const) {
      if (!touching[side]) {
        this.onHead[side] = null;
        continue;
      }
      const state = (this.onHead[side] ??= { since: now, fired: false });
      if (state.fired || now - state.since < HEAD_HOLD_MS) continue;
      state.fired = true;
      if (side === 'left') this.actions.push('reset');
      else {
        this.actions.push('pit');
        this.openTyreWindow();
      }
    }
    return driving;
  }

  /** In the tyre window: a finger count (1..6) held steady picks that tyre and closes the window. */
  private countFingers(hands: Point[][], now: number): void {
    let n = 0;
    for (const h of hands) n += fingerCount(h);
    this.fingers = n;
    if (n !== this.fingerValue) {
      this.fingerValue = n;
      this.fingerSince = now;
      return;
    }
    if (n < 1 || n > 6 || now - this.fingerSince < TYRE_HOLD_MS) return;
    this.actions.push(`tyre${n as 1 | 2 | 3 | 4 | 5 | 6}`);
    this.tyreWindowUntil = 0;
  }
}
