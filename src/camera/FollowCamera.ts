import * as THREE from 'three';

export interface FollowCameraOptions {
  /** Distance behind and height above the target. */
  distance: number;
  height: number;
  /** Point the camera looks at, relative to the car (up / ahead). */
  lookHeight: number;
  lookAhead: number;
  /** Exponential smoothing rates (1/s). Higher = stiffer. */
  positionDamping: number;
  rotationDamping: number;
  baseFov: number;
  /** Extra FOV at top speed for a sense of speed. */
  speedFov: number;
}

const DEFAULTS: FollowCameraOptions = {
  distance: 6.8,
  height: 2.6,
  lookHeight: 1.1,
  lookAhead: 3,
  positionDamping: 9,
  rotationDamping: 4.5,
  baseFov: 62,
  speedFov: 14,
};

/** Camera views, cycled with C (like the F1 games: chase, far chase, T-cam, cockpit, nose). */
export type CameraMode = 'chase' | 'far' | 'tcam' | 'cockpit' | 'driver' | 'nose';
export const CAMERA_MODES: CameraMode[] = ['chase', 'far', 'tcam', 'cockpit', 'driver', 'nose'];
export const CAMERA_LABELS: Record<CameraMode, string> = { chase: '체이스', far: '먼 체이스', tcam: 'T-캠', cockpit: '콕핏', driver: '드라이버 시점', nose: '노즈캠' };
type OnboardMode = 'tcam' | 'cockpit' | 'driver' | 'nose';
const isOnboard = (m: CameraMode): m is OnboardMode => m === 'tcam' || m === 'cockpit' || m === 'driver' || m === 'nose';

/**
 * Onboard camera mounts in car space (m; +X right, +Y up, -Z forward,
 * origin = chassis centre), matched to the 2026 F1 body: driver's eyes
 * under the halo, T-cam on top of the airbox, nose cam ahead of the cockpit.
 */
const ONBOARD: Record<OnboardMode, { pos: THREE.Vector3; look: THREE.Vector3; fov: number }> = {
  tcam: { pos: new THREE.Vector3(0, 0.62, 0.2), look: new THREE.Vector3(0, 0.25, -12), fov: 68 },
  cockpit: { pos: new THREE.Vector3(0, 0.44, -0.55), look: new THREE.Vector3(0, 0.2, -12), fov: 78 },
  nose: { pos: new THREE.Vector3(0, 0.12, -2.2), look: new THREE.Vector3(0, 0.05, -14), fov: 74 },
  // Inside the helmet: halo pillar, steering wheel and mirrors in view.
  driver: { pos: new THREE.Vector3(0, 0.31, -0.26), look: new THREE.Vector3(0, 0.0, -12), fov: 80 },
};
const _local = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Frame-rate independent smoothing factor. */
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const _forward = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();

/**
 * Third-person chase camera (NFS/Forza style).
 * Only the car's *yaw* is followed (smoothed), so pitch/roll from suspension
 * and bumps never shake the view; position is smoothed separately.
 */
export class FollowCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly options: FollowCameraOptions;
  private yaw = 0;
  private initialized = false;
  private readonly lookTarget = new THREE.Vector3();
  mode: CameraMode = 'chase';

  constructor(aspect: number, options: Partial<FollowCameraOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.camera = new THREE.PerspectiveCamera(this.options.baseFov, aspect, 0.3, 15000); // distant hills; small scenery is distance-culled by the track
  }

  /**
   * @param target car root (interpolated pose)
   * @param speedRatio 0..1 of top speed, drives FOV
   */
  update(target: THREE.Object3D, speedRatio: number, dt: number): void {
    if (isOnboard(this.mode)) {
      this.updateOnboard(target, speedRatio, dt);
      return;
    }
    const o = this.mode === 'far' ? { ...this.options, distance: this.options.distance * 1.6, height: this.options.height * 1.5 } : this.options;
    _forward.set(0, 0, -1).applyQuaternion(target.quaternion);
    const targetYaw = Math.atan2(-_forward.x, -_forward.z);

    if (!this.initialized) {
      this.snap(target);
      return;
    }

    this.camera.up.set(0, 1, 0);
    this.yaw += shortestAngle(this.yaw, targetYaw) * damp(o.rotationDamping, dt);

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Behind the car = opposite of its forward (-sin, -cos) -> (+sin, +cos).
    _desired.set(target.position.x + sin * o.distance, target.position.y + o.height, target.position.z + cos * o.distance);
    this.camera.position.lerp(_desired, damp(o.positionDamping, dt));

    _look.set(
      target.position.x - sin * o.lookAhead,
      target.position.y + o.lookHeight,
      target.position.z - cos * o.lookAhead,
    );
    this.lookTarget.lerp(_look, damp(o.positionDamping * 1.5, dt));
    this.camera.lookAt(this.lookTarget);

    const fov = o.baseFov + o.speedFov * Math.min(Math.max(speedRatio, 0), 1) ** 1.5;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * damp(3, dt);
      this.camera.updateProjectionMatrix();
    }
  }

  /** Next view; returns its name for the HUD. */
  cycleMode(): CameraMode {
    return this.setMode(CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length]);
  }

  setMode(mode: CameraMode): CameraMode {
    this.mode = mode;
    const onboard = isOnboard(this.mode);
    // Onboard views sit centimetres from the bodywork.
    this.camera.near = onboard ? 0.05 : 0.3;
    this.camera.updateProjectionMatrix();
    this.initialized = false;
    return this.mode;
  }

  /** Rigidly mounted on the car (suspension pitch and roll included, like a real onboard). */
  private updateOnboard(target: THREE.Object3D, speedRatio: number, dt: number): void {
    const mount = ONBOARD[this.mode as OnboardMode];
    target.updateMatrixWorld();
    _m.copy(target.matrixWorld);
    this.camera.position.copy(_local.copy(mount.pos).applyMatrix4(_m));
    this.lookTarget.copy(_local.copy(mount.look).applyMatrix4(_m));
    this.camera.up.set(0, 1, 0).applyQuaternion(target.quaternion);
    this.camera.lookAt(this.lookTarget);
    const fov = mount.fov + 6 * Math.min(Math.max(speedRatio, 0), 1) ** 1.5;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * damp(3, dt);
      this.camera.updateProjectionMatrix();
    }
    this.initialized = true;
  }

  /** Jump straight behind the target (spawn / reset). */
  snap(target: THREE.Object3D): void {
    if (isOnboard(this.mode)) {
      this.updateOnboard(target, 0, 1);
      return;
    }
    this.camera.up.set(0, 1, 0);
    const o = this.mode === 'far' ? { ...this.options, distance: this.options.distance * 1.6, height: this.options.height * 1.5 } : this.options;
    _forward.set(0, 0, -1).applyQuaternion(target.quaternion);
    this.yaw = Math.atan2(-_forward.x, -_forward.z);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.camera.position.set(
      target.position.x + sin * o.distance,
      target.position.y + o.height,
      target.position.z + cos * o.distance,
    );
    this.lookTarget.set(
      target.position.x - sin * o.lookAhead,
      target.position.y + o.lookHeight,
      target.position.z - cos * o.lookAhead,
    );
    this.camera.lookAt(this.lookTarget);
    this.initialized = true;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
