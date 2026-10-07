import * as THREE from 'three';
import { FollowCamera } from '../camera/FollowCamera';
import type { SimConfig } from '../config';
import { GamepadInput } from '../input/GamepadInput';
import { InputManager } from '../input/InputManager';
import { KeyboardInput } from '../input/KeyboardInput';
import { PerformanceMonitor } from '../performance/PerformanceMonitor';
import { PhysicsDebugRenderer } from '../physics/PhysicsDebugRenderer';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { HUD } from '../ui/HUD';
import { Vehicle } from '../vehicle/Vehicle';
import { DEFAULT_CAR } from '../vehicle/VehicleConfig';
import { ProceduralCarVisual } from '../vehicle/VehicleVisual';
import { Environment } from '../world/Environment';
import { ProceduralTrack, type Track } from '../world/Track';
import { DEMO_TRACK } from '../world/TrackLayout';
import { GameLoop } from './GameLoop';

/** Seconds a car may stay flipped before it is put back on its wheels. */
const FLIP_RESET_DELAY = 2.5;

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

  private constructor(
    private readonly container: HTMLElement,
    readonly config: SimConfig,
    readonly physics: PhysicsWorld,
  ) {
    // --- renderer -----------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ antialias: config.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, config.pixelRatio));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = config.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    // --- world --------------------------------------------------------
    this.environment = new Environment(this.scene, { shadows: config.shadows, shadowMapSize: config.shadowMapSize });
    this.track = new ProceduralTrack(physics, DEMO_TRACK, { treeCount: config.trees });
    this.scene.add(this.track.root);

    // --- player -------------------------------------------------------
    const visual = new ProceduralCarVisual(DEFAULT_CAR);
    this.player = new Vehicle(physics, DEFAULT_CAR, visual, this.track.getSpawnPose());
    this.scene.add(this.player.object3D);

    // --- input / camera / ui -----------------------------------------
    this.input.add(new KeyboardInput()).add(new GamepadInput());
    this.followCamera = new FollowCamera(container.clientWidth / container.clientHeight);
    this.player.render(1);
    this.followCamera.snap(this.player.object3D);
    this.hud = new HUD();

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
  }

  static async create(container: HTMLElement, config: SimConfig): Promise<Game> {
    const physics = await PhysicsWorld.create(1 / config.physicsHz);
    return new Game(container, config, physics);
  }

  start(): void {
    this.loop.start();
  }

  /** Put the player back on the track centerline nearest to where it is. */
  resetPlayer(toSpawn = false): void {
    const pose = toSpawn ? this.track.getSpawnPose() : this.track.getResetPose(this.player.position);
    this.player.teleport(pose);
    this.player.render(1);
    this.followCamera.snap(this.player.object3D);
    this.flippedTime = 0;
  }

  dispose(): void {
    this.loop.stop();
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.player.dispose();
    this.track.dispose();
    this.environment.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // --------------------------------------------------------------------

  private fixedUpdate(dt: number): void {
    this.perf.beginSection();

    const { input, actions } = this.input.poll();
    if (actions.includes('reset')) this.resetPlayer();

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

    this.perf.endPhysics();
  }

  private update(frameDt: number, alpha: number): void {
    this.perf.beginFrame();
    this.player.render(alpha);
    const speedRatio = this.player.physics.forwardSpeed / this.player.config.maxSpeed;
    this.followCamera.update(this.player.object3D, speedRatio, frameDt);
    this.environment.update(this.player.object3D.position);
    this.debugRenderer?.update();
    this.hud.update(this.perf.snapshot, {
      speedKmh: this.player.speedKmh,
      input: this.input.activeSource,
    });
  }

  private render(): void {
    this.perf.beginSection();
    this.renderer.render(this.scene, this.followCamera.camera);
    this.perf.endRender(this.renderer.info);
  }

  private onResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.followCamera.setAspect(w / h);
  };
}
