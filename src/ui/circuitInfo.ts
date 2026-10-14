/**
 * Country (three-letter code, as on the F1 timing screens: flag emoji do not render on
 * Windows) and the official number of corners (FIA / F1 circuit guides), for the menu cards.
 */
export interface CircuitInfo {
  code: string;
  corners: number;
  /** 1 = 입문, 5 = 매우 어려움. 메뉴 정렬과 추천에 함께 사용합니다. */
  difficulty: 1 | 2 | 3 | 4 | 5;
  character: string;
  description: string;
  tags: string[];
}

export const CIRCUIT_INFO: Record<string, CircuitInfo> = {
  melbourne: { code: 'AUS', corners: 14, difficulty: 2, character: '빠른 공원 서킷', description: '흐름이 자연스럽고 추월 기회도 고르게 있어 첫 레이스에 잘 맞습니다.', tags: ['균형형', '중고속', '입문 추천'] },
  shanghai: { code: 'CHN', corners: 16, difficulty: 3, character: '긴 직선과 복합 코너', description: '긴 백스트레이트와 점점 조여드는 코너가 제동과 타이어 관리를 함께 시험합니다.', tags: ['긴 직선', '헤어핀', '타이어 관리'] },
  suzuka: { code: 'JPN', corners: 18, difficulty: 5, character: '정교한 고속 리듬', description: 'S자와 130R을 매끄럽게 이어야 기록이 나오는 기술적인 드라이버 서킷입니다.', tags: ['S 코너', '고속', '정밀 조작'] },
  sakhir: { code: 'BHR', corners: 15, difficulty: 3, character: '제동과 트랙션', description: '긴 직선 끝 강한 제동과 느린 코너 탈출이 반복되어 추월 연습에 좋습니다.', tags: ['강한 제동', '추월', '트랙션'] },
  jeddah: { code: 'KSA', corners: 27, difficulty: 5, character: '초고속 시가지', description: '벽 사이의 빠른 블라인드 코너가 이어져 집중력과 자신감이 필요합니다.', tags: ['시가지', '초고속', '벽'] },
  miami: { code: 'USA', corners: 19, difficulty: 3, character: '가속과 저속 테크니컬', description: '빠른 구간과 매우 느린 복합 코너가 섞여 셋업 타협이 중요한 서킷입니다.', tags: ['긴 직선', '저속 구간', '추월'] },
  montreal: { code: 'CAN', corners: 14, difficulty: 3, character: '스톱 앤드 고', description: '연석을 적극적으로 쓰며 강하게 제동하고 빠르게 가속하는 리듬이 핵심입니다.', tags: ['연석', '강한 제동', '추월'] },
  monaco: { code: 'MON', corners: 19, difficulty: 5, character: '좁은 시가지 정밀전', description: '추월 공간이 거의 없고 벽이 가까워 한 랩 내내 정확한 조작이 필요합니다.', tags: ['시가지', '저속', '최고 난도'] },
  catalunya: { code: 'ESP', corners: 14, difficulty: 3, character: '올라운드 테스트', description: '저속부터 고속까지 골고루 담겨 차량과 기본기를 비교하기 좋습니다.', tags: ['균형형', '고속 코너', '타이어 관리'] },
  spielberg: { code: 'AUT', corners: 10, difficulty: 2, character: '짧고 빠른 업다운', description: '코너 수가 적고 랩이 짧아 브레이킹 포인트와 레이스 감각을 익히기 좋습니다.', tags: ['짧은 랩', '고저차', '입문 추천'] },
  silverstone: { code: 'GBR', corners: 18, difficulty: 4, character: '고속 코너의 연속', description: '마곳·베켓 같은 연속 코너에서 라인과 속도 유지가 랩타임을 좌우합니다.', tags: ['초고속', '연속 코너', '다운포스'] },
  spa: { code: 'BEL', corners: 19, difficulty: 4, character: '긴 랩과 큰 고저차', description: '오 루즈부터 긴 직선과 기술 구간까지 변화가 커 종합적인 실력이 필요합니다.', tags: ['최장 거리', '고저차', '고속'] },
  budapest: { code: 'HUN', corners: 14, difficulty: 4, character: '쉴 틈 없는 연속 코너', description: '직선이 짧고 코너가 연이어 나와 리듬을 잃지 않는 것이 중요합니다.', tags: ['연속 코너', '다운포스', '추월 어려움'] },
  zandvoort: { code: 'NED', corners: 14, difficulty: 4, character: '뱅킹과 좁은 라인', description: '폭이 좁고 뱅크가 큰 코너가 있어 과감하지만 정밀한 라인 선택이 필요합니다.', tags: ['뱅킹', '고저차', '좁은 트랙'] },
  monza: { code: 'ITA', corners: 11, difficulty: 2, character: '최고속도와 제동', description: '긴 직선과 시케인 중심이라 추월과 강한 제동을 익히기 좋은 고속 서킷입니다.', tags: ['최고속도', '시케인', '입문 추천'] },
  madrid: { code: 'ESP', corners: 22, difficulty: 3, character: '현대적 복합 레이아웃', description: '긴 직선과 다양한 반경의 코너가 섞여 빠른 적응과 균형 잡힌 주행이 필요합니다.', tags: ['복합 코너', '긴 직선', '균형형'] },
  baku: { code: 'AZE', corners: 20, difficulty: 5, character: '극단적인 시가지', description: '아주 긴 직선과 성곽의 좁은 구간이 공존해 실수의 대가가 큽니다.', tags: ['시가지', '최장 직선', '벽'] },
  singapore: { code: 'SGP', corners: 19, difficulty: 5, character: '긴 저속 시가지', description: '벽과 저속 코너가 계속 이어지는 긴 랩으로 집중력과 타이어 관리가 중요합니다.', tags: ['야간', '시가지', '집중력'] },
  austin: { code: 'USA', corners: 20, difficulty: 4, character: '고저차와 복합 코너', description: '가파른 1번 코너와 빠른 S 구간, 긴 직선이 모두 있는 종합 서킷입니다.', tags: ['고저차', 'S 코너', '추월'] },
  mexicocity: { code: 'MEX', corners: 17, difficulty: 3, character: '고지대 저그립', description: '공기가 희박해 제동과 다운포스 감각이 달라지고 스타디움 구간이 특징적입니다.', tags: ['고지대', '긴 직선', '스타디움'] },
  saopaulo: { code: 'BRA', corners: 15, difficulty: 4, character: '짧고 격렬한 역주행', description: '큰 고저차와 연속 코너, 긴 가속 구간이 짧은 랩 안에 압축되어 있습니다.', tags: ['고저차', '역주행', '레이싱'] },
  lasvegas: { code: 'USA', corners: 17, difficulty: 3, character: '초고속 야간 시가지', description: '긴 스트립에서 최고속도를 내고 저속 코너에서 강하게 제동하는 레이아웃입니다.', tags: ['야간', '긴 직선', '강한 제동'] },
  lusail: { code: 'QAT', corners: 16, difficulty: 4, character: '빠른 연속 코너', description: '중고속 코너가 대부분이라 부드러운 조향과 타이어 관리가 기록을 좌우합니다.', tags: ['야간', '중고속', '타이어 관리'] },
  yasmarina: { code: 'UAE', corners: 16, difficulty: 3, character: '정밀한 야간 레이스', description: '긴 직선의 추월 구간과 느린 기술 구간이 명확히 나뉘어 있습니다.', tags: ['야간', '추월', '저속 구간'] },
};
