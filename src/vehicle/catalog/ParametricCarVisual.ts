import * as THREE from 'three';
import type { VehicleConfig } from '../VehicleConfig';
import { PrimitiveCarVisual } from '../VehicleVisual';
import { airfoil, bump, extrudeProfile, smooth } from '../cars/shapes';
import type { BodyType, CarSpec } from './specs';

/** Proportions per closed-body archetype (fractions of height / wheelbase). */
interface BodyStyle {
  rideHeight: number;
  /** Bonnet line at the nose and beltline (fractions of total height). */
  nose: number;
  belt: number;
  /** Windscreen base, measured back from the front axle (fraction of wheelbase). */
  cowl: number;
  /** Windscreen rake: horizontal run per meter of rise. */
  rake: number;
  /** Roof length (fraction of wheelbase). */
  roof: number;
  /** Rear: 'hatch' (steep), 'notch' (boot lid), 'fast' (fastback), 'open' (roadster), 'engine' (mid-engine deck). */
  rear: 'hatch' | 'notch' | 'fast' | 'open' | 'engine';
  /** Greenhouse width as a fraction of body width (prototype canopies are narrow). */
  cabinWidth: number;
  /** Share of the overhang in front of the front axle. */
  frontOverhang: number;
  wing: 'none' | 'lip' | 'ducktail' | 'gt' | 'lmp';
  race: boolean;
}

const STYLES: Partial<Record<BodyType, BodyStyle>> = {
  hatch: { rideHeight: 0.13, nose: 0.45, belt: 0.6, cowl: 0.22, rake: 1.5, roof: 0.62, rear: 'hatch', cabinWidth: 0.86, frontOverhang: 0.6, wing: 'none', race: false },
  sedan: { rideHeight: 0.13, nose: 0.44, belt: 0.6, cowl: 0.25, rake: 1.6, roof: 0.42, rear: 'notch', cabinWidth: 0.86, frontOverhang: 0.52, wing: 'lip', race: false },
  wagon: { rideHeight: 0.13, nose: 0.44, belt: 0.6, cowl: 0.25, rake: 1.6, roof: 0.78, rear: 'hatch', cabinWidth: 0.87, frontOverhang: 0.5, wing: 'none', race: false },
  coupe: { rideHeight: 0.12, nose: 0.42, belt: 0.58, cowl: 0.36, rake: 1.9, roof: 0.3, rear: 'fast', cabinWidth: 0.84, frontOverhang: 0.48, wing: 'lip', race: false },
  roadster: { rideHeight: 0.12, nose: 0.44, belt: 0.62, cowl: 0.42, rake: 1.6, roof: 0, rear: 'open', cabinWidth: 0.82, frontOverhang: 0.5, wing: 'none', race: false },
  mid: { rideHeight: 0.11, nose: 0.36, belt: 0.56, cowl: 0.82, rake: 2.1, roof: 0.24, rear: 'engine', cabinWidth: 0.8, frontOverhang: 0.48, wing: 'ducktail', race: false },
  gt3: { rideHeight: 0.07, nose: 0.36, belt: 0.56, cowl: 0.45, rake: 2.0, roof: 0.28, rear: 'fast', cabinWidth: 0.78, frontOverhang: 0.5, wing: 'gt', race: true },
  supercar: { rideHeight: 0.09, nose: 0.32, belt: 0.55, cowl: 0.85, rake: 2.3, roof: 0.2, rear: 'engine', cabinWidth: 0.78, frontOverhang: 0.46, wing: 'ducktail', race: false },
  lmp: { rideHeight: 0.06, nose: 0.36, belt: 0.58, cowl: 0.62, rake: 2.0, roof: 0.2, rear: 'engine', cabinWidth: 0.5, frontOverhang: 0.48, wing: 'lmp', race: true },
};

/**
 * Closed-body car built from real dimensions (length, width, height,
 * wheelbase): side profile with wheel arches, glass house, roof, lights and
 * body-type specific aero (GT3 wing, LMP fin, ducktail). One code path for
 * hatchbacks through Le Mans prototypes; proportions come from BodyStyle.
 */
