# Benchmark: mobile-after-mid

- Date: 2026-10-10T09:37:02.855Z
- GPU: ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)
- Resolution: 1894x980 (pixel ratio 1), quality tier mid, dynamic resolution off, vsync off
- Scene: f1-ferrari × 20 cars (player on autopilot), 15 s per track after a 3 s warmup
- Target: 90 fps minimum (frame time ≤ 11.1 ms)

| Track | Avg fps | 1% low | Min fps | Frames < 90 fps | Physics ms | Render ms | Draw calls (avg/max) | Triangles (avg/max) | Heap MB | Load ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| monza | 72.6 | 41.3 | 20.9 | 77.59% | 2.34 | 9.61 | 825 / 1218 | 2.21M / 3.83M | 159.4 | 10088 |
| spa | 75.5 | 42.6 | 27.2 | 70.85% | 2.82 | 8.55 | 711 / 1053 | 2.50M / 3.88M | 336.3 | 6075 |
| suzuka | 73.7 | 44.6 | 22.4 | 74.3% | 2.8 | 8.9 | 818 / 1181 | 2.29M / 3.83M | 489.4 | 4936 |
| monaco | 69.1 | 32.3 | 9.3 | 78.32% | 3 | 9.36 | 738 / 1070 | 2.12M / 3.59M | 551.3 | 3747 |
