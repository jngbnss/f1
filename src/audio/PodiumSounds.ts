/**
 * Podium ceremony sounds, synthesized (no recordings): the champagne cork's pop
 * and a crowd cheer that swells and fades (band-passed noise with a slow,
 * uneven swell, like a grandstand).
 */
export class PodiumSounds {
  private readonly noise: AudioBuffer;
  private readonly out: GainNode;

  constructor(
    private readonly ctx: AudioContext,
    master: GainNode,
  ) {
    // 3 s of noise, reused (looped) by every cheer.
    const n = Math.round(ctx.sampleRate * 3);
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    // Pinkish: a running average takes the hiss off.
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = last * 0.86 + (Math.random() * 2 - 1) * 0.14;
      d[i] = last * 3;
    }
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(master);
  }

  /** The cork: a sharp click of noise and a hollow thump. */
  pop(): void {
    const { ctx } = this;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2200;
    band.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1.4, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    src.connect(band).connect(g).connect(this.out);
    src.start(t, Math.random() * 2);
    src.stop(t + 0.1);
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(190, t);
    thump.frequency.exponentialRampToValueAtTime(70, t + 0.12);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.7, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    thump.connect(tg).connect(this.out);
    thump.start(t);
    thump.stop(t + 0.16);
  }

  /** Crowd cheer over `seconds`: swells in ~1 s, rolls a little, fades out. */
  cheer(seconds = 6, level = 0.5): void {
    const { ctx } = this;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 950;
    band.Q.value = 0.55;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 1.1);
    // Uneven roar: a few swells while it lasts.
    for (let s = 1.6; s < seconds - 1.5; s += 0.9 + Math.random() * 0.8) g.gain.linearRampToValueAtTime(level * (0.75 + Math.random() * 0.4), t + s);
    g.gain.linearRampToValueAtTime(level * 0.8, t + seconds - 1.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    // Whistles and shouts: the band wanders up and down a little.
    band.frequency.setValueAtTime(900, t);
    for (let s = 0.5; s < seconds; s += 0.35 + Math.random() * 0.4) band.frequency.linearRampToValueAtTime(800 + Math.random() * 700, t + s);
    src.connect(band).connect(low).connect(g).connect(this.out);
    src.start(t, Math.random() * 2);
    src.stop(t + seconds + 0.05);
  }

  dispose(): void {
    this.out.disconnect();
  }
}
