/**
 * Background music: a playlist described by `public/audio/bgm/tracks.json`,
 * played through a plain `<audio>` element (a whole song decoded into an
 * AudioBuffer would cost tens of MB, and the music needs no DSP).
 *
 * It has its own volume and on/off switch, kept apart from the game bus
 * (engines, tyres) and the team radio, and it ducks while the engineer talks.
 * Music starts in the menu, so it cannot wait for the game's AudioContext;
 * browsers block autoplay, so the first play attempt is retried on the first
 * click / key press. No manifest or no tracks → it stays silent and the
 * settings row is hidden (see VolumeControl).
 */

export interface MusicSettings {
  /** Background music on at all. */
  on: boolean;
  /** Music volume 0..1 (separate from the game sound and the radio). */
  volume: number;
}

export interface MusicTrack {
  /** File name inside public/audio/bgm/ (or an absolute URL). */
  src: string;
  /** Shown in the sound panel while it plays. */
  title?: string;
}

const SETTINGS_KEY = 'f1:music';
const DEFAULTS: MusicSettings = { on: true, volume: 0.35 };

export function readMusicSettings(): MusicSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<MusicSettings>;
    return { on: saved.on ?? DEFAULTS.on, volume: Math.min(Math.max(Number(saved.volume ?? DEFAULTS.volume), 0), 1) };
  } catch {
    return { ...DEFAULTS };
  }
}

const settingsListeners = new Set<(s: MusicSettings) => void>();

export function saveMusicSettings(s: MusicSettings): void {
  const next: MusicSettings = { on: s.on, volume: Math.min(Math.max(s.volume, 0), 1) };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* not remembered */
  }
  music.settingsChanged(next);
  for (const l of settingsListeners) l(next);
}

export function onMusicSettings(l: (s: MusicSettings) => void): () => void {
  settingsListeners.add(l);
  return () => settingsListeners.delete(l);
}

const BGM_DIR = `${import.meta.env.BASE_URL}audio/bgm/`;
/** Fade length for start / stop / track changes (ms). */
const FADE_MS = 1200;
const STEP_MS = 50;
/** How far the music drops while the engineer talks. */
const DUCK = 0.3;
/** Extensions tried for `bgm1`, `bgm2`, … when there is no tracks.json. */
const EXTS = ['mp3', 'ogg', 'm4a', 'wav', 'opus'];
/** Where the bgm<N> search gives up. */
const MAX_TRACKS = 20;

