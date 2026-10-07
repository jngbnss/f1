# web-sim-lab · Racing Prototype

브라우저에서 설치 없이 바로 실행되는 경량 3D 레이싱 시뮬레이터 프로토타입입니다.
이후 진행할 **브라우저 게임 최적화 실험**(LOD, instancing, Draco/Meshopt/KTX2, Worker, WebGPU 등)의 테스트베드로 쓰려고 만들었습니다.

- Vite + TypeScript (React 없음)
- Three.js (렌더링)
- Rapier (`@dimforge/rapier3d-compat`, WASM 물리)
- 외부 에셋 0개: 트랙과 차량을 모두 primitive geometry로 만듭니다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173 을 Chrome에서 열면 바로 주행 가능
npm run build      # 타입 체크 + 프로덕션 빌드 (dist/)
npm run preview    # 빌드 결과 확인
npm run sim:test   # 헤드리스 물리 테스트 (조작 검증 + 봇 1랩 완주)
```

## 조작

| 키 | 동작 |
|---|---|
| W / ↑ | 가속 |
| S / ↓ | 브레이크 (거의 정지한 상태에서는 후진) |
| A / ← , D / → | 조향 |
| Space | 핸드브레이크 (드리프트) |
| R | 가장 가까운 트랙 중심선으로 리셋 |
| H | HUD 숨기기/표시 |

게임패드(표준 매핑)도 바로 동작합니다: 왼쪽 스틱 = 조향, RT = 가속, LT = 브레이크, A = 핸드브레이크, Y = 리셋.

트랙 밖으로 떨어지면 출발 지점으로 자동 리셋되고, 차가 2.5초 이상 뒤집혀 있으면 자동으로 다시 세웁니다.

## 실험용 URL 파라미터

코드를 고치지 않고 렌더링/물리 설정을 바꿔 비교할 수 있습니다.

| 파라미터 | 기본값 | 설명 |
|---|---|---|
| `shadows` | `1` | 그림자 on/off |
| `shadowmap` | `2048` | 그림자 맵 해상도 |
| `aa` | `1` | MSAA |
| `pr` | `2` | 최대 devicePixelRatio |
| `trees` | `400` | 인스턴싱 나무 개수 (draw call은 개수와 무관하게 2개) |
| `hz` | `60` | 고정 물리 스텝 주파수 |
| `debug` | `0` | Rapier 콜라이더 와이어프레임 표시 |

예시: `http://localhost:5173/?shadows=0&pr=1&trees=5000`

개발 모드에서는 콘솔에서 `sim` 객체로 내부에 접근할 수 있습니다 (`sim.perf.snapshot`, `sim.player`, `sim.resetPlayer()` 등).

## 구조

```
src/
  main.ts                    진입점 (config 읽기 → Game 생성)
  config.ts                  URL 쿼리 → SimConfig
  core/
    Game.ts                  조립 루트: 렌더러/물리/월드/차량/입력/카메라/HUD 연결
    GameLoop.ts              고정 timestep 누산기 루프 + 렌더 보간 alpha
  physics/
    PhysicsWorld.ts          Rapier 초기화와 world 소유
    PhysicsDebugRenderer.ts  ?debug=1 콜라이더 와이어프레임
  input/
    VehicleInput.ts          장치 독립 입력 타입 + InputSource 인터페이스
    InputManager.ts          여러 InputSource를 하나의 VehicleInput으로 합침
    KeyboardInput.ts
    GamepadInput.ts
  vehicle/
    VehicleConfig.ts         차량 튜닝 수치 (차량 선택 = 이 객체 교체)
    VehicleController.ts     VehicleInput → VehicleCommands (페달 의미, 조향 스무딩, 속도별 조향각)
    VehiclePhysics.ts        Rapier 강체 + 레이캐스트 서스펜션 + 타이어 임펄스
    VehicleVisual.ts         VehicleVisual 인터페이스 + ProceduralCarVisual
    Vehicle.ts               controller + physics + visual 조합, 렌더 보간
  world/
    TrackLayout.ts           트랙 데이터 (중심선 제어점, 폭 등)
    Track.ts                 Track 인터페이스 + ProceduralTrack 구현
    Environment.ts           하늘, 조명, 안개, 차량을 따라다니는 그림자
  camera/
    FollowCamera.ts          3인칭 추적 카메라
  performance/
    PerformanceMonitor.ts    FPS, 프레임 타임, 물리/렌더 CPU 시간, renderer.info, heap
  ui/
    HUD.ts                   DOM 오버레이
scripts/
  sim-test.ts                헤드리스 물리 테스트
```

### 데이터 흐름

