import type { InputAction, InputSource, VehicleInput } from './VehicleInput';

/** The bits of the Web Speech API used here (Chrome/Edge ship it prefixed). */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

const BOX = /박스|복스|\bbox\b|피트\s*인|핏\s*인|\bpit\b/i;
/** Tyre by name or number, in the digit-key order: 1 hyper .. 6 wet. */
const TYRE_WORDS: [RegExp, number][] = [
  [/하이퍼|hyper/i, 1],
  [/소프트|soft/i, 2],
  [/미디엄|미디움|medium/i, 3],
  [/하드|hard/i, 4],
  [/인터|inter/i, 5],
  [/웻|웨트|\bwet\b/i, 6],
  // Recognizers write spoken numbers as digits ("2번"); native words too. Not 이/일/사/오 alone: "이번 랩" is "this lap".
  [/(^|\D)1(\D|$)|하나|\bone\b/i, 1],
  [/(^|\D)2(\D|$)|(^|\s)둘|\btwo\b/i, 2],
  [/(^|\D)3(\D|$)|(^|\s)셋|\bthree\b/i, 3],
  [/(^|\D)4(\D|$)|(^|\s)넷|\bfour\b/i, 4],
  [/(^|\D)5(\D|$)|다섯|\bfive\b/i, 5],
  [/(^|\D)6(\D|$)|여섯|\bsix\b/i, 6],
];

/** Commands in one recognized phrase: "박스 디스 랩" -> pit, "소프트" / "2번" -> tyre2. */
export function parseVoice(text: string): InputAction[] {
  const out: InputAction[] = [];
  if (BOX.test(text)) out.push('pit');
  const tyre = TYRE_WORDS.find(([re]) => re.test(text));
  if (tyre) out.push(`tyre${tyre[1] as 1 | 2 | 3 | 4 | 5 | 6}`);
  return out;
}

/**
 * Spoken pit calls: "box this lap" (박스 디스 랩) requests the stop, a tyre
 * number or name picks the compound. Uses the browser's speech recognition
 * (Chrome/Edge; it sends audio to the browser vendor's service). Ignores the
 * mic while `muted()` (the race engineer talking over the speakers).
 */
export class VoiceCommands implements InputSource {
  readonly id = 'voice';
  private actions: InputAction[] = [];
  private readonly rec: Recognition;
  private stopped = false;

  static get supported(): boolean {
    return !!speechRecognitionCtor();
  }

  /** `onCommand` sees every command as it is heard; `onFatal` when the mic is denied. */
  constructor(
    private readonly muted: () => boolean,
    onCommand: (a: InputAction, heard: string) => void,
    onFatal: (error: string) => void,
  ) {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) throw new Error('speech recognition unsupported');
    const rec = new Ctor();
    rec.lang = 'ko-KR';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r.isFinal || this.muted()) continue;
        const heard = r[0].transcript.trim();
        for (const a of parseVoice(heard)) {
          this.actions.push(a);
          onCommand(a, heard);
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.stopped = true;
        onFatal(e.error);
      }
    };
    // The service ends a session after silence or a while: keep listening.
    rec.onend = () => {
      if (!this.stopped) rec.start();
    };
    rec.start();
    this.rec = rec;
  }

  read(): VehicleInput | null {
    return null;
  }

  consumeActions(): InputAction[] {
    if (!this.actions.length) return this.actions;
    const out = this.actions;
    this.actions = [];
    return out;
  }

  dispose(): void {
    this.stopped = true;
    this.rec.stop();
  }
}

function speechRecognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}
