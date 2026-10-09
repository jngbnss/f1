import * as THREE from 'three';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { COUNTDOWN, type RaceManager, type Racer } from '../race/RaceManager';
import type { Compound } from '../vehicle/Tyres';
import type { Vehicle } from '../vehicle/Vehicle';
import { COMPOUND_COLORS } from '../vehicle/cars/GltfF1Visual';
import { INTERP_DELAY, STATE_HZ, type CarState, type RacePlan } from './protocol';
import type { Room } from './Room';
import { VoiceOverlay } from '../ui/VoiceControls';

// Wire codes: append only (older clients know 0-2).
const COMPOUND_ORDER: Compound[] = ['soft', 'medium', 'hard', 'hyper', 'wet'];
/** Never extrapolate a remote car further than this past its last state (ms). */
const MAX_EXTRAPOLATION = 300;
/** States kept per remote car (~1.5 s at 20 Hz). */
const BUFFER = 30;

/** What the game hands the network layer once the race scene exists. */
export interface NetGameView {
  race: RaceManager;
  physics: PhysicsWorld;
  /** True while the pit controller drives this car. */
  inPitLane(v: Vehicle): boolean;
}

interface Remote {
  racer: Racer;
  states: CarState[];
  gone: boolean;
  compound: number;
  damage: [number, number];
  inPit: boolean;
}

const _pos = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _fwd = new THREE.Vector3();

/**
 * Networked race on top of the normal single-player race:
 *  - cars this browser owns (its player, plus the AI cars when hosting) are
 *    simulated normally and their state is sent 20x per second;
 *  - every other car is a kinematic body placed by snapshot interpolation
 *    (shown ~110 ms in the past, between two received states), so it moves
 *    smoothly and still pushes your car on contact;
 *  - the start lights run off the host's clock, so everyone gets the green
 *    light at the same moment.
 */
export class NetRace {
  private view: NetGameView | null = null;
  private readonly remotes = new Map<number, Remote>();
  private readonly owned: { slot: number; racer: Racer }[] = [];
  private sendClock = 0;
  private goAt: number | null = null;
  private banner: HTMLDivElement | null = null;
  private voiceUi: VoiceOverlay | null = null;
  /** Tower names without the talking marker, per grid slot of a human player. */
  private readonly baseNames = new Map<number, { id: string; racer: Racer; name: string }>();

  constructor(
    readonly room: Room,
    readonly plan: RacePlan,
  ) {
    room.onStates = (states) => this.receive(states);
    room.onGo = (startAt) => {
      this.goAt = startAt;
      this.say(null);
    };
    room.onLeft = (id) => this.dropPlayer(id);
    room.onEnd = (reason) => this.say(`${reason} — Esc: 메뉴`, true);
    window.addEventListener('pagehide', () => room.leave());
  }

  get localId(): string {
    return this.room.myId;
  }

  /** Grid slots this browser simulates. */
  ownsSlot(slot: number): boolean {
    const s = this.plan.slots[slot];
    return s.id === this.localId || (s.ai && this.room.isHost);
  }

  /** Racers are in grid-slot order. */
  attach(view: NetGameView): void {
    this.view = view;
    const { rapier } = view.physics;
    view.race.racers.forEach((racer, slot) => {
      const s = this.plan.slots[slot];
      if (!s.ai) this.baseNames.set(slot, { id: s.id, racer, name: racer.name });
      if (this.ownsSlot(slot)) {
        this.owned.push({ slot, racer });
        return;
      }
      racer.vehicle.physics.body.setBodyType(rapier.RigidBodyType.KinematicPositionBased, true);
      this.remotes.set(slot, { racer, states: [], gone: false, compound: -1, damage: [0, 0], inPit: false });
    });
    this.say('다른 플레이어를 기다리는 중…');
    this.room.sendLoaded();
    this.voiceUi = new VoiceOverlay(this.room, () => new Map([...this.baseNames.values()].map((b) => [b.id, b.name])));
  }

  inPit(v: Vehicle): boolean {
    for (const r of this.remotes.values()) if (r.racer.vehicle === v) return r.inPit;
    return false;
  }

  /** Before the physics step: start lights from the host clock, remote cars to their interpolated pose. */
  beforeStep(dt: number): void {
    const view = this.view;
    if (!view) return;
    const now = this.room.hostNow();
    const race = view.race;
    if (race.state === 'countdown') {
      race.countdown = this.goAt === null ? COUNTDOWN : Math.max(0, Math.min(COUNTDOWN, (this.goAt - now) / 1000));
    }
    const t = now - INTERP_DELAY;
    for (const remote of this.remotes.values()) this.place(remote, t, dt);
    // Timing tower: 🎙️ next to whoever is talking on voice chat.
    for (const b of this.baseNames.values()) b.racer.name = this.room.voice.isSpeaking(b.id) ? `${b.name} 🎙️` : b.name;
  }

  /** After the physics step: send the states of the cars this browser owns. */
  afterStep(dt: number): void {
    const view = this.view;
    if (!view) return;
    this.sendClock += dt;
    if (this.sendClock < 1 / STATE_HZ) return;
    this.sendClock %= 1 / STATE_HZ;
    const time = this.room.hostNow();
    this.room.sendStates(this.owned.map(({ slot, racer }) => this.stateOf(slot, racer.vehicle, time, view.inPitLane(racer.vehicle))));
  }

  dispose(): void {
    this.banner?.remove();
    this.voiceUi?.dispose();
    this.room.leave();
  }

  // ------------------------------------------------------------------------

