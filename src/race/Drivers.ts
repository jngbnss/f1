import { urlWith } from '../config';

/**
 * The 2026 driver line-up, two per team in the order of the livery's race
 * numbers (driver 0 / 1 of a team). The player picks one in the menu; the
 * other drives the team-mate's car. Remembered in the browser; `?driver=1` wins.
 */
export interface Driver {
  name: string;
  /** Korean spelling for the menu. */
  ko: string;
  /** Timing-tower code. */
  code: string;
  number: number;
}

const d = (name: string, ko: string, code: string, number: number): Driver => ({ name, ko, code, number });

export const DRIVERS: Record<string, [Driver, Driver]> = {
  'f1-ferrari': [d('Charles Leclerc', '샤를 르클레르', 'LEC', 16), d('Lewis Hamilton', '루이스 해밀턴', 'HAM', 44)],
  'f1-mercedes': [d('George Russell', '조지 러셀', 'RUS', 63), d('Kimi Antonelli', '키미 안토넬리', 'ANT', 12)],
  'f1-redbull': [d('Max Verstappen', '막스 페르스타펜', 'VER', 3), d('Isack Hadjar', '아이작 하자르', 'HAD', 6)],
  'f1-mclaren': [d('Lando Norris', '랜도 노리스', 'NOR', 1), d('Oscar Piastri', '오스카 피아스트리', 'PIA', 81)],
  'f1-aston': [d('Fernando Alonso', '페르난도 알론소', 'ALO', 14), d('Lance Stroll', '랜스 스트롤', 'STR', 18)],
  'f1-alpine': [d('Pierre Gasly', '피에르 가슬리', 'GAS', 10), d('Franco Colapinto', '프랑코 콜라핀토', 'COL', 43)],
  'f1-williams': [d('Alexander Albon', '알렉산더 알본', 'ALB', 23), d('Carlos Sainz', '카를로스 사인츠', 'SAI', 55)],
  'f1-racingbulls': [d('Liam Lawson', '리암 로슨', 'LAW', 30), d('Arvid Lindblad', '아르비드 린드블라드', 'LIN', 41)],
  'f1-haas': [d('Esteban Ocon', '에스테반 오콘', 'OCO', 31), d('Oliver Bearman', '올리버 베어먼', 'BEA', 87)],
  'f1-audi': [d('Nico Hülkenberg', '니코 휠켄베르크', 'HUL', 27), d('Gabriel Bortoleto', '가브리엘 보르톨레토', 'BOR', 5)],
};

/** Driver `index` (0 / 1) of a team, or null for a car without a real line-up. */
export function driverOf(carId: string, index: number): Driver | null {
  return DRIVERS[carId]?.[index % 2] ?? null;
}

export function readDriverIndex(): number {
  const fromUrl = new URLSearchParams(window.location.search).get('driver');
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('driver');
  } catch {
    /* storage blocked */
  }
  return (fromUrl ?? stored) === '1' ? 1 : 0;
}

export function saveDriverIndex(index: number): void {
  try {
    localStorage.setItem('driver', String(index));
  } catch {
    /* the URL still carries it */
  }
  history.replaceState(null, '', urlWith({ driver: String(index) }));
}
