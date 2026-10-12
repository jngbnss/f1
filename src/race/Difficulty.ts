import { urlWith } from '../config';

/**
 * Difficulty, F1-game style (assists + how forgiving the race is), picked in the
 * menu. Remembered in the browser; `?diff=expert` in the URL wins.
 *  - beginner: steering keeps working under braking, traction control, spin
 *    assist, no punctures, light damage, slower tyre wear, no safety car /
 *    VSC / yellow flags or track-limit penalties, slower AI
 *  - intermediate: half the assists, rare punctures, safety car on
 *  - expert: the full simulation (no assists beyond the ABS setting)
 */
export type Difficulty = 'beginner' | 'intermediate' | 'expert';
export const DIFFICULTIES: Difficulty[] = ['beginner', 'intermediate', 'expert'];

export interface DifficultySpec {
  name: string;
  hint: string;
  /** ABS always on (else the player's B setting). */
  abs: boolean;
  /** 0..1: under braking, how much of the cornering grip is kept for steering. */
  steerPriority: number;
  /** 0..1: throttle trimmed so the rear tyres keep their cornering grip (no wheelspin snap). */
  tractionControl: number;
  /** 0..1: damps a yaw rate beyond what the steering asks for (spin assist). */
  stability: number;
  /** Multipliers for the player's puncture chance, impact damage and tyre wear. */
  punctures: number;
  damage: number;
  tyreWear: number;
  /** Race control (VSC, safety car, yellow flags) and track-limit penalties. */
  raceControl: boolean;
  penalties: boolean;
  /** AI pace multiplier. */
  aiPace: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultySpec> = {
  beginner: {
    name: '초보',
    hint: '쉽게 운전 · 펑크·세이프티카 없음',
    abs: true,
    steerPriority: 0.85,
    tractionControl: 1,
    stability: 1,
    punctures: 0,
    damage: 0.3,
    tyreWear: 0.5,
    raceControl: false,
    penalties: false,
    aiPace: 0.95,
  },
  intermediate: {
    name: '중급',
    hint: '보조 절반 · 세이프티카 있음',
    abs: false,
    steerPriority: 0.5,
    tractionControl: 0.5,
    stability: 0.4,
    punctures: 0.5,
    damage: 0.7,
    tyreWear: 0.8,
    raceControl: true,
    penalties: true,
    aiPace: 0.98,
  },
  expert: {
    name: '고급',
    hint: '완전 사실적 · 보조 없음',
    abs: false,
    steerPriority: 0,
    tractionControl: 0,
    stability: 0,
    punctures: 1,
    damage: 1,
    tyreWear: 1,
    raceControl: true,
    penalties: true,
    aiPace: 1,
  },
};

export function readDifficulty(): Difficulty {
  const fromUrl = new URLSearchParams(window.location.search).get('diff');
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('difficulty');
  } catch {
    /* storage blocked */
  }
  const pick = (fromUrl ?? stored ?? 'beginner') as Difficulty;
  return DIFFICULTIES.includes(pick) ? pick : 'beginner';
}

export function saveDifficulty(d: Difficulty): void {
  try {
    localStorage.setItem('difficulty', d);
  } catch {
    /* the URL still carries it */
  }
  history.replaceState(null, '', urlWith({ diff: d }));
}
