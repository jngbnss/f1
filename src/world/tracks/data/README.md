# Real circuit data

`Spielberg.csv`, `Monza.csv`, `Silverstone.csv`, `Spa.csv` come unmodified from
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

`*_raceline.csv` — minimum-curvature racing lines from the same TUMFTM
repository (LGPL-3.0), computed with their open-source
[global_racetrajectory_optimization](https://github.com/TUMFTM/global_racetrajectory_optimization).

## Surroundings (`*_osm.json`)

Buildings, forests, water, car parks and roads around each circuit, downloaded
from **OpenStreetMap** via the Overpass API by `scripts/fetch-osm.ts` and
rigidly aligned to the TUMFTM frame (RMS error ≈ 2–3 m).

© OpenStreetMap contributors. This derived data is made available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
