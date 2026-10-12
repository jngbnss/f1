import { formatLapTime } from './LapTimer';

/**
 * One-shot qualifying, F1-game style: the player is alone on track for an out
 * lap and QUALI_LAPS timed laps; the rest of the field's times come from their
 * cars' speed profiles (ideal lap / AI pace, calibrated against real AI laps).
 * The best valid lap sets the grid slot; "Start the race" reloads into the
 * race with ?grid=<position>.
 */
export const QUALI_LAPS = 3;
/** AI lap time / (ideal lap / pace), measured: Monza 1.054-1.066, Suzuka 1.054, Monaco 1.062, Silverstone 1.10. */
export const AI_LAP_FACTOR = 1.06;

export interface QualiEntry {
  name: string;
  color: number;
  /** Lap time (s); null = no valid lap. */
  time: number | null;
  isPlayer?: boolean;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export class Qualifying {
  /** Timed laps driven (out lap excluded). */
  done = 0;
  best: number | null = null;
  finished = false;
  /** Past the out lap: the current lap is timed. */
  private timing = false;
  private readonly panel = document.createElement('div');
  private readonly results = document.createElement('div');
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Enter' || e.repeat) return;
    if (this.finished) this.startRace(this.position);
    else if (this.done > 0) this.finish();
  };

  constructor(
    /** The rest of the field, quickest first (the race grid fills its other slots in this order). */
    private readonly field: QualiEntry[],
    private readonly player: { name: string; color: number },
    private readonly startRace: (position: number) => void,
  ) {
    this.panel.className = 'quali-panel';
    this.results.className = 'results quali-results';
    document.body.append(this.panel, this.results);
    window.addEventListener('keydown', this.onKey);
    this.render();
  }

  /** A lap ended: `lap` = its number (1 = the out lap from the start line). */
  onLap(lap: number, time: number, valid: boolean): void {
    if (this.finished) return;
    this.timing = true;
    if (lap < 2) return this.render();
    this.done++;
    if (valid && (this.best === null || time < this.best)) this.best = time;
    if (this.done >= QUALI_LAPS) this.finish();
    else this.render();
  }

  /** Grid position (1-based) the best lap is worth now. */
  get position(): number {
    if (this.best === null) return this.field.length + 1;
    return 1 + this.field.filter((e) => e.time !== null && e.time < this.best!).length;
  }

  classification(): QualiEntry[] {
    const me: QualiEntry = { ...this.player, time: this.best, isPlayer: true };
    const list = [...this.field];
    list.splice(this.position - 1, 0, me);
    return list;
  }

  private render(): void {
    const status = this.timing ? `측정 랩 ${this.done + 1}/${QUALI_LAPS}` : '아웃랩 · 결승선을 지나면 측정 시작';
    this.panel.innerHTML =
      `<strong>예선</strong><span>${status}</span>` +
      `<span>베스트 <b>${formatLapTime(this.best)}</b>${this.best !== null ? ` · 예상 <b>P${this.position}</b>` : ''}</span>` +
      (this.done > 0 ? '<small>Enter: 예선 끝내고 결과 보기</small>' : '');
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.panel.remove();
    const pole = this.classification()[0].time;
    const rows = this.classification()
      .map((e, i) => {
        const gap = e.time === null ? '기록 없음' : i === 0 || pole === null ? formatLapTime(e.time) : `+${(e.time - pole).toFixed(3)}`;
        return `<li class="${e.isPlayer ? 'me' : ''}"><span><i style="display:inline-block;width:4px;height:12px;margin-right:6px;vertical-align:-1px;background:${hex(e.color)}"></i>${i + 1}. ${e.name}</span><span>${gap}</span></li>`;
      })
      .join('');
    const p = this.position;
    this.results.innerHTML =
      `<h2>예선 결과 · ${p}번 그리드</h2><ol>${rows}</ol>` +
      '<button type="button" class="menu-start quali-go">결승 출발 ▶ <small>Enter</small></button>' +
      '<p>Esc: 메뉴</p>';
    this.results.querySelector('button')!.addEventListener('click', () => this.startRace(p));
    this.results.classList.add('show');
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.panel.remove();
    this.results.remove();
  }
}
