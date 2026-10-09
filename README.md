# web-sim-lab · Racing

브라우저에서 설치 없이 바로 실행되는 경량 3D 레이싱 시뮬레이터입니다.
**2026 F1 캘린더 서킷 16곳**과 **F1 2026 10개 팀**이 있고, **최대 20대 AI 레이스**, 지역별 배경 테마, 미니맵, 관중, 엔진 소리, 다이내믹 레이싱 라인, 랩타임 기록을 지원합니다.
**브라우저 게임 최적화 실험**(LOD, instancing, 압축, 스트리밍, Worker, WebGPU 등)의 테스트베드로 쓰기 위해 만들었습니다.

- Vite + TypeScript (React 없음)
- Three.js (렌더링, PBR, HDRI)
- Rapier (`@dimforge/rapier3d-compat`, WASM 물리)

## 바로 해보기

배포 링크: **https://jngbnss.github.io/f1/** (GitHub Pages, `main`에 push할 때마다 자동 배포)

메뉴는 바로 뜨고(첫 다운로드 약 13 KB gzip), 3D 엔진과 물리는 메뉴를 보는 동안 뒤에서 받습니다.

링크를 열고 → 차, 서킷, 레이스 규모(자유 주행 / 6, 12, 20대)를 고른 뒤 → **Enter**를 누르면 바로 출발합니다.
URL로 바로 시작할 수도 있습니다: `.../f1/?car=f1-ferrari&track=monza&ai=19&laps=3`

