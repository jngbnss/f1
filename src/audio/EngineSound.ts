/**
 * Procedural car audio (Web Audio API, no samples):
 *  - engine: oscillators at the cylinder firing frequency + harmonics,
 *    combustion noise, soft-clip distortion and a load-dependent low-pass
 *  - tyre squeal: band-passed noise driven by lateral slip
 *  - wind: low-passed noise driven by speed
 *
 * Swapping to recorded RPM-layered samples later only means replacing this
 * class; the inputs (CarAudioState) stay the same.
 */

export interface EngineVoice {
  type: OscillatorType;
  /** Frequency multiplier relative to the firing frequency. */
  mult: number;
  gain: number;
}

export interface EngineSoundProfile {
  cylinders: number;
  voices: EngineVoice[];
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
  rpm: number;
  /** 0..1 between idle and redline. */
  rpmRatio: number;
  throttle: number;
  /** m/s */
  speed: number;
  /** Max lateral slip over grounded wheels (m/s). */
  slip: number;
  /** True while changing gear. */
  shifting: boolean;
}

function softClipCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + drive) * x) / (1 + drive * Math.abs(x));
  }
  return curve;
}

function noiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

const SMOOTH = 0.03; // seconds, param smoothing time constant

export class CarAudio {
  private readonly oscillators: { node: OscillatorNode; voice: EngineVoice }[] = [];
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
  ) {
    const mix = this.keep(ctx.createGain());
    for (const voice of profile.voices) {
      const osc = this.keep(ctx.createOscillator());
      osc.type = voice.type;
      const g = this.keep(ctx.createGain());
      g.gain.value = voice.gain;
      osc.connect(g).connect(mix);
      this.oscillators.push({ node: osc, voice });
    }

    this.noise = this.keep(ctx.createBufferSource());
    this.noise.buffer = noiseBuffer(ctx);
    this.noise.loop = true;

    this.combustionFilter = this.keep(ctx.createBiquadFilter());
    this.combustionFilter.type = 'bandpass';
    this.combustionFilter.Q.value = 1.2;
    this.combustionGain = this.keep(ctx.createGain());
    this.noise.connect(this.combustionFilter).connect(this.combustionGain).connect(mix);

    const shaper = this.keep(ctx.createWaveShaper());
    shaper.curve = softClipCurve(profile.distortion);
    shaper.oversample = '2x';
    this.lowpass = this.keep(ctx.createBiquadFilter());
    this.lowpass.type = 'lowpass';
    this.lowpass.Q.value = 0.9;
    this.engineGain = this.keep(ctx.createGain());
    this.engineGain.gain.value = 0;
    mix.connect(shaper).connect(this.lowpass).connect(this.engineGain).connect(output);

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
    this.noise.start();
  }

  update(s: CarAudioState, dt: number): void {
    const p = this.profile;
    const t = this.ctx.currentTime;

    // Engine load follows the throttle with a little lag (sounds less robotic).
    this.load += (s.throttle - this.load) * (1 - Math.exp(-10 * dt));

    const firing = (s.rpm / 60) * (p.cylinders / 2);
    // Tiny random wobble = combustion irregularity.
    const wobble = 1 + (Math.random() - 0.5) * 0.006;
    for (const { node, voice } of this.oscillators) {
      node.frequency.setTargetAtTime(firing * voice.mult * wobble, t, SMOOTH);
    }
    this.combustionFilter.frequency.setTargetAtTime(firing * 2, t, SMOOTH);
    this.combustionGain.gain.setTargetAtTime(p.noise * (0.3 + 0.7 * this.load), t, SMOOTH);

    const r = Math.min(Math.max(s.rpmRatio, 0), 1);
    const cutoff = p.filterMin + (p.filterMax - p.filterMin) * (0.25 * r + 0.75 * r * this.load);
    this.lowpass.frequency.setTargetAtTime(cutoff, t, SMOOTH);

    let volume = p.volume * (0.35 + 0.65 * this.load) * (0.65 + 0.35 * r);
    if (s.shifting) volume *= 0.35;
    this.engineGain.gain.setTargetAtTime(volume, t, s.shifting ? 0.01 : SMOOTH);

    const skid = Math.min(Math.max((s.slip - 2.5) / 8, 0), 1);
    this.skidGain.gain.setTargetAtTime(skid * 0.22, t, 0.05);

    const wind = Math.min(s.speed / 90, 1);
    this.windGain.gain.setTargetAtTime(wind * wind * 0.25, t, 0.1);
  }

  dispose(): void {
    for (const { node } of this.oscillators) node.stop();
    this.noise.stop();
    for (const n of this.nodes) n.disconnect();
  }

  private keep<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }
}
