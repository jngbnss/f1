import type { MediaConnection, Peer } from 'peerjs';
import { duckGameAudio } from '../audio/AudioSystem';

/**
 * Voice chat between the humans in a room, over the same PeerJS peers as the
 * game data (no extra server). Audio goes peer-to-peer in a full mesh: every
 * player with a mic sends one Opus stream to every other player.
 *
 * Mesh cost: with N talkers each browser uploads N-1 streams and decodes N-1.
 * At the ~24 kbps cap that is ~0.45 Mbps up for a 20-player room, fine on
 * desktop but heavy on phones; push-to-talk keeps it near zero most of the
 * time (a disabled track sends silence/comfort-noise frames only). Beyond
 * ~10 simultaneous talkers an SFU (LiveKit) would be the next step.
 *
 * Incoming voices sound like F1 team radio: band-limited (300-3400 Hz),
 * slightly overdriven, a faint hiss while the channel is open, and a
 * synthesized squelch beep at the start and end of each transmission. The
 * voice itself is delayed ~0.12 s so the opening beep comes before the words.
 * Game sound (engines) is ducked while someone talks.
 *
 * Pairing: each pair has exactly one call. A player who turns their mic on
 * calls everyone; the callee answers with its own mic if it has one (else
 * receive-only) and replaces any older call with that peer, so the pair ends
 * up two-way. If both call each other at the same moment the lower peer id's
 * call wins.
 */

export type VoiceMode = 'ptt' | 'open';

const MAX_BITRATE = 24000;
/** RMS level above which a remote voice counts as talking. */
const SPEAK_LEVEL = 0.012;
/** Silence (ms) before a transmission counts as over. */
const HANG_MS = 350;
/** Open-mic voice detection threshold and hang. */
const VAD_LEVEL = 0.02;
const VAD_HANG_MS = 600;
const VOICE_DELAY = 0.12;
/** A call this young (ms) that we started wins a simultaneous call from a higher id. */
const CALL_RACE_MS = 5000;

interface Remote {
  id: string;
  call: MediaConnection;
  outgoing: boolean;
  since: number;
  el: HTMLAudioElement | null;
  nodes: AudioNode[];
  analyser: AnalyserNode | null;
  out: GainNode | null;
  noise: GainNode | null;
  speaking: boolean;
  lastLoud: number;
}

interface PeerPrefs {
  volume: number;
  muted: boolean;
}

export class Voice {
  /** Mic captured (user turned voice on). */
  micOn = false;
  mode: VoiceMode = (stored('voice-mode') as VoiceMode) === 'open' ? 'open' : 'ptt';
  /** Own mic muted (never transmits). */
  selfMuted = false;
  /** All incoming voices muted. */
  deafened = false;
  /** Push-to-talk held. */
  private talking = false;
  /** Open mic: voice detected. */
  private vadOpen = false;
  private lastVad = 0;
  private transmitting = false;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private mic: MediaStream | null = null;
  private sendStream: MediaStream | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private readonly remotes = new Map<string, Remote>();
  private readonly prefs = new Map<string, PeerPrefs>();
  private peers = new Set<string>();
  private readonly buf = new Float32Array(1024);
  private timer = 0;
  private stopped = false;
  private ducking = false;

  /** Something visible changed (speaking, mic state, peers). */
  onChange?: () => void;

  constructor(
    private readonly peer: Peer,
    private readonly myId: () => string,
  ) {
    peer.on('call', this.onIncoming);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('pointerdown', this.onGesture);
    window.addEventListener('keydown', this.onGesture);
    window.addEventListener('blur', this.onBlur);
    this.timer = window.setInterval(() => this.tick(), 50);
  }

  /** Room members (peer ids, including mine). New ones get a call if my mic is on. */
  setPeers(ids: string[]): void {
    const next = new Set(ids.filter((id) => id !== this.myId()));
    for (const id of this.peers) if (!next.has(id)) this.drop(id);
    const added = [...next].filter((id) => !this.peers.has(id));
    this.peers = next;
    if (this.micOn) for (const id of added) this.callPeer(id);
    this.onChange?.();
  }

  /** A member left: hang up and forget them. */
  drop(id: string): void {
    this.peers.delete(id);
    const r = this.remotes.get(id);
    if (r) {
      this.remotes.delete(id);
      this.detach(r);
      r.call.close();
    }
    this.onChange?.();
  }

  /** Asks for the mic (only ever on this explicit action) and calls everyone. */
  async enableMic(): Promise<void> {
    if (this.micOn || this.stopped) return;
    const ctx = this.audio();
    void ctx.resume();
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (this.stopped) {
      for (const t of mic.getTracks()) t.stop();
      return;
    }
    this.mic = mic;
    // Send a clone so the local level meter keeps working while the sent track is gated.
    const send = mic.getAudioTracks()[0].clone();
    send.enabled = false;
    this.sendStream = new MediaStream([send]);
    const src = ctx.createMediaStreamSource(mic);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    src.connect(this.micAnalyser);
    this.micOn = true;
    for (const id of this.peers) this.callPeer(id);
    this.onChange?.();
  }

