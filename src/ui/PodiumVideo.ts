/**
 * A YouTube clip over the podium ceremony (the official embed player, so the
 * video stays the uploader's: nothing is downloaded or re-hosted). Portrait
 * (Shorts) frame in the middle of the screen; `ended` turns true when the clip
 * finishes, fails to load or is closed. Starts muted when the page hasn't had a
 * click / key press yet (browsers block sound then), with sound otherwise.
 */

/** Default clip: 오렌토맨, 「포디움이 뭐야」 (YouTube Shorts). `?podium-video=<id>` overrides, `=0` turns it off. */
export const PODIUM_VIDEO_ID = '2-oNYIK2swg';
export const PODIUM_VIDEO_CREDIT = '영상: 오렌토맨 「포디움이 뭐야」 · YouTube';

interface YTPlayer {
  playVideo(): void;
  destroy(): void;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, number | string>;
      events?: { onReady?: (e: { target: YTPlayer }) => void; onStateChange?: (e: { data: number }) => void; onError?: () => void };
    },
  ) => YTPlayer;
}
type YTWindow = Window & { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void };

let apiLoading: Promise<YTNamespace> | null = null;
function loadApi(): Promise<YTNamespace> {
  const w = window as YTWindow;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  apiLoading ??= new Promise((resolve, reject) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(w.YT!);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('YouTube API blocked / offline'));
    document.head.append(s);
  });
  return apiLoading;
}

/** The clip id for this page: the default, a `?podium-video=` override, or null (off). */
export function podiumVideoId(): string | null {
  const v = new URLSearchParams(window.location.search).get('podium-video');
  if (v === '0' || v === 'off') return null;
  return v && /^[\w-]{6,20}$/.test(v) ? v : PODIUM_VIDEO_ID;
}

export class PodiumVideo {
  readonly el: HTMLDivElement;
  ended = false;
  /** Couldn't play (blocked, offline, embedding off): the 3D ceremony runs alone. */
  failed = false;
  private player: YTPlayer | null = null;
  private disposed = false;

  constructor(videoId: string, parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'podium-video';
    const frame = document.createElement('div');
    const credit = document.createElement('small');
    credit.textContent = PODIUM_VIDEO_CREDIT;
    this.el.append(frame, credit);
    parent.append(this.el);
    const muted = !(navigator.userActivation?.hasBeenActive ?? false);
    // Give up after 8 s without a player (blocked, offline): the 3D ceremony carries on alone.
    const timeout = window.setTimeout(() => this.fail(), 8000);
    loadApi()
      .then((YT) => {
        if (this.disposed) return;
        this.player = new YT.Player(frame, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { autoplay: 1, mute: muted ? 1 : 0, playsinline: 1, rel: 0, modestbranding: 1, controls: 1 },
          events: {
            onReady: (e) => {
              window.clearTimeout(timeout);
              e.target.playVideo();
            },
            // 0 = ended.
            onStateChange: (e) => {
              if (e.data === 0) this.ended = true;
            },
            onError: () => this.fail(),
          },
        });
      })
      .catch(() => this.fail());
  }

  private fail(): void {
    if (this.ended && !this.failed) return; // finished fine already
    this.failed = true;
    this.ended = true;
    this.el.classList.add('failed');
  }

  dispose(): void {
    this.disposed = true;
    this.ended = true;
    try {
      this.player?.destroy();
    } catch {
      /* already gone */
    }
    this.el.remove();
  }
}
