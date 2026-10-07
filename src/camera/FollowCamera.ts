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

  constructor(aspect: number, options: Partial<FollowCameraOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.camera = new THREE.PerspectiveCamera(this.options.baseFov, aspect, 0.1, 1500);
  }

  /**
   * @param target car root (interpolated pose)
   * @param speedRatio 0..1 of top speed, drives FOV
   */
  update(target: THREE.Object3D, speedRatio: number, dt: number): void {
    const o = this.options;
    _forward.set(0, 0, -1).applyQuaternion(target.quaternion);
    const targetYaw = Math.atan2(-_forward.x, -_forward.z);

    if (!this.initialized) {
      this.snap(target);
      return;
    }

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

  /** Jump straight behind the target (spawn / reset). */
  snap(target: THREE.Object3D): void {
    const o = this.options;
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