  private stateOf(slot: number, v: Vehicle, time: number, inPit: boolean): CarState {
    const p = v.position;
    const q = v.quaternion;
    const lv = v.physics.body.linvel();
    const steerWheel = v.physics.wheels.find((w) => w.steerAngle !== 0) ?? v.physics.wheels[0];
    return {
      slot,
      time,
      px: p.x,
      py: p.y,
      pz: p.z,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
      vx: lv.x,
      vy: lv.y,
      vz: lv.z,
      steer: steerWheel?.steerAngle ?? 0,
      throttle: v.throttle,
      rpm: v.gearbox?.rpmRatio ?? 0,
      damageFront: v.damage.front,
      damageRear: v.damage.rear,
      compound: COMPOUND_ORDER.indexOf(v.tyres.compound),
      inPit,
      lights: false,
    };
  }

  private receive(states: CarState[]): void {
    for (const s of states) {
      const remote = this.remotes.get(s.slot);
      if (!remote || remote.gone) continue;
      const buf = remote.states;
      if (buf.length && s.time <= buf[buf.length - 1].time) continue; // late or duplicate (unordered channel)
      buf.push(s);
      if (buf.length > BUFFER) buf.shift();
    }
  }

  /** Interpolated (or briefly extrapolated) pose at host time `t` -> kinematic target, wheels, car state. */
  private place(remote: Remote, t: number, dt: number): void {
    const buf = remote.states;
    if (!buf.length || remote.gone) return;
    let a = buf[0];
    let b = buf[0];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].time <= t) {
        a = buf[i];
        b = buf[Math.min(i + 1, buf.length - 1)];
        break;
      }
    }
    // Drop states we will never need again.
    while (buf.length > 2 && buf[1].time < t - 1000) buf.shift();

    const v = remote.racer.vehicle;
    if (a !== b) {
      const k = Math.max(0, Math.min(1, (t - a.time) / (b.time - a.time)));
      _pos.set(a.px + (b.px - a.px) * k, a.py + (b.py - a.py) * k, a.pz + (b.pz - a.pz) * k);
      _q.set(a.qx, a.qy, a.qz, a.qw).slerp(_qb.set(b.qx, b.qy, b.qz, b.qw), k);
    } else {
      // Ahead of the newest state (lag spike): carry on along its velocity for a moment.
      const ahead = Math.max(0, Math.min(MAX_EXTRAPOLATION, t - a.time)) / 1000;
      _pos.set(a.px + a.vx * ahead, a.py + a.vy * ahead, a.pz + a.vz * ahead);
      _q.set(a.qx, a.qy, a.qz, a.qw);
    }
    const body = v.physics.body;
    body.setNextKinematicTranslation(_pos);
    body.setNextKinematicRotation(_q);

    // Wheels: steer from the state, roll from the speed along the car.
    const latest = b;
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    const forward = latest.vx * _fwd.x + latest.vy * _fwd.y + latest.vz * _fwd.z;
    const config = v.config;
    v.physics.wheels.forEach((w, i) => {
      w.grounded = true;
      w.suspensionLength = config.suspensionRestLength * 0.75;
      w.steerAngle = config.wheels[i].steerable ? latest.steer : 0;
      w.spin += (forward * dt) / config.wheelRadius;
    });
    v.throttle = latest.throttle;
    v.gearbox?.update(forward, latest.throttle, true, dt);

    if (latest.compound !== remote.compound && COMPOUND_ORDER[latest.compound] !== undefined) {
      remote.compound = latest.compound;
      const c = COMPOUND_ORDER[latest.compound];
      v.tyres.fit(c);
      v.visual.setCompound?.(COMPOUND_COLORS[c]);
    }
    // The owner's damage numbers win (local contacts may have dented the puppet meanwhile).
    const df = latest.damageFront;
    const dr = latest.damageRear;
    const changed = Math.abs(df - remote.damage[0]) > 0.01 || Math.abs(dr - remote.damage[1]) > 0.01;
    if (changed || v.damage.front !== remote.damage[0] || v.damage.rear !== remote.damage[1]) {
      if (changed) remote.damage = [df, dr];
      v.damage.front = remote.damage[0];
      v.damage.rear = remote.damage[1];
      v.visual.setDamage?.(remote.damage[0], remote.damage[1]);
    }
    remote.inPit = latest.inPit;
  }

  /** A player left mid-race: their car disappears, their name stays greyed in the tower. */
  private dropPlayer(id: string): void {
    this.plan.slots.forEach((s, slot) => {
      if (s.id !== id) return;
      const remote = this.remotes.get(slot);
      if (!remote || remote.gone) return;
      remote.gone = true;
      const v = remote.racer.vehicle;
      v.object3D.visible = false;
      v.physics.collider.setEnabled(false);
      remote.racer.name = `${remote.racer.name} (나감)`;
      const base = this.baseNames.get(slot);
      if (base) base.name = `${base.name} (나감)`;
    });
  }

  /** Message banner over the race (waiting for players, room closed). */
  private say(text: string | null, sticky = false): void {
    if (!text) {
      this.banner?.remove();
      this.banner = null;
      return;
    }
    if (!this.banner) {
      this.banner = document.createElement('div');
      this.banner.className = 'net-banner';
      Object.assign(this.banner.style, {
        position: 'fixed',
        left: '50%',
        top: '22%',
        transform: 'translateX(-50%)',
        padding: '10px 18px',
        borderRadius: '10px',
        background: 'rgba(10,14,22,0.82)',
        color: '#fff',
        font: '600 16px system-ui, sans-serif',
        zIndex: '30',
        pointerEvents: 'none',
        textAlign: 'center',
        maxWidth: '90vw',
      });
      document.body.append(this.banner);
    }
    this.banner.textContent = text;
    this.banner.dataset.sticky = sticky ? '1' : '';
  }
}
