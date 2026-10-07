# web-sim-lab · Racing

브라우저에서 설치 없이 바로 실행되는 경량 3D 레이싱 시뮬레이터입니다.
실제 서킷 4곳과 차량 3종이 있고, 엔진 소리, 다이내믹 레이싱 라인, 랩타임 기록을 지원합니다.
**브라우저 게임 최적화 실험**(LOD, instancing, 압축, 스트리밍, Worker, WebGPU 등)의 테스트베드로 쓰기 위해 만들었습니다.

- Vite + TypeScript (React 없음)
- Three.js (렌더링, PBR, HDRI)
- Rapier (`@dimforge/rapier3d-compat`, WASM 물리)

## 바로 해보기

배포 링크: **https://jngbnss.github.io/web-sim-lab/** (GitHub Pages, `main`에 push할 때마다 자동 배포)

링크를 열고 → 차와 서킷을 고른 뒤 → **Enter**를 누르면 바로 출발합니다.
URL로 바로 시작할 수도 있습니다: `.../web-sim-lab/?car=formula&track=monza`

## 로컬 실행

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # 타입 체크 + 프로덕션 빌드 (dist/)
npm run preview    # 빌드 결과 확인
npm run sim:test   # 헤드리스 테스트: 차량 3종 조작 + 서킷 5곳 봇 랩 + 레이싱 라인 (-- quick: 테스트 서킷만)
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

### 차량

| 차량 | 특징 |
|---|---|
| Formula | F1 스타일 오픈휠. 800 kg, 다운포스가 크고 최고 331 km/h. V10 사운드, 8단 |
| GT Sports | 프런트 엔진 GT. 1450 kg, 302 km/h. V8 사운드, 7단 |
| Street | 해치백. 1200 kg, 209 km/h. 4기통 사운드, 6단 |

- 차체는 측면 프로파일 곡선을 둥근 모서리로 압출한 뒤, 폭 함수(노즈를 좁히고 휠 부분을 부풀리고 위로 갈수록 좁힘)로 다듬어 만듭니다.
- 클리어코트 카페인트(MeshPhysicalMaterial)가 HDRI 하늘을 반사합니다.
- 실제 브랜드 디자인이나 리버리는 쓰지 않았습니다.

### 서킷

| 서킷 | 길이 | 데이터 |
|---|---|---|
| Test Circuit | 1.1 km | 직접 만든 레이아웃 |
| Red Bull Ring (Spielberg) | 4.32 km | 실제 중심선, 레이싱 라인, OSM 주변 환경 |
| Monza | 5.79 km | 〃 (건물 2,240개) |
| Silverstone | 5.89 km | 〃 |
| Spa-Francorchamps | 7.00 km | 〃 |

- 실제 서킷은 고저차 없이 평지로 재현합니다(원본 데이터가 2D).
- 연석은 코너에만, 그래블 트랩은 코너 바깥쪽에만 자동 배치됩니다.
- 잔디와 그래블에 올라가면 그립이 떨어지고 감속합니다.

### 레이싱 라인 (L)

- 실제 서킷의 라인은 TUMFTM이 오픈소스 최적화 툴로 계산한 **최소 곡률 레이싱 라인**입니다. Test Circuit은 중심선을 사용합니다.
- 선택한 차의 성능으로 각 지점의 목표 속도를 계산합니다(코너링 한계 → 가속/감속 패스).
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

- Web Audio로 합성하며 녹음 파일을 쓰지 않습니다.
  - 기통 수 × RPM으로 점화 주파수를 정하고, 하모닉 오실레이터, 연소 노이즈, 소프트 클리핑, 스로틀에 따른 로우패스를 조합합니다.
  - 자동 변속기가 RPM을 만들고, 변속할 때 소리가 잠깐 끊깁니다.
  - 타이어 스키드음(횡슬립), 바람 소리(속도)도 있습니다.
- 브라우저 정책상 첫 키 입력이나 클릭 이후에 소리가 납니다.

## 데이터 출처와 라이선스

