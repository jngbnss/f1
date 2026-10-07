import * as THREE from 'three';
import { FollowCamera } from '../camera/FollowCamera';
import { CarAudio } from '../audio/EngineSound';
import { AudioSystem } from '../audio/AudioSystem';
import { urlWith, type SimConfig } from '../config';
import { GamepadInput } from '../input/GamepadInput';
import { InputManager } from '../input/InputManager';
import { KeyboardInput } from '../input/KeyboardInput';
import { PerformanceMonitor } from '../performance/PerformanceMonitor';
import { PhysicsDebugRenderer } from '../physics/PhysicsDebugRenderer';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { HUD } from '../ui/HUD';
import { Vehicle } from '../vehicle/Vehicle';
import type { CarDefinition } from '../vehicle/cars';
import { LapTimer } from '../race/LapTimer';
import { Environment } from '../world/Environment';
import { RacingLine } from '../world/RacingLine';
import { applyTrackTextures } from '../world/TrackTextures';
import { ProceduralTrack, type Surface, type Track } from '../world/Track';
import type { TrackLayout } from '../world/TrackLayout';
import { GameLoop } from './GameLoop';

/** Seconds a car may stay flipped before it is put back on its wheels. */
const FLIP_RESET_DELAY = 2.5;

/** Arcade surface model: grip multiplier and extra deceleration (m/s²). */
const SURFACES: Record<Surface, { grip: number; drag: number }> = {
  asphalt: { grip: 1, drag: 0 },
  kerb: { grip: 0.95, drag: 0.3 },
  grass: { grip: 0.6, drag: 2.5 },
  gravel: { grip: 0.45, drag: 7 },
};

