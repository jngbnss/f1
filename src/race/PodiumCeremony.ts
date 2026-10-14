import * as THREE from 'three';
import { PIT_BUILDING_FRONT } from '../world/PitBuilding';
import { setCrowdExcitement } from '../world/Crowd';
import type { Track } from '../world/Track';

/**
 * Post-race podium ceremony, after the F1 games' cut-scene: the top three walk
 * out onto a podium balcony over the main straight (P3, P2, then the winner),
 * the anthem plays over a close-up of the winner, the trophies go up, then the
 * champagne and the confetti, with a broadcast lower-third naming the three.
 * Builds its own podium so it works on every circuit; drives the camera shot.
 */
export interface PodiumEntry {
  name: string;
  team: string;
  /** Race suit and cap. */
  primary: number;
  secondary: number;
  accent: number;
  /** "1:23:45.678" or a gap; shown in the lower-third. */
  time: string;
  /** The player's driver: tagged in the lower-third and given a close-up. */
  isPlayer?: boolean;
}

/** Sound cues the game plays: crowd cheer swells, the champagne cork. */
export type PodiumCue = 'cheer' | 'pop';

/** Ceremony length (s): the results come back after it. */
export const PODIUM_DURATION = 33;

// Timeline (s, ceremony time: runs slower in the slow-motion window).
const ENTER = [0.6, 1.6, 2.6]; // P3, P2, P1 start walking
const WALK = 2.2;
/** Behind the steps the two others go to the winner: hugs and pats on the back. */
const HUG = [5, 7.6];
/** Back to their steps, then up: P3, P2, the winner last with a big jump. */
const BACK = [7.6, 8.4];
const HOP_AT = [8.4, 8.7, 9.1];
const HOP = 0.5;
/** The winner's jumps and fist pumps on the top step. */
const JUMPS = [9.6, 11];
const ANTHEM = [11.4, 15.6];
const TROPHY = [15.8, 16.8, 18]; // P3, P2, P1 receive it
const BOTTLES = 20.4;
/** The corks pop; spraying each other until the end. */
const SPRAY = [21.6, 29.2];
const CONFETTI = 21.6;
/** Slow motion on the first faceful of champagne. */
const SLOWMO = [22.6, 24.6];
const SLOWMO_RATE = 0.35;
/** Winner's swig from the bottle. */
const SWIG = [27.4, 28.8];

/** Step per finishing position: lateral slot (local x) and step height. */
const STEPS: [number, number][] = [
  [0, 1.0],
  [2.1, 0.7],
  [-2.1, 0.5],
];
const DECK_BOTTOM = 11.2;
const DECK_THICK = 1.1;
const DECK_LENGTH = 26;

const SKIN = [0xe0b48f, 0xc99470, 0xa8714c];
const GOLD = 0xd8b04a;
const SILVER = 0xc8ccd2;
const BRONZE = 0xb07444;
const GRAVITY = 9.8;

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const span = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));

interface Figure {
  root: THREE.Group;
  /** Upper body above the hips: twists, leans and breathes. */
  spine: THREE.Group;
  /** Head pivot: looks around and nods. */
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  handR: THREE.Object3D;
  handL: THREE.Object3D;
  trophy: THREE.Group;
  bottle: THREE.Group;
  /** Bottle mouth, for the spray. */
  mouth: THREE.Object3D;
  /** Who this driver is spraying (figure index) right now, -1 = the crowd / nobody. */
  target: number;
  /** Per-driver phase seed: the three never bounce or glance in lockstep. */
  seed: number;
}

/**
 * How worked up the drivers are over the ceremony (0 = standing at attention for
 * the anthem, 1 = going wild). Drives the bouncing, the spine twist and how far
 * the head swings around, so nobody ever stands frozen.
 */
const HYPE: [number, number][] = [
  [0, 0.6],
  [HOP_AT[0], 0.95],
  [ANTHEM[0] - 0.5, 0.95],
  [ANTHEM[0] + 0.7, 0.08],
  [ANTHEM[1] - 0.3, 0.08],
  [ANTHEM[1] + 0.8, 0.6],
  [BOTTLES, 0.9],
  [SPRAY[0], 1],
  [PODIUM_DURATION, 0.95],
];

function hypeAt(T: number): number {
  let v = HYPE[0][1];
  for (let i = 1; i < HYPE.length; i++) {
    const [ta, va] = HYPE[i - 1];
    const [tb, vb] = HYPE[i];
    if (T <= ta) break;
    v = THREE.MathUtils.lerp(va, vb, smooth(clamp01((T - ta) / (tb - ta))));
  }
  return v;
}

/** Spray targets over time per driver (figure index; -1 = the crowd). */
const SPRAY_PLAN: [number, number][][] = [
  // Winner: P2, then P3, then the crowd.
  [[SPRAY[0], 1], [24.8, 2], [26.6, -1]],
  // P2 and P3 go for the winner; P3 turns on P2 near the end.
  [[SPRAY[0], 0]],
  [[SPRAY[0], 0], [26.2, 1]],
];

