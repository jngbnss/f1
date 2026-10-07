import * as THREE from 'three';
import type { VehicleConfig } from '../VehicleConfig';
import { PrimitiveCarVisual } from '../VehicleVisual';
import { airfoil, bump, extrudePlan, extrudeProfile, smooth } from './shapes';

/*
 * Procedural "modelled" cars: side profiles extruded with rounded edges and
 * sculpted by per-vertex width functions, PBR car paint with clearcoat.
 * Profile coordinates: u = forward (front +), v = up, car-local meters.
 * No real brands or liveries.
 */

/** Wheel-arch helper: draws the bottom edge with an arch over a wheel at u. */
function arch(s: THREE.Shape, u: number, v: number, r: number, bottom: number): void {
  s.lineTo(u - r, bottom);
  s.lineTo(u - r, v);
  s.absarc(u, v, r, Math.PI, 0, true);
  s.lineTo(u + r, bottom);
}

/** Open-wheel formula car (generic F1-style, no real team livery). */
export class FormulaCarVisual extends PrimitiveCarVisual {
  constructor(config: VehicleConfig, color = 0x1546c9, accent = 0xffc400) {
    super(config, { width: 0.42, segments: 32, tyreColor: 0x121212, rimColor: 0x2a2d31, rimRatio: 0.62, spokes: 7 });
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
      const side = Math.sign(wc.position.x);
      const inner = 0.3;
      const outer = Math.abs(wc.position.x) - 0.12;
      for (const [v, dz] of [
        [-0.18, 0.12],
        [-0.34, -0.12],
      ] as const) {
        const arm = new THREE.Mesh(armGeo, carbon);
        arm.scale.x = outer - inner;
        arm.position.set(side * (inner + outer) / 2, v, wc.position.z + dz * 0.5);
        arm.rotation.y = side * dz;
        this.root.add(arm);
      }
    }
  }
}

/** Front-engine GT sports car. */
export class GTCarVisual extends PrimitiveCarVisual {
  constructor(config: VehicleConfig, color = 0xb3121c) {
    super(config, { width: 0.32, segments: 32, tyreColor: 0x121212, rimColor: 0xc9ced4, rimRatio: 0.7, spokes: 10 });
    const paint = this.paint(color);
    const glass = this.glass();
    const carbon = this.carbon();
    const light = this.material({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.7, roughness: 0.1 });
    const tail = this.material({ color: 0x400000, emissive: 0xff1a00, emissiveIntensity: 1.3, roughness: 0.2 });

    const fu = -config.wheels[0].position.z; // front axle (u)
    const ru = -config.wheels[2].position.z; // rear axle (u)
    const wv = -0.4;
    const r = 0.46;
    const bottom = -0.56;

    const body = new THREE.Shape();
    body.moveTo(-2.3, bottom);
    arch(body, ru, wv, r, bottom);
    arch(body, fu, wv, r, bottom);
    body.lineTo(2.28, bottom + 0.02);
    body.quadraticCurveTo(2.43, -0.45, 2.4, -0.25);
    body.quadraticCurveTo(2.35, -0.08, 2.05, -0.02);
    body.quadraticCurveTo(1.3, 0.1, 0.62, 0.14);
    body.lineTo(-1.25, 0.16);
    body.quadraticCurveTo(-1.95, 0.2, -2.3, 0.15);
    body.quadraticCurveTo(-2.43, 0.0, -2.38, -0.25);
    body.lineTo(-2.3, bottom);
    this.mesh(
      extrudeProfile(body, {
        width: 2.0,
        bevel: 0.1,
        widthFn: (u, v) => {
          let f = 0.92 + 0.08 * Math.max(bump(u, fu, 0.6), bump(u, ru, 0.65));
          f *= 1 - 0.12 * smooth(1.9, 2.42, u);
          f *= 1 - 0.07 * smooth(-1.9, -2.4, u);
          f *= 1 - 0.08 * smooth(-0.15, 0.18, v);
          return f;
        },
      }),
      paint,
    );

    // Greenhouse (tinted glass) + painted roof.
    const cabin = new THREE.Shape();
    cabin.moveTo(0.62, 0.12);
    cabin.quadraticCurveTo(0.2, 0.42, -0.1, 0.5);
    cabin.quadraticCurveTo(-0.5, 0.56, -0.85, 0.5);
    cabin.quadraticCurveTo(-1.35, 0.36, -1.75, 0.16);
    cabin.lineTo(0.62, 0.12);
    this.mesh(extrudeProfile(cabin, { width: 1.6, bevel: 0.09, widthFn: (_u, v) => 1 - 0.22 * smooth(0.15, 0.56, v) }), glass);
    const roof = new THREE.Shape();
    roof.moveTo(-0.05, 0.505);
    roof.quadraticCurveTo(-0.5, 0.575, -0.9, 0.505);
    roof.lineTo(-0.9, 0.47);
    roof.quadraticCurveTo(-0.5, 0.54, -0.05, 0.47);
    roof.lineTo(-0.05, 0.505);
    this.mesh(extrudeProfile(roof, { width: 1.24, bevel: 0.015 }), paint);

    // Front: grille, splitter, headlights. Rear: light bar, diffuser, wing.
    this.box(1.0, 0.14, 0.06, carbon, 0, -0.33, -2.38);
    this.box(1.95, 0.03, 0.28, carbon, 0, -0.56, -2.3);
    for (const side of [-1, 1]) {
      const head = this.part(this.track(new THREE.SphereGeometry(0.15, 16, 10)), light, side * 0.66, -0.14, -2.22, false);
      head.scale.set(1.1, 0.32, 0.8);
      this.box(0.16, 0.07, 0.1, paint, side * 0.98, 0.24, -0.35); // mirror
    }
    this.part(this.track(new THREE.BoxGeometry(1.7, 0.05, 0.05)), tail, 0, -0.02, 2.37, false);
    const diffuser = this.box(1.5, 0.12, 0.32, carbon, 0, -0.5, 2.25);
    diffuser.rotation.x = 0.15;
    this.mesh(airfoil(1.75, 0.32, 0.05, -1.95, 0.44, 0.1), carbon);
    for (const side of [-1, 1]) {
      this.box(0.04, 0.28, 0.1, carbon, side * 0.55, 0.3, 2.05);
      this.box(0.02, 0.16, 0.36, carbon, side * 0.875, 0.44, 2.08); // wing endplates
      this.box(0.05, 0.1, 2.2, carbon, side * 0.93, -0.5, 0); // side skirts
    }
  }
}

