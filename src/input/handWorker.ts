/**
 * MediaPipe hand + face detection off the main thread (a module worker), so
 * inference and its GPU read-backs never stall the game's frame. HandInput
 * posts camera frames as ImageBitmaps (one in flight at a time) and gets the
 * landmarks back.
 */
import { FaceDetector, FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

/** Runtime + models, pinned to the installed @mediapipe/tasks-vision version. */
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm';
const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const FACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

export type HandWorkerRequest = { type: 'init' } | { type: 'frame'; bitmap: ImageBitmap; ts: number; withFace: boolean };

export interface FaceBoxPx {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export type HandWorkerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string }
  /** `face` is undefined when not looked for this frame, null when not found. */
  | { type: 'result'; landmarks: { x: number; y: number }[][]; face: FaceBoxPx | null | undefined };

let hands: HandLandmarker | null = null;
let face: FaceDetector | null = null;

const post = (msg: HandWorkerResponse) => (self as unknown as Worker).postMessage(msg);

/** Loads both tasks; resolves with the delegate the hand model ended up on. */
async function init(): Promise<'GPU' | 'CPU'> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL, true);
  // GPU needs a WebGL2 OffscreenCanvas per task in a worker; the CPU path always works.
  const handTask = (delegate: 'GPU' | 'CPU') =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
      canvas: new OffscreenCanvas(1, 1),
      runningMode: 'VIDEO',
      numHands: 2,
    });
  const faceTask = (delegate: 'GPU' | 'CPU') =>
    FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate },
      canvas: new OffscreenCanvas(1, 1),
      runningMode: 'VIDEO',
    });
  let delegate: 'GPU' | 'CPU' = 'GPU';
  const handCpu = () => {
    delegate = 'CPU';
    return handTask('CPU');
  };
  [hands, face] = await Promise.all([handTask('GPU').catch(handCpu), faceTask('GPU').catch(() => faceTask('CPU'))]);
  return delegate;
}

self.onmessage = (e: MessageEvent<HandWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    init().then(
      (delegate) => post({ type: 'ready', delegate }),
      (err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }
  const { bitmap, ts, withFace } = msg;
  try {
    if (!hands || !face) return;
    const landmarks = hands.detectForVideo(bitmap, ts).landmarks.map((lm) => lm.map((p) => ({ x: p.x, y: p.y })));
    let box: FaceBoxPx | null | undefined;
    if (withFace) {
      const b = face.detectForVideo(bitmap, ts).detections[0]?.boundingBox;
      box = b ? { originX: b.originX, originY: b.originY, width: b.width, height: b.height } : null;
    }
    post({ type: 'result', landmarks, face: box });
  } finally {
    bitmap.close();
  }
};
