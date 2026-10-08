import type * as THREE from 'three';

export interface PerfSnapshot {
  fps: number;
  /** Average / worst frame interval (ms) over the last window. */
  frameTimeAvg: number;
  frameTimeMax: number;
  /** CPU time spent in physics steps / render() per frame (ms, averaged). */
  physicsMs: number;
  renderMs: number;
  /** Physics steps per rendered frame (fixed timestep). */
  stepsPerFrame: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  /** JS heap in MB (Chromium only; null elsewhere). */
  heapMB: number | null;
  /** Increments every time a new snapshot is published. */
  windowId: number;
  /** Current renderer pixel ratio (dynamic resolution). */
  pixelRatio: number;
}

interface ChromeMemory {
  usedJSHeapSize: number;
}

/**
 * Collects per-frame timings and renderer stats and publishes an averaged
 * snapshot every `windowMs`. Kept free of DOM code so it can also feed
 * automated benchmarks (see window.sim.perf in dev builds).
 */
export class PerformanceMonitor {
  snapshot: PerfSnapshot = {
    fps: 0,
    frameTimeAvg: 0,
    frameTimeMax: 0,
    physicsMs: 0,
    renderMs: 0,
    stepsPerFrame: 0,
    drawCalls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    heapMB: null,
    windowId: 0,
    pixelRatio: 1,
  };

  /** CPU ms accumulated since the consumer last zeroed it (benchmarks read it once per frame). */
  readonly frame = { physicsMs: 0, renderMs: 0 };

  /** Ring buffer of recent frame times (ms), for graphs / export. */
  readonly history: Float32Array;
  private historyIndex = 0;

  private lastFrame = 0;
  private windowStart = 0;
  private frames = 0;
  private frameTimeSum = 0;
  private frameTimeMax = 0;
  private physicsSum = 0;
  private renderSum = 0;
  private steps = 0;
  private sectionStart = 0;

  constructor(
    private readonly windowMs = 500,
    historySize = 300,
  ) {
    this.history = new Float32Array(historySize);
  }

  /** Call at the top of every rendered frame. */
  beginFrame(now = performance.now()): void {
    if (this.lastFrame > 0) {
      const dt = now - this.lastFrame;
      this.frames++;
      this.frameTimeSum += dt;
      if (dt > this.frameTimeMax) this.frameTimeMax = dt;
      this.history[this.historyIndex] = dt;
      this.historyIndex = (this.historyIndex + 1) % this.history.length;
    } else {
      this.windowStart = now;
    }
    this.lastFrame = now;

    if (now - this.windowStart >= this.windowMs && this.frames > 0) this.publish(now);
  }

  beginSection(): void {
    this.sectionStart = performance.now();
  }

  endPhysics(): void {
    const ms = performance.now() - this.sectionStart;
    this.physicsSum += ms;
    this.frame.physicsMs += ms;
    this.steps++;
  }

  endRender(info: THREE.WebGLInfo): void {
    const ms = performance.now() - this.sectionStart;
    this.renderSum += ms;
    this.frame.renderMs += ms;
    const s = this.snapshot;
    s.drawCalls = info.render.calls;
    s.triangles = info.render.triangles;
    s.geometries = info.memory.geometries;
    s.textures = info.memory.textures;
  }

  private publish(now: number): void {
    const s = this.snapshot;
    const elapsed = now - this.windowStart;
    s.fps = (this.frames * 1000) / elapsed;
    s.frameTimeAvg = this.frameTimeSum / this.frames;
    s.frameTimeMax = this.frameTimeMax;
    s.physicsMs = this.physicsSum / this.frames;
    s.renderMs = this.renderSum / this.frames;
    s.stepsPerFrame = this.steps / this.frames;
    const mem = (performance as Performance & { memory?: ChromeMemory }).memory;
    s.heapMB = mem ? mem.usedJSHeapSize / 1048576 : null;
    s.windowId++;

    this.windowStart = now;
    this.frames = 0;
    this.frameTimeSum = 0;
    this.frameTimeMax = 0;
    this.physicsSum = 0;
    this.renderSum = 0;
    this.steps = 0;
  }
}
