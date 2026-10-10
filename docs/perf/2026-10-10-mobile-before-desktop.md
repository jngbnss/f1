# Benchmark: mobile-before-desktop

- Date: 2026-10-10T09:22:21.133Z
- GPU: ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)
- Resolution: 1894x980 (pixel ratio 1), dynamic resolution off, vsync off
- Scene: f1-ferrari × 20 cars (player on autopilot), 15 s per track after a 3 s warmup
- Target: 90 fps minimum (frame time ≤ 11.1 ms)

| Track | Avg fps | 1% low | Min fps | Frames < 90 fps | Physics ms | Render ms | Draw calls (avg/max) | Triangles (avg/max) | Heap MB | Load ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| monza | 64.2 | 31.9 | 14.1 | 85.06% | 2.57 | 11.46 | 1009 / 1491 | 2.89M / 4.52M | 224.5 | 7713 |
| spa | 63.3 | 29.8 | 17.7 | 79.05% | 3.16 | 10.92 | 884 / 1295 | 3.09M / 4.85M | 317.7 | 5238 |
| suzuka | 73.9 | 36 | 17.9 | 71.96% | 2.41 | 9.7 | 1029 / 1453 | 3.20M / 5.12M | 479.3 | 3871 |
| monaco | 54.7 | 24.2 | 16.8 | 86.74% | 3.68 | 12.62 | 956 / 1319 | 3.12M / 4.69M | 570.1 | 3284 |
