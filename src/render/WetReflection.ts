import * as THREE from 'three';

/**
 * Mirror image of the cars and the lights for a soaked track (the look of
 * F1 in the rain on TV). A virtual camera mirrored about the road plane
 * renders a low-resolution image of only the objects on REFLECT_LAYER (plus
 * the sky) once per frame; the asphalt shader samples it in screen space,
 * rippled and blended by wetness, standing water and the Fresnel term.
 * Port of three.js' Reflector maths (oblique near plane = the road).
 */
export const REFLECT_LAYER = 2;
/** Road surface height (ribbons sit at y = 0.02). */
const PLANE_Y = 0.02;
/** Reflection resolution vs the screen. */
const SCALE = 0.3;
/** Beyond this the reflection is just sky (cheap: far cars are culled). */
const FAR = 160;

export class WetReflection {
  readonly target: THREE.WebGLRenderTarget;
  readonly textureMatrix = new THREE.Matrix4();
  private readonly virtual = new THREE.PerspectiveCamera();
  private readonly normal = new THREE.Vector3(0, 1, 0);
  private readonly plane = new THREE.Plane();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();
  private readonly size = new THREE.Vector2();
  private readonly _v = new THREE.Vector3();
  private readonly _cam = new THREE.Vector3();
  private readonly _look = new THREE.Vector3();
  private readonly _target = new THREE.Vector3();
  private readonly _rot = new THREE.Matrix4();
  private readonly point = new THREE.Vector3(0, PLANE_Y, 0);

  constructor() {
    this.target = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples: 0 });
    this.target.texture.generateMipmaps = false;
    this.virtual.layers.set(REFLECT_LAYER);
  }

  /** Renders the mirror image for `camera`; returns false when the camera is below the road. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): boolean {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(16, Math.round(this.size.x * SCALE));
    const h = Math.max(16, Math.round(this.size.y * SCALE));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    this.point.set(camera.position.x, PLANE_Y, camera.position.z);
    this._cam.setFromMatrixPosition(camera.matrixWorld);
    this._v.subVectors(this.point, this._cam);
    if (this._v.dot(this.normal) > 0) return false;
    this._v.reflect(this.normal).negate().add(this.point);
    this._rot.extractRotation(camera.matrixWorld);
    this._look.set(0, 0, -1).applyMatrix4(this._rot).add(this._cam);
    this._target.subVectors(this.point, this._look).reflect(this.normal).negate().add(this.point);

    const v = this.virtual;
    v.position.copy(this._v);
    v.up.set(0, 1, 0).applyMatrix4(this._rot).reflect(this.normal);
    v.lookAt(this._target);
    v.near = camera.near;
    v.far = FAR;
    v.updateMatrixWorld();
    v.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(v.projectionMatrix).multiply(v.matrixWorldInverse);

    // Oblique near plane = the road, so nothing below it shows up in the mirror.
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.point).applyMatrix4(v.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = v.projectionMatrix.elements;
    this.q.set((Math.sign(this.clip.x) + p[8]) / p[0], (Math.sign(this.clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    p[2] = this.clip.x;
    p[6] = this.clip.y;
    p[10] = this.clip.z + 1;
    p[14] = this.clip.w;

    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, v);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevShadow;
    return true;
  }

  dispose(): void {
    this.target.dispose();
  }
}
