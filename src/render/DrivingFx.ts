import * as THREE from 'three';
import type { FollowCamera } from '../camera/FollowCamera';
import type { LapTimer } from '../race/LapTimer';
import type { RaceManager } from '../race/RaceManager';
import { DashFeed } from '../vehicle/DashFeed';
import type { Vehicle } from '../vehicle/Vehicle';
import type { Surface, Track } from '../world/Track';
import { SkidMarks } from './SkidMarks';

/** How much each surface shakes the onboard cameras. */
const ROUGHNESS: Record<Surface, number> = { asphalt: 0, kerb: 0.7, grass: 0.4, gravel: 1 };

/**
 * Per-frame driving feedback that isn't physics: tyre marks on the tarmac,
 * the live steering-wheel display, and surface roughness for camera shake.
 */
export class DrivingFx {
  readonly skidMarks: SkidMarks;
  private readonly dash = new DashFeed();
  private readonly probe = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private readonly track: Track,
    camera: FollowCamera,
  ) {
    this.skidMarks = new SkidMarks((x, z) => {
      const s = track.surfaceAt(this.probe.set(x, 0, z));
      return s === 'asphalt' || s === 'kerb';
    });
    scene.add(this.skidMarks.mesh);
    camera.setTrack(track.getCenterline(), track.getRights(), (p) => {
      const s = track.surfaceAt(p);
      return s === 'asphalt' || s === 'kerb';
    });
  }

  update(dt: number, vehicles: readonly Vehicle[], player: Vehicle, camera: FollowCamera, laps: LapTimer, race: RaceManager | null): void {
    this.skidMarks.update(dt, vehicles);
    camera.setRoughness(this.roughnessUnder(player));
    const me = race?.player;
    const dash = this.dash.update(dt, player, laps, me && race ? race.lapOf(me) : laps.lap, race ? race.laps : null);
    // The display is only visible from inside the car: don't redraw it otherwise.
    if (camera.mode === 'driver' || camera.mode === 'cockpit') player.visual.setDash?.(dash);
  }

  /** Average roughness under the grounded wheels (0 = tarmac). */
  private roughnessUnder(car: Vehicle): number {
    let sum = 0;
    let n = 0;
    const wheels = car.physics.wheels;
    for (let i = 0; i < wheels.length; i++) {
      if (!wheels[i].grounded) continue;
      const c = car.config.wheels[i].position;
      this.probe.set(c.x, 0, c.z).applyQuaternion(car.quaternion).add(car.position);
      sum += ROUGHNESS[this.track.surfaceAt(this.probe)];
      n++;
    }
    return n ? sum / n : 0;
  }

  dispose(): void {
    this.skidMarks.dispose();
  }
}
