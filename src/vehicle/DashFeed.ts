import type { LapTimer } from '../race/LapTimer';
import { COMPOUND_LABELS } from './Tyres';
import type { Vehicle } from './Vehicle';
import type { DashState } from './cars/SteeringWheel';

/**
 * Feeds the steering-wheel display of the player's car. There is no real
 * ERS model yet, so the battery is a stand-in: it charges under braking and
 * lifting, and drains on full throttle at speed (like the 2026 cars'
 * 350 kW MGU-K would), clamped to 0..100 %.
 */
export class DashFeed {
  private soc = 80;
  private readonly state: DashState = { gear: 'N', speed: 0, rpm: 0, delta: null, battery: 80, lap: 0, totalLaps: null, tyreLabel: 'M 0%' };

  update(dt: number, car: Vehicle, laps: LapTimer, lap: number, totalLaps: number | null): DashState {
    const speed = car.physics.speed;
    const brake = car.controller.commands.brake;
    const charge = brake * Math.min(speed / 30, 1) * 9 + (car.throttle < 0.1 && speed > 20 ? 2 : 0);
    const drain = car.throttle > 0.9 && speed > 45 ? 3.2 : 0;
    this.soc = Math.max(0, Math.min(100, this.soc + (charge - drain) * dt));

    const s = this.state;
    s.gear = car.gearbox?.label ?? 'N';
    s.speed = car.physics.forwardSpeed * 3.6;
    s.rpm = car.gearbox?.rpmRatio ?? 0;
    s.delta = laps.last !== null && laps.best !== null ? laps.last - laps.best : null;
    s.battery = this.soc;
    s.lap = lap;
    s.totalLaps = totalLaps;
    const t = car.tyres;
    s.tyreLabel = `${COMPOUND_LABELS[t.compound]} ${Math.round(t.maxWear * 100)}%`;
    return s;
  }
}
