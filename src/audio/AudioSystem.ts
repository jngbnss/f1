/**
 * Owns the AudioContext. Browsers only allow audio after a user gesture, so
 * the context is created on the first key press / click (or immediately if
 * the page already had one, e.g. the menu's Start click). M toggles mute.
 */
export class AudioSystem {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  muted = false;
  private readonly volume = 0.8;
  private readonly readyCallbacks: ((ctx: AudioContext, master: GainNode) => void)[] = [];

  constructor() {
    window.addEventListener('keydown', this.onGesture);
    window.addEventListener('pointerdown', this.onGesture);
    document.addEventListener('visibilitychange', this.onVisibility);
    if (navigator.userActivation?.hasBeenActive) this.init();
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Runs `cb` once audio is available (immediately if it already is). */
  onReady(cb: (ctx: AudioContext, master: GainNode) => void): void {
    if (this.ctx && this.master) cb(this.ctx, this.master);
    else this.readyCallbacks.push(cb);
  }

  toggleMute(): void {
    this.muted = !this.muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  dispose(): void {
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
    master.connect(compressor).connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    for (const cb of this.readyCallbacks.splice(0)) cb(ctx, master);
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
