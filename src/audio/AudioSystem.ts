import { makeNoiseBuffer, makeReverbBuffer, type AudioAssets } from './EngineSound';

/**
 * Owns the AudioContext and shared audio assets (recorded engine loop,
 * reverb, noise). Browsers only allow audio after a user gesture, so
 * the context is created on the first key press / click (or immediately if
 * the page already had one, e.g. the menu's Start click). M toggles mute.
 */
/** Live game audio systems (normally one), for ducking under voice chat. */
const live = new Set<AudioSystem>();

/** Lowers game sound (engines, tyres) while a teammate talks on voice chat. */
export function duckGameAudio(on: boolean): void {
  for (const a of live) a.setDuck(on);
}

export class AudioSystem {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  muted = false;
  private readonly volume = 0.8;
  assets: AudioAssets | null = null;
  private duckNode: GainNode | null = null;
  private ducked = false;
  private readonly readyCallbacks: ((ctx: AudioContext, master: GainNode, assets: AudioAssets) => void)[] = [];

  constructor() {
    window.addEventListener('keydown', this.onGesture);
    window.addEventListener('pointerdown', this.onGesture);
    document.addEventListener('visibilitychange', this.onVisibility);
    if (navigator.userActivation?.hasBeenActive) this.init();
    live.add(this);
  }

  setDuck(on: boolean): void {
    this.ducked = on;
    if (this.duckNode && this.ctx) this.duckNode.gain.setTargetAtTime(on ? 0.45 : 1, this.ctx.currentTime, on ? 0.04 : 0.25);
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Runs `cb` once audio and its assets are available (immediately if they already are). */
  onReady(cb: (ctx: AudioContext, master: GainNode, assets: AudioAssets) => void): void {
    if (this.ctx && this.master && this.assets) cb(this.ctx, this.master, this.assets);
    else this.readyCallbacks.push(cb);
  }

  toggleMute(): void {
    this.muted = !this.muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  dispose(): void {
    live.delete(this);
    window.removeEventListener('keydown', this.onGesture);
    window.removeEventListener('pointerdown', this.onGesture);
    document.removeEventListener('visibilitychange', this.onVisibility);
    void this.ctx?.close();
  }

  private init(): void {
    if (this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    // Light compression keeps engine + skid + wind from clipping.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.ratio.value = 4;
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.volume;
    const duck = (this.duckNode = ctx.createGain());
    duck.gain.value = this.ducked ? 0.45 : 1;
    master.connect(duck).connect(compressor).connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;

    const reverb = new ConvolverNode(ctx, { buffer: makeReverbBuffer(ctx) });
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    reverb.connect(wet).connect(master);
    const noise = makeNoiseBuffer(ctx);
    void this.loadBuffer(`${import.meta.env.BASE_URL}audio/engine_loop.wav`).then((engineLoop) => {
      this.assets = { engineLoop, reverb, noise };
      for (const cb of this.readyCallbacks.splice(0)) cb(ctx, master, this.assets);
    });
  }

  private async loadBuffer(url: string): Promise<AudioBuffer | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      return await this.ctx!.decodeAudioData(await res.arrayBuffer());
    } catch (e) {
      console.warn('Engine sample unavailable, using synth only', e);
      return null;
    }
  }

  private onGesture = (e: Event): void => {
    if (e instanceof KeyboardEvent && e.code === 'KeyM' && !e.repeat) this.toggleMute();
    if (!this.ctx) this.init();
    else if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume();
  };

  /** Silence (and save CPU) while the tab is in the background. */
  private onVisibility = (): void => {
    if (!this.ctx) return;
    if (document.hidden) void this.ctx.suspend();
    else void this.ctx.resume();
  };
}