  setMode(mode: VoiceMode): void {
    this.mode = mode;
    store('voice-mode', mode);
    this.updateTx();
    this.onChange?.();
  }

  setSelfMuted(muted: boolean): void {
    this.selfMuted = muted;
    this.updateTx();
    this.onChange?.();
  }

  setDeafened(deaf: boolean): void {
    this.deafened = deaf;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(deaf ? 0 : 1, this.ctx.currentTime, 0.03);
    this.onChange?.();
  }

  /** Push-to-talk (V key, mic button). */
  setTalking(on: boolean): void {
    if (this.talking === on) return;
    this.talking = on;
    if (on) void this.ctx?.resume();
    this.updateTx();
    this.onChange?.();
  }

  peerPrefs(id: string): PeerPrefs {
    let p = this.prefs.get(id);
    if (!p) this.prefs.set(id, (p = { volume: 1, muted: false }));
    return p;
  }

  setPeerVolume(id: string, volume: number): void {
    this.peerPrefs(id).volume = volume;
    this.applyPrefs(id);
  }

  setPeerMuted(id: string, muted: boolean): void {
    this.peerPrefs(id).muted = muted;
    this.applyPrefs(id);
    this.onChange?.();
  }

  /** True while `id` (any member, or me) is talking. */
  isSpeaking(id: string): boolean {
    if (id === this.myId()) return this.transmitting;
    return this.remotes.get(id)?.speaking ?? false;
  }

  /** Remote peers whose audio is connected. */
  connected(id: string): boolean {
    return !!this.remotes.get(id)?.analyser;
  }

  /** Current input level of a remote (0..1), for tests and meters. */
  level(id: string): number {
    const r = this.remotes.get(id);
    return r?.analyser ? rms(r.analyser, this.buf) : 0;
  }

  get transmittingNow(): boolean {
    return this.transmitting;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.peer.off('call', this.onIncoming);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('pointerdown', this.onGesture);
    window.removeEventListener('keydown', this.onGesture);
    window.removeEventListener('blur', this.onBlur);
    for (const r of this.remotes.values()) {
      this.detach(r);
      r.call.close();
    }
    this.remotes.clear();
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    for (const t of this.sendStream?.getTracks() ?? []) t.stop();
    if (this.ducking) duckGameAudio(false);
    void this.ctx?.close();
  }

  // --------------------------------------------------------------------------

  private callPeer(id: string): void {
    if (!this.sendStream || this.stopped) return;
    const old = this.remotes.get(id);
    const call = this.peer.call(id, this.sendStream);
    if (!call) return;
    if (old) {
      this.detach(old);
      old.call.close();
    }
    this.bind({ id, call, outgoing: true, since: performance.now(), el: null, nodes: [], analyser: null, out: null, noise: null, speaking: false, lastLoud: 0 });
  }

  private onIncoming = (call: MediaConnection): void => {
    if (this.stopped) return call.close();
    const id = call.peer;
    const old = this.remotes.get(id);
    if (old && old.outgoing && performance.now() - old.since < CALL_RACE_MS && this.myId() < id) {
      // Both called at once: mine wins.
      call.close();
      return;
    }
    if (old) {
      this.remotes.delete(id);
      this.detach(old);
      old.call.close();
    }
    call.answer(this.sendStream ?? undefined);
    this.bind({ id, call, outgoing: false, since: performance.now(), el: null, nodes: [], analyser: null, out: null, noise: null, speaking: false, lastLoud: 0 });
    capBitrate(call);
  };

  private bind(r: Remote): void {
    this.remotes.set(r.id, r);
    r.call.on('stream', (stream) => {
      if (this.remotes.get(r.id) !== r) return;
      this.attach(r, stream);
      capBitrate(r.call);
      this.onChange?.();
    });
    const gone = () => {
      if (this.remotes.get(r.id) !== r) return;
      this.remotes.delete(r.id);
      this.detach(r);
      this.onChange?.();
    };
    r.call.on('close', gone);
    r.call.on('error', gone);
  }

