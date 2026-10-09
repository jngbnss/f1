/**
 * Woodland mask from the near satellite image: OSM only knows a fraction of
 * the trees around many circuits (Monza's park is almost all woods, mapped
 * as "park"). Dark, green pixels of the Sentinel-2 image are canopy.
 *
 *   npx tsx scripts/bake-woods.ts <terrainId> <DataName> [debug.jpg]
 *   e.g. npx tsx scripts/bake-woods.ts monza Monza
 *
 * Writes src/world/tracks/data/<DataName>_woods.json: a bitmask (base64,
 * row-major, z rows) of CELL-metre cells over the near image rectangle.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';

const [id, name, debug] = process.argv.slice(2);
if (!id || !name) throw new Error('usage: bake-woods.ts <terrainId> <DataName> [debug.jpg]');
const CELL = 4;

const meta = JSON.parse(readFileSync(`public/terrain/${id}/terrain.json`, 'utf8')) as { near: { rect: [number, number, number, number] } };
const img = jpeg.decode(readFileSync(`public/terrain/${id}/near.jpg`), { useTArray: true });
const [x0, z0, x1, z1] = meta.near.rect;
const w = Math.floor((x1 - x0) / CELL);
const h = Math.floor((z1 - z0) / CELL);

const px = (u: number, v: number) => {
  const i = (Math.min(img.height - 1, Math.floor(v * img.height)) * img.width + Math.min(img.width - 1, Math.floor(u * img.width))) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

const bits = new Uint8Array(Math.ceil((w * h) / 8));
let count = 0;
const out = debug ? new Uint8Array(w * h * 4) : null;
for (let j = 0; j < h; j++)
  for (let i = 0; i < w; i++) {
    const [r, g, b] = px((i + 0.5) / w, (j + 0.5) / h);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // Canopy: dark, green-dominant (fields are brighter, roofs red/grey, roads light).
    const woods = (lum < 52 && g >= r + 2 && g >= b) || (lum < 36 && g >= r - 4);
    if (woods) {
      bits[(j * w + i) >> 3] |= 1 << ((j * w + i) & 7);
      count++;
    }
    if (out) {
      const k = (j * w + i) * 4;
      out[k] = woods ? 0 : r;
      out[k + 1] = woods ? 255 : g;
      out[k + 2] = woods ? 0 : b;
      out[k + 3] = 255;
    }
  }

writeFileSync(
  `src/world/tracks/data/${name}_woods.json`,
  JSON.stringify({ source: 'EOxCloudless 2016 (Copernicus Sentinel data, CC BY 4.0), dark-green pixels', rect: [x0, z0, x0 + w * CELL, z0 + h * CELL], cell: CELL, w, h, bits: Buffer.from(bits).toString('base64') }),
);
console.log(`${name}: ${w}x${h} cells, woods ${((100 * count) / (w * h)).toFixed(1)}% (${((count * CELL * CELL) / 1e6).toFixed(2)} km²)`);
if (out && debug) writeFileSync(debug, jpeg.encode({ data: out, width: w, height: h }, 85).data);
