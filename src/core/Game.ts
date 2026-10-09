import * as THREE from 'three';
import { FollowCamera } from '../camera/FollowCamera';
import { CarAudio, EngineVoice } from '../audio/EngineSound';
import { AudioSystem } from '../audio/AudioSystem';
import { urlWith, type SimConfig } from '../config';
import { GamepadInput } from '../input/GamepadInput';
import { InputManager } from '../input/InputManager';
import { KeyboardInput } from '../input/KeyboardInput';
import { Benchmark } from '../performance/Benchmark';
import { DynamicResolution } from '../performance/DynamicResolution';
import { PerformanceMonitor } from '../performance/PerformanceMonitor';
import { PhysicsDebugRenderer } from '../physics/PhysicsDebugRenderer';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { HUD } from '../ui/HUD';
import { Minimap } from '../ui/Minimap';
import { Vehicle } from '../vehicle/Vehicle';
import { opponentsFor, type CarDefinition } from '../vehicle/cars';
import { AIDriver } from '../race/AIDriver';
import { LapTimer } from '../race/LapTimer';
import { RaceManager, type Racer } from '../race/RaceManager';
import type { VehicleInput } from '../input/VehicleInput';
import { Environment } from '../world/Environment';
import { RacingLine } from '../world/RacingLine';
import { racingLineFor } from '../world/RacingLineOptimizer';
import { applyTerrainImagery, buildTerrain } from '../world/Terrain';
import { applySatelliteTint, drapeOnGround, groundField, loadRealTerrain, loadSatellite, REAL_TERRAIN_CREDIT, trackMask, type Ground, type RealTerrain } from '../world/RealTerrain';
import { themeFor, type WorldTheme } from '../world/themes';
import { applyTrackTextures } from '../world/TrackTextures';
import { ProceduralTrack, type Surface, type Track } from '../world/Track';
import type { TrackLayout } from '../world/TrackLayout';
import { GameLoop } from './GameLoop';
import { F1_MODEL_CREDIT, f1ModelReady, GltfF1Visual, loadF1Model } from '../vehicle/cars/GltfF1Visual';

/** Player's dot on the minimap. */
const PLAYER_DOT = 0xffd23f;

/** Input used while cars wait on the grid. */
const HOLD: VehicleInput = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };

/** Seconds a car may stay flipped before it is put back on its wheels. */
const FLIP_RESET_DELAY = 2.5;
/** Seconds a car may be outside the barriers before it is put back on track. */
const OUT_OF_BOUNDS_DELAY = 0.5;