/**
 * Composition root: wires renderer, physics, world, player car, input,
 * camera and instrumentation together and drives them from the GameLoop.
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly perf = new PerformanceMonitor();
  readonly input = new InputManager();
  readonly followCamera: FollowCamera;
  readonly environment: Environment;
  readonly track: Track;
  readonly player: Vehicle;
  readonly loop: GameLoop;

  private readonly hud: HUD;
  private readonly debugRenderer: PhysicsDebugRenderer | null = null;
  private flippedTime = 0;
  /** Latched lap event from fixed steps, consumed by the next rendered frame. */
  private lapEvent: 'lap' | 'best' | null = null;
  readonly racingLine: RacingLine;
  readonly lapTimer: LapTimer;
  private readonly audio: AudioSystem | null = null;
  private carAudio: CarAudio | null = null;

  private constructor(
    private readonly container: HTMLElement,
    readonly config: SimConfig,
    readonly physics: PhysicsWorld,
    readonly car: CarDefinition,
    layout: TrackLayout,
  ) {
    // --- renderer -----------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ antialias: config.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, config.pixelRatio));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = config.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    // --- world --------------------------------------------------------
    this.environment = new Environment(this.scene, { shadows: config.shadows, shadowMapSize: config.shadowMapSize });
    this.track = new ProceduralTrack(physics, layout, { treesPerKm: config.treesPerKm, scenery: layout.scenery });
    this.scene.add(this.track.root);
    this.racingLine = new RacingLine(layout.raceline ?? layout.points, car.physics);
    this.scene.add(this.racingLine.mesh);
    this.lapTimer = new LapTimer(this.track.getCenterline().length, this.track.spawnIndex, `best:${car.id}:${layout.id}`);

    // --- player -------------------------------------------------------
    const visual = car.createVisual();
    this.player = new Vehicle(physics, car.physics, visual, this.track.getSpawnPose(), car.gearbox);
    this.scene.add(this.player.object3D);

    // --- input / camera / ui -----------------------------------------
    this.input.add(new KeyboardInput()).add(new GamepadInput());
    this.followCamera = new FollowCamera(container.clientWidth / container.clientHeight, {
      distance: car.physics.halfExtents.z * 2 + 2.6,
    });
    this.player.render(1);
    this.followCamera.snap(this.player.object3D);
    this.hud = new HUD(layout.name, layout.attribution);

    if (config.sound) {
      this.audio = new AudioSystem();
      this.audio.onReady((ctx, master) => (this.carAudio = new CarAudio(ctx, master, car.engine)));
    }

    if (config.physicsDebug) {
      this.debugRenderer = new PhysicsDebugRenderer(physics);
      this.scene.add(this.debugRenderer.lines);
    }

    this.loop = new GameLoop(
      {
        fixedUpdate: (dt) => this.fixedUpdate(dt),
        update: (dt, alpha) => this.update(dt, alpha),
        render: () => this.render(),
      },
      1 / config.physicsHz,
    );

    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
  }

  static async create(container: HTMLElement, config: SimConfig, car: CarDefinition, layout: TrackLayout): Promise<Game> {
    const physics = await PhysicsWorld.create(1 / config.physicsHz);
    return new Game(container, config, physics, car, layout);
  }

  start(): void {
    this.loop.start();
    // Stream heavy assets after the first frame: drive first, prettier a moment later.
    const base = import.meta.env.BASE_URL;
    applyTrackTextures(this.track.materials, this.renderer).catch((e) => console.warn('Track textures failed', e));
    this.environment.loadSky(`${base}hdri/sky_2k.hdr`, this.renderer).catch((e) => console.warn('HDRI sky failed', e));
  }

  /** Put the player back on the track centerline nearest to where it is. */
  resetPlayer(toSpawn = false): void {
    const pose = toSpawn ? this.track.getSpawnPose() : this.track.getResetPose(this.player.position);
    this.player.teleport(pose);
    if (toSpawn) this.lapTimer.invalidate();
    this.player.render(1);
    this.followCamera.snap(this.player.object3D);
    this.flippedTime = 0;
  }

  dispose(): void {
    this.loop.stop();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    this.carAudio?.dispose();
    this.audio?.dispose();
    this.input.dispose();
    this.player.dispose();
    this.track.dispose();
    this.racingLine.dispose();
    this.environment.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // --------------------------------------------------------------------

  private fixedUpdate(dt: number): void {
    this.perf.beginSection();

    const { input, actions } = this.input.poll();
    if (actions.includes('reset')) {
      this.resetPlayer();
      this.lapTimer.invalidate();
    }

    const surface = this.track.surfaceAt(this.player.position);
    const s = SURFACES[surface];
    this.player.physics.surfaceGrip = s.grip;
    this.player.physics.surfaceDrag = s.drag;
    this.player.fixedUpdate(input, dt);
    this.physics.step();
    this.player.snapshot();

    // Fell off the world?
    if (this.player.position.y < this.track.bounds.min.y - 10) this.resetPlayer(true);

    // Stuck on its roof / side?
    if (this.player.isFlipped() && this.player.physics.speed < 3) {
      this.flippedTime += dt;
      if (this.flippedTime > FLIP_RESET_DELAY) this.resetPlayer();
    } else {
      this.flippedTime = 0;
    }

    this.lapTimer.update(this.track.nearestIndex(this.player.position), dt);
    if (this.lapTimer.event) this.lapEvent = this.lapTimer.event;

    this.perf.endPhysics();
  }

  private update(frameDt: number, alpha: number): void {
    this.perf.beginFrame();
    this.player.render(alpha);
    const speedRatio = this.player.physics.forwardSpeed / this.player.config.maxSpeed;
    this.followCamera.update(this.player.object3D, speedRatio, frameDt);
    this.environment.update(this.player.object3D.position);
    this.racingLine.update(this.player.object3D.position, this.player.physics.forwardSpeed);
    this.debugRenderer?.update();
    this.hud.updateLaps(this.lapTimer, this.lapEvent);
    this.lapEvent = null;
    const gearbox = this.player.gearbox;
    this.hud.update(this.perf.snapshot, {
      speedKmh: this.player.speedKmh,
      gear: gearbox ? gearbox.label : '',
      rpmRatio: gearbox ? gearbox.rpmRatio : 0,
      input: this.input.activeSource,
    });
    if (this.carAudio && gearbox && this.audio?.running) {
      this.carAudio.update(
        {
          rpm: gearbox.rpm,
          rpmRatio: gearbox.rpmRatio,
          throttle: this.player.throttle,
          speed: this.player.physics.speed,
          slip: this.player.physics.maxSlip,
          shifting: gearbox.shiftTimer > 0,
        },
        frameDt,
      );
    }
  }

  private render(): void {
    this.perf.beginSection();
    this.renderer.render(this.scene, this.followCamera.camera);
    this.perf.endRender(this.renderer.info);
  }

  /** Esc: back to the start menu (keeps the current car/track preselected). */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') window.location.href = urlWith({ menu: '' });
    if (e.code === 'KeyL' && !e.repeat) this.racingLine.mesh.visible = !this.racingLine.mesh.visible;
  };

  private onResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.followCamera.setAspect(w / h);
  };
}
