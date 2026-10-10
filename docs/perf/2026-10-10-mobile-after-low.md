# Benchmark: mobile-after-low

- Date: 2026-10-10T09:34:27.287Z
- GPU: ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)
- Resolution: 1420x735 (pixel ratio 0.75), quality tier low, dynamic resolution off, vsync off
- Scene: f1-ferrari × 20 cars (player on autopilot), 15 s per track after a 3 s warmup
- Target: 90 fps minimum (frame time ≤ 11.1 ms)

| Track | Avg fps | 1% low | Min fps | Frames < 90 fps | Physics ms | Render ms | Draw calls (avg/max) | Triangles (avg/max) | Heap MB | Load ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| monza | 132.7 | 73.5 | 38 | 9.05% | 1.04 | 5.34 | 576 / 689 | 917k / 1.28M | 174.2 | 8119 |
| spa | 141.8 | 79.4 | 62.5 | 5.88% | 1.17 | 4.77 | 469 / 585 | 982k / 1.30M | 312.1 | 5731 |
| suzuka | 135.1 | 78.1 | 41.3 | 8.14% | 1.26 | 4.98 | 491 / 618 | 1.01M / 1.37M | 427.6 | 4165 |
| monaco | 110.5 | 42.7 | 27.9 | 19.96% | 1.67 | 5.94 | 504 / 583 | 1.11M / 1.45M | 516.3 | 2989 |
