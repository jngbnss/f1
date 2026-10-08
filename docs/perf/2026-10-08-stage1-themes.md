# Benchmark: stage1-themes

- Date: 2026-10-08T13:50:41.457Z
- GPU: ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)
- Resolution: 1902x984 (pixel ratio 1), dynamic resolution off, vsync off
- Scene: formula × 20 cars (player on autopilot), 40 s per track after a 3 s warmup
- Target: 90 fps minimum (frame time ≤ 11.1 ms)

| Track | Avg fps | 1% low | Min fps | Frames < 90 fps | Physics ms | Render ms | Draw calls (avg/max) | Triangles (avg/max) | Heap MB | Load ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| test | 420 | 222.2 | 113.6 | 0% | 0.14 | 2.01 | 448 / 572 | 489k / 674k | 89.1 | 1360 |
| spielberg | 432.3 | 217.4 | 78.1 | 0.01% | 0.18 | 1.9 | 338 / 541 | 571k / 938k | 179.2 | 1448 |
| monza | 282.9 | 172.4 | 116.3 | 0% | 0.3 | 2.96 | 588 / 671 | 767k / 1.05M | 262.9 | 1040 |
| silverstone | 377 | 200 | 128.2 | 0% | 0.23 | 2.18 | 449 / 653 | 705k / 984k | 340.7 | 950 |
| spa | 503 | 238.1 | 61.3 | 0.01% | 0.18 | 1.58 | 297 / 557 | 567k / 911k | 386.7 | 873 |
