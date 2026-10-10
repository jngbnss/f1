# Benchmark: mobile-before-preset

- Date: 2026-10-10T09:24:41.671Z
- GPU: ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)
- Resolution: 1894x980 (pixel ratio 1), dynamic resolution off, vsync off
- Scene: f1-ferrari × 20 cars (player on autopilot), 15 s per track after a 3 s warmup
- Target: 90 fps minimum (frame time ≤ 11.1 ms)

| Track | Avg fps | 1% low | Min fps | Frames < 90 fps | Physics ms | Render ms | Draw calls (avg/max) | Triangles (avg/max) | Heap MB | Load ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| monza | 82.9 | 47.6 | 29.6 | 59.05% | 1.88 | 8.63 | 853 / 1269 | 2.53M / 4.30M | 186.2 | 8764 |
| spa | 92.9 | 37.7 | 6.7 | 37.8% | 2.08 | 7.27 | 714 / 1077 | 2.77M / 4.39M | 365.4 | 4808 |
| suzuka | 84 | 46.5 | 26.1 | 56.24% | 2.37 | 7.89 | 880 / 1207 | 2.92M / 4.56M | 493.4 | 3934 |
| monaco | 78.9 | 33.1 | 22.3 | 57.4% | 2.64 | 8.25 | 758 / 1095 | 2.54M / 4.24M | 577.2 | 3360 |