```
Keyboard / Gamepad / (Mobile Gyro) / (Wheel) / (WebSocket)
        │  InputSource.read() → VehicleInput {throttle, brake, steer, handbrake}
        ▼
   InputManager      여러 장치 합치기 (페달은 최댓값, 조향은 절댓값이 가장 큰 입력)
        ▼
 VehicleController   브레이크/후진 판단, 조향 속도 제한, 속도에 따른 조향각 축소
        │  VehicleCommands {drive, brake, handbrake, steerAngle}
        ▼
  VehiclePhysics     Rapier 강체에 힘 적용 → world.step()
        ▼
 Vehicle.render(α)   이전/현재 물리 상태를 보간 → VehicleVisual
```

입력 장치는 `VehicleInput`만 만들면 되고, 차량 쪽은 어떤 장치가 붙었는지 모릅니다. AI 차량이나 고스트는 `VehicleInput`(또는 `VehicleCommands`)을 직접 넣으면 됩니다.

## 차량 물리 (arcade raycast vehicle)

차체는 Rapier dynamic rigid body 하나와 box collider 하나뿐입니다. 바퀴용 강체나 조인트는 없습니다.

1. **서스펜션**: 바퀴마다 차체 아래로 레이를 쏘고, 압축량과 압축 속도로 스프링-댐퍼 힘을 계산해 임펄스로 적용합니다.
2. **횡방향 그립**: 접지점의 옆 미끄러짐 속도를 `grip` 비율만큼 상쇄하는 임펄스를 줍니다. 이 값은 `μ × 하중`으로 제한되므로 한계를 넘으면 자연스럽게 미끄러집니다. 앞바퀴 그립을 약간 낮게 잡아 고속에서 안정적인 언더스티어 성향입니다.
3. **구동/제동**: 후륜구동입니다. 엔진 힘은 최고 속도에 가까울수록 `1 − (v/vmax)²`로 줄어듭니다. 브레이크는 속도를 0에서 멈추게만 하고 반대 방향으로 밀지 않으며, 구름 저항도 포함합니다.
4. **핸드브레이크**: 뒷바퀴의 그립과 μ를 낮추고 제동을 걸어 드리프트가 나게 합니다.
5. **차체 힘**: 공기 저항(`v²`), 다운포스(`v²`), 최고 속도 안전 캡을 적용합니다.
6. **조향**: 키보드처럼 디지털 입력이어도 부드럽도록 조향 변화 속도를 제한합니다(복귀는 더 빠름). 최대 조향각은 저속 0.6 rad에서 고속 0.13 rad까지 줄어듭니다.
7. **안정성**: 무게중심을 낮추고 관성 텐서를 키우고 각감쇠를 적용했습니다. 모든 바퀴는 스텝 시작 시점의 속도 스냅샷으로 계산합니다(임펄스 적용 순서 때문에 한쪽으로 쏠리는 것을 막기 위함).
8. **고정 timestep**: 물리는 60 Hz 고정이고, 화면은 그 사이를 보간합니다. 60/120/144 Hz 모니터에서 같은 결과가 나오므로 고스트/멀티플레이 확장에 필요한 결정성의 기반이 됩니다.

튜닝 수치는 모두 `src/vehicle/VehicleConfig.ts`에 있습니다.

## 현재 한계

- 타이어 모델이 단순합니다(슬립 각/슬립 비율 곡선, 하중 이동 기반 마찰원 없음). 시뮬레이터라기보다 아케이드에 가깝습니다.
- 기어, 엔진 RPM, 사운드, 스키드 마크, 파티클이 없습니다.
- 트랙은 평지만 지원합니다(고저차와 뱅크 없음). 지면 콜라이더는 큰 박스 하나입니다.
- 랩타임, 체크포인트, AI, 고스트, 미니맵이 없습니다(중심선 API `Track.getCenterline()`은 준비되어 있음).
- 모바일 터치/자이로 입력이 아직 없습니다.
- `rapier3d-compat`이 WASM을 base64로 JS에 포함하므로 번들이 큽니다(약 4.9 MB, gzip 1.8 MB).
- 핸드브레이크 드리프트는 각도가 쉽게 커집니다. 카운터 스티어 보조가 없습니다.

## 다음에 적용하기 좋은 최적화

현재 수치 기준은 draw calls 약 48, 삼각형 약 5.6만, 물리 약 0.3 ms/step입니다.

