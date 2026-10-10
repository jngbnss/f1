# Benchmark: mobile-after-desktop

- Date: 2026-10-10T09:29:09.171Z
- GPU: ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)
- Resolution: 1894x980 (pixel ratio 1), quality tier high, dynamic resolution off, vsync off
- Scene: f1-ferrari × 20 cars (player on autopilot), 15 s per track after a 3 s warmup
- Target: 90 fps minimum (frame time ≤ 11.1 ms)

| Track | Avg fps | 1% low | Min fps | Frames < 90 fps | Physics ms | Render ms | Draw calls (avg/max) | Triangles (avg/max) | Heap MB | Load ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| monza | 48.3 | 31.5 | 22.8 | 97.79% | 3.7 | 14.99 | 1020 / 1491 | 2.91M / 4.52M | 165.8 | 10310 |
| spa | 58.3 | 35.1 | 29.3 | 91.76% | 3.29 | 12.07 | 869 / 1290 | 3.05M / 4.70M | 360.2 | 5986 |
| suzuka | 54 | 29.8 | 10.9 | 93.21% | 3.51 | 13.07 | 1022 / 1453 | 3.17M / 5.12M | 488.3 | 4290 |
| monaco | 51.9 | 21.7 | 14.7 | 93.06% | 3.76 | 13.38 | 921 / 1324 | 3.02M / 4.70M | 575.2 | 3639 |