## 로컬 실행

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # 타입 체크 + 프로덕션 빌드 (dist/)
npm run preview    # 빌드 결과 확인
npm run sim:test   # 헤드리스 테스트: 차량 3종 조작 + 서킷 5곳 봇 랩 + 레이싱 라인 (-- quick: 테스트 서킷만)
npm run race:test -- spielberg 20 1 f1-ferrari   # 헤드리스 20대 AI 레이스 (서킷, 대수, 랩, 차)
npx tsx scripts/handling.ts [차 id | all]      # 0-100, 최고속도, 제동 거리, 속도별 횡 g
npm run bench                                   # 로컬 Chrome/Edge로 전체 서킷 fps 측정 → docs/perf/
npx tsx scripts/shot.ts monza@f1-ferrari        # 헤드리스 스크린샷
npx tsx scripts/scene-stats.ts monza  # 서킷 장면의 삼각형/드로우콜 추정 (GPU 불필요)
npx tsx scripts/fetch-osm.ts [circuit]   # OpenStreetMap 주변 환경 데이터 다시 받기
```

## 조작

| 키 | 동작 |
|---|---|
| W / ↑ | 가속 |
| S / ↓ | 브레이크 (거의 정지한 상태에서는 후진) |
| A / ← , D / → | 조향 |
| Space | 핸드브레이크 (드리프트) |
| R | 가장 가까운 트랙 위치로 리셋 (이번 랩은 기록 무효) |
| L | 레이싱 라인 켜기/끄기 |
| M | 소리 켜기/끄기 |
| H | HUD 숨기기/표시 |
| Esc | 메뉴로 돌아가기 |

게임패드(표준 매핑): 왼쪽 스틱 조향, RT 가속, LT 브레이크, A 핸드브레이크, Y 리셋.

## 콘텐츠

### 차량: F1 2026 (10개 팀, 레이스는 팀당 2대 = 20대)

페라리, 메르세데스, 레드불, 맥라렌, 애스턴마틴, 알핀, 윌리엄스, 레이싱 불스, 하스, 아우디.

- 차체는 실제 2026 규정 기반 CAD 모델(아래 출처)을 단순화해서 씁니다. 팀 색은 게임에서 칠하고, 팀·스폰서 로고는 넣지 않습니다.
- 타이어 폭은 2026 규격(앞 280 mm, 뒤 375 mm)에 맞췄습니다.
- 출력, 무게, 최고속도, 크기는 공개 제원 기준 근삿값입니다(`src/vehicle/catalog/specs.ts`). 지금은 모든 팀이 같은 성능이고 색만 다릅니다.
- 레이스 상대는 실제 그리드처럼 팀메이트 1대 + 나머지 팀 각 2대입니다.
- 예전의 일반차·GT·하이퍼카 등급은 뺐습니다. 코드로 만든 차체(`ParametricCarVisual`, `FormulaCarVisual`)는 GLB를 못 불러올 때의 대체용과 테스트용으로 남아 있습니다.

### 서킷

| 서킷 | 길이 | 데이터 |
|---|---|---|
| Test Circuit | 1.1 km | 직접 만든 레이아웃 |
| Albert Park, Shanghai, Suzuka, Bahrain, Montréal, Barcelona | 4.4–5.8 km | 실제 중심선 + OSM 주변 환경 |
| Red Bull Ring, Silverstone, Spa, Hungaroring, Zandvoort, Monza | 4.3–7.0 km | 〃 |
| COTA, Mexico City, Interlagos, Yas Marina | 4.3–5.5 km | 〃 |

- 2026 F1 캘린더 중 TUMFTM 데이터셋에 있는 16곳을 캘린더 순서로 넣었습니다. 데이터셋에 없는 제다, 마이애미, 모나코, 바쿠, 싱가포르, 라스베이거스, 카타르, 마드리드는 아직 없습니다.
- 일부 레이아웃은 데이터셋이 만들어진 시점 기준입니다(예: 2021년 이전 야스 마리나).
- 서킷마다 지역 테마가 있습니다: 하늘 HDRI, 햇빛, 안개 농도, 잔디 색, 먼 지형(알프스 산맥, 아르덴 숲 언덕, 사막, 모래 언덕, 멕시코 고원 등). `?theme=`로 바꿔 볼 수 있습니다.
- 장난감 같던 나무는 기본으로 껐습니다. 먼 산의 숲은 지형 색으로 표현합니다.
- 화면 왼쪽 아래 미니맵에 트랙과 모든 차가 표시됩니다.

- 실제 서킷은 고저차 없이 평지로 재현합니다(원본 데이터가 2D).
- 연석은 코너에만, 그래블 트랩은 코너 바깥쪽에만 자동 배치됩니다.
- 노면은 바퀴마다 따로 판정합니다. 잔디는 미끄럽고(접지력 ×0.32), 그래블은 감속이 큽니다. 두 바퀴만 잔디에 올라가도 차가 그쪽으로 끌려갑니다.

### 물리

- 엔진: 출력(kW) 기반이라 속도가 붙을수록 힘이 줄고(힘 = 출력 / 속도), 최고속도는 출력과 공기저항으로 정해집니다.
- 타이어: 횡력과 종력(가속·제동)이 마찰원 μ·하중을 나눠 씁니다. 코너에서 브레이크를 밟거나 가속하면 횡 그립이 줄어듭니다.
- 다운포스가 하중에 더해져서 빠를수록 더 붙습니다. F1 측정값은 최고 339 km/h, 0-200 5.2 s, 200→0 제동 55 m, 300 km/h에서 5.9 g입니다(`scripts/handling.ts`).

### AI 레이스

- 메뉴에서 상대 0(자유 주행), 5, 11, 19대를 고릅니다. 랩 수는 1, 3, 5입니다.
- 실제 F1처럼 2열 엇갈린 그리드에서 출발하고, 3·2·1·GO 카운트다운이 있습니다. 플레이어는 그리드 중간에서 출발합니다.
- AI는 키보드와 같은 `VehicleInput`을 만들어 플레이어와 **같은 물리**로 달립니다.
  - 레이싱 라인을 따라가고, 차량 성능에 맞춰 코너 앞에서 미리 감속합니다.
  - 앞차가 길을 막으면 공간이 넓은 쪽으로 추월하고, 공간이 없으면 간격을 유지합니다.
  - 차마다 페이스와 선호 라인이 달라서(앞 그리드일수록 빠름) 대열이 흩어집니다.
- 화면에 순위(POS), 랩, 상위 6위 + 내 순위가 표시되고, 완주하면 결과표가 나옵니다.
- 상대 차량의 엔진 소리는 3D 위치에서 들립니다.
- 20대 레이스 헤드리스 테스트: Red Bull Ring 1랩, 20대 전원 완주(1위 107 s, 꼴찌 130 s). 물리 + AI는 스텝당 약 2 ms입니다.

### 관중

- 그랜드스탠드에 앉은 관중과 코너 바깥 잔디의 관중이 있습니다. 서킷당 약 2만 명입니다.
- 실제 서킷은 OSM의 `building=grandstand` 위치에 계단식 관중석을 세우고, 트랙을 향하도록 회전시킵니다.
- 셔츠 색은 인스턴스 색, 얼굴과 바지는 정점 색입니다. 응원 동작(점프)은 버텍스 셰이더로 처리합니다.
- 거리별 LOD를 적용합니다: 90 m까지 상세, 450 m까지 단순 박스, 그 너머는 그리지 않습니다.
- OSM 건물 벽에는 캔버스로 그린 창문 텍스처를 입혀서 회색 벽 느낌을 줄였습니다.

### 레이싱 라인 (L)

- 게임 도로 폭에 맞춰 직접 계산합니다(`RacingLineOptimizer.ts`). **최소 곡률**(아웃-인-아웃)로 풀고, 느린 코너는 에이펙스를 뒤로 미룹니다(슬로우 인 패스트 아웃).
- 선택한 차의 성능으로 각 지점의 목표 속도를 계산합니다(다운포스를 반영한 코너링 한계, 출력·공기저항 가속, 마찰 한계 제동).
- 앞쪽 400 m의 라인 색이 **현재 속도에 따라 실시간으로** 바뀝니다.
  - 빨강: 지금 브레이크를 밟지 않으면 코너 목표 속도까지 못 줄임
  - 노랑: 곧 브레이크
  - 초록: 지금 속도면 안전
- 속도를 줄이면 라인이 초록으로 바뀝니다.

### 랩타임

- 출발선을 지나면 시작합니다. 중심선 진행도로 한 바퀴를 판정합니다.
- 최고 기록은 차와 서킷 조합별로 브라우저(localStorage)에 저장됩니다.
- R로 리셋한 랩은 무효(✕) 처리됩니다.

### 엔진 소리

- 실제 레이스카 녹음 루프를 씁니다([OpenGameArt, CC0](https://opengameart.org/node/5633), 기본음 43 Hz). RPM에 따라 피치를 바꿉니다.
- 그 아래에 합성 저음층(서브옥타브 오실레이터와 연소 노이즈)을 깔아 무게감을 더합니다.
- 저음을 강조하고 2.6 kHz 부근을 줄이는 EQ로 "모기 소리"를 없앴고, 리버브로 공간감을 더했습니다.
- 차량별로 피치 범위가 다릅니다: F1 120→520 Hz, GT V8 42→330 Hz, 해치백 38→235 Hz.
- 자동 변속기가 RPM을 만들고, 변속할 때 소리가 잠깐 끊깁니다. 타이어 스키드음(횡슬립)과 바람 소리(속도)도 있습니다.
- 브라우저 정책상 첫 키 입력이나 클릭 이후에 소리가 납니다.

## 데이터 출처와 라이선스

| 자산 | 출처 | 라이선스 |
|---|---|---|
| 서킷 중심선, 폭, 레이싱 라인 | [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database) | LGPL-3.0 (원본은 OSM 기반) |
| 건물, 숲, 물, 주차장, 도로 | [OpenStreetMap](https://www.openstreetmap.org/copyright) (Overpass API) | © OpenStreetMap contributors, **ODbL** |
| 아스팔트, 잔디, 그래블 텍스처 | [Poly Haven](https://polyhaven.com) `asphalt_02`, `leafy_grass`, `gravelly_sand` | CC0 |
| 하늘 HDRI | Poly Haven `kloofendal_48d_partly_cloudy_puresky`, `qwantani_late_afternoon_puresky`, `kloofendal_overcast_puresky`, `kloofendal_28d_misty_puresky` | CC0 |
| F1 2026 차체 (팀 색은 게임에서 칠함) | ["F1 2026 concept (polygon model)"](https://sketchfab.com/3d-models/f1-2026-concept-polygon-model-ea3bde709b1e4dc9b0ec8557d106ed42) by [Qvist_designs](https://sketchfab.com/Qvist_Designs) — `scripts/build-f1-model.ts`로 단순화·부위 분리 | [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/) |
| 서킷 주변 위성사진 (땅 색) | [EOxCloudless 2016](https://cloudless.eox.at) by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017) | CC BY 4.0 |
| 서킷 주변 지형 높이 | Copernicus DEM GLO-30 © DLR e.V. 2010-2014, © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the EU and ESA | Copernicus DEM 라이선스 (무료, 출처 표기) |
| 엔진 녹음 루프 | [OpenGameArt "Racing car engine sound loops"](https://opengameart.org/node/5633) by domasx2 | CC0 |

- OSM 데이터는 `scripts/fetch-osm.ts`가 받습니다.
- 실제 지형(높이 + 위성사진)은 `scripts/fetch-terrain.ts`가 받아 `public/terrain/<서킷>/`에 저장합니다. 트랙 자체는 평지 그대로이고, 트랙에서 130 m 밖부터 450 m까지 서서히 실제 높낮이(근처 트랙 높이 기준)로 바뀝니다. 트랙 바로 옆(60~200 m)은 위성사진이 아스팔트·주차장과 섞여 보여서 기존 잔디색을 유지합니다.
- 받은 데이터는 TUM 좌표계에 강체 정합(그리드 탐색 + trimmed ICP)해서 `src/world/tracks/data/*_osm.json`으로 저장합니다(정합 오차 RMS 2~3 m).
- 파생 데이터도 ODbL이 적용됩니다.
- 위성사진은 상용 지도(Google, Esri 등) 라이선스가 게임 내 사용을 허용하지 않아 쓰지 않았습니다.
- 서킷 이름은 실제 위치를 가리키기 위해서만 사용합니다. 이 프로젝트는 어떤 서킷, 시리즈, 팀과도 관계가 없습니다.

## 실험용 URL 파라미터

| 파라미터 | 기본값 | 설명 |
|---|---|---|
| `car` / `track` | – | 메뉴 없이 바로 시작 (차 id 예: `f1-ferrari`, `porsche-911-gt3r`, `vw-golf-gti` / 서킷 id 예: `suzuka`, `monza`, `yasmarina`) |
| `menu` | – | 메뉴 강제 표시 |
| `shadows` | `1` | 그림자 on/off |
| `shadowmap` | `2048` | 그림자 맵 해상도 |
| `aa` | `1` | MSAA |
| `pr` | `2` | 최대 devicePixelRatio |
| `trees` | `0` | 나무 (기본 끔. 0보다 크면 OSM 숲 + Test Circuit에 km당 개수만큼) |
| `theme` | 서킷별 | 배경 테마 강제 (`default`, `alpine`, `lombardy`, `england`, `ardennes`) |
| `bench` | – | 벤치마크 모드 (초). 서킷을 빼면 전체 서킷을 차례로 측정 |
| `hz` | `60` | 고정 물리 스텝 주파수 |
| `sound` | `1` | 오디오 on/off |
| `debug` | `0` | Rapier 콜라이더 와이어프레임 |

개발 모드에서는 콘솔의 `sim` 객체로 내부에 접근할 수 있습니다 (`sim.perf.snapshot`, `sim.player`, `sim.racingLine`, `sim.lapTimer` 등).

## 구조

```
src/
  main.ts                    진입점: 메뉴 → 서킷 데이터 로드 → Game
  config.ts                  URL 쿼리 → SimConfig
  core/        Game.ts (조립 루트), GameLoop.ts (고정 timestep + 보간)
  physics/     PhysicsWorld.ts, PhysicsDebugRenderer.ts
  input/       VehicleInput.ts (장치 독립 입력), InputManager.ts, KeyboardInput.ts, GamepadInput.ts
  vehicle/
    VehicleConfig.ts         튜닝 수치
    VehicleController.ts     입력 → 명령 (페달 의미, 조향 스무딩, 속도별 조향각)
    VehiclePhysics.ts        Rapier 강체 + 레이캐스트 서스펜션 + 타이어 임펄스 + 노면 그립
    Gearbox.ts               자동 변속, RPM (사운드/HUD용)
    VehicleVisual.ts         VehicleVisual 인터페이스 + PrimitiveCarVisual (바퀴, 재질)
    Vehicle.ts               controller + physics + gearbox + visual, 렌더 보간
    catalog/                 F1 10개 팀 제원(specs.ts), 제원 → 물리/변속기/소리/점수(build.ts),
                             메뉴용 경량 목록(index.ts), 실제 크기 기반 차체(ParametricCarVisual.ts)
    cars/                    CarDefinition(물리 + 비주얼), 상대 선택, F1 차체(CarVisuals.ts), 형상 도구(shapes.ts)
  audio/       AudioSystem.ts (컨텍스트, 음소거), EngineSound.ts (엔진/스키드/바람 합성)
  race/        LapTimer.ts, RaceManager.ts, AIDriver.ts
  world/
    TrackLayout.ts           트랙 데이터 형식 + TUM CSV 파서
    Track.ts                 Track 인터페이스 + ProceduralTrack (도로, 연석, 그래블, 가드레일, 나무 …)
    OsmScenery.ts            OSM 건물, 숲, 물, 주차장, 도로 → 3D (병합 메시, 인스턴싱)
    RacingLineOptimizer.ts   최소 곡률 + 레이트 에이펙스 레이싱 라인 계산
    RacingLine.ts            속도 프로파일 + 다이내믹 색상 레이싱 라인
    themes.ts                서킷별 배경 테마 (하늘, 빛, 안개, 지형 색)
    Terrain.ts               서킷 밖 먼 지형 (평지 → 언덕/산맥)
    TrackTextures.ts         PBR 텍스처 스트리밍
    Environment.ts           HDRI 하늘, IBL, 태양 방향 자동 추정, 그림자, 안개
    tracks/                  서킷 카탈로그 + data/ (CSV, OSM JSON)
  camera/      FollowCamera.ts
  performance/ PerformanceMonitor.ts, Benchmark.ts (?bench), DynamicResolution.ts
  ui/          HUD.ts, Menu.ts, Minimap.ts
scripts/
  sim-test.ts                헤드리스 테스트 (CI에서도 실행)
  race-test.ts               헤드리스 20대 레이스
  handling.ts                차량 성능 측정 (가속, 최고속도, 제동, 횡 g)
  bench.ts / shot.ts         실제 브라우저 fps 벤치마크 / 스크린샷
  fetch-osm.ts               OSM 주변 환경 다운로드 + 정합 (Overpass 미러 순환)
  tracks-node.ts             Node 스크립트용 서킷 로더
public/
  textures/, hdri/           CC0 에셋 (게임 시작 후 스트리밍)
.github/workflows/deploy.yml GitHub Pages 자동 배포
```

### 데이터 흐름

```
Keyboard / Gamepad / (Mobile Gyro) / (Wheel) / (WebSocket)
        │  InputSource.read() → VehicleInput {throttle, brake, steer, handbrake}
        ▼
   InputManager  →  VehicleController  →  VehiclePhysics  →  Rapier step
                                                 ▲ 노면 그립/저항 (Track.surfaceAt)
        Vehicle.render(α) → VehicleVisual        Gearbox → CarAudio, HUD
```

## 차량 물리 (arcade raycast vehicle)

- 차체는 Rapier dynamic rigid body 하나입니다. 바퀴는 레이캐스트 스프링-댐퍼 서스펜션으로 처리합니다.
- 횡그립: 옆 미끄러짐을 일정 비율씩 상쇄하되 `μ × 하중`으로 제한하므로 한계를 넘으면 미끄러집니다. 핸드브레이크는 후륜 그립을 낮춥니다.
- 구동과 제동: 엔진 힘은 `1 − (v/vmax)²` 곡선을 따르고, 브레이크는 속도를 0에서 멈추게만 합니다. 공기 저항과 다운포스(`v²`)도 있습니다.
- 노면: 아스팔트, 연석, 잔디, 그래블마다 그립 배율과 추가 감속이 다릅니다.
- 모든 바퀴는 스텝 시작 시점의 속도 스냅샷으로 계산합니다(임펄스 적용 순서로 인한 쏠림 방지). 물리는 60 Hz 고정 timestep입니다.

## 현재 한계

- 고저차와 뱅크가 없습니다(평지 서킷).
- 타이어 모델이 단순하고, 변속은 소리와 HUD에만 반영되며 물리 구동력에는 영향이 없습니다.
- 차량은 절차적 모델이라 실차 수준의 디테일은 아닙니다(GLB로 교체 가능, 아래 참고).
- OSM 건물은 높이 정보가 없으면 기본 높이로 압출하고, 지붕 형태는 평평합니다.
- 모바일 터치 조작이 없어서 휴대폰으로는 아직 운전할 수 없습니다.
- AI는 단순한 규칙 기반이라 가끔 서로 부딪히거나 벽에 걸리고, 걸리면 자동으로 빠져나오거나 리셋됩니다.
- 메인 번들이 큽니다(rapier-compat의 WASM 포함, gzip 1.8 MB). 실제 서킷은 서킷별로 지연 로딩됩니다.

## 성능 최적화 (적용됨)

| 항목 | 내용 |
|---|---|
| 타일 컬링 | 나무, 가드레일, OSM 건물, 관중을 120~300 m 타일로 나눠 카메라와 그림자 카메라 모두에서 타일 단위로 컬링 (`TiledInstances`) |
| LOD | 나무: 160 m부터 저폴리. 관중: 90 m부터 박스, 450 m부터 생략 |
| 차량 병합 | 재질별 메시 병합으로 차량 1대 draw call 약 60 → 약 20 |
| 동적 해상도 | 평균 프레임이 20 ms를 넘으면 픽셀 비율을 낮추고, 여유가 생기면 다시 올림 (HUD "resolution") |
| 기타 | 카메라 far를 안개 끝(1.2 km)으로, 레이싱 라인은 바뀐 범위만 GPU 업로드, 물리 루프 할당 줄임 |

Monza 실측(`scene-stats`): 이전에는 매 프레임 약 78만 삼각형을 2번(본 패스 + 그림자) 그렸습니다. 타일링 후에는 그림자 패스가 약 3만 삼각형으로 줄었고, 본 패스는 시야 안의 타일만 그립니다.

## 다음에 적용하기 좋은 최적화

1. **나무 임포스터**: 먼 나무를 빌보드로 바꿉니다.
2. **AI 차량 LOD**: 먼 차량을 단순화하고 바퀴를 생략합니다.
3. **번들**: non-compat Rapier + 스트리밍 WASM 컴파일, vendor 청크를 분리합니다.
4. **텍스처**: JPG를 KTX2(Basis)로, HDRI를 압축 포맷으로 바꿉니다(현재 텍스처와 HDRI 약 12 MB).
5. **Web Worker 물리**, **WebGPU 렌더러** 비교 실험.

## GLB 차량 넣기

실제 예: 2026 F1 차체(`src/vehicle/cars/GltfF1Visual.ts`). 원본(Sketchfab glTF, 약 100만 삼각형)을 `assets-src/`에 받아 두고 `npm run model:f1`을 실행하면 `public/models/f1-2026.glb`(차체 6만/7천 삼각형 2단계 LOD, 바퀴 분리, 팀 색 칠할 부위 분리)가 만들어집니다. 원본 파일은 용량 때문에 저장소에 넣지 않습니다.

`VehicleVisual` 인터페이스(`root`, `updateWheels`, `dispose`)를 구현하면 물리 코드를 고치지 않고 비주얼만 바꿀 수 있습니다.

1. 라이선스가 확인된 GLB(예: Sketchfab CC-BY)를 `public/cars/`에 넣습니다.
2. `GLTFLoader`로 불러와 `root`에 추가합니다. 전방은 -Z, 원점은 차체 중심에 맞춥니다.
3. 바퀴 노드(`wheel_FL` 등)를 찾아 `updateWheels`에서 `suspensionLength`, `steerAngle`, `spin`을 적용합니다.
4. `src/vehicle/catalog/specs.ts`에 제원을 추가하고, `src/vehicle/cars/index.ts`의 `visualFor`에서 그 차의 비주얼을 GLB로 바꿉니다. 물리와 소리는 제원에서 자동으로 만들어집니다.

## GLB 트랙 넣기

`Track` 인터페이스(`root`, `bounds`, `materials`, `getSpawnPose`, `getResetPose`, `getCenterline`, `nearestIndex`, `spawnIndex`, `surfaceAt`, `dispose`)를 구현하는 `GltfTrack`을 만듭니다.
충돌은 `ColliderDesc.trimesh`로, 스폰과 중심선은 GLB 안의 empty 오브젝트나 `TrackLayout` JSON으로 지정합니다.