/** Arm rotation (x, z) that points a hanging arm (-y) along unit `d`, in the figure's frame. */
function aimArm(d: THREE.Vector3): [number, number] {
  const rz = Math.asin(THREE.MathUtils.clamp(d.x, -1, 1));
  return [Math.atan2(-d.z, -d.y), rz];
}

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _col = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class PodiumCeremony {
  readonly group = new THREE.Group();
  /** World point the shadows and the camera centre on. */
  readonly center = new THREE.Vector3();
  readonly shotPos = new THREE.Vector3();
  readonly shotLook = new THREE.Vector3();
  time = 0;
  private readonly owned: { dispose(): void }[] = [];
  private readonly figures: Figure[] = [];
  /** Local z of the step row (front of the deck is -depth/2). */
  private readonly stepZ: number;
  private readonly deckY = DECK_BOTTOM + DECK_THICK;
  private readonly depth: number;
  private readonly ui: HTMLDivElement | null = null;
  private readonly spray: Spray;
  private readonly confetti: Confetti;
  private readonly light: THREE.SpotLight;
  /** Podium position (figure index) of the player's driver, -1 if not on it. */
  private readonly playerK: number;

  constructor(
    track: Track,
    entries: PodiumEntry[],
    title: string,
    onSkip: () => void,
    private readonly onCue: (cue: PodiumCue) => void = () => {},
  ) {
    this.playerK = entries.slice(0, 3).findIndex((e) => e.isPlayer);
    // Over the main straight on the pit side, in front of the middle of the pit building.
    const P = track.getCenterline();
    const R = track.getRights();
    const pit = track.pit;
    let i = track.spawnIndex;
    let side = 1;
    let lane = track.halfWidth + 10;
    let y = P[i].y;
    if (pit) {
      const k = Math.round((pit.limiterStart + pit.limiterEnd) / 2);
      i = pit.pathIndex[k];
      side = pit.side;
      lane = pit.lateralAt(i) || pit.laneOffset;
      y = pit.path[k].y;
    }
    const r = R[i].clone().multiplyScalar(side);
    const inner = track.halfWidth - 3;
    const outer = lane + PIT_BUILDING_FRONT + 3;
    this.depth = outer - inner;
    this.stepZ = -this.depth / 2 + 3;
    this.group.name = 'PodiumCeremony';
    this.group.position.copy(P[i]).addScaledVector(r, (inner + outer) / 2).setY(y);
    // Local axes: z towards the building (track side = -z), y up, x = y × z along the straight.
    const up = new THREE.Vector3(0, 1, 0);
    const z = r.clone().setY(0).normalize();
    this.group.quaternion.setFromRotationMatrix(_m.makeBasis(new THREE.Vector3().crossVectors(up, z).normalize(), up, z));
    this.group.updateMatrixWorld(true);
    this.center.copy(this.group.localToWorld(new THREE.Vector3(0, this.deckY + 1.5, this.stepZ)));

    this.buildStage(title, pit !== null);
    entries.slice(0, 3).forEach((e, k) => this.figures.push(this.buildFigure(e, k)));

    // Warm key light over the steps: readable at dusk and at night too.
    this.light = new THREE.SpotLight(0xfff1dc, 900, 40, 0.75, 0.6, 1.6);
    this.light.position.set(0, this.deckY + 9, this.stepZ - 9);
    this.light.target.position.set(0, this.deckY + 1, this.stepZ);
    this.group.add(this.light, this.light.target);

    this.spray = new Spray(this.own.bind(this));
    this.confetti = new Confetti(this.own.bind(this), entries.map((e) => e.primary));
    this.group.add(this.spray.points, this.confetti.mesh);

    if (typeof document !== 'undefined') {
      this.ui = document.createElement('div');
      this.ui.className = 'podium-ui';
      const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
      this.ui.innerHTML =
        `<div class="podium-third"><div class="podium-head"><b>PODIUM</b><span>${title}</span></div><ol>` +
        entries
          .slice(0, 3)
          .map((e, k) => `<li data-k="${k}"${e.isPlayer ? ' class="you"' : ''}><b>${k + 1}</b><i style="background:${hex(e.primary)}"></i><span>${e.name}${e.isPlayer ? '<u>YOU</u>' : ''}<em>${e.team}</em></span><small>${e.time}</small></li>`)
          .join('') +
        `</ol></div><button class="podium-skip" type="button">건너뛰기 <kbd>Space</kbd></button>`;
      this.ui.querySelector('button')!.addEventListener('click', onSkip);
      document.body.append(this.ui);
    }
    // The whole grandstand is on its feet for a podium, not politely watching a race.
    setCrowdExcitement(2.4);
  }

  get done(): boolean {
    return this.time >= PODIUM_DURATION;
  }

  /** Advance the ceremony (dt in real seconds); the camera shot is in shotPos / shotLook. */
  update(realDt: number): void {
    // Slow motion: the ceremony clock (animation, spray, confetti) runs slower.
    const slow = this.time > SLOWMO[0] && this.time < SLOWMO[1];
    const dt = realDt * (slow ? SLOWMO_RATE : 1);
    const before = this.time;
    this.time += dt;
    const T = this.time;
    const cue = (at: number, c: PodiumCue) => before < at && T >= at && this.onCue(c);
    cue(HOP_AT[0] + HOP + 0.4, 'cheer');
    cue(SPRAY[0], 'pop');
    cue(SPRAY[0] + 0.15, 'cheer');
    this.figures.forEach((f, k) => this.animateFigure(f, k, T));
    this.group.updateMatrixWorld(true);

    // Champagne: each bottle sprays along its neck.
    const spraying = T > SPRAY[0] && T < SPRAY[1];
    for (const f of this.figures) {
      if (!spraying) break;
      if (f.target === -2) continue; // drinking
      f.mouth.getWorldPosition(_v);
      this.group.worldToLocal(_v);
      f.mouth.getWorldQuaternion(_q);
      _d.set(0, 1, 0).applyQuaternion(_q).applyQuaternion(this.group.quaternion.clone().invert());
      // The pop: a burst of foam for the first moment.
      this.spray.emit(_v, _d, dt * (T < SPRAY[0] + 0.25 ? 3 : 1));
    }
    this.spray.update(dt);
    if (T > CONFETTI && !this.confetti.fired) this.confetti.fire(this.stepZ, this.deckY);
    this.confetti.update(dt);

    this.updateUi(T);
    this.camera(T);
  }

  skip(): void {
    this.time = PODIUM_DURATION;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const o of this.owned) o.dispose();
    this.ui?.remove();
    setCrowdExcitement(1);
  }

  // ---------------------------------------------------------------------------

  private own<T extends { dispose(): void }>(o: T): T {
    this.owned.push(o);
    return o;
  }

  private buildStage(title: string, overPit: boolean): void {
    const g = this.group;
    const std = (color: number, roughness = 0.55, metalness = 0) => this.own(new THREE.MeshStandardMaterial({ color, roughness, metalness }));
    const white = std(0xf3f3f0, 0.5);
    const steel = std(0x9aa0a6, 0.4, 0.6);
    const carpet = std(0x1b1d22, 0.9);
    const red = std(0xc8102e, 0.6);
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material | THREE.Material[]) => {
      const m = new THREE.Mesh(this.own(new THREE.BoxGeometry(w, h, d)), mat);
      m.position.set(x, y, z);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      return m;
    };
    const { depth, deckY, stepZ } = this;
    // Deck (red fascia on the track edge and the ends), dark carpet on top.
    box(DECK_LENGTH, DECK_THICK, depth, 0, DECK_BOTTOM + DECK_THICK / 2, 0, [red, red, white, white, white, red]);
    box(DECK_LENGTH - 0.4, 0.04, depth - 0.4, 0, deckY + 0.02, 0, carpet);
    // Glass balustrade on three sides.
    const glass = this.own(new THREE.MeshStandardMaterial({ color: 0xbfd6e4, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
    box(DECK_LENGTH, 1.1, 0.05, 0, deckY + 0.55, -depth / 2 + 0.1, glass);
    for (const s of [-1, 1]) box(0.05, 1.1, depth - 0.2, (s * DECK_LENGTH) / 2 - s * 0.1, deckY + 0.55, 0, glass);
    // Masts and ties up the back: the deck hangs from them. Without a pit building, legs to the ground.
    for (const s of [-0.35, 0.35]) {
      if (overPit) {
        box(0.6, 9, 0.6, s * DECK_LENGTH, DECK_BOTTOM + 4.5, depth / 2 - 0.5, steel);
        const tie = box(0.18, 0.18, 1, s * DECK_LENGTH, 0, 0, steel);
        const a = new THREE.Vector3(s * DECK_LENGTH, DECK_BOTTOM + 9, depth / 2 - 0.5);
        const b = new THREE.Vector3(s * DECK_LENGTH, deckY, -depth / 2 + 0.8);
        tie.position.copy(a).add(b).multiplyScalar(0.5);
        tie.scale.z = a.distanceTo(b);
        tie.lookAt(g.localToWorld(b.clone()));
      } else {
        for (const z of [-depth / 2 + 1, depth / 2 - 1]) box(0.6, DECK_BOTTOM, 0.6, s * DECK_LENGTH, DECK_BOTTOM / 2, z, steel);
      }
    }
    // Steps: white blocks with the position number on the front.
    STEPS.forEach(([x, h], k) => {
      const tex = this.own(numberTexture(k + 1));
      const face = std(0xffffff, 0.5);
      face.map = tex;
      box(1.9, h, 1.6, x, deckY + h / 2, stepZ, [white, white, white, white, white, face]);
    });
    // Backdrop wall with the event banner, team-neutral.
    const back = this.own(bannerTexture(title));
    const backMat = std(0xffffff, 0.6);
    backMat.map = back;
    box(14, 4.4, 0.3, 0, deckY + 2.2, stepZ + 3.2, [white, white, white, white, white, backMat]);
  }

  private buildFigure(e: PodiumEntry, k: number): Figure {
    const mat = (color: number, roughness = 0.6) => this.own(new THREE.MeshStandardMaterial({ color, roughness }));
    // Race suit in the team colour, the second colour down the sides, the accent on the collar.
    const suit = mat(e.primary, 0.55);
    const suitDark = mat(_col.setHex(e.primary).multiplyScalar(0.82).getHex(), 0.6);
    const trim = mat(e.secondary === e.primary ? 0xf2f2f2 : e.secondary, 0.55);
    const accent = mat(e.accent, 0.5);
    const band = mat(0xf2f2f2, 0.5);
    const skin = mat(SKIN[k % SKIN.length], 0.7);
    const cap = mat(e.primary, 0.6);
    const hair = mat([0x2a1d14, 0x14100d, 0x5a3b22][k % 3], 0.8);
    const black = mat(0x151515, 0.7);
    const capsule = (r: number, len: number, m: THREE.Material) => {
      const mesh = new THREE.Mesh(this.own(new THREE.CapsuleGeometry(r, len, 3, 10)), m);
      mesh.castShadow = true;
      return mesh;
    };
    const root = new THREE.Group();
    root.name = `PodiumDriver${k + 1}`;
    // Legs pivot at the hip, hanging down -y; the knee folds the shin back.
    const leg = (x: number) => {
      const hip = new THREE.Group();
      hip.position.set(x, 0.92, 0);
      const thigh = capsule(0.085, 0.36, suitDark);
      thigh.position.y = -0.22;
      const knee = new THREE.Group();
      knee.position.y = -0.42;
      const shin = capsule(0.072, 0.36, suitDark);
      shin.position.y = -0.2;
      const shoe = capsule(0.055, 0.17, black);
      shoe.rotation.x = Math.PI / 2;
      shoe.position.set(0, -0.44, -0.05);
      // Side stripe down the outside of the leg, in two pieces so the knee can bend.
      const stripe = (h: number, y: number) => {
        const s = new THREE.Mesh(this.own(new THREE.BoxGeometry(0.03, h, 0.07)), trim);
        s.position.set(Math.sign(x) * 0.075, y, 0);
        return s;
      };
      knee.add(shin, shoe, stripe(0.36, -0.2));
      hip.add(thigh, knee, stripe(0.38, -0.21));
      root.add(hip);
      return { hip, knee };
    };
    const legL = leg(-0.1);
    const legR = leg(0.1);

    // Everything above the hips hangs off the spine so the upper body can twist,
    // lean and breathe on its own. Positions below are relative to it (root y 0.95).
    const spine = new THREE.Group();
    spine.position.y = 0.95;
    root.add(spine);
    const pelvis = capsule(0.14, 0.12, suitDark);
    pelvis.rotation.z = Math.PI / 2;
    pelvis.scale.z = 0.75;
    const torso = capsule(0.165, 0.28, suit);
    torso.scale.set(1.3, 1, 0.78);
    torso.position.y = 0.29;
    const chest = new THREE.Mesh(this.own(new THREE.BoxGeometry(0.36, 0.07, 0.04)), band);
    chest.position.set(0, 0.37, -0.125);
    for (const x of [-0.205, 0.205]) {
      const stripe = new THREE.Mesh(this.own(new THREE.BoxGeometry(0.035, 0.42, 0.2)), trim);
      stripe.position.set(x, 0.25, 0);
      spine.add(stripe);
    }
    const collar = new THREE.Mesh(this.own(new THREE.CylinderGeometry(0.075, 0.085, 0.06, 14)), accent);
    collar.position.y = 0.54;
    spine.add(pelvis, torso, chest, collar);

    // Head pivot at the base of the neck (root y 1.50).
    const head = new THREE.Group();
    head.position.y = 0.55;
    spine.add(head);
    const neck = capsule(0.055, 0.08, skin);
    neck.position.y = 0.02;
    const skull = new THREE.Mesh(this.own(new THREE.SphereGeometry(0.12, 16, 12)), skin);
    skull.scale.set(0.92, 1.08, 1);
    skull.position.y = 0.17;
    skull.castShadow = true;
    // Face (towards -z): eyes and brows; ears; hair showing under the cap at the back.
    for (const x of [-0.042, 0.042]) {
      const eye = new THREE.Mesh(this.own(new THREE.SphereGeometry(0.014, 8, 6)), black);
      eye.position.set(x, 0.175, -0.108);
      const brow = new THREE.Mesh(this.own(new THREE.BoxGeometry(0.04, 0.009, 0.01)), hair);
      brow.position.set(x, 0.2, -0.108);
      const ear = new THREE.Mesh(this.own(new THREE.SphereGeometry(0.026, 8, 6)), skin);
      ear.scale.set(0.5, 1, 0.8);
      ear.position.set(Math.sign(x) * 0.11, 0.165, 0.005);
      head.add(eye, brow, ear);
    }
    const nose = new THREE.Mesh(this.own(new THREE.SphereGeometry(0.018, 8, 6)), skin);
    nose.position.set(0, 0.155, -0.118);
    const back = new THREE.Mesh(this.own(new THREE.SphereGeometry(0.124, 14, 8, 0, Math.PI, Math.PI * 0.3, Math.PI * 0.42)), hair);
    back.position.y = 0.18;
    // Team cap: crown in the team colour, second-colour brim towards the crowd.
    const crown = new THREE.Mesh(this.own(new THREE.SphereGeometry(0.128, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)), cap);
    crown.position.y = 0.21;
    const brim = new THREE.Mesh(this.own(new THREE.CylinderGeometry(0.11, 0.11, 0.015, 16, 1, false, Math.PI / 2, Math.PI)), trim);
    brim.scale.z = 1.25;
    brim.position.set(0, 0.215, -0.07);
    head.add(neck, skull, nose, back, crown, brim);

    // Arms pivot at the shoulder, hanging down -y; rotation.x > 0 swings them forward
    // and up, and the elbow folds the forearm the same way.
    const arm = (x: number) => {
      const sh = new THREE.Group();
      sh.position.set(x, 0.47, 0);
      const upper = capsule(0.058, 0.26, suit);
      upper.position.y = -0.16;
      const elbow = new THREE.Group();
      elbow.position.y = -0.32;
      const fore = capsule(0.05, 0.24, suit);
      fore.position.y = -0.13;
      const glove = new THREE.Mesh(this.own(new THREE.SphereGeometry(0.058, 10, 8)), black);
      glove.position.y = -0.3;
      const hand = new THREE.Object3D();
      hand.position.y = -0.32;
      elbow.add(fore, glove, hand);
      sh.add(upper, elbow);
      spine.add(sh);
      return { sh, elbow, hand };
    };
    const L = arm(-0.22);
    const R = arm(0.22);
    // Trophy (upright, placed between the hands each frame): gold for the winner.
    const trophy = new THREE.Group();
    const metal = this.own(new THREE.MeshStandardMaterial({ color: [GOLD, SILVER, BRONZE][k], metalness: 0.95, roughness: 0.22 }));
    const s = k === 0 ? 1.25 : 1;
    const cup = new THREE.Mesh(this.own(new THREE.LatheGeometry([new THREE.Vector2(0.03, 0), new THREE.Vector2(0.09, 0.02), new THREE.Vector2(0.04, 0.06), new THREE.Vector2(0.03, 0.18), new THREE.Vector2(0.08, 0.24), new THREE.Vector2(0.14, 0.36), new THREE.Vector2(0.15, 0.46), new THREE.Vector2(0.13, 0.47)], 20)), metal);
    cup.scale.setScalar(s);
    cup.position.y = -0.05;
    cup.castShadow = true;
    trophy.add(cup);
    trophy.visible = false;
    root.add(trophy);
    // Champagne bottle in the right hand, neck along the hand's -y (= along the forearm).
    const bottle = new THREE.Group();
    const glassMat = this.own(new THREE.MeshStandardMaterial({ color: 0x0f3a1e, roughness: 0.15, metalness: 0.1 }));
    const foil = this.own(new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.3, metalness: 0.9 }));
    const body = new THREE.Mesh(this.own(new THREE.LatheGeometry([new THREE.Vector2(0, -0.12), new THREE.Vector2(0.045, -0.12), new THREE.Vector2(0.045, 0.06), new THREE.Vector2(0.018, 0.13), new THREE.Vector2(0.016, 0.2)], 14)), glassMat);
    const neckFoil = new THREE.Mesh(this.own(new THREE.CylinderGeometry(0.019, 0.02, 0.07, 10)), foil);
    neckFoil.position.y = 0.165;
    const mouth = new THREE.Object3D();
    mouth.position.y = 0.21;
    bottle.add(body, neckFoil, mouth);
    // Held at the base, neck pointing down the arm (the spray then follows the arm).
    bottle.rotation.x = Math.PI;
    bottle.position.y = -0.1;
    bottle.visible = false;
    R.hand.add(bottle);
    this.group.add(root);
    return {
      root,
      spine,
      head,
      armL: L.sh,
      armR: R.sh,
      elbowL: L.elbow,
      elbowR: R.elbow,
      legL: legL.hip,
      legR: legR.hip,
      kneeL: legL.knee,
      kneeR: legR.knee,
      handR: R.hand,
      handL: L.hand,
      trophy,
      bottle,
      mouth,
      target: -1,
      seed: k * 1.7 + 0.4,
    };
  }

  /** Pose driver k (0 = winner) at ceremony time T. */
  private animateFigure(f: Figure, k: number, T: number): void {
    const [x, h] = STEPS[k];
    const z = this.stepZ;
    const behindZ = z + 1.5;
    const t0 = ENTER[2 - k];
    const root = f.root;
    root.visible = T >= t0;
    let px = x;
    let py = this.deckY;
    let pz = behindZ;
    let yaw = 0;
    let lean = 0;
    let step = 0;
    let rL = 0;
    let zL = -0.08;
    let rR = 0;
    let zR = 0.08;

    // 1. Walk in from the side door behind the backdrop end (yaw pi/2 = facing -x).
    const walk = span(T, t0, t0 + WALK);
    // 2. Behind the steps the other two go to the winner: a hug and pats on the back.
    const hugX = [0, 0.62, -0.62][k];
    const toHug = smooth(span(T, HUG[0], HUG[0] + 0.7));
    const fromHug = smooth(span(T, BACK[0], BACK[1]));
    const hug = toHug * (1 - fromHug);
    // 3. Up onto the step.
    const hopT = HOP_AT[2 - k];
    const hop = span(T, hopT, hopT + HOP);
    if (walk < 1) {
      px = THREE.MathUtils.lerp(x + 8.5, x, walk);
      yaw = Math.PI / 2;
      step = walk > 0 ? Math.sin(T * 9) : 0;
      py += Math.abs(step) * 0.03;
    } else if (T < hopT) {
      px = THREE.MathUtils.lerp(x, hugX, hug);
      const moving = (toHug > 0 && toHug < 1) || (fromHug > 0 && fromHug < 1);
      if (moving) step = Math.sin(T * 9) * 0.6;
      if (k > 0) {
        // Face the winner while going to him and hugging, the other way walking back.
        const toWinner = x > 0 ? Math.PI / 2 : -Math.PI / 2;
        yaw = fromHug > 0 && fromHug < 1 ? -toWinner : toWinner * smooth(span(T, HUG[0] - 0.3, HUG[0] + 0.2)) * (fromHug < 1 ? 1 : 0);
        lean = 0.14 * hug;
        rR = rL = 1.35 * hug;
        zR = THREE.MathUtils.lerp(0.08, -0.35, hug);
        zL = -zR;
        rR += Math.sin(T * 7 + k) * 0.2 * hug; // pat, pat
      } else {
        // The winner opens both arms around them.
        rR = rL = 1.2 * hug;
        zR = THREE.MathUtils.lerp(0.08, 1.0, hug) + Math.sin(T * 7) * 0.12 * hug;
        zL = -zR;
      }
    } else {
      const e = smooth(hop);
      py = this.deckY + h * e + Math.sin(hop * Math.PI) * (k === 0 ? 0.45 : 0.25);
      pz = THREE.MathUtils.lerp(behindZ, z, e);
    }

    // 4. On the step: the winner jumps with fists up; the others wave.
    const arrived = hopT + HOP;
    if (T > arrived && T < ANTHEM[0] - 0.2) {
      const fade = 1 - span(T, ANTHEM[0] - 0.8, ANTHEM[0] - 0.2);
      const w = smooth(span(T, arrived, arrived + 0.4)) * fade;
      if (k === 0) {
        const j = span(T, JUMPS[0], JUMPS[1]);
        if (j > 0 && j < 1) py += Math.abs(Math.sin((T - JUMPS[0]) * Math.PI * 2.2)) * 0.32;
        const pump = Math.sin(T * 9) * 0.18;
        rR = rL = THREE.MathUtils.lerp(0, 2.85 + pump, w);
        zR = THREE.MathUtils.lerp(0.08, 0.32, w);
        zL = -zR;
      } else {
        rR = THREE.MathUtils.lerp(0, 2.9, w);
        zR = THREE.MathUtils.lerp(0.08, 0.35 + Math.sin(T * 6 + k) * 0.14, w);
      }
    }

    // 5. Trophy: chest height, then overhead.
    const got = TROPHY[2 - k];
    if (T > got && T < BOTTLES) {
      const e = smooth(span(T, got + 0.25, got + 0.9) * (1 - span(T, BOTTLES - 0.6, BOTTLES - 0.1)));
      rR = rL = THREE.MathUtils.lerp(1.2, 2.95, e);
      zR = THREE.MathUtils.lerp(-0.25, -0.12, e) + Math.sin(T * 4 + k) * 0.05 * e;
      zL = -zR;
    }
    f.trophy.visible = T > got && T < BOTTLES - 0.1;

    // 6. Champagne: shake it, pop, then go for each other's heads.
    f.bottle.visible = T > BOTTLES;
    f.target = -1;
    if (T > BOTTLES && T < SPRAY[0]) {
      rR = 1.3 + Math.sin(T * 30) * 0.25;
      zR = -0.2 + Math.sin(T * 30 + 1) * 0.08;
      rL = 0.9;
      zL = -0.2;
    } else if (T >= SPRAY[0]) {
      const sp = smooth(span(T, SPRAY[0], SPRAY[0] + 0.3)) * (1 - span(T, SPRAY[1] - 0.6, SPRAY[1]));
      const plan = SPRAY_PLAN[k];
      let target = -1;
      for (const [at, who] of plan) if (T >= at) target = who;
      if (target >= this.figures.length) target = -1;
      f.target = target;
      // Where to aim: the other's head (a little over it: the stream drops), else up over the crowd.
      const me = root.position;
      if (target >= 0) _v.copy(this.figures[target].root.position).setY(this.figures[target].root.position.y + 1.85);
      else _v.set(me.x * 0.5, this.deckY + 5, this.stepZ - 14);
      _d.set(me.x, me.y + 1.42, me.z);
      _v.sub(_d);
      _v.y += _v.length() * 0.12;
      // Turn the body part of the way, the arm the rest.
      const want = Math.atan2(-_v.x, -_v.z);
      const bodyYaw = THREE.MathUtils.clamp(want * 0.6, -1.1, 1.1) * sp;
      yaw = bodyYaw;
      _v.normalize().applyAxisAngle(UP, -bodyYaw);
      const [ax, az] = aimArm(_v);
      rR = THREE.MathUtils.lerp(0.9, ax + Math.sin(T * 5 + k) * 0.08, sp);
      zR = THREE.MathUtils.lerp(-0.2, az + Math.sin(T * 3.3 + k) * 0.1, sp);
      rL = THREE.MathUtils.lerp(0.9, 0.35, sp);
      zL = -0.25;
      // Bouncing about the whole time.
      py += Math.abs(Math.sin(T * 5 + k * 1.3)) * 0.07 * sp;
      // Getting a faceful: lean back, free hand up in front of the face.
      const hit = this.figures.some((o, j) => j !== k && o.target === k);
      if (hit && sp > 0) {
        lean = -0.2 + Math.sin(T * 6 + k) * 0.05;
        // Left forearm across the face (+z swings the left arm in towards the body).
        rL = 2.0;
        zL = 0.65;
      }
      // The end: all three hold their bottles up to the crowd, waving.
      const finale = smooth(span(T, SPRAY[1] - 0.4, SPRAY[1] + 0.4));
      if (finale > 0) {
        rR = THREE.MathUtils.lerp(rR, 2.75 + Math.sin(T * 5 + k) * 0.15, finale);
        zR = THREE.MathUtils.lerp(zR, 0.3, finale);
        rL = THREE.MathUtils.lerp(rL, k === 0 ? 2.75 : 0.2, finale);
        zL = THREE.MathUtils.lerp(zL, k === 0 ? -0.3 : -0.1, finale);
        lean *= 1 - finale;
        yaw *= 1 - finale;
      }
      if (k === 0) {
        // The winner's swig near the end.
        const swig = smooth(span(T, SWIG[0], SWIG[0] + 0.5)) * (1 - span(T, SWIG[1] - 0.5, SWIG[1]));
        if (swig > 0) {
          f.target = -2; // not spraying while drinking
          rR = THREE.MathUtils.lerp(rR, 2.6, swig);
          zR = THREE.MathUtils.lerp(zR, -0.55, swig);
          yaw = THREE.MathUtils.lerp(yaw, 0, swig);
          lean = THREE.MathUtils.lerp(lean, -0.12, swig);
        }
      }
    }

    // --- liveliness --------------------------------------------------------------------
    // Nobody on a podium stands still. On top of the scripted pose every driver gets his
    // own bounce, weight shift, breathing, head glances and bent joints, scaled by how
    // worked up he is (flat during the anthem, maximum in the champagne). The three use
    // different frequencies and phases so they never move as one block of avatars.
    const s = f.seed;
    const hype = hypeAt(T);
    const bounce = Math.sin(T * (3.3 + s * 0.42) + s * 2.2);
    const sway = Math.sin(T * (0.82 + s * 0.11) + s * 1.7);
    const breath = Math.sin(T * (1.05 + s * 0.13) + s * 3.1);
    const bob = Math.max(0, bounce);
    py += bob * 0.04 * hype;

    root.position.set(px, py, pz);
    root.rotation.set(lean, yaw, 0, 'YXZ');
    // Legs: the walk cycle, plus knees giving under every bounce and a weight shift.
    const shift = sway * 0.055 * (0.35 + hype);
    f.legL.rotation.set(step * 0.45, 0, shift);
    f.legR.rotation.set(-step * 0.45, 0, shift);
    const squat = -(0.05 + 0.3 * bob * hype);
    f.kneeL.rotation.x = squat - Math.max(0, step) * 0.5;
    f.kneeR.rotation.x = squat - Math.max(0, -step) * 0.5;
    // Spine: twists with the sway, pumps with the bounce, breathes all the time.
    f.spine.rotation.set(-0.03 * breath - 0.07 * bounce * hype, 0.1 * sway * hype, 0.05 * sway * (0.3 + hype), 'YXZ');
    f.spine.scale.y = 1 + 0.015 * breath;
    // Head: at the crowd most of the time, at whoever he is spraying, nodding on the beat.
    let headYaw = 0.2 * sway * hype;
    if (f.target >= 0) {
      const o = this.figures[f.target].root.position;
      headYaw = THREE.MathUtils.clamp(Math.atan2(-(o.x - px), -(o.z - pz)) - yaw, -1, 1);
    } else {
      headYaw += Math.sin(T * 0.47 + s * 2.3) * 0.3 * hype;
    }
    f.head.rotation.set(-0.05 * hype + 0.07 * bounce * hype, headYaw, 0.04 * sway, 'YXZ');
    if (step) {
      rL += -step * 0.35;
      rR += step * 0.35;
    }
    f.armL.rotation.set(rL, 0, zL);
    f.armR.rotation.set(rR, 0, zR);
    // Elbows: a straight plank arm is the thing that reads as a puppet. Bend most at
    // mid-height (waving, hugging, aiming a bottle), least hanging down or fully overhead.
    const elbow = (r: number, phase: number) => 0.2 + 0.55 * Math.sin(clamp01(Math.abs(r) / 3) * Math.PI) + 0.12 * hype * Math.sin(T * 4.1 + phase);
    f.elbowL.rotation.x = elbow(rL, s * 1.9);
    // The bottle points down the forearm, so the aiming arm stays nearly straight.
    f.elbowR.rotation.x = f.bottle.visible && T >= SPRAY[0] ? 0.1 + 0.07 * Math.sin(T * 4.1 + s) : elbow(rR, s * 1.9 + 1.4);
    // Trophy upright between the hands.
    if (f.trophy.visible) {
      root.updateMatrixWorld(true);
      f.handR.getWorldPosition(_v);
      f.handL.getWorldPosition(_d);
      _v.add(_d).multiplyScalar(0.5);
      root.worldToLocal(_v);
      f.trophy.position.copy(_v);
    }
  }

  private updateUi(T: number): void {
    if (!this.ui) return;
    this.ui.classList.toggle('show', T > 1);
    // Names while they come out and for the anthem; then the pictures speak.
    this.ui.classList.toggle('names', T < TROPHY[0] + 1.5);
    this.ui.querySelectorAll<HTMLLIElement>('li').forEach((li) => {
      const k = Number(li.dataset.k);
      li.classList.toggle('in', T > HOP_AT[2 - k] + HOP);
    });
  }

  /** Broadcast shots, cut together, each a slow move with a hand-held wobble; podium-local space. */
  private camera(T: number): void {
    const { deckY, stepZ } = this;
    const front = -this.depth / 2;
    const closeUp = (k: number, e: number) => {
      const [x, h] = STEPS[k];
      _pos.set(x + 0.3, deckY + h + 1.62, stepZ - THREE.MathUtils.lerp(2.9, 2.1, e));
      _look.set(x, deckY + h + 1.5, stepZ);
    };
    if (T < HUG[0]) {
      // From the track below, the crowd's view: slow truck along the straight, rising.
      const e = smooth(span(T, 0, HUG[0]));
      _pos.set(THREE.MathUtils.lerp(-12, -6, e), THREE.MathUtils.lerp(deckY - 1.5, deckY + 0.8, e), front - 22);
      _look.set(THREE.MathUtils.lerp(4, 1, e), deckY + 1.3, stepZ);
    } else if (T < HOP_AT[0]) {
      // The hug behind the steps: over the top of the steps, close.
      const e = smooth(span(T, HUG[0], HOP_AT[0]));
      _pos.set(THREE.MathUtils.lerp(-2.4, -1.2, e), deckY + 2.15, stepZ - 3.1);
      _look.set(0, deckY + 1.25, stepZ + 1.5);
    } else if (T < ANTHEM[0]) {
      // Up onto the steps, the winner's jumps: medium-wide, arcing.
      const e = smooth(span(T, HOP_AT[0], ANTHEM[0]));
      const a = THREE.MathUtils.lerp(0.4, -0.15, e);
      _pos.set(Math.sin(a) * 7.5, deckY + 2.2, stepZ - Math.cos(a) * 7.5);
      _look.set(0, deckY + 1.8, stepZ);
    } else if (T < ANTHEM[1]) {
      // Anthem: the winner in close-up; then the player's driver, if on the podium too.
      const cut = this.playerK > 0 ? ANTHEM[0] + (ANTHEM[1] - ANTHEM[0]) * 0.55 : ANTHEM[1];
      if (T < cut) closeUp(0, smooth(span(T, ANTHEM[0], cut)));
      else closeUp(this.playerK, smooth(span(T, cut, ANTHEM[1])));
    } else if (T < SPRAY[0]) {
      // Trophies, then shaking the bottles: the three in a medium shot, arcing across.
      const e = smooth(span(T, ANTHEM[1], SPRAY[0]));
      const a = THREE.MathUtils.lerp(-0.35, 0.3, e);
      _pos.set(Math.sin(a) * 8, deckY + 2.6, stepZ - Math.cos(a) * 8);
      _look.set(0, deckY + 1.9, stepZ);
    } else if (T < SLOWMO[0]) {
      // Pop! Tight on the winner's bottle.
      _pos.set(-0.9, deckY + STEPS[0][1] + 1.85, stepZ - 1.9);
      _look.set(0.2, deckY + STEPS[0][1] + 1.75, stepZ);
    } else if (T < SLOWMO[1]) {
      // Slow motion: low, between them, the winner's stream into P2's face.
      const e = smooth(span(T, SLOWMO[0], SLOWMO[1]));
      const [x2, h2] = STEPS[1];
      _pos.set(x2 * 0.5 + THREE.MathUtils.lerp(-0.4, 0.3, e), deckY + 1.35, stepZ - 3.2);
      _look.set(x2 * 0.55, deckY + h2 + 1.7, stepZ);
    } else if (T < SPRAY[1]) {
      // Orbiting through the spray.
      const e = span(T, SLOWMO[1], SPRAY[1]);
      const a = THREE.MathUtils.lerp(0.55, -0.5, smooth(e));
      _pos.set(Math.sin(a) * 6, deckY + 1.5 + e * 0.6, stepZ - Math.cos(a) * 6);
      _look.set(0, deckY + 2, stepZ);
    } else {
      // Crane out over the straight, confetti still falling.
      const e = smooth(span(T, SPRAY[1], PODIUM_DURATION));
      _pos.set(THREE.MathUtils.lerp(4, 9, e), THREE.MathUtils.lerp(deckY + 3, deckY + 9, e), THREE.MathUtils.lerp(front - 6, front - 22, e));
      _look.set(0, deckY + 1.6, stepZ);
    }
    // Hand-held: a shoulder-mounted camera never sits still, and an operator chasing a
    // celebration least of all. Three octaves of drift, growing with the party; the crane
    // shot at the end is on a jib, so it stays smooth.
    if (T < SPRAY[1]) {
      const energy = 0.6 + 0.9 * hypeAt(T);
      const w = (a: number, b: number) => (Math.sin(T * a + b) * 0.02 + Math.sin(T * a * 2.3 + b * 1.7) * 0.011 + Math.sin(T * a * 5.7 + b * 0.6) * 0.004) * energy;
      _pos.x += w(1.1, 0);
      _pos.y += w(1.3, 2);
      _pos.z += w(0.7, 5);
      // The operator keeps re-framing: the look point lags and overshoots a little.
      _look.x += w(0.9, 4) * 1.8;
      _look.y += w(1.2, 1) * 1.8;
    }
    this.shotPos.copy(this.group.localToWorld(_pos));
    this.shotLook.copy(this.group.localToWorld(_look));
  }
}

