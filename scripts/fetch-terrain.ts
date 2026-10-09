/**
 * Real surroundings for every circuit from open data, baked into
 * public/terrain/<id>/ so the game needs no API at runtime:
 *
 *   npx tsx scripts/fetch-terrain.ts            # all circuits
 *   npx tsx scripts/fetch-terrain.ts spa        # one circuit
 *   npx tsx scripts/fetch-terrain.ts spa --dem  # heights only (imagery kept)
 *
 * - near.jpg: satellite colors around the track (tints the grass plane)
 * - far.jpg:  satellite colors of the whole landscape (terrain texture)
 * - dem.bin:  heights of the whole landscape (Int16, decimeters relative to the track's mean height)
 * - dem_near.bin: the same around the track at ~20 m spacing
 * - terrain.json: world rectangles of the above + attribution
 *
 * Sources:
 * - Imagery: EOxCloudless 2016 (Sentinel-2 cloudless) by EOX IT Services GmbH,
 *   CC BY 4.0, WMTS layer s2cloudless_3857 (https://cloudless.eox.at).
 * - Heights: Copernicus DEM GLO-30 (public COG tiles on AWS Open Data).
 *
 * World frame = the TUMFTM centerline frame. The rigid transform to
 * latitude/longitude is the same OSM alignment fetch-osm.ts uses; it is
 * cached per circuit in src/world/tracks/data/<Name>_geo.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fromUrl } from 'geotiff';
import jpeg from 'jpeg-js';
import { align, CIRCUITS, DATA_DIR, densify, overpass, projector, readCenterline, type Circuit, type V2 } from './fetch-osm';

/** Must match src/world/Terrain.ts (flat zone + landscape extent). */
const FLAT_MARGIN = 900;
const EXTENT = 14000;
/** Satellite tint for the grass plane reaches this far beyond the centerline bounds (m). */
const NEAR_MARGIN = 1000;
const IMAGE_SIZE = 2048;
const DEM_SIZE = 257;
const NEAR_ZOOM = 14;
const FAR_ZOOM = 13;
const USER_AGENT = 'web-sim-lab/0.1 (https://github.com/jngbnss/web-sim-lab; offline terrain build script)';
const ATTRIBUTION =
  'Imagery: EOxCloudless 2016 by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017, CC BY 4.0) · Heights: Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA';

interface Geo {
  lat0: number;
  lon0: number;
  theta: number;
  tx: number;
  ty: number;
  rms: number;
  inliers: number;
}

/** OSM alignment of the TUM centerline (same method as fetch-osm.ts), cached. */
async function geoFor(c: Circuit, tum: V2[]): Promise<Geo> {
  const file = new URL(`${c.file}_geo.json`, DATA_DIR);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Geo;
  const proj = projector(c.lat, c.lon);
  const radius = Math.round(Math.max(2500, Math.max(...tum.map((p) => Math.hypot(p[0], p[1]))) + 400));
  const lines = async (filter: string) => {
    const res = await overpass(`[out:json][timeout:120];way["highway"~"^(${filter})$"](around:${radius},${c.lat},${c.lon});out geom;`);
    return res.elements.filter((e) => e.geometry).flatMap((e) => densify(e.geometry!.map((g) => proj(g.lat, g.lon)), 2));
  };
  let t = align(tum, await lines('raceway'));
  if (t.inliers < 0.8) {
    const t2 = align(tum, await lines('primary|secondary|tertiary|unclassified|residential|service|raceway'));
    if (t2.inliers > t.inliers) t = t2;
  }
  const geo: Geo = { lat0: c.lat, lon0: c.lon, theta: t.theta, tx: t.tx, ty: t.ty, rms: +t.rms.toFixed(2), inliers: +t.inliers.toFixed(3) };
  writeFileSync(file, JSON.stringify(geo, null, 2));
  return geo;
}

/** World (x, z) -> [lat, lon]. Inverse of fetch-osm's toWorld. */
function unprojector(g: Geo): (x: number, z: number) => [number, number] {
  const kx = Math.cos((g.lat0 * Math.PI) / 180) * 111320;
  const ky = 110540;
  const cos = Math.cos(g.theta);
  const sin = Math.sin(g.theta);
  return (x, z) => {
    const y = -z;
    const ox = cos * x - sin * y + g.tx;
    const oy = sin * x + cos * y + g.ty;
    return [g.lat0 + oy / ky, g.lon0 + ox / kx];
  };
}

