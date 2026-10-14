/**
 * "b206" voice pack: clips the players recorded themselves
 * (public/audio/b206). Off by default and switched on with the b206 button on
 * the start screen, before a race starts. While it is on:
 *  - the team radio adds a shout at five race moments (see VOICE_CUES);
 *  - every car's engine is the recorded voice loop instead of the sampled one.
 *
 * The flag is read once when the race builds its audio, so toggling it mid-race
 * does nothing; that is why the button lives in the menu.
 */

export type VoiceCue = 'start' | 'overtake' | 'hurry' | 'pit_near' | 'pit_in' | 'finish';

export interface CueClip {
  /** Audio file under public/. */
  file: string;
  /** Subtitle shown while it plays. */
  text: string;
}

export const VOICE_CUES: Record<VoiceCue, CueClip> = {
  start: { file: 'audio/b206/start.m4a', text: '까가우!' },
  overtake: { file: 'audio/b206/overtake.m4a', text: '줴~줴이야!' },
  hurry: { file: 'audio/b206/hurry.m4a', text: '아 빨리가라능' },
  pit_near: { file: 'audio/b206/pit_near.m4a', text: '고민되넹…' },
  pit_in: { file: 'audio/b206/pit_in.m4a', text: '주유해야된다능' },
  finish: { file: 'audio/b206/finish.m4a', text: '아 줴줴이야' },
};

/** Lights out: this many shouts, this many seconds apart. */
export const START_SHOUTS = 3;
export const START_SHOUT_GAP = 3;

/**
 * The recorded voice "engine". Playback rate is `rate * (firingHz / baseHz) ** rateExp`:
 * `rateExp: 0` drops the RPM pitching (a voice sped up by the firing frequency just
 * sounds shrill), and `rate` is the fixed speed the clip loops at. Only the volume
 * follows the throttle and the revs.
 */
export const VOICE_ENGINE = { file: 'audio/b206/engine.mp3', rate: 0.75, baseHz: 120, rateExp: 0 };

const KEY = 'f1:b206';

let enabled = (() => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();

export function voicePackOn(): boolean {
  return enabled;
}

export function setVoicePack(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* storage blocked: on for this page only */
  }
}