/** Arcade surface model: grip multiplier and extra deceleration (m/s²). */
const SURFACES: Record<Surface, { grip: number; drag: number }> = {
  asphalt: { grip: 1, drag: 0 },
  kerb: { grip: 0.95, drag: 0.3 },
  // Grass: tyres slide (low μ) but little rolling drag — you skate across it.
  grass: { grip: 0.32, drag: 1.2 },
  // Gravel: loose and deep — little grip and it bogs the car down.
  gravel: { grip: 0.4, drag: 6.5 },
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
  /** Every car on track (player first). */
  readonly vehicles: Vehicle[] = [];
  readonly race: RaceManager | null = null;
  private readonly aiFlipTime = new Map<Vehicle, number>();
  readonly loop: GameLoop;

  private readonly hud: HUD;
  private readonly debugRenderer: PhysicsDebugRenderer | null = null;
  private flippedTime = 0;
  private outTime = 0;
  /** Real ground around the track (null = procedural backdrop). */
  private ground: Ground | null = null;
  private readonly aiOutTime = new Map<Vehicle, number>();
  private readonly dynamicResolution: DynamicResolution | null;
  /** Latched lap event from fixed steps, consumed by the next rendered frame. */
  private lapEvent: 'lap' | 'best' | null = null;
  readonly racingLine: RacingLine;
  readonly lapTimer: LapTimer;
  private readonly audio: AudioSystem | null = null;
  private carAudio: CarAudio | null = null;
  /** 3D engine sounds of the opponents. */
  private readonly voices = new Map<Vehicle, EngineVoice>();
  private readonly _camDir = new THREE.Vector3();
  /** Car model of each opponent (engine sound, name). */
  private readonly carOf = new Map<Vehicle, CarDefinition>();
  /** Speed profiles per car model (the player's one is also the visible line). */
  private readonly rivalLines = new Map<string, RacingLine>();
  /** Benchmark mode: the player's car is driven by an AI and frames are recorded. */
  private readonly autopilot: AIDriver | null = null;
  private readonly bench: Benchmark | null = null;
  readonly theme: WorldTheme;
  private readonly terrain: THREE.Mesh;
  private readonly minimap: Minimap;

  private constructor(
    private readonly container: HTMLElement,
    readonly config: SimConfig,
    readonly physics: PhysicsWorld,
    readonly car: CarDefinition,
    layout: TrackLayout,
    private readonly realTerrain: RealTerrain | null = null,
  ) {
    // --- renderer -----------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ antialias: config.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, config.pixelRatio));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = config.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const theme = themeFor(layout.id, config.theme);
    // Real hills on the horizon are worth seeing: clearer air than the procedural backdrop needs.
    this.theme = realTerrain ? { ...theme, fogDensity: theme.fogDensity * 0.55 } : theme;
    this.renderer.toneMappingExposure = this.theme.exposure;
    container.appendChild(this.renderer.domElement);
    this.dynamicResolution = config.dynamicResolution
      ? new DynamicResolution(this.renderer, Math.min(window.devicePixelRatio, config.pixelRatio))
      : null;

    // --- world --------------------------------------------------------
    this.environment = new Environment(this.scene, { shadows: config.shadows, shadowMapSize: config.shadowMapSize, theme: this.theme });
    this.track = new ProceduralTrack(physics, layout, { treesPerKm: config.treesPerKm, scenery: layout.scenery });
    this.scene.add(this.track.root);
    // Real relief: the landscape, the grass plane and the OSM scenery follow the
    // DEM relative to the nearby track height (the track itself stays flat).
    const ground = realTerrain ? groundField(realTerrain, this.track.getCenterline()) : null;
    this.ground = ground;
    if (ground) {
      for (const name of ['Grass', 'OsmScenery']) {
        const o = this.track.root.getObjectByName(name);
        if (o) drapeOnGround(o, ground.height);
      }
    }
    this.terrain = buildTerrain(this.track.bounds, this.theme.terrain, 7, realTerrain, ground ? ground.height : null);
    this.scene.add(this.terrain);
    // Racing line computed on the game's own (widened) road, not the real-width dataset line.
    this.racingLine = new RacingLine(racingLineFor(this.track), car.physics);
    this.scene.add(this.racingLine.mesh);
    this.lapTimer = new LapTimer(this.track.getCenterline().length, this.track.spawnIndex, `best:${car.id}:${layout.id}`);

    // --- player + opponents ----------------------------------------------
    const opponents = Math.max(0, Math.min(19, Math.round(config.ai)));
    const total = opponents + 1;
    // Player starts mid-field; with no opponents it's a free practice session.
    const playerSlot = Math.floor(total / 2);
    const playerPose = opponents > 0 ? this.track.gridPose(playerSlot) : this.track.getSpawnPose();
    this.player = new Vehicle(physics, car.physics, car.createVisual(), playerPose, car.gearbox);
    this.scene.add(this.player.object3D);
    this.vehicles.push(this.player);

    if (opponents > 0) {
      const racers: Racer[] = [];
      // Same-class rivals closest in performance; quicker cars start further up.
      const rivals = opponentsFor(car, opponents).sort((a, b) => b.stats.pi - a.stats.pi);
      // Each distinct rival car gets its own speed profile on the shared racing line.
      const lines = this.rivalLines;
      lines.set(car.id, this.racingLine);
      let rivalIndex = 0;
      for (let slot = 0; slot < total; slot++) {
        if (slot === playerSlot) {
          racers.push(this.racer('YOU', this.player, null, true, 0xffffff));
          continue;
        }
        const def = rivals[rivalIndex++];
        // Teammates share their team's livery.
        const vehicle = new Vehicle(physics, def.physics, def.createVisual(), this.track.gridPose(slot), def.gearbox);
        this.scene.add(vehicle.object3D);
        this.vehicles.push(vehicle);
        this.carOf.set(vehicle, def);
        let line = lines.get(def.id);
        if (!line) lines.set(def.id, (line = new RacingLine(this.racingLine.path, def.physics)));
        // Front of the grid = faster drivers, with some randomness.
        const r = Math.sin(slot * 12.9898) * 43758.5453;
        const rand = r - Math.floor(r);
        const ai = new AIDriver(vehicle, line, this.track, {
          pace: 0.97 - (slot / total) * 0.07 + (rand - 0.5) * 0.04,
          lane: (rand - 0.5) * 2.4,
          aggression: rand,
        });
        racers.push(this.racer(def.spec.brand, vehicle, ai, false, def.spec.color));
      }
      this.race = new RaceManager(this.track, racers, Math.max(1, Math.round(config.laps)));
    }

    // Surface is sampled under each wheel (two wheels on the grass pull the car around).
    const probe = new THREE.Vector3();
    const surfaceAt = (x: number, z: number) => SURFACES[this.track.surfaceAt(probe.set(x, 0, z))];
    for (const v of this.vehicles) v.physics.surfaceAt = surfaceAt;

    if (config.bench > 0) {
      this.autopilot = new AIDriver(this.player, this.racingLine, this.track, { pace: 0.95, lane: 0, aggression: 0.5 });
      this.bench = new Benchmark(config.bench, {
        track: layout.id,
        car: car.id,
        cars: this.vehicles.length,
        renderer: this.renderer,
        queue: config.benchQueue,
        nextUrl: (track, queue) => urlWith({ track, benchq: queue.length ? queue.join(',') : null, benchi: '1' }),
      });
    }

    // --- input / camera / ui -----------------------------------------
    this.input.add(new KeyboardInput()).add(new GamepadInput());
    this.followCamera = new FollowCamera(container.clientWidth / container.clientHeight, {
      distance: car.physics.halfExtents.z * 2 + 2.6,
    });
    this.player.render(1);
    this.followCamera.snap(this.player.object3D);
    const credits = [
      layout.attribution,
      realTerrain ? REAL_TERRAIN_CREDIT : '',
      f1ModelReady() && this.vehicles.some((v) => v.visual instanceof GltfF1Visual) ? F1_MODEL_CREDIT : '',
    ];
    this.hud = new HUD(layout.name, credits.filter(Boolean).join(' · '));
    this.minimap = new Minimap(this.track.getCenterline());

    if (config.sound) {
      this.audio = new AudioSystem();
      this.audio.onReady((ctx, master, assets) => {
        this.carAudio = new CarAudio(ctx, master, car.engine, assets);
        if (assets.engineLoop) {
          for (const v of this.vehicles) {
            if (v !== this.player) this.voices.set(v, new EngineVoice(ctx, master, (this.carOf.get(v) ?? car).engine, assets.engineLoop));
          }
        }
      });
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
    const base = import.meta.env.BASE_URL;
    const [physics, realTerrain] = await Promise.all([
      PhysicsWorld.create(1 / config.physicsHz),
      // Real heights for the landscape (imagery streams in after the start).
      loadRealTerrain(base, layout.id),
      // Real F1 bodies; primitives if the model fails.
      car.cls === 'formula' ? loadF1Model(base).catch((e) => console.warn('F1 model failed', e)) : null,
    ]);
    return new Game(container, config, physics, car, layout, realTerrain);
  }

  start(): void {
    this.loop.start();
    // Stream heavy assets after the first frame: drive first, prettier a moment later.
    const base = import.meta.env.BASE_URL;
    const textures = applyTrackTextures(this.track.materials, this.renderer, this.theme.grassTint);
    textures.catch((e) => console.warn('Track textures failed', e));
    const real = this.realTerrain;
    if (real) {
      // Satellite colors: landscape texture + tint of the grass around the track.
      loadSatellite(base, real, 'far', this.renderer)
        .then((tex) => applyTerrainImagery(this.terrain, tex))
        .catch((e) => console.warn('Terrain imagery failed', e));
      Promise.all([loadSatellite(base, real, 'near', this.renderer), textures])
        .then(([tex]) => applySatelliteTint(this.track.materials.grass, tex, trackMask(real, this.ground!), real))
        .catch((e) => console.warn('Ground imagery failed', e));
    }
    this.environment.loadSky(base, this.renderer).catch((e) => console.warn('HDRI sky failed', e));
  }

  /** Put the player back on the track centerline nearest to where it is. */
  resetPlayer(toSpawn = false): void {
    const pose = toSpawn ? this.track.getSpawnPose() : this.track.getResetPose(this.player.position);
    this.player.teleport(pose);
    if (toSpawn) this.lapTimer.invalidate();
    this.player.render(1);
    this.followCamera.snap(this.player.object3D);
    this.flippedTime = 0;
    this.outTime = 0;
    const me = this.race?.player;
    if (me) this.race!.resync(me);
  }

  private _minimapCars: { position: THREE.Vector3; color: number; isPlayer: boolean }[] | null = null;

  /** Minimap entries (built once; positions are live references). */
  private get minimapCars() {
    if (!this._minimapCars) {
      this._minimapCars = this.race
        ? this.race.racers.map((r) => ({ position: r.vehicle.position, color: r.isPlayer ? PLAYER_DOT : r.color, isPlayer: r.isPlayer }))
        : [{ position: this.player.position, color: PLAYER_DOT, isPlayer: true }];
    }
    return this._minimapCars;
  }

  private racer(name: string, vehicle: Vehicle, ai: AIDriver | null, isPlayer: boolean, color: number): Racer {
    return { name, vehicle, ai, isPlayer, progress: 0, lastIndex: 0, finished: false, finishTime: 0, color };
  }

  /** AI cars that are flipped, off the world or hopelessly stuck go back on track. */
  private recoverAI(dt: number): void {
    for (const r of this.race!.racers) {
      if (!r.ai) continue;
      const v = r.vehicle;
      let flip = this.aiFlipTime.get(v) ?? 0;
      flip = v.isFlipped() && v.physics.speed < 3 ? flip + dt : 0;
      this.aiFlipTime.set(v, flip);
      const out = this.track.isOutOfBounds(v.position) ? (this.aiOutTime.get(v) ?? 0) + dt : 0;
      this.aiOutTime.set(v, out);
      if (flip > FLIP_RESET_DELAY || out > OUT_OF_BOUNDS_DELAY || v.position.y < this.track.bounds.min.y - 10 || r.ai.unstuckCount >= 3) {
        v.teleport(this.track.getResetPose(v.position));
        r.ai.resetState();
        r.ai.unstuckCount = 0;
        this.aiFlipTime.set(v, 0);
        this.aiOutTime.set(v, 0);
        this.race!.resync(r);
      }
    }
  }

  dispose(): void {
    this.loop.stop();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    this.carAudio?.dispose();
    for (const voice of this.voices.values()) voice.dispose();
    this.audio?.dispose();
    this.input.dispose();
    for (const v of this.vehicles) v.dispose();
    this.track.dispose();
    for (const line of this.rivalLines.values()) if (line !== this.racingLine) line.dispose();
    this.racingLine.dispose();
    this.environment.dispose();
    this.terrain.removeFromParent();
    this.terrain.geometry.dispose();
    (this.terrain.material as THREE.Material).dispose();
    this.minimap.dispose();
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

    const frozen = this.race?.frozen ?? false;
    const playerInput = this.autopilot ? this.autopilot.update(dt, this.vehicles) : input;
    this.player.fixedUpdate(frozen ? HOLD : playerInput, dt);
    if (this.race) {
      for (const r of this.race.racers) {
        if (!r.ai) continue;
        r.vehicle.fixedUpdate(frozen ? HOLD : r.ai.update(dt, this.vehicles), dt);
      }
    }
    this.physics.step();
    for (const v of this.vehicles) v.snapshot();
    if (this.race) {
      this.recoverAI(dt);
      this.race.update(dt);
    }

    // Fell off the world?
    if (this.player.position.y < this.track.bounds.min.y - 10) this.resetPlayer(true);

    // Escaped over or through the barriers? Back on track, lap invalid.
    this.outTime = this.track.isOutOfBounds(this.player.position) ? this.outTime + dt : 0;
    if (this.outTime > OUT_OF_BOUNDS_DELAY) {
      this.resetPlayer();
      this.lapTimer.invalidate();
    }

    if (this.autopilot && this.autopilot.unstuckCount >= 3) {
      this.resetPlayer();
      this.autopilot.resetState();
      this.autopilot.unstuckCount = 0;
    }

    // Stuck on its roof / side?
    if (this.player.isFlipped() && this.player.physics.speed < 3) {
      this.flippedTime += dt;
      if (this.flippedTime > FLIP_RESET_DELAY) this.resetPlayer();
    } else {
      this.flippedTime = 0;
    }

    if (!frozen) this.lapTimer.update(this.track.nearestIndex(this.player.position), dt);
    if (this.lapTimer.event) this.lapEvent = this.lapTimer.event;

    this.perf.endPhysics();
  }

  private update(frameDt: number, alpha: number): void {
    this.perf.beginFrame();
    this.dynamicResolution?.update(this.perf.snapshot);
    this.perf.snapshot.pixelRatio = this.renderer.getPixelRatio();
    for (const v of this.vehicles) v.render(alpha);
    // Car LOD: beyond ~70 m wheel rims and brake discs are a few pixels; hide them.
    const cam = this.followCamera.camera.position;
    for (const v of this.vehicles) v.visual.setDetail?.(v.object3D.position.distanceToSquared(cam) < 70 * 70);
    const speedRatio = this.player.physics.forwardSpeed / this.player.config.maxSpeed;
    this.followCamera.update(this.player.object3D, speedRatio, frameDt);
    this.environment.update(this.player.object3D.position);
    this.track.update(performance.now() / 1000, this.followCamera.camera.position);
    this.minimap.update(this.minimapCars);
    this.racingLine.update(this.player.object3D.position, this.player.physics.forwardSpeed);
    this.debugRenderer?.update();
    this.hud.updateLaps(this.lapTimer, this.lapEvent);
    if (this.race) this.hud.updateRace(this.race);
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
          rpmRatio: gearbox.rpmRatio,
          throttle: this.player.throttle,
          speed: this.player.physics.speed,
          slip: this.player.physics.maxSlip,
          shifting: gearbox.shiftTimer > 0,
        },
        frameDt,
      );
      this.updateVoices();
    }
  }

  /** Listener = camera; opponents' engines are positioned in 3D. */
  private updateVoices(): void {
    const ctx = this.audio?.ctx;
    if (!ctx || this.voices.size === 0) return;
    const cam = this.followCamera.camera;
    const l = ctx.listener;
    cam.getWorldDirection(this._camDir);
    if (l.positionX) {
      l.positionX.value = cam.position.x;
      l.positionY.value = cam.position.y;
      l.positionZ.value = cam.position.z;
      l.forwardX.value = this._camDir.x;
      l.forwardY.value = this._camDir.y;
      l.forwardZ.value = this._camDir.z;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    }
    for (const [v, voice] of this.voices) {
      const p = v.object3D.position;
      voice.update(p.x, p.y, p.z, v.gearbox?.rpmRatio ?? 0.3, v.throttle);
    }
  }

  private render(): void {
    this.perf.beginSection();
    this.renderer.render(this.scene, this.followCamera.camera);
    this.perf.endRender(this.renderer.info);
    if (this.bench) {
      this.bench.frame(!(this.race?.frozen ?? false), this.perf.frame, this.renderer.info);
      this.perf.frame.physicsMs = 0;
      this.perf.frame.renderMs = 0;
    }
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