/** Champagne droplets: a ballistic particle pool in podium-local space. */
class Spray {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private next = 0;
  private carry = 0;
  private static readonly N = 4000;
  private static readonly RATE = 420;

  constructor(own: <T extends { dispose(): void }>(o: T) => T) {
    const N = Spray.N;
    this.pos = new Float32Array(N * 3).fill(-1000);
    this.vel = new Float32Array(N * 3);
    this.life = new Float32Array(N);
    const geo = own(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = own(new THREE.PointsMaterial({ color: 0xfff4cf, size: 0.045, map: own(dropTexture()), alphaTest: 0.02, transparent: true, opacity: 0.9, depthWrite: false }));
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  emit(at: THREE.Vector3, dir: THREE.Vector3, dt: number): void {
    this.carry += Spray.RATE * dt;
    while (this.carry >= 1) {
      this.carry--;
      const i = this.next;
      this.next = (this.next + 1) % Spray.N;
      const s = 6 + Math.random() * 4;
      const j = 0.22;
      this.pos.set([at.x, at.y, at.z], i * 3);
      this.vel.set([(dir.x + (Math.random() - 0.5) * j) * s, (dir.y + (Math.random() - 0.5) * j) * s, (dir.z + (Math.random() - 0.5) * j) * s], i * 3);
      this.life[i] = 1.4 + Math.random() * 0.6;
    }
  }

  update(dt: number): void {
    const { pos, vel, life } = this;
    for (let i = 0; i < Spray.N; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      vel[i * 3 + 1] -= GRAVITY * dt;
      // A little drag: the stream breaks up into a mist.
      const drag = Math.exp(-1.2 * dt);
      vel[i * 3] *= drag;
      vel[i * 3 + 2] *= drag;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (life[i] <= 0) pos[i * 3 + 1] = -1000;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

/** Ticker-tape confetti fired from cannons at the deck's front corners, fluttering down. */
class Confetti {
  readonly mesh: THREE.InstancedMesh;
  fired = false;
  private static readonly N = 1400;
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly spin: Float32Array;
  private readonly obj = new THREE.Object3D();

  constructor(own: <T extends { dispose(): void }>(o: T) => T, teamColors: number[]) {
    const N = Confetti.N;
    const geo = own(new THREE.PlaneGeometry(0.07, 0.045));
    const mat = own(new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.4, metalness: 0.3 }));
    this.mesh = new THREE.InstancedMesh(geo, mat, N);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const palette = [GOLD, 0xffffff, 0xe10600, ...teamColors];
    for (let i = 0; i < N; i++) this.mesh.setColorAt(i, _col.setHex(palette[i % palette.length]));
    this.p = new Float32Array(N * 3);
    this.v = new Float32Array(N * 3);
    this.spin = new Float32Array(N * 3);
    this.mesh.count = 0;
  }

  fire(stepZ: number, deckY: number): void {
    this.fired = true;
    const N = Confetti.N;
    for (let i = 0; i < N; i++) {
      const sx = i % 2 ? -1 : 1;
      this.p.set([sx * 6.5, deckY + 0.6, stepZ - 1.5], i * 3);
      const s = 8 + Math.random() * 7;
      this.v.set([-sx * (0.15 + Math.random() * 0.5) * s, (0.75 + Math.random() * 0.4) * s, (Math.random() - 0.6) * 0.5 * s], i * 3);
      this.spin.set([Math.random() * 6, Math.random() * 6, Math.random() * Math.PI * 2], i * 3);
    }
    this.mesh.count = N;
  }

  update(dt: number): void {
    if (!this.fired) return;
    const { p, v, spin, obj } = this;
    for (let i = 0; i < Confetti.N; i++) {
      const k = i * 3;
      // Strong air drag: the paper slows fast, then drifts down at ~1 m/s, fluttering.
      const drag = Math.exp(-2.6 * dt);
      v[k] *= drag;
      v[k + 2] *= drag;
      v[k + 1] = Math.max(-1.1, v[k + 1] * drag - GRAVITY * 0.5 * dt);
      spin[k + 2] += dt * 3;
      p[k] += (v[k] + Math.sin(spin[k + 2] + i) * 0.4) * dt;
      p[k + 1] += v[k + 1] * dt;
      p[k + 2] += (v[k + 2] + Math.cos(spin[k + 2] * 0.7 + i) * 0.3) * dt;
      obj.position.set(p[k], p[k + 1], p[k + 2]);
      obj.rotation.set(spin[k] + spin[k + 2] * 2, spin[k + 1] + spin[k + 2], 0);
      obj.updateMatrix();
      this.mesh.setMatrixAt(i, obj.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Soft round droplet sprite. */
function dropTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

function numberTexture(n: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f3f3f0';
  g.fillRect(0, 0, 256, 160);
  g.fillStyle = '#c8102e';
  g.fillRect(0, 140, 256, 20);
  g.fillStyle = '#15151e';
  g.font = 'italic 900 110px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 128, 74);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function bannerTexture(title: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 320;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 320);
  grad.addColorStop(0, '#15151e');
  grad.addColorStop(1, '#23232e');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 320);
  // Red speed stripes on both sides.
  g.fillStyle = '#e10600';
  for (const x of [0, 1024]) {
    g.save();
    g.translate(x, 0);
    if (x) g.scale(-1, 1);
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.moveTo(40 + k * 34, 320);
      g.lineTo(130 + k * 34, 0);
      g.lineTo(148 + k * 34, 0);
      g.lineTo(58 + k * 34, 320);
      g.fill();
    }
    g.restore();
  }
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'italic 900 82px "Arial Black", Arial, sans-serif';
  g.fillText('GRAND PRIX', 512, 120);
  g.fillStyle = '#d8b04a';
  const sub = `${title.toUpperCase()} · 2026`;
  let size = 40;
  do g.font = `700 ${size}px Arial, sans-serif`;
  while (g.measureText(sub).width > 700 && --size > 24);
  g.fillText(sub, 512, 205);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
