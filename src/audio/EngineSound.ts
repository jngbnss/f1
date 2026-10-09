/**
 * Car audio (Web Audio API):
 *  - engine = a real recorded engine loop (CC0, see public/audio/CREDITS.md)
 *    pitched by RPM, layered with a synthesized low "body" (sub-octave
 *    oscillators + combustion noise), shaped by EQ (bass up, harsh highs
 *    down), soft saturation and a reverb send for size
 *  - tyre squeal: band-passed noise driven by lateral slip
 *  - wind: low-passed noise driven by speed
 * Other cars use the cheaper `EngineVoice` (loop only, 3D-panned).
 */

export interface EngineVoiceSpec {
  type: OscillatorType;
  /** Frequency multiplier relative to the firing frequency. */
  mult: number;
  gain: number;
}

export interface EngineSoundProfile {
  /** Perceived firing frequency (Hz) at idle and at redline. */
  idleHz: number;
  redlineHz: number;
  /** Mix of the recorded loop vs. the synthesized body. */
  sampleGain: number;
  synthGain: number;
  voices: EngineVoiceSpec[];
  /** Combustion noise amount. */
  noise: number;
  /** Waveshaper drive (0 = clean). */
  distortion: number;
  /** Low-pass cutoff (Hz) off-throttle at idle / on-throttle at redline. */
  filterMin: number;
  filterMax: number;
  volume: number;
}

export interface CarAudioState {
  rpmRatio: number;
  throttle: number;
  /** m/s */
  speed: number;
  /** Max lateral slip over grounded wheels (m/s). */
  slip: number;
  /** True while changing gear. */
  shifting: boolean;
}

export interface AudioAssets {
  /** Recorded engine loop (null if it failed to load: synth only). */
  engineLoop: AudioBuffer | null;
  /** Shared reverb send. */
  reverb: AudioNode;
  noise: AudioBuffer;
}

/** Firing frequency of the recorded loop at playbackRate 1 (measured: 43 Hz + harmonics). */
export const LOOP_BASE_HZ = 43;

const SMOOTH = 0.03; // s, parameter smoothing
/** Overall engine loudness (players found it too loud next to the rest of the mix). */
const ENGINE_LEVEL = 0.7;

function softClipCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + drive) * x) / (1 + drive * Math.abs(x));
  }
  return curve;
}

export function makeNoiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Synthetic room/stadium impulse response (decaying stereo noise). */
export function makeReverbBuffer(ctx: BaseAudioContext, seconds = 1.6, decay = 3): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buffer;
}

function firingHz(p: EngineSoundProfile, rpmRatio: number): number {
  const r = Math.min(Math.max(rpmRatio, 0), 1.05);
  return p.idleHz + (p.redlineHz - p.idleHz) * Math.pow(r, 0.9);
}

/** The player's car: full engine model + skid + wind. */
export class CarAudio {
  private readonly oscillators: { node: OscillatorNode; voice: EngineVoiceSpec }[] = [];
  private readonly loop: AudioBufferSourceNode | null = null;
  private readonly noise: AudioBufferSourceNode;
  private readonly combustionFilter: BiquadFilterNode;
  private readonly combustionGain: GainNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly engineGain: GainNode;
  private readonly skidGain: GainNode;
  private readonly windGain: GainNode;
  private readonly nodes: AudioNode[] = [];
  private load = 0;

  constructor(
    private readonly ctx: AudioContext,
    output: AudioNode,
    private readonly profile: EngineSoundProfile,
    assets: AudioAssets,
  ) {
    const bus = this.keep(ctx.createGain()); // pre-EQ engine mix

    // Recorded loop
    if (assets.engineLoop) {
      const loop = this.keep(ctx.createBufferSource());
      loop.buffer = assets.engineLoop;
      loop.loop = true;
      const g = this.keep(ctx.createGain());
      g.gain.value = profile.sampleGain;
      loop.connect(g).connect(bus);
      this.loop = loop;
    }

    // Synth body (through saturation)
    const synth = this.keep(ctx.createGain());
    synth.gain.value = assets.engineLoop ? profile.synthGain : 1;
    for (const voice of profile.voices) {
      const osc = this.keep(ctx.createOscillator());
      osc.type = voice.type;
      const g = this.keep(ctx.createGain());
      g.gain.value = voice.gain;
      osc.connect(g).connect(synth);
      this.oscillators.push({ node: osc, voice });
    }
    this.noise = this.keep(ctx.createBufferSource());
    this.noise.buffer = assets.noise;
    this.noise.loop = true;
    this.combustionFilter = this.keep(ctx.createBiquadFilter());
    this.combustionFilter.type = 'bandpass';
    this.combustionFilter.Q.value = 1.2;
    this.combustionGain = this.keep(ctx.createGain());
    this.noise.connect(this.combustionFilter).connect(this.combustionGain).connect(synth);
    const shaper = this.keep(ctx.createWaveShaper());
    shaper.curve = softClipCurve(profile.distortion);
    shaper.oversample = '2x';
    synth.connect(shaper).connect(bus);

    // Tone: load-dependent low-pass, bass up, harsh highs down (no "mosquito").
    this.lowpass = this.keep(ctx.createBiquadFilter());
    this.lowpass.type = 'lowpass';
    this.lowpass.Q.value = 0.7;
    const bass = this.keep(ctx.createBiquadFilter());
    bass.type = 'lowshelf';
    bass.frequency.value = 160;
    bass.gain.value = 7;
    const presence = this.keep(ctx.createBiquadFilter());
    presence.type = 'peaking';
    presence.frequency.value = 2600;
    presence.Q.value = 0.8;
    presence.gain.value = -6;
    this.engineGain = this.keep(ctx.createGain());
    this.engineGain.gain.value = 0;
    bus.connect(this.lowpass).connect(bass).connect(presence).connect(this.engineGain);
    this.engineGain.connect(output);
    const send = this.keep(ctx.createGain());
    send.gain.value = 0.35;
    this.engineGain.connect(send).connect(assets.reverb);

    // Tyre squeal
    const skidFilter = this.keep(ctx.createBiquadFilter());
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 1100;
    skidFilter.Q.value = 4;
    this.skidGain = this.keep(ctx.createGain());
    this.skidGain.gain.value = 0;
    this.noise.connect(skidFilter).connect(this.skidGain).connect(output);

    // Wind
    const windFilter = this.keep(ctx.createBiquadFilter());
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 450;
    this.windGain = this.keep(ctx.createGain());
    this.windGain.gain.value = 0;
    this.noise.connect(windFilter).connect(this.windGain).connect(output);

    for (const { node } of this.oscillators) node.start();
    this.loop?.start();
    this.noise.start();
  }