1. **번들/로딩**: `@dimforge/rapier3d`(non-compat) + `.wasm` 파일 스트리밍 컴파일을 쓰고, three/rapier를 별도 청크로 분리해 캐시 효율을 높입니다.
2. **Instancing 확장**: 트리 수를 `?trees=` 파라미터로 바꿔 가며 instancing 효과를 측정할 수 있습니다. 커브(연석)와 라인도 하나의 merged geometry로 합칩니다.
3. **LOD / 임포스터**: 먼 나무를 빌보드로 바꾸고, 트랙을 청크로 나눈 뒤 frustum culling을 적용합니다(지금은 리본 하나라 항상 그려짐).
4. **그림자**: 현재는 차량을 따라가는 그림자 카메라 하나입니다. CSM이나 정적 오브젝트 lightmap 베이크와 비교해 볼 수 있습니다.
5. **에셋 압축**: GLB를 넣을 때 Meshopt/Draco + KTX2(Basis)로 압축하고 `?asset=` 파라미터로 A/B 비교합니다.
6. **Web Worker 물리**: `PhysicsWorld`를 Worker로 옮기고 transform만 SharedArrayBuffer로 전달합니다(이를 위해 물리 접근을 한곳으로 모아 두었습니다).
7. **WebGPU**: `three/webgpu`의 `WebGPURenderer`로 교체하고 같은 HUD 지표로 비교합니다.
8. **자동 벤치마크**: `sim:test`의 봇 랩을 브라우저에서 재생해 고정된 경로의 프레임 타임을 수집합니다(`PerformanceMonitor.history`).

## GLB 차량 넣기

물리와 비주얼이 분리되어 있으므로 비주얼만 교체하면 됩니다.

```ts
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VehicleVisual } from './vehicle/VehicleVisual';
import type { WheelState } from './vehicle/VehiclePhysics';

export class GltfCarVisual implements VehicleVisual {
  readonly root = new THREE.Group();
  private wheels: THREE.Object3D[] = [];

  static async load(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url);
    const v = new GltfCarVisual();
    // 모델 원점과 방향을 물리 차체에 맞춥니다 (전방 = -Z, 원점 = 차체 중심).
    v.root.add(gltf.scene);
    v.wheels = ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR'].map((n) => gltf.scene.getObjectByName(n)!);
    return v;
  }

  updateWheels(states: readonly WheelState[]) {
    states.forEach((s, i) => {
      // 기준 위치는 VehicleConfig.wheels[i].position, 서스펜션 길이만큼 아래로 내립니다
      this.wheels[i].position.y = /* baseY */ -s.suspensionLength;
      this.wheels[i].rotation.set(-s.spin, -s.steerAngle, 0, 'YXZ');
    });
  }
  dispose() { /* geometry/material dispose */ }
}
```

`Game.ts`에서 `new ProceduralCarVisual(DEFAULT_CAR)`를 `await GltfCarVisual.load('/cars/sports.glb')`로 바꾸면 됩니다. 모델 크기에 맞춰 `VehicleConfig`의 `halfExtents`, `wheels[].position`, `wheelRadius`를 조정하세요. 큰 GLB는 Meshopt/Draco 디코더를 `GLTFLoader`에 연결해 사용합니다.

## GLB 트랙 넣기

`Track` 인터페이스(`root`, `bounds`, `getSpawnPose`, `getResetPose`, `getCenterline`, `dispose`)를 구현하는 `GltfTrack`을 만듭니다.

1. 비주얼: `gltf.scene`을 `root`에 추가합니다.
2. 충돌: 이름 규칙(예: `COL_*`)이 있는 메시에서 `ColliderDesc.trimesh(vertices, indices)`로 fixed collider를 만듭니다. 시각용 메시와 충돌용 저폴리 메시를 분리하는 것을 권장합니다.
3. 스폰과 중심선: GLB 안의 빈 오브젝트(`SPAWN`, `CENTER_000…`)나 별도 JSON에서 읽습니다. 기존 `TrackLayout` 형식을 그대로 써도 됩니다.
4. `Game.ts`에서 `new ProceduralTrack(...)`를 `await GltfTrack.load(...)`로 교체합니다.

## 향후 확장 포인트

| 기능 | 붙일 위치 |
|---|---|
| 모바일 자이로 / 터치 | `InputSource` 구현 (`DeviceOrientationEvent` → `steer`) |
| WebSocket 모바일 컨트롤러 | 서버에서 받은 메시지를 `VehicleInput`으로 변환하는 `InputSource` |
| 레이싱 휠 | Gamepad API 축 매핑을 다르게 한 `InputSource` |
| AI 차량 | `getCenterline()` 기반 pure pursuit (`scripts/sim-test.ts`의 봇 참고) → `Vehicle.fixedUpdate()` |
| 랩타임 / 체크포인트 | 중심선 인덱스 진행도 추적 (`sim-test.ts`의 progress 계산과 같은 방식) |
| 고스트 | 고정 스텝마다 `VehicleInput` 또는 pose를 기록하고 재생 |
| 멀티플레이 | 고정 timestep과 입력 기반 구조라서 입력 동기화 또는 스냅샷 보간에 적합 |
| 차량 선택 | `VehicleConfig` + `VehicleVisual` 쌍을 교체 |
| WebGPU | `Game.ts`의 렌더러 생성부만 교체 |