// ---- Satellite tiles (Web Mercator) ---------------------------------------

const tiles = new Map<string, Promise<{ data: Uint8Array; width: number } | null>>();
function tile(z: number, x: number, y: number) {
  const key = `${z}/${x}/${y}`;
  let p = tiles.get(key);
  if (!p) {
    p = (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch(`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${z}/${y}/${x}.jpg`, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(60000),
          });
          // Missing / non-image tiles (open sea, outside coverage): painted as water below.
          if (res.status === 404 || !(res.headers.get('content-type') ?? '').includes('jpeg')) return null;
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const img = jpeg.decode(new Uint8Array(await res.arrayBuffer()), { useTArray: true });
          return { data: img.data, width: img.width };
        } catch (e) {
          if (attempt === 3) throw e;
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      return null;
    })();
    tiles.set(key, p);
  }
  return p;
}

const mercator = (lat: number, lon: number, z: number): [number, number] => {
  const n = 256 * 2 ** z;
  const phi = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n];
};

/** Renders a world-aligned image of rect [x0, z0, x1, z1] (u = +x, v = +z). */
async function satellite(rect: number[], zoom: number, toLatLon: (x: number, z: number) => [number, number]) {
  const [x0, z0, x1, z1] = rect;
  const aspect = (x1 - x0) / (z1 - z0);
  const w = aspect >= 1 ? IMAGE_SIZE : Math.round(IMAGE_SIZE * aspect);
  const h = aspect >= 1 ? Math.round(IMAGE_SIZE / aspect) : IMAGE_SIZE;
  // Pixel -> global mercator pixel, then fetch every tile touched (in parallel batches).
  const coords = new Float64Array(w * h * 2);
  const needed = new Set<string>();
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const [lat, lon] = toLatLon(x0 + ((i + 0.5) / w) * (x1 - x0), z0 + ((j + 0.5) / h) * (z1 - z0));
      const [mx, my] = mercator(lat, lon, zoom);
      coords[(j * w + i) * 2] = mx;
      coords[(j * w + i) * 2 + 1] = my;
      needed.add(`${Math.floor(mx / 256)},${Math.floor(my / 256)}`);
    }
  const list = [...needed].map((k) => k.split(',').map(Number));
  for (let i = 0; i < list.length; i += 6) await Promise.all(list.slice(i, i + 6).map(([tx, ty]) => tile(zoom, tx, ty)));
  const loaded = new Map<string, { data: Uint8Array; width: number } | null>();
  for (const [tx, ty] of list) loaded.set(`${tx},${ty}`, await tile(zoom, tx, ty));

  const texel = (gx: number, gy: number, out: number[]) => {
    const t = loaded.get(`${Math.floor(gx / 256)},${Math.floor(gy / 256)}`);
    if (!t) return ((out[0] = 30), (out[1] = 52), (out[2] = 70));
    const k = ((Math.floor(gy) % 256) * t.width + (Math.floor(gx) % 256)) * 4;
    out[0] = t.data[k];
    out[1] = t.data[k + 1];
    out[2] = t.data[k + 2];
  };
  const rgba = new Uint8Array(w * h * 4);
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const c = [0, 0, 0];
  const d = [0, 0, 0];
  for (let p = 0; p < w * h; p++) {
    const mx = coords[p * 2] - 0.5;
    const my = coords[p * 2 + 1] - 0.5;
    const fx = mx - Math.floor(mx);
    const fy = my - Math.floor(my);
    texel(Math.floor(mx), Math.floor(my), a);
    texel(Math.floor(mx) + 1, Math.floor(my), b);
    texel(Math.floor(mx), Math.floor(my) + 1, c);
    texel(Math.floor(mx) + 1, Math.floor(my) + 1, d);
    for (let k = 0; k < 3; k++) rgba[p * 4 + k] = Math.round((a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (c[k] * (1 - fx) + d[k] * fx) * fy);
    rgba[p * 4 + 3] = 255;
  }
  return { w, h, rgba, tiles: list.length };
}