  update(s: CarAudioState, dt: number): void {
    const p = this.profile;
    const t = this.ctx.currentTime;

    // Engine load follows the throttle with a little lag (less robotic).
    this.load += (s.throttle - this.load) * (1 - Math.exp(-10 * dt));

    const f = firingHz(p, s.rpmRatio);
    const wobble = 1 + (Math.random() - 0.5) * 0.006; // combustion irregularity
    this.loop?.playbackRate.setTargetAtTime((f / LOOP_BASE_HZ) * wobble, t, SMOOTH);
    for (const { node, voice } of this.oscillators) node.frequency.setTargetAtTime(f * voice.mult * wobble, t, SMOOTH);
    this.combustionFilter.frequency.setTargetAtTime(f * 2, t, SMOOTH);
    this.combustionGain.gain.setTargetAtTime(p.noise * (0.3 + 0.7 * this.load), t, SMOOTH);

    const r = Math.min(Math.max(s.rpmRatio, 0), 1);
    const cutoff = p.filterMin + (p.filterMax - p.filterMin) * (0.25 * r + 0.75 * r * this.load);
    this.lowpass.frequency.setTargetAtTime(cutoff, t, SMOOTH);

    let volume = ENGINE_LEVEL * p.volume * (0.4 + 0.6 * this.load) * (0.7 + 0.3 * r);
    if (s.shifting) volume *= 0.35;
    this.engineGain.gain.setTargetAtTime(volume, t, s.shifting ? 0.01 : SMOOTH);

    const skid = Math.min(Math.max((s.slip - 2.5) / 8, 0), 1);
    this.skidGain.gain.setTargetAtTime(skid * 0.2, t, 0.05);

    const wind = Math.min(s.speed / 90, 1);
    this.windGain.gain.setTargetAtTime(wind * wind * 0.22, t, 0.1);
  }

  dispose(): void {
    for (const { node } of this.oscillators) node.stop();
    this.loop?.stop();
    this.noise.stop();
    for (const n of this.nodes) n.disconnect();
  }

  private keep<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }
}

/**
 * Lightweight engine for opponent cars: the recorded loop through a
 * low-pass and an HRTF-free 3D panner (distance attenuation + stereo).
 */
export class EngineVoice {
  private readonly source: AudioBufferSourceNode;
  private readonly gain: GainNode;
  private readonly filter: BiquadFilterNode;
  readonly panner: PannerNode;

  constructor(
    private readonly ctx: AudioContext,
    output: AudioNode,
    private readonly profile: EngineSoundProfile,
    loop: AudioBuffer,
  ) {
    this.source = ctx.createBufferSource();
    this.source.buffer = loop;
    this.source.loop = true;
    // Random start offset so 19 identical loops don't phase together.
    this.source.start(0, Math.random() * loop.duration);
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 2000;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.panner = new PannerNode(ctx, {
      panningModel: 'equalpower',
      distanceModel: 'inverse',
      refDistance: 6,
      rolloffFactor: 1.3,
      maxDistance: 400,
    });
    this.source.connect(this.filter).connect(this.gain).connect(this.panner).connect(output);
  }

  update(x: number, y: number, z: number, rpmRatio: number, throttle: number): void {
    const t = this.ctx.currentTime;
    this.panner.positionX.setTargetAtTime(x, t, SMOOTH);
    this.panner.positionY.setTargetAtTime(y, t, SMOOTH);
    this.panner.positionZ.setTargetAtTime(z, t, SMOOTH);
    this.source.playbackRate.setTargetAtTime(firingHz(this.profile, rpmRatio) / LOOP_BASE_HZ, t, SMOOTH);
    this.filter.frequency.setTargetAtTime(900 + 2500 * throttle, t, SMOOTH);
    this.gain.gain.setTargetAtTime(ENGINE_LEVEL * this.profile.volume * (0.45 + 0.55 * throttle) * 0.9, t, SMOOTH);
  }

  dispose(): void {
    this.source.stop();
    this.source.disconnect();
    this.filter.disconnect();
    this.gain.disconnect();
    this.panner.disconnect();
  }
}
