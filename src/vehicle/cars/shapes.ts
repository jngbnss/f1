import * as THREE from 'three';

/**
 * Geometry helpers for smooth, "modelled" looking procedural cars.
 *
 * Profiles are drawn in a side view: u = forward (front positive), v = up,
 * in car-local meters. The extrusion runs across the car (local X), and an
 * optional width function narrows/flares the body per vertex, which turns a
 * flat extrusion into a sculpted shape (narrow nose, wheel flares, tumblehome).
 */

export type WidthFn = (u: number, v: number) => number;

export interface ProfileOptions {
  /** Full width of the part (m). */
  width: number;
  /** Center of the part along local X. */
  x?: number;
  /** Rounded edge radius (m). */
  bevel?: number;
  /** Per-vertex width multiplier (u forward, v up). */
  widthFn?: WidthFn;
  curveSegments?: number;
}

/** Extrude a side-profile shape across the car, with rounded edges. */
export function extrudeProfile(shape: THREE.Shape, opts: ProfileOptions): THREE.BufferGeometry {
  const bevel = opts.bevel ?? 0.05;
  const depth = Math.max(opts.width - 2 * bevel, 0.001);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelOffset: -bevel * 0.8, // keep the outline where it was drawn
    bevelSegments: 4,
    curveSegments: opts.curveSegments ?? 18,
  });
  // Shape XY = (u, v), extrusion +Z -> rotate so u -> -Z (forward), extrusion -> X.
  geo.rotateY(Math.PI / 2);
  geo.translate(-depth / 2, 0, 0);

  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const v = pos.getY(i);
    const u = -pos.getZ(i);
    const f = opts.widthFn ? opts.widthFn(u, v) : 1;
    pos.setX(i, x * f + (opts.x ?? 0));
  }
  geo.computeVertexNormals();
  return geo;
}

/** Extrude a top-view outline (x lateral, u forward) vertically from `y` by `thickness`. */
export function extrudePlan(shape: THREE.Shape, y: number, thickness: number, bevel = 0.02): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(thickness - 2 * bevel, 0.001),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 2,
    curveSegments: 12,
  });
  // Shape (x, u) -> X, -Z; extrusion -> +Y.
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y + bevel, 0);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Wing element cross-section (cambered airfoil) extruded across `span`.
 * `chord` along u, leading edge at `u`, angle of attack `aoa` (rad, nose down positive = more downforce).
 */
export function airfoil(span: number, chord: number, thickness: number, u: number, v: number, aoa = 0.12): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const t = thickness;
  s.moveTo(0, 0);
  s.bezierCurveTo(-chord * 0.05, t * 0.9, -chord * 0.35, t * 1.1, -chord, t * 0.25);
  s.lineTo(-chord, 0.0);
  s.bezierCurveTo(-chord * 0.6, -t * 0.05, -chord * 0.2, -t * 0.5, 0, 0);
  const geo = extrudeProfile(s, { width: span, bevel: Math.min(t * 0.3, 0.012), curveSegments: 10 });
  geo.rotateX(-aoa);
  geo.translate(0, v, -u);
  return geo;
}

/** Simple smoothstep. */
export function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Gaussian bump centered at c with half-width w. */
export function bump(x: number, c: number, w: number): number {
  const d = (x - c) / w;
  return Math.exp(-d * d);
}

/** Tyre cross-section revolved around the axle (local X). */
export function tyreGeometry(radius: number, width: number, sidewall: number, segments = 32): THREE.BufferGeometry {
  const rIn = radius - sidewall;
  const hw = width / 2;
  const pts = [
    new THREE.Vector2(rIn, -hw * 0.92),
    new THREE.Vector2(radius - 0.035, -hw),
    new THREE.Vector2(radius - 0.01, -hw + 0.02),
    new THREE.Vector2(radius, -hw + 0.05),
    new THREE.Vector2(radius, hw - 0.05),
    new THREE.Vector2(radius - 0.01, hw - 0.02),
    new THREE.Vector2(radius - 0.035, hw),
    new THREE.Vector2(rIn, hw * 0.92),
  ];
  const geo = new THREE.LatheGeometry(pts, segments);
  // Lathe axis is Y -> make it X.
  geo.rotateZ(Math.PI / 2);
  return geo;
}
