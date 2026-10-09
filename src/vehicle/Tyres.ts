import type { VehiclePhysics } from './VehiclePhysics';

/**
 * Tyre compounds, wear and temperature: the F1-game model in miniature.
 *
 * - Softer = more grip, faster wear, lower working-temperature window.
 * - Temperature rises with sliding (lateral slip x speed) and cools with
 *   airflow; outside the window grip drops (cold tyres at the start of a
 *   stint, overheated after a long slide).
 * - Wear grows with distance and sliding; grip falls off progressively and
 *   steeply past ~70 % ("the cliff").
 *
 * Like the F1 games, wear runs faster than real life (WEAR_MULTIPLIER) so a
 * few-lap race still needs a decision; real F1 mediums last ~25-35 laps.
 */
export type Compound = 'soft' | 'medium' | 'hard';

interface CompoundSpec {
  grip: number;
  /** Wear per km of normal running at multiplier 1 (fraction of the tyre). */
  wearPerKm: number;
  /** Working window (°C). */
  window: [number, number];
}

export const COMPOUNDS: Record<Compound, CompoundSpec> = {
  soft: { grip: 1.035, wearPerKm: 0.0085, window: [75, 100] },
  medium: { grip: 1.0, wearPerKm: 0.0055, window: [85, 110] },
  hard: { grip: 0.97, wearPerKm: 0.0036, window: [95, 120] },
};

export const COMPOUND_LABELS: Record<Compound, string> = { soft: 'S', medium: 'M', hard: 'H' };
export const COMPOUND_NAMES: Record<Compound, string> = { soft: '소프트', medium: '미디엄', hard: '하드' };

/**
 * Track condition multiplier on every tyre (1 = dry; wet ≈ 0.78, set by the weather).
 * Physics and the AI both read tyre grip, so the AI slows down in the wet on its own.
 */
export const TRACK_GRIP = { value: 1 };

/** Game wear rate vs real life (the F1 games' "tyre wear" setting). */
export const WEAR_MULTIPLIER = 4;
const AMBIENT = 25;
const FRONT_SLIP_WEIGHT = 0.35;
/** Tyre blankets: fitted tyres start warm but below the window. */
const BLANKET = 75;

export class TyreSet {
  compound: Compound;
  /** 0 = new, 1 = destroyed. Front and rear axle. */
  wear = { front: 0, rear: 0 };
  /** Carcass temperature (°C) per axle. */
  temp = { front: BLANKET, rear: BLANKET };
  /** Distance on this set (m). */
  distance = 0;

  constructor(compound: Compound = 'medium') {
    this.compound = compound;
  }

  /** Fresh set (pit stop). */
  fit(compound: Compound): void {
    this.compound = compound;
    this.wear.front = this.wear.rear = 0;
    this.temp.front = this.temp.rear = BLANKET;
    this.distance = 0;
  }

  /** Grip multiplier of one axle (compound x temperature x wear). */
  grip(axle: 'front' | 'rear'): number {
    const spec = COMPOUNDS[this.compound];
    const t = this.temp[axle];
    const [lo, hi] = spec.window;
    const out = t < lo ? (lo - t) / 30 : t > hi ? (t - hi) / 25 : 0;
    const thermal = 1 - 0.1 * Math.min(out, 1.2) ** 1.5;
    const w = this.wear[axle];
    const worn = 1 - 0.07 * w - 0.25 * Math.max(0, w - 0.7) ** 1.5 * 4;
    return spec.grip * thermal * Math.max(worn, 0.55) * TRACK_GRIP.value;
  }

  /** After a physics step: heat, cool and wear from what the wheels did. */
  update(physics: VehiclePhysics, dt: number): void {
    const speed = Math.abs(physics.forwardSpeed);
    const spec = COMPOUNDS[this.compound];
    const step = speed * dt;
    this.distance += step;
    let slipF = 0;
    let slipR = 0;
    let nF = 0;
    let nR = 0;
    physics.wheels.forEach((w, i) => {
      if (!w.grounded) return;
      if (physics.config.wheels[i].steerable) {
        slipF += Math.abs(w.slip);
        nF++;
      } else {
        slipR += Math.abs(w.slip);
        nR++;
      }
    });
    // Steered wheels report extra lateral velocity from steering itself: weight them down
    // so both axles see a similar 'sliding' measure (measured on Monza: 0.56 vs 0.16 m/s mean).
    const axles: ['front' | 'rear', number][] = [
      ['front', nF ? (FRONT_SLIP_WEIGHT * slipF) / nF : 0],
      ['rear', nR ? slipR / nR : 0],
    ];
    for (const [axle, slip] of axles) {
      // Sliding energy heats (slip m/s x speed), airflow cools towards ambient.
      // Slip is capped: a spin or a trip over the grass must not cook the tyres for a whole lap.
      const heat = 0.18 * Math.min(slip, 1.2) * Math.min(speed, 90) + 0.06 * speed;
      const cool = (this.temp[axle] - AMBIENT) * (0.015 + speed * 0.0009);
      this.temp[axle] += (heat - cool) * dt;
      // Wear: base per km, more when sliding and when overheated.
      const over = Math.max(0, this.temp[axle] - spec.window[1]) / 20;
      const rate = spec.wearPerKm * WEAR_MULTIPLIER * (1 + 1.6 * Math.min(slip, 3) + over);
      this.wear[axle] = Math.min(1, this.wear[axle] + (rate * step) / 1000);
    }
  }
}
