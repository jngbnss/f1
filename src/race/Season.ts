import { FEATURED_TRACKS } from '../world/tracks';

/**
 * Season mode: the 2026 calendar round by round (every circuit, in calendar order), F1
 * points for the top ten, drivers' and constructors' standings. Kept in the browser
 * (localStorage) so a season can be continued later; a race counts for the season when
 * it is the current round's circuit and the URL has ?season=1.
 */
export const SEASON_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
export const CALENDAR: string[] = FEATURED_TRACKS.map((t) => t.id);
const KEY = 'season';

export interface SeasonState {
  version: 1;
  /** The player's team and driver (0 / 1). */
  carId: string;
  driver: number;
  laps: number;
  quali: boolean;
  /** Next round (0-based index into CALENDAR); CALENDAR.length = season over. */
  round: number;
  /** Points per driver code and per team id. */
  drivers: Record<string, number>;
  teams: Record<string, number>;
  /** Team and colour of each driver code (for the tables). */
  info: Record<string, { team: string; color: number; player?: boolean }>;
  /** Player's finishing position per round. */
  mine: number[];
}

export interface Finisher {
  name: string;
  team: string;
  color: number;
  isPlayer: boolean;
}

export function loadSeason(): SeasonState | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as SeasonState | null;
    return s?.version === 1 ? s : null;
  } catch {
    return null;
  }
}

function save(s: SeasonState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: this race still shows its points */
  }
}

export function newSeason(carId: string, driver: number, laps: number, quali: boolean): SeasonState {
  const s: SeasonState = { version: 1, carId, driver, laps, quali, round: 0, drivers: {}, teams: {}, info: {}, mine: [] };
  save(s);
  return s;
}

/** Scores one race (finishing order, winner first) and moves the season to the next round. */
export function recordRace(s: SeasonState, order: Finisher[]): SeasonState {
  order.forEach((f, i) => {
    const pts = SEASON_POINTS[i] ?? 0;
    s.drivers[f.name] = (s.drivers[f.name] ?? 0) + pts;
    s.teams[f.team] = (s.teams[f.team] ?? 0) + pts;
    s.info[f.name] = { team: f.team, color: f.color, player: f.isPlayer || undefined };
    if (f.isPlayer) s.mine.push(i + 1);
  });
  s.round++;
  save(s);
  return s;
}

/** Sorted standings: [name, points], most points first. */
export function table(points: Record<string, number>): [string, number][] {
  return Object.entries(points).sort((a, b) => b[1] - a[1]);
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/**
 * After a season race: points scored, the drivers' and constructors' tables and the button
 * to the next round (Enter). Shown next to the race results.
 */
export function showSeasonPanel(s: SeasonState, gained: number, position: number, teamName: (id: string) => string, next: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'results show season-panel';
  const done = s.round >= CALENDAR.length;
  const drivers = table(s.drivers);
  const teams = table(s.teams);
  const myName = Object.keys(s.info).find((n) => s.info[n].player);
  const myRank = drivers.findIndex(([n]) => n === myName) + 1;
  const row = (name: string, pts: number, i: number, color: number, me: boolean) =>
    `<li class="${me ? 'me' : ''}"><span><i style="display:inline-block;width:4px;height:12px;margin-right:6px;vertical-align:-1px;background:${hex(color)}"></i>${i + 1}. ${name}</span><span>${pts}</span></li>`;
  const nextTrack = FEATURED_TRACKS.find((t) => t.id === CALENDAR[s.round]);
  el.innerHTML =
    `<h2>${done ? '🏆 시즌 종료' : `라운드 ${s.round}/${CALENDAR.length}`} · P${position} +${gained}점</h2>` +
    `<p class="season-me">드라이버 순위 <b>${myRank}위</b> · ${s.drivers[myName ?? ''] ?? 0}점${done && myRank === 1 ? ' · 월드 챔피언!' : ''}</p>` +
    '<div class="season-tables"><div><h3>드라이버</h3><ol>' +
    drivers.slice(0, 10).map(([n, p], i) => row(n, p, i, s.info[n]?.color ?? 0x888888, n === myName)).join('') +
    '</ol></div><div><h3>컨스트럭터</h3><ol>' +
    teams.map(([t, p], i) => row(teamName(t), p, i, Object.values(s.info).find((x) => x.team === t)?.color ?? 0x888888, t === s.carId)).join('') +
    '</ol></div></div>' +
    (done
      ? '<p>Esc: 메뉴 (새 시즌은 메뉴에서)</p>'
      : `<button type="button" class="menu-start quali-go">다음 라운드: ${nextTrack?.name ?? ''} ▶ <small>Enter</small></button><p>Esc: 메뉴 (시즌은 저장됨)</p>`);
  el.querySelector('button')?.addEventListener('click', next);
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Enter' && !done) next();
  };
  window.addEventListener('keydown', onKey);
  document.body.append(el);
  return el;
}
