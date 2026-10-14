# CAD 설계 차량을 게임에 넣는 방법 (외형 교체)

## 결론

- CAD로 설계한 차량을 넣어 **달리게 할 수 있다.** 단, CAD 형상은 **외형(비주얼)에만** 쓰인다.
- 주행 성능(가속·최고속도·그립·공력)은 형상이 아니라 `src/vehicle/catalog/specs.ts`의 숫자 스펙에서 나온다.
- 형상 기반 공력/무게중심 계산은 현재 구조에 없다. 성능을 바꾸려면 스펙 숫자를 따로 조정한다.

## 현재 구조

| 구분 | 위치 | 역할 |
| --- | --- | --- |
| 물리 | `src/vehicle/VehiclePhysics.ts` | 차체 = 박스 콜라이더(`halfExtents`), 바퀴 4개 = 레이캐스트 서스펜션 + Pacejka 타이어 |
| 스펙 | `src/vehicle/catalog/specs.ts` | 질량·출력·최고속도·치수(길이, 폭, 높이, 휠베이스) |
| 스펙→물리 | `src/vehicle/catalog/build.ts` | 스펙에서 항력·다운포스·서스펜션·브레이크 등 `VehicleConfig` 계산 |
| F1 외형 | `src/vehicle/cars/GltfF1Visual.ts` | `public/models/f1-2026.glb` 로드, 팀 색 셰이더 |
| GLB 생성 | `scripts/build-f1-model.ts` | 원본 모델 → 게임용 GLB(LOD 2단, 바퀴 분리, meshopt 압축) |
| 외형 선택 | `src/vehicle/cars/index.ts` | 차종별로 Visual 클래스 선택 |

## 모델 준비 (사용자 작업)

1. **포맷**: STEP/IGES 등 CAD 원본 → Blender(또는 CAD의 glTF 내보내기)로 **GLB** 변환.
2. **단위/축**: 미터 단위, Y-up. 차 앞쪽 방향은 기존 GLB와 맞춘다.
3. **노드 분리**: 차체 1개 + 바퀴 4개를 별도 노드로. 바퀴 피벗(원점)은 **바퀴 중심**(회전축)에 둔다.
4. **치수**: 현재 F1 기준 휠베이스 약 3.5 m, 바퀴 좌우 ±0.81 m. 크게 다르면 스펙 `dims`도 맞춘다.
5. **폴리곤 감량**: CAD 원본은 너무 무겁다. Decimate 등으로 줄여 GLB 수 MB 이하 권장.
6. **재질**: 기본 PBR(색/금속도/거칠기) 정도로 단순하게.

## 코드 연결 (구현 시 할 일)

1. GLB를 `public/models/`에 둔다.
2. `GltfF1Visual.ts`의 로드 경로와 노드 이름 매칭을 새 모델에 맞춘다. LOD가 없으면 단일 메시로 처리하도록 분기.
3. 팀 색 셰이더는 모델 좌표 기준으로 칠하므로, 새 모델에선 우선 끄고 모델 자체 재질을 쓴다.
4. 차체 높이: 로더가 `suspensionRestLength`·정적 처짐·바퀴 Y로 차체 위치를 계산한다(`bodyY`). 모델 바퀴 높이 상수(`MODEL_WHEEL_Y`)를 새 모델에 맞춘다.
5. 필요하면 `specs.ts`에 새 차량 스펙을 추가하고 `cars/index.ts`에서 새 Visual로 연결.

## 하지 않는 것 (현재 범위 밖)

- 형상에서 공력계수(Cd, 다운포스) 자동 계산.
- 메시 기반 충돌(콜라이더는 박스 유지).
- 형상에서 질량·무게중심 자동 계산.