  /** Remote stream -> team-radio chain -> speakers. */
  private attach(r: Remote, stream: MediaStream): void {
    this.detach(r);
    const ctx = this.audio();
    // Chrome only pulls remote WebRTC audio into WebAudio if a media element also plays it.
    const el = document.createElement('audio');
    el.muted = true;
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.srcObject = stream;
    void el.play().catch(() => {});
    r.el = el;

    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 300, Q: 0.7 });
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3400, Q: 0.7 });
    const peak = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1800, gain: 5, Q: 1 });
    const shaper = new WaveShaperNode(ctx, { curve: driveCurve(2.2), oversample: '2x' });
    const delay = new DelayNode(ctx, { delayTime: VOICE_DELAY, maxDelayTime: 0.5 });
    const out = ctx.createGain();
    // Faint hiss while the channel is open.
    const noiseSrc = new AudioBufferSourceNode(ctx, { buffer: this.noise(ctx), loop: true });
    const noiseBand = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 2200, Q: 0.6 });
    const noise = ctx.createGain();
    noise.gain.value = 0;
    noiseSrc.connect(noiseBand).connect(noise).connect(out);
    noiseSrc.start();
    src.connect(hp).connect(lp).connect(peak).connect(shaper).connect(delay).connect(out).connect(this.master!);
    r.nodes = [src, analyser, hp, lp, peak, shaper, delay, out, noiseSrc, noiseBand, noise];
    r.analyser = analyser;
    r.out = out;
    r.noise = noise;
    this.applyPrefs(r.id);
  }

  private detach(r: Remote): void {
    for (const n of r.nodes) {
      try {
        if (n instanceof AudioBufferSourceNode) n.stop();
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    r.nodes = [];
    r.analyser = null;
    r.out = null;
    r.noise = null;
    if (r.el) {
      r.el.srcObject = null;
      r.el = null;
    }
    if (r.speaking) r.speaking = false;
  }

  private applyPrefs(id: string): void {
    const r = this.remotes.get(id);
    if (!r?.out || !this.ctx) return;
    const p = this.peerPrefs(id);
    r.out.gain.setTargetAtTime(p.muted ? 0 : p.volume * 1.4, this.ctx.currentTime, 0.03);
  }

  private updateTx(): void {
    const track = this.sendStream?.getAudioTracks()[0];
    const tx = this.micOn && !this.selfMuted && (this.mode === 'ptt' ? this.talking : this.vadOpen);
    if (track) track.enabled = tx;
    if (tx !== this.transmitting) {
      this.transmitting = tx;
      this.onChange?.();
    }
  }

  /** 20 Hz: who is talking, open-mic detection, squelch beeps, ducking. */
  private tick(): void {
    const now = performance.now();
    let changed = false;
    if (this.micOn && this.mode === 'open' && this.micAnalyser) {
      if (rms(this.micAnalyser, this.buf) > VAD_LEVEL) this.lastVad = now;
      const open = now - this.lastVad < VAD_HANG_MS;
      if (open !== this.vadOpen) {
        this.vadOpen = open;
        this.updateTx();
      }
    }
    let anyone = false;
    for (const r of this.remotes.values()) {
      if (!r.analyser) continue;
      if (rms(r.analyser, this.buf) > SPEAK_LEVEL) r.lastLoud = now;
      const speaking = now - r.lastLoud < HANG_MS;
      const audible = !this.peerPrefs(r.id).muted && !this.deafened;
      if (speaking !== r.speaking) {
        r.speaking = speaking;
        changed = true;
        if (audible && this.ctx && r.out) {
          squelch(this.ctx, r.out, speaking);
          r.noise?.gain.setTargetAtTime(speaking ? 0.012 : 0, this.ctx.currentTime + (speaking ? 0 : VOICE_DELAY), 0.02);
        }
      }
      if (speaking && audible) anyone = true;
    }
    if (anyone !== this.ducking) {
      this.ducking = anyone;
      duckGameAudio(anyone);
    }
    if (changed) this.onChange?.();
  }

  private audio(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor!();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.deafened ? 0 : 1;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private noise(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuffer = b;
    }
    return this.noiseBuffer;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'KeyV' || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    this.setTalking(e.type === 'keydown');
  };

  /** iOS / Chrome autoplay: audio only starts after a user gesture. */
  private onGesture = (): void => {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  };

  private onBlur = (): void => this.setTalking(false);
}

/** Opus at speech bitrate (each sender), mono. */
function capBitrate(call: MediaConnection): void {
  const apply = () => {
    const pc = call.peerConnection;
    if (!pc) return;
    for (const s of pc.getSenders()) {
      if (s.track?.kind !== 'audio') continue;
      const p = s.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = MAX_BITRATE;
      s.setParameters(p).catch(() => {});
    }
  };
  setTimeout(apply, 500);
  setTimeout(apply, 2500);
}

function rms(a: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  const n = Math.min(buf.length, a.fftSize);
  const view = buf.subarray(0, n);
  a.getFloatTimeDomainData(view);
  let s = 0;
  for (let i = 0; i < n; i++) s += view[i] * view[i];
  return Math.sqrt(s / n);
}

function driveCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}

/** "삐리릭" at the start of a transmission, a short "kssh" + low blip at the end. */
function squelch(ctx: AudioContext, out: AudioNode, start: boolean): void {
  const t0 = ctx.currentTime + 0.005;
  const g = ctx.createGain();
  g.gain.value = 0;
  g.connect(out);
  if (start) {
    const notes = [1750, 2350, 1950];
    notes.forEach((f, i) => {
      const o = new OscillatorNode(ctx, { type: 'square', frequency: f });
      const t = t0 + i * 0.035;
      o.connect(g);
      o.start(t);
      o.stop(t + 0.03);
    });
    g.gain.setValueAtTime(0.05, t0);
    g.gain.setValueAtTime(0, t0 + notes.length * 0.035);
  } else {
    const o = new OscillatorNode(ctx, { type: 'square', frequency: 1300 });
    o.connect(g);
    o.start(t0);
    o.stop(t0 + 0.05);
    g.gain.setValueAtTime(0.04, t0);
    g.gain.setValueAtTime(0, t0 + 0.05);
  }
  setTimeout(() => g.disconnect(), 400);
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered */
  }
}