function shuffled<T>(list: readonly T[]): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class MusicPlayer {
  private el: HTMLAudioElement | null = null;
  private tracks: MusicTrack[] = [];
  private index = 0;
  private settings = readMusicSettings();
  private muted = false;
  private ducked = false;
  /** Current fade level 0..1 and where it is heading. */
  private level = 0;
  private target = 0;
  private timer = 0;
  private starting = false;
  private pendingGesture = false;
  /** Tracks that failed to load since the last one actually played. */
  private failures = 0;
  private readonly trackListeners = new Set<(t: MusicTrack | null) => void>();

  get available(): boolean {
    return this.tracks.length > 0;
  }

  get current(): MusicTrack | null {
    return this.available ? this.tracks[this.index] : null;
  }

  onTrack(l: (t: MusicTrack | null) => void): () => void {
    this.trackListeners.add(l);
    l(this.current);
    return () => this.trackListeners.delete(l);
  }

  /** Finds the playlist (once) and starts playing if music is on. */
  async start(): Promise<void> {
    if (this.el || this.starting) {
      this.settingsChanged(this.settings);
      return;
    }
    this.starting = true;
    try {
      this.tracks = shuffled(await this.discover());
    } finally {
      this.starting = false;
    }
    if (!this.tracks.length) return;

    const el = (this.el = new Audio());
    el.preload = 'auto';
    el.volume = 0;
    el.addEventListener('ended', () => this.next());
    // A broken / unsupported file must not stop the playlist, but a playlist
    // where nothing loads must not spin through itself for ever.
    el.addEventListener('error', () => {
      if (++this.failures < this.tracks.length) this.next();
    });
    el.addEventListener('playing', () => (this.failures = 0));
    document.addEventListener('visibilitychange', this.onVisibility);
    this.load(0);
    for (const l of this.trackListeners) l(this.current);
    this.apply();
  }

  /**
   * The playlist: `tracks.json` if it is there, otherwise plain `bgm1.mp3`,
   * `bgm2.ogg`, … (any supported extension) until a number is missing.
   */
  private async discover(): Promise<MusicTrack[]> {
    try {
      const res = await fetch(`${BGM_DIR}tracks.json`, { cache: 'no-cache' });
      // A dev server / SPA host answers 200 with index.html for missing files.
      if (res.ok && !/html/i.test(res.headers.get('content-type') ?? '')) {
        const data = (await res.json()) as { tracks?: MusicTrack[] } | MusicTrack[];
        const list = Array.isArray(data) ? data : (data.tracks ?? []);
        const named = list.filter((t) => t && typeof t.src === 'string' && t.src);
        if (named.length) return named;
      }
    } catch {
      // No manifest: fall through to the bgm1, bgm2, … convention.
    }
    const found: MusicTrack[] = [];
    for (let i = 1; i <= MAX_TRACKS; i++) {
      const hit = await this.probe(`bgm${i}`);
      if (!hit) break;
      found.push({ src: hit, title: `BGM ${i}` });
    }
    return found;
  }

  /** Name + the first extension that really exists on the server, or null. */
  private async probe(name: string): Promise<string | null> {
    for (const ext of EXTS) {
      try {
        const res = await fetch(`${BGM_DIR}${name}.${ext}`, { method: 'HEAD', cache: 'no-cache' });
        // index.html handed back for a missing file is not a track.
        if (res.ok && !/html/i.test(res.headers.get('content-type') ?? '')) return `${name}.${ext}`;
      } catch {
        return null; // offline / blocked: no point trying the rest
      }
    }
    return null;
  }

  settingsChanged(s: MusicSettings): void {
    this.settings = s;
    this.apply();
  }

  setMuted(on: boolean): void {
    this.muted = on;
    this.apply();
  }

  setDuck(on: boolean): void {
    this.ducked = on;
    this.applyVolume();
  }

  /** Skips to the next track (also used when one ends or fails to load). */
  next(): void {
    if (!this.el || this.tracks.length === 0) return;
    this.load((this.index + 1) % this.tracks.length);
    for (const l of this.trackListeners) l(this.current);
    this.apply();
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopTimer();
    this.el?.pause();
    this.el = null;
  }

  private load(i: number): void {
    if (!this.el) return;
    this.index = i;
    const src = this.tracks[i].src;
    this.el.src = /^(https?:)?\/\//.test(src) || src.startsWith('/') ? src : BGM_DIR + encodeURIComponent(src);
    // A new track fades in rather than punching in at full volume.
    this.level = 0;
    this.applyVolume();
  }

  /** Plays / pauses and aims the fade at where the settings say it should be. */
  private apply(): void {
    const el = this.el;
    if (!el) return;
    const wanted = this.settings.on && !this.muted && !document.hidden;
    this.target = wanted ? 1 : 0;
    if (wanted && el.paused) this.play();
    this.applyVolume();
    if (this.level !== this.target) this.startTimer();
    else if (!wanted) el.pause();
  }

  private play(): void {
    const el = this.el;
    if (!el) return;
    void el.play().catch(() => this.waitForGesture());
  }

  /** Autoplay was blocked: try again on the first real user gesture. */
  private waitForGesture(): void {
    if (this.pendingGesture) return;
    this.pendingGesture = true;
    const retry = (): void => {
      window.removeEventListener('pointerdown', retry);
      window.removeEventListener('keydown', retry);
      this.pendingGesture = false;
      if (this.target > 0) this.play();
    };
    window.addEventListener('pointerdown', retry, { once: true });
    window.addEventListener('keydown', retry, { once: true });
  }

  private applyVolume(): void {
    if (!this.el) return;
    const v = this.settings.volume * this.level * (this.ducked ? DUCK : 1);
    this.el.volume = Math.min(Math.max(v, 0), 1);
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = window.setInterval(this.tick, STEP_MS);
  }

  private stopTimer(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  private tick = (): void => {
    const step = STEP_MS / FADE_MS;
    this.level = this.target > this.level ? Math.min(this.level + step, this.target) : Math.max(this.level - step, this.target);
    this.applyVolume();
    if (this.level !== this.target) return;
    this.stopTimer();
    if (this.level === 0) this.el?.pause();
  };

  private onVisibility = (): void => {
    // Background tab: fade out and pause (no CPU, no music over another window).
    this.apply();
  };
}

/**
 * The one background-music player. `start()` loads the playlist and begins,
 * `setDuck()` lowers it while the engineer talks, `setMuted()` follows the
 * game's mute key (M), `available` tells the UI whether to show the row.
 */
export const music = new MusicPlayer();
