import * as THREE from 'three';
import type { VehicleConfig } from '../VehicleConfig';
import { PrimitiveCarVisual } from '../VehicleVisual';
import { airfoil, extrudePlan, extrudeProfile, smooth } from './shapes';

/*
 * Procedural "modelled" cars: side profiles extruded with rounded edges and
 * sculpted by per-vertex width functions, PBR car paint with clearcoat.
 * Profile coordinates: u = forward (front +), v = up, car-local meters.
 * Used for every single-seater (scaled per car); closed cars use catalog/ParametricCarVisual.
 */

/** Open-wheel formula car (generic F1-style, no real team livery). */
export interface FormulaOptions {
  /** Body scale (x, y, z) for smaller / larger single-seaters; wheels follow the physics config. */
  scale?: [number, number, number];
  /** IndyCar-style wrap-around screen instead of the halo. */
  aeroscreen?: boolean;
}

export class FormulaCarVisual extends PrimitiveCarVisual {
  constructor(config: VehicleConfig, color = 0x1546c9, accent = 0xffc400, options: FormulaOptions = {}) {
    super(config, { width: 0.42, segments: 32, tyreColor: 0x121212, rimColor: 0x2a2d31, rimRatio: 0.62, spokes: 7 });
    if (options.scale) this.bodyScale = options.scale;
    const [isx, , isz] = (options.scale ?? [1, 1, 1]).map((s) => 1 / s);
    const paint = this.paint(color, 0.5, 0.3);
    const accentMat = this.paint(accent, 0.3, 0.35);
    const carbon = this.carbon();
    const helmet = this.paint(0xf2f2f2, 0.2, 0.25);
    const visor = this.glass();
    const rain = this.material({ color: 0x330000, emissive: 0xff1a1a, emissiveIntensity: 2 });

    // --- survival cell / nose / engine cover ----------------------------
    const body = new THREE.Shape();
    body.moveTo(-1.95, -0.46);
    body.lineTo(2.2, -0.46);
    body.quadraticCurveTo(2.62, -0.44, 2.66, -0.34);
    body.quadraticCurveTo(2.2, -0.2, 1.2, -0.1);
    body.quadraticCurveTo(0.7, -0.02, 0.45, 0.05);
    body.quadraticCurveTo(0.1, -0.03, -0.32, 0.0);
    body.lineTo(-0.42, 0.14);
    body.quadraticCurveTo(-0.5, 0.42, -0.72, 0.45);
    body.quadraticCurveTo(-0.95, 0.47, -1.1, 0.3);
    body.quadraticCurveTo(-1.6, 0.05, -1.95, -0.18);
    body.lineTo(-1.95, -0.46);
    this.mesh(
      extrudeProfile(body, {
        width: 0.8,
        bevel: 0.07,
        widthFn: (u, v) =>
          (1 - 0.66 * smooth(0.9, 2.6, u)) * (1 - 0.5 * smooth(-0.9, -1.95, u)) * (1 - 0.45 * smooth(0.08, 0.3, v)),
      }),
      paint,
    );
    // Shark fin
    const fin = new THREE.Shape();
    fin.moveTo(-0.95, 0.42);
    fin.quadraticCurveTo(-1.5, 0.36, -1.85, 0.2);
    fin.lineTo(-1.85, 0.0);
    fin.lineTo(-1.2, 0.2);
    fin.lineTo(-0.95, 0.42);
    this.mesh(extrudeProfile(fin, { width: 0.025, bevel: 0.006 }), accentMat);

    // --- sidepods -------------------------------------------------------
    const pod = new THREE.Shape();
    pod.moveTo(0.38, -0.46);
    pod.lineTo(0.38, -0.14);
    pod.quadraticCurveTo(0.36, -0.05, 0.24, -0.05);
    pod.quadraticCurveTo(-0.5, -0.06, -1.35, -0.32);
    pod.lineTo(-1.42, -0.46);
    pod.lineTo(0.38, -0.46);
    for (const side of [-1, 1]) {
      this.mesh(
        extrudeProfile(pod, { width: 0.5, x: side * 0.56, bevel: 0.08, widthFn: (u) => 1 - 0.4 * smooth(-0.3, -1.42, u) }),
        paint,
      );
    }

    // --- floor ----------------------------------------------------------
    const floor = new THREE.Shape();
    floor.moveTo(-0.72, -1.65);
    floor.lineTo(0.72, -1.65);
    floor.lineTo(0.72, 0.45);
    floor.lineTo(0.32, 1.3);
    floor.lineTo(-0.32, 1.3);
    floor.lineTo(-0.72, 0.45);
    floor.lineTo(-0.72, -1.65);
    this.mesh(extrudePlan(floor, -0.53, 0.04, 0.01), carbon);

    // --- cockpit: halo, helmet, mirrors --------------------------------
    const halo = this.mesh(this.track(new THREE.TorusGeometry(0.3, 0.032, 10, 28, Math.PI)), carbon);
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(0, 0.2, 0.2);
    if (options.aeroscreen) {
      const screen = this.part(this.track(new THREE.CylinderGeometry(0.34, 0.36, 0.26, 20, 1, true, -Math.PI * 0.9, Math.PI * 1.8)), visor, 0, 0.3, 0.12);
      screen.rotation.y = Math.PI;
    }
    const strut = this.box(0.05, 0.22, 0.05, carbon, 0, 0.1, -0.14);
    strut.rotation.x = -0.35;
    for (const side of [-1, 1]) this.box(0.05, 0.2, 0.05, carbon, side * 0.3, 0.1, 0.2);
    const head = this.part(this.track(new THREE.SphereGeometry(0.15, 20, 14)), helmet, 0, 0.13, 0.12);
    head.scale.set(1, 0.95, 1.12);
    const vis = this.part(this.track(new THREE.SphereGeometry(0.152, 20, 8, Math.PI * 1.15, Math.PI * 0.7, Math.PI * 0.38, Math.PI * 0.2)), visor, 0, 0.13, 0.12);
    vis.scale.set(1, 0.95, 1.12);
    for (const side of [-1, 1]) {
      this.box(0.14, 0.06, 0.08, paint, side * 0.42, 0.08, -0.35);
      this.box(0.02, 0.02, 0.2, carbon, side * 0.34, 0.05, -0.35);
    }

    // --- wings ----------------------------------------------------------
    this.mesh(airfoil(1.95, 0.42, 0.05, 2.98, -0.5, 0.06), carbon);
    this.mesh(airfoil(1.85, 0.24, 0.04, 2.66, -0.42, 0.35), accentMat);
    const plate = (u0: number, u1: number, v0: number, v1: number) => {
      const s = new THREE.Shape();
      s.moveTo(u0, v0);
      s.lineTo(u1, v0);
      s.quadraticCurveTo(u1 - 0.04, v1, u1 - 0.12, v1);
      s.lineTo(u0 + 0.06, v1);
      s.lineTo(u0, v0);
      return s;
    };
    for (const side of [-1, 1]) {
      this.mesh(extrudeProfile(plate(2.45, 3.0, -0.56, -0.32), { width: 0.025, x: side * 0.98, bevel: 0.008 }), paint);
      this.mesh(extrudeProfile(plate(-2.48, -1.9, -0.25, 0.56), { width: 0.03, x: side * 0.52, bevel: 0.01 }), paint);
      this.box(0.04, 0.16, 0.06, carbon, side * 0.12, -0.42, -2.55); // nose pylons
    }
    this.mesh(airfoil(1.02, 0.36, 0.05, -1.95, 0.27, 0.16), carbon);
    this.mesh(airfoil(1.02, 0.22, 0.035, -2.24, 0.42, 0.5), accentMat);
    this.box(0.05, 0.45, 0.12, carbon, 0, 0.02, 2.15); // swan-neck pylon
    // Diffuser + rain light
    const diffuser = this.box(1.0, 0.04, 0.42, carbon, 0, -0.42, 2.0);
    diffuser.rotation.x = -0.25;
    this.part(this.track(new THREE.BoxGeometry(0.14, 0.06, 0.04)), rain, 0, -0.22, 2.4, false);

    // --- suspension wishbones (visual only) ------------------------------
    const armGeo = this.track(new THREE.CylinderGeometry(0.016, 0.016, 1, 6).rotateZ(Math.PI / 2));
    for (const wc of config.wheels) {
      // Arms are placed in unscaled body space so they meet the (unscaled) wheels after optimize().
      const side = Math.sign(wc.position.x);
      const inner = 0.3;
      const outer = (Math.abs(wc.position.x) - 0.12) * isx;
      for (const [v, dz] of [
        [-0.18, 0.12],
        [-0.34, -0.12],
      ] as const) {
        const arm = new THREE.Mesh(armGeo, carbon);
        arm.scale.x = outer - inner;
        arm.position.set(side * (inner + outer) / 2, v, (wc.position.z + dz * 0.5) * isz);
        arm.rotation.y = side * dz;
        this.root.add(arm);
      }
    }
  }
}