| 자산 | 출처 | 라이선스 |
|---|---|---|
| 서킷 중심선, 폭, 레이싱 라인 | [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database) | LGPL-3.0 (원본은 OSM 기반) |
| 건물, 숲, 물, 주차장, 도로 | [OpenStreetMap](https://www.openstreetmap.org/copyright) (Overpass API) | © OpenStreetMap contributors, **ODbL** |
| 아스팔트, 잔디, 그래블 텍스처 | [Poly Haven](https://polyhaven.com) `asphalt_02`, `leafy_grass`, `gravelly_sand` | CC0 |
| 하늘 HDRI | Poly Haven `kloofendal_48d_partly_cloudy_puresky` | CC0 |

- OSM 데이터는 `scripts/fetch-osm.ts`가 받습니다.
- 받은 데이터는 TUM 좌표계에 강체 정합(그리드 탐색 + trimmed ICP)해서 `src/world/tracks/data/*_osm.json`으로 저장합니다(정합 오차 RMS 2~3 m).
- 파생 데이터도 ODbL이 적용됩니다.
- 위성사진은 상용 지도(Google, Esri 등) 라이선스가 게임 내 사용을 허용하지 않아 쓰지 않았습니다.
- 서킷 이름은 실제 위치를 가리키기 위해서만 사용합니다. 이 프로젝트는 어떤 서킷, 시리즈, 팀과도 관계가 없습니다.

## 실험용 URL 파라미터

| 파라미터 | 기본값 | 설명 |
|---|---|---|
| `car` / `track` | – | 메뉴 없이 바로 시작 (`formula`, `gt`, `street` / `test`, `spielberg`, `monza`, `silverstone`, `spa`) |
| `menu` | – | 메뉴 강제 표시 |
| `shadows` | `1` | 그림자 on/off |
| `shadowmap` | `2048` | 그림자 맵 해상도 |
| `aa` | `1` | MSAA |
| `pr` | `2` | 최대 devicePixelRatio |
| `trees` | `300` | km당 나무 수 (OSM 숲이 없는 Test Circuit에만 적용) |
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
    cars/                    CarDefinition 카탈로그, 차체 형상(shapes.ts), 차량 비주얼
  audio/       AudioSystem.ts (컨텍스트, 음소거), EngineSound.ts (엔진/스키드/바람 합성)
  race/        LapTimer.ts
  world/
    TrackLayout.ts           트랙 데이터 형식 + TUM CSV 파서
    Track.ts                 Track 인터페이스 + ProceduralTrack (도로, 연석, 그래블, 가드레일, 나무 …)
    OsmScenery.ts            OSM 건물, 숲, 물, 주차장, 도로 → 3D (병합 메시, 인스턴싱)
    RacingLine.ts            속도 프로파일 + 다이내믹 색상 레이싱 라인
    TrackTextures.ts         PBR 텍스처 스트리밍
    Environment.ts           HDRI 하늘, IBL, 태양 방향 자동 추정, 그림자, 안개
    tracks/                  서킷 카탈로그 + data/ (CSV, OSM JSON)
  camera/      FollowCamera.ts
  performance/ PerformanceMonitor.ts
  ui/          HUD.ts, Menu.ts
scripts/
  sim-test.ts                헤드리스 테스트 (CI에서도 실행)
  fetch-osm.ts               OSM 주변 환경 다운로드 + 정합
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
- 메인 번들이 큽니다(rapier-compat의 WASM 포함, gzip 1.8 MB). 실제 서킷은 서킷별로 지연 로딩됩니다.

## 다음에 적용하기 좋은 최적화

현재 기준 Monza: draw calls 약 140, 삼각형 약 150만(그림자 패스 포함).

1. **나무 타일링**: 인스턴스 나무를 300 m 타일로 나눠 frustum culling + 거리 LOD(먼 나무는 빌보드)를 적용합니다. 지금은 숲 전체가 항상 그려집니다.
2. **OSM 건물 LOD**: 먼 건물을 단순화하거나 청크 단위로 컬링합니다.
3. **번들**: non-compat Rapier + 스트리밍 WASM 컴파일, vendor 청크를 분리합니다.
4. **텍스처**: JPG를 KTX2(Basis)로, HDRI를 압축 포맷으로 바꿉니다(현재 텍스처와 HDRI 약 12 MB).
5. **Web Worker 물리**, **WebGPU 렌더러** 비교 실험.

## GLB 차량 넣기

`VehicleVisual` 인터페이스(`root`, `updateWheels`, `dispose`)를 구현하면 물리 코드를 고치지 않고 비주얼만 바꿀 수 있습니다.

1. 라이선스가 확인된 GLB(예: Sketchfab CC-BY)를 `public/cars/`에 넣습니다.
2. `GLTFLoader`로 불러와 `root`에 추가합니다. 전방은 -Z, 원점은 차체 중심에 맞춥니다.
3. 바퀴 노드(`wheel_FL` 등)를 찾아 `updateWheels`에서 `suspensionLength`, `steerAngle`, `spin`을 적용합니다.
4. `src/vehicle/cars/index.ts`의 `CARS`에 새 `CarDefinition`을 추가합니다. 이때 `physics`, `gearbox`, `engine`, `createVisual`을 지정합니다.

## GLB 트랙 넣기

`Track` 인터페이스(`root`, `bounds`, `materials`, `getSpawnPose`, `getResetPose`, `getCenterline`, `nearestIndex`, `spawnIndex`, `surfaceAt`, `dispose`)를 구현하는 `GltfTrack`을 만듭니다.
충돌은 `ColliderDesc.trimesh`로, 스폰과 중심선은 GLB 안의 empty 오브젝트나 `TrackLayout` JSON으로 지정합니다.