/** Compact hot hatch. */
export class StreetCarVisual extends PrimitiveCarVisual {
  constructor(config: VehicleConfig, color = 0xe07b00) {
    super(config, { width: 0.3, segments: 28, tyreColor: 0x111111, rimColor: 0xd0d4d9, rimRatio: 0.66, spokes: 6 });
    const paint = this.paint(color, 0.45, 0.32);
    const glass = this.glass();
    const dark = this.carbon();
    const light = this.material({ color: 0xffffff, emissive: 0xfff2c0, emissiveIntensity: 0.7, roughness: 0.1 });
    const tail = this.material({ color: 0x400000, emissive: 0xff2200, emissiveIntensity: 1.1, roughness: 0.2 });

    const fu = -config.wheels[0].position.z;
    const ru = -config.wheels[2].position.z;
    const wv = -0.46;
    const r = 0.45;
    const bottom = -0.62;

    const body = new THREE.Shape();
    body.moveTo(-2.05, bottom);
    arch(body, ru, wv, r, bottom);
    arch(body, fu, wv, r, bottom);
    body.lineTo(2.05, bottom + 0.02);
    body.quadraticCurveTo(2.18, -0.45, 2.15, -0.2);
    body.quadraticCurveTo(2.1, -0.04, 1.7, 0.0);
    body.quadraticCurveTo(1.2, 0.05, 0.85, 0.08);
    body.lineTo(-1.95, 0.12);
    body.quadraticCurveTo(-2.13, 0.1, -2.13, -0.1);
    body.quadraticCurveTo(-2.13, -0.45, -2.05, bottom);
    this.mesh(
      extrudeProfile(body, {
        width: 1.84,
        bevel: 0.1,
        widthFn: (u, v) => {
          let f = 0.93 + 0.07 * Math.max(bump(u, fu, 0.55), bump(u, ru, 0.55));
          f *= 1 - 0.08 * smooth(1.7, 2.15, u);
          f *= 1 - 0.07 * smooth(-0.2, 0.12, v);
          return f;
        },
      }),
      paint,
    );

    const cabin = new THREE.Shape();
    cabin.moveTo(0.85, 0.07);
    cabin.quadraticCurveTo(0.45, 0.42, 0.15, 0.55);
    cabin.lineTo(-1.55, 0.6);
    cabin.quadraticCurveTo(-1.92, 0.55, -2.0, 0.1);
    cabin.lineTo(0.85, 0.07);
    this.mesh(extrudeProfile(cabin, { width: 1.6, bevel: 0.08, widthFn: (_u, v) => 1 - 0.16 * smooth(0.1, 0.6, v) }), glass);
    const roof = new THREE.Shape();
    roof.moveTo(0.12, 0.575);
    roof.lineTo(-1.6, 0.625);
    roof.quadraticCurveTo(-1.74, 0.62, -1.78, 0.58);
    roof.lineTo(0.12, 0.54);
    roof.lineTo(0.12, 0.575);
    this.mesh(extrudeProfile(roof, { width: 1.2, bevel: 0.015 }), paint);

    this.box(0.9, 0.12, 0.05, dark, 0, -0.32, -2.14);
    this.box(1.7, 0.12, 0.08, dark, 0, -0.52, 2.08);
    this.box(1.3, 0.05, 0.3, dark, 0, 0.6, 1.72); // roof spoiler
    for (const side of [-1, 1]) {
      const head = this.part(this.track(new THREE.SphereGeometry(0.14, 16, 10)), light, side * 0.62, -0.12, -2.07, false);
      head.scale.set(1.0, 0.4, 0.75);
      this.part(this.track(new THREE.BoxGeometry(0.34, 0.12, 0.05)), tail, side * 0.66, -0.05, 2.12, false);
      this.box(0.15, 0.08, 0.1, paint, side * 0.92, 0.18, -0.65); // mirror
    }
  }
}
