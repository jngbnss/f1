/**
 * Shared helpers for the F1 body pipeline (scripts/build-f1-model.ts):
 * loads the Sketchfab glTF (one material, mesh cut into arbitrary chunks),
 * welds it into a single indexed triangle soup in car space (meters,
 * +X right, +Y up, -Z forward) and splits it into connected components
 * (the CAD model's separate solids: tyres, wings, suspension arms...).
 */
import { NodeIO } from '@gltf-transform/core';

export interface Soup {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface Component {
  id: number;
  tris: number[];
  min: [number, number, number];
  max: [number, number, number];
}

/** Loads every primitive, applies node transforms, converts to car space and welds vertices. */
export async function loadSoup(path: string, toCar: (p: [number, number, number]) => [number, number, number]): Promise<Soup> {
  const doc = await new NodeIO().read(path);
  const pos: number[] = [];
  const idx: number[] = [];
  const key = new Map<string, number>();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const p = prim.getAttribute('POSITION')!;
      const remap = new Uint32Array(p.getCount());
      const v = [0, 0, 0] as [number, number, number];
      for (let i = 0; i < p.getCount(); i++) {
        p.getElement(i, v);
        const w = [0, 1, 2].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]);
        const c = toCar([w[0], w[1], w[2]]);
        const k = `${Math.round(c[0] * 1e4)},${Math.round(c[1] * 1e4)},${Math.round(c[2] * 1e4)}`;
        let id = key.get(k);
        if (id === undefined) {
          id = pos.length / 3;
          key.set(k, id);
          pos.push(c[0], c[1], c[2]);
        }
        remap[i] = id;
      }
      const ind = prim.getIndices();
      const n = ind ? ind.getCount() : p.getCount();
      for (let i = 0; i < n; i += 3) {
        const a = remap[ind ? ind.getScalar(i) : i];
        const b = remap[ind ? ind.getScalar(i + 1) : i + 1];
        const c = remap[ind ? ind.getScalar(i + 2) : i + 2];
        if (a !== b && b !== c && a !== c) idx.push(a, b, c);
      }
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Connected components over shared vertices. */
export function components(soup: Soup): Component[] {
  const nv = soup.positions.length / 3;
  const parent = new Int32Array(nv).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const { indices: I, positions: P } = soup;
  for (let t = 0; t < I.length; t += 3) {
    const a = find(I[t]);
    parent[find(I[t + 1])] = a;
    parent[find(I[t + 2])] = a;
  }
  const byRoot = new Map<number, Component>();
  for (let t = 0; t < I.length; t += 3) {
    const r = find(I[t]);
    let c = byRoot.get(r);
    if (!c) byRoot.set(r, (c = { id: byRoot.size, tris: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    c.tris.push(t / 3);
    for (let k = 0; k < 3; k++) {
      const v = I[t + k] * 3;
      for (let d = 0; d < 3; d++) {
        c.min[d] = Math.min(c.min[d], P[v + d]);
        c.max[d] = Math.max(c.max[d], P[v + d]);
      }
    }
  }
  return [...byRoot.values()].sort((a, b) => b.tris.length - a.tris.length);
}