export class ParametricCarVisual extends PrimitiveCarVisual {
  constructor(config: VehicleConfig, spec: CarSpec, color = spec.color, accent = spec.accent ?? 0x1c1c1c) {
    const style = STYLES[spec.body] ?? STYLES.coupe!;
    super(config, {
      width: style.race ? 0.33 : 0.27,
      segments: 28,
      tyreColor: 0x121212,
      rimColor: style.race ? 0x2a2d31 : 0xc9ced4,
      rimRatio: style.race ? 0.7 : 0.66,
      spokes: style.race ? 10 : 5,
    });
    const [L, W, H, WB] = spec.dims;
    const paint = this.paint(color);
    const accentMat = this.paint(accent, 0.3, 0.35);
    const glass = this.glass();
    const carbon = this.carbon();
    const light = this.material({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.7, roughness: 0.1 });
    const tail = this.material({ color: 0x400000, emissive: 0xff1a00, emissiveIntensity: 1.3, roughness: 0.2 });

    // --- reference heights (car-local, y up) ------------------------------
    const wc = config.wheels[0];
    const r = config.wheelRadius;
    const sag = (config.mass * 9.81) / 4 / config.suspensionStiffness;
    const wv = wc.position.y - (config.suspensionRestLength - sag); // wheel centre at rest
    const ground = wv - r;
    const bottom = ground + style.rideHeight;
    const top = ground + H;
    const noseV = ground + H * style.nose;
    const beltV = ground + H * style.belt;
    const fu = WB / 2; // front axle (u forward)
    const ru = -WB / 2;
    const overhang = Math.max(L - WB, 0.6);
    const front = fu + overhang * style.frontOverhang;
    const rear = ru - overhang * (1 - style.frontOverhang);
    const archR = r + 0.06;

    // --- lower body: side profile with wheel arches -------------------------
    const body = new THREE.Shape();
    body.moveTo(rear + 0.05, bottom);
    arch(body, ru, wv, archR, bottom);
    arch(body, fu, wv, archR, bottom);
    body.lineTo(front - 0.08, bottom);
    body.quadraticCurveTo(front + 0.02, bottom + 0.05, front, (bottom + noseV) / 2);
    body.quadraticCurveTo(front - 0.02, noseV, front - 0.3, noseV + 0.02);
    // Bonnet rises to the cowl / beltline.
    const cowlU = fu - WB * style.cowl;
    body.quadraticCurveTo((front + cowlU) / 2, beltV - 0.02, cowlU, beltV);
    // Rear deck.
    const deckV = style.rear === 'hatch' ? beltV + 0.02 : style.rear === 'engine' ? beltV + 0.04 : beltV + 0.03;
    // Deck falls slightly towards the tail, which rounds over into the bumper.
    body.quadraticCurveTo((cowlU + rear) / 2, deckV + 0.02, rear + 0.3, deckV - 0.04);
    body.quadraticCurveTo(rear - 0.02, deckV - 0.06, rear, (deckV + bottom) / 2 + 0.02);
    body.quadraticCurveTo(rear + 0.02, bottom + 0.04, rear + 0.05, bottom);
    const flare = style.race ? 0.11 : 0.07;
    this.mesh(
      extrudeProfile(body, {
        width: W,
        bevel: Math.min(0.18, H * 0.14),
        widthFn: (u, v) => {
          let f = 1 - flare + flare * Math.max(bump(u, fu, 0.65), bump(u, ru, 0.7));
          f *= 1 - 0.12 * smooth(front - 0.6, front, u);
          f *= 1 - 0.08 * smooth(rear + 0.5, rear, u);
          f *= 1 - 0.14 * smooth(beltV - 0.35, beltV + 0.05, v); // tumblehome
          f *= 1 - 0.05 * smooth(bottom + 0.15, bottom, v); // tucked-in sills
          return f;
        },
      }),
      paint,
    );

    // --- greenhouse + roof ---------------------------------------------------
    const roofV = top - 0.02;
    const rise = roofV - beltV;
    const roofFront = cowlU - rise * style.rake;
    if (style.rear === 'open') {
      // Roadster: windscreen frame only + roll hoops.
      const ws = new THREE.Shape();
      ws.moveTo(cowlU, beltV - 0.01);
      ws.lineTo(cowlU - 0.35, beltV + rise * 0.55);
      ws.lineTo(cowlU - 0.4, beltV + rise * 0.55);
      ws.lineTo(cowlU - 0.08, beltV - 0.01);
      this.mesh(extrudeProfile(ws, { width: W * 0.82, bevel: 0.02 }), glass);
      for (const side of [-1, 1]) this.box(0.06, rise * 0.45, 0.06, carbon, side * W * 0.22, beltV + rise * 0.2, -(cowlU - 1.05));
    } else {
      const roofRear = roofFront - WB * style.roof;
      const cabin = new THREE.Shape();
      cabin.moveTo(cowlU + 0.05, beltV - 0.03);
      cabin.quadraticCurveTo(roofFront + 0.15, roofV - 0.02, roofFront, roofV);
      cabin.lineTo(roofRear, roofV);
      let backU: number;
      if (style.rear === 'hatch') backU = Math.max(rear + 0.12, roofRear - 0.25);
      else if (style.rear === 'notch') backU = Math.max(rear + 0.85, roofRear - 0.65);
      else if (style.rear === 'fast') backU = Math.max(rear + 0.35, roofRear - rise * 2.6);
      else backU = roofRear - rise * 1.2; // engine deck: short buttress
      cabin.quadraticCurveTo(roofRear - (roofRear - backU) * 0.35, roofV - 0.01, backU, beltV - 0.02);
      cabin.lineTo(cowlU + 0.05, beltV - 0.03);
      const cw = W * style.cabinWidth;
      this.mesh(extrudeProfile(cabin, { width: cw, bevel: 0.12, widthFn: (_u, v) => 1 - 0.28 * smooth(beltV, roofV, v) }), glass);
      // Painted roof skin.
      const roof = new THREE.Shape();
      const r0 = roofFront - 0.12;
      const r1 = roofRear + 0.05;
      roof.moveTo(r0, roofV + 0.012);
      roof.lineTo(r1, roofV + 0.012);
      roof.lineTo(r1, roofV - 0.03);
      roof.lineTo(r0, roofV - 0.03);
      roof.lineTo(r0, roofV + 0.012);
      this.mesh(extrudeProfile(roof, { width: cw * 0.7, bevel: 0.012 }), paint);
    }

    // --- lights, grille, mirrors -------------------------------------------
    for (const side of [-1, 1]) {
      const head = this.part(this.track(new THREE.SphereGeometry(0.15, 14, 8)), light, side * W * 0.33, noseV - 0.08, -(front - 0.15), false);
      head.scale.set(1.15, 0.3, 0.8);
      this.box(0.15, 0.07, 0.1, style.race ? carbon : paint, side * (W / 2 + 0.03), beltV + 0.08, -(cowlU - 0.15));
    }
    // Tail lamps: a full-width bar on race cars and modern supercars, two clusters on road cars.
    if (style.race || spec.cls === 'hyper') this.part(this.track(new THREE.BoxGeometry(W * 0.8, 0.05, 0.05)), tail, 0, deckV - 0.14, -(rear + 0.02), false);
    else for (const side of [-1, 1]) this.part(this.track(new THREE.BoxGeometry(W * 0.22, 0.09, 0.05)), tail, side * W * 0.33, deckV - 0.16, -(rear + 0.03), false);
    this.box(W * 0.45, Math.max(noseV - bottom - 0.12, 0.08), 0.05, carbon, 0, (noseV + bottom) / 2 - 0.02, -(front - 0.01));
    this.box(W * 0.7, 0.1, 0.25, carbon, 0, bottom + 0.06, -(rear + 0.12)); // diffuser

    if (style.race || spec.cls !== 'street') {
      this.box(W * 0.96, 0.03, 0.3, carbon, 0, bottom + 0.015, -(front - 0.12)); // splitter
      for (const side of [-1, 1]) this.box(0.05, 0.08, WB * 0.75, carbon, side * (W / 2 - 0.02), bottom + 0.04, 0); // skirts
    }

    // --- aero ---------------------------------------------------------------
    const wingU = rear + 0.25;
    if (style.wing === 'gt' || style.wing === 'lmp') {
      const span = W * (style.wing === 'lmp' ? 0.92 : 0.86);
      const h = style.wing === 'lmp' ? deckV + 0.2 : roofV - 0.02;
      this.mesh(airfoil(span, 0.34, 0.05, wingU + 0.17, h, 0.12), carbon);
      for (const side of [-1, 1]) {
        this.box(0.02, 0.28, 0.42, carbon, side * span * 0.5, h - 0.05, -wingU);
        if (style.wing === 'gt') this.box(0.04, h - deckV, 0.1, carbon, side * W * 0.22, (h + deckV) / 2, -(wingU + 0.05));
      }
      if (style.wing === 'lmp') {
        // Shark fin along the engine cover.
        const fin = new THREE.Shape();
        fin.moveTo(roofFront - WB * style.roof, roofV - 0.02);
        fin.lineTo(wingU, h);
        fin.lineTo(wingU, deckV);
        fin.lineTo(roofFront - WB * style.roof - 0.3, deckV);
        this.mesh(extrudeProfile(fin, { width: 0.025, bevel: 0.005 }), accentMat);
        // Accent stripe along the flanks.
        for (const side of [-1, 1]) this.box(0.01, 0.06, L * 0.6, accentMat, side * (W / 2 + 0.005), beltV - 0.12, 0);
      }
    } else if (style.wing === 'ducktail') {
      this.box(W * 0.75, 0.05, 0.2, style.race ? carbon : paint, 0, deckV + 0.04, -(rear + 0.15));
      if (spec.cls === 'hyper' && spec.kg < 1400) {
        // Track-focused hypercars: raised wing.
        this.mesh(airfoil(W * 0.8, 0.3, 0.05, wingU + 0.15, roofV - 0.05, 0.12), carbon);
        for (const side of [-1, 1]) this.box(0.04, roofV - deckV, 0.1, carbon, side * W * 0.2, (roofV + deckV) / 2 - 0.05, -(wingU + 0.05));
      }
    } else if (style.wing === 'lip') {
      this.box(W * 0.7, 0.03, 0.12, carbon, 0, deckV + 0.025, -(rear + 0.12));
    }

    // Race number panel / livery accent on the doors for race cars.
    if (style.race) {
      for (const side of [-1, 1]) this.box(0.01, 0.32, 0.55, accentMat, side * (W / 2 + 0.004), (beltV + bottom) / 2 + 0.05, -(fu - WB * 0.5));
    }
  }
}

/** Wheel-arch helper: draws the bottom edge with an arch over a wheel at u. */
function arch(s: THREE.Shape, u: number, v: number, r: number, bottom: number): void {
  s.lineTo(u - r, bottom);
  s.lineTo(u - r, v);
  s.absarc(u, v, r, Math.PI, 0, true);
  s.lineTo(u + r, bottom);
}