// ---- Heights (Copernicus DEM GLO-30, 1°x1° COG tiles) ------------------------

const demTiles = new Map<string, Promise<Awaited<ReturnType<typeof fromUrl>> | null>>();
function demTile(lat: number, lon: number) {
  const la = Math.floor(lat);
  const lo = Math.floor(lon);
  const key = `${la},${lo}`;
  let p = demTiles.get(key);
  if (!p) {
    const ns = `${la >= 0 ? 'N' : 'S'}${String(Math.abs(la)).padStart(2, '0')}_00`;
    const ew = `${lo >= 0 ? 'E' : 'W'}${String(Math.abs(lo)).padStart(3, '0')}_00`;
    const name = `Copernicus_DSM_COG_10_${ns}_${ew}_DEM`;
    const url = `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
    p = fetch(url, { method: 'HEAD' }).then((r) => (r.ok ? fromUrl(url) : null)); // missing tile = open sea
    demTiles.set(key, p);
  }
  return p;
}

/** Samples heights at many lat/lon points: one windowed read per DEM tile. */
async function heights(points: [number, number][]): Promise<Float32Array> {
  const out = new Float32Array(points.length);
  const byTile = new Map<string, number[]>();
  points.forEach(([lat, lon], i) => {
    const k = `${Math.floor(lat)},${Math.floor(lon)}`;
    let l = byTile.get(k);
    if (!l) byTile.set(k, (l = []));
    l.push(i);
  });
  for (const idx of byTile.values()) {
    const [lat0, lon0] = points[idx[0]];
    const tiff = await demTile(lat0, lon0);
    if (!tiff) continue;
    const image = await tiff.getImage();
    const [bx0, by0, bx1, by1] = image.getBoundingBox();
    const W = image.getWidth();
    const H = image.getHeight();
    const px = (lon: number) => ((lon - bx0) / (bx1 - bx0)) * W - 0.5;
    const py = (lat: number) => ((by1 - lat) / (by1 - by0)) * H - 0.5;
    let wx0 = Infinity;
    let wy0 = Infinity;
    let wx1 = -Infinity;
    let wy1 = -Infinity;
    for (const i of idx) {
      const [lat, lon] = points[i];
      wx0 = Math.min(wx0, Math.floor(px(lon)));
      wx1 = Math.max(wx1, Math.floor(px(lon)) + 2);
      wy0 = Math.min(wy0, Math.floor(py(lat)));
      wy1 = Math.max(wy1, Math.floor(py(lat)) + 2);
    }
    wx0 = Math.max(0, wx0);
    wy0 = Math.max(0, wy0);
    wx1 = Math.min(W, wx1);
    wy1 = Math.min(H, wy1);
    const [band] = (await image.readRasters({ window: [wx0, wy0, wx1, wy1] })) as unknown as Float32Array[];
    const ww = wx1 - wx0;
    const at = (x: number, y: number) => band[Math.min(Math.max(y - wy0, 0), wy1 - wy0 - 1) * ww + Math.min(Math.max(x - wx0, 0), ww - 1)];
    for (const i of idx) {
      const [lat, lon] = points[i];
      const x = px(lon);
      const y = py(lat);
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const fx = x - ix;
      const fy = y - iy;
      out[i] = (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Per-channel median color (sRGB 0..1): the "typical" ground the game tints against. */
const medianColor = (rgba: Uint8Array) =>
  [0, 1, 2].map((k) => {
    const l: number[] = [];
    for (let p = k; p < rgba.length; p += 16) l.push(rgba[p]);
    l.sort((a, b) => a - b);
    return +(l[l.length >> 1] / 255).toFixed(3);
  });

/** Finer heights (~20 m) around the track, where the ground meets the OSM scenery. */
async function nearDem(near: number[], base: number, toLatLon: (x: number, z: number) => [number, number], dir: URL): Promise<void> {
  const grid: [number, number][] = [];
  for (let j = 0; j < DEM_SIZE; j++)
    for (let i = 0; i < DEM_SIZE; i++)
      grid.push(toLatLon(near[0] + (i / (DEM_SIZE - 1)) * (near[2] - near[0]), near[1] + (j / (DEM_SIZE - 1)) * (near[3] - near[1])));
  const dem = await heights(grid);
  const dm = new Int16Array(dem.length);
  dem.forEach((h, i) => (dm[i] = Math.max(-32000, Math.min(32000, Math.round((h - base) * 10)))));
  writeFileSync(new URL('dem_near.bin', dir), new Uint8Array(dm.buffer));
}

async function processCircuit(c: Circuit): Promise<void> {
  console.log(`\n${c.id}`);
  const tum = readCenterline(c);
  const geo = await geoFor(c, tum);
  const toLatLon = unprojector(geo);
  console.log(`  alignment θ=${((geo.theta * 180) / Math.PI).toFixed(2)}°, rms ${geo.rms} m`);

  const xs = tum.map((p) => p[0]);
  const zs = tum.map((p) => -p[1]);
  const bounds = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
  const grow = (m: number) => [bounds[0] - m, bounds[1] - m, bounds[2] + m, bounds[3] + m].map(Math.round);
  const near = grow(NEAR_MARGIN);
  const far = grow(FLAT_MARGIN + EXTENT);

  // Heights: mean along the centerline is the game's y = 0.
  const centerline = tum.filter((_, i) => i % 10 === 0).map(([x, y]) => toLatLon(x, -y));
  const trackHeights = await heights(centerline);
  const base = trackHeights.reduce((s, h) => s + h, 0) / trackHeights.length;
  const grid: [number, number][] = [];
  for (let j = 0; j < DEM_SIZE; j++)
    for (let i = 0; i < DEM_SIZE; i++)
      grid.push(toLatLon(far[0] + (i / (DEM_SIZE - 1)) * (far[2] - far[0]), far[1] + (j / (DEM_SIZE - 1)) * (far[3] - far[1])));
  const dem = await heights(grid);
  const dm = new Int16Array(dem.length);
  dem.forEach((h, i) => (dm[i] = Math.max(-32000, Math.min(32000, Math.round((h - base) * 10)))));
  const span = Math.max(...trackHeights) - Math.min(...trackHeights);
  console.log(`  heights: track ${base.toFixed(0)} m (±${(span / 2).toFixed(0)}), landscape ${(Math.min(...dem) - base).toFixed(0)}..+${(Math.max(...dem) - base).toFixed(0)} m`);

  const dir = new URL(`../public/terrain/${c.id}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('dem.bin', dir), new Uint8Array(dm.buffer));
  await nearDem(near, base, toLatLon, dir);
  if (demOnly) {
    const meta = JSON.parse(readFileSync(new URL('terrain.json', dir), 'utf8'));
    meta.demNear = { rect: near, size: DEM_SIZE, scale: 0.1 };
    writeFileSync(new URL('terrain.json', dir), JSON.stringify(meta, null, 2));
    return;
  }

  const nearImg = await satellite(near, NEAR_ZOOM, toLatLon);
  writeFileSync(new URL('near.jpg', dir), jpeg.encode({ data: nearImg.rgba, width: nearImg.w, height: nearImg.h }, 82).data);
  const farImg = await satellite(far, FAR_ZOOM, toLatLon);
  writeFileSync(new URL('far.jpg', dir), jpeg.encode({ data: farImg.rgba, width: farImg.w, height: farImg.h }, 82).data);
  console.log(`  imagery: near ${nearImg.w}x${nearImg.h} (${nearImg.tiles} tiles), far ${farImg.w}x${farImg.h} (${farImg.tiles} tiles)`);

  const meta = {
    attribution: ATTRIBUTION,
    fetched: new Date().toISOString().slice(0, 10),
    baseHeight: +base.toFixed(1),
    trackHeightSpan: +span.toFixed(1),
    near: { rect: near, median: medianColor(nearImg.rgba) },
    far: { rect: far },
    dem: { rect: far, size: DEM_SIZE, scale: 0.1 },
    demNear: { rect: near, size: DEM_SIZE, scale: 0.1 },
  };
  writeFileSync(new URL('terrain.json', dir), JSON.stringify(meta, null, 2));
}

/** --dem: recompute only the height grids of already fetched circuits (no imagery). */
const demOnly = process.argv.includes('--dem');
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
for (const c of CIRCUITS.filter((c) => !only || c.id === only)) await processCircuit(c);
