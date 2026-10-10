# Real circuit data

The circuit CSVs `Shanghai`, `Suzuka`, `Sakhir`, `Montreal`, `Spa`, `Monza`,
`MexicoCity` and `SaoPaulo` come unmodified from
[TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database)
(Technical University of Munich, Institute of Automotive Technology),
licensed under **LGPL-3.0**.

The original centerlines were derived from GPS points of the
[OpenStreetMap](https://www.openstreetmap.org/copyright) project
(© OpenStreetMap contributors, ODbL), smoothed by TUMFTM; track widths were
extracted from satellite images.

Format: `# x_m, y_m, w_tr_right_m, w_tr_left_m` — meters, x = east, y = north,
first point ≈ start/finish line, points in driving direction.

The data is 2D (no elevation), so all circuits are rendered flat.
Circuit names are used only to identify the real-world location of each layout;
this project is not affiliated with or endorsed by any circuit, series or team.

## Racing lines

`*_raceline.csv` (four circuits) — minimum-curvature racing lines from the same
TUMFTM repository (LGPL-3.0), kept for reference. The game no longer loads
them: it computes its own line on the widened game road
(`src/world/RacingLineOptimizer.ts`).

Some dataset layouts predate recent changes to the real circuits (e.g. Yas
Marina before 2021, Barcelona with the final chicane).

`Silverstone`, `Budapest`, `Austin`, `Zandvoort` and `Spielberg` are the
TUMFTM files smoothed by `scripts/smooth-centerline.ts` (300 passes, ≤ 5 m
shift): their local curvature spikes made fast corners slow (Abbey, flat out in
reality, was a 41 m-radius line at 100 km/h). With it their ideal laps sit at
~1.12-1.16x the real 2025 poles like the other circuits.

`Melbourne` (2022 layout), `Catalunya` (2023, no final chicane) and `YasMarina`
(2021 layout) are built from OpenStreetMap circuit relations by
`scripts/fetch-osm-circuit.ts` (© OpenStreetMap contributors, ODbL), in the same
frame as before; their widths come from the TUMFTM files they replaced
(LGPL-3.0). `Monaco.csv` is built from OSM too (`scripts/fetch-monaco.ts`).

Elevation (`*_elev.json`, `scripts/bake-elevation.ts`) is used where the DEM
agrees with the real circuit; Albert Park, Montréal and Yas Marina stay flat
(the DEM's tree canopy and buildings made up 7-11 % grades there), Zandvoort too (its
8 m of dunes broke the pit lane and the banking is not modelled), Barcelona's
grade is capped at 8 %.

## Surroundings (`*_osm.json`)

Buildings, forests, water, car parks and roads around each circuit, downloaded
from **OpenStreetMap** via the Overpass API by `scripts/fetch-osm.ts` and
rigidly aligned to the TUMFTM frame (RMS error ≈ 1–3 m; street circuits such as
Albert Park are aligned to the public road network, ≈ 7 m).

Albert Park's automatic fit locked onto the street grid ~870 m south-west of
the park (good RMS, wrong place). Its scenery, satellite / DEM rectangles and
georeference were moved onto the park roads by `scripts/realign-scenery.ts`
(see `alignment.corrected` in `Melbourne_osm.json`); the track now runs round
Albert Park Lake as it should.

© OpenStreetMap contributors. This derived data is made available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
