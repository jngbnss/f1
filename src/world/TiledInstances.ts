import * as THREE from 'three';

export interface InstanceLevel {
  /** null = draw nothing at this distance (culled level). */
  geometry: THREE.BufferGeometry | null;
  material: THREE.Material | null;
  /** Camera distance (m) from which this level is used (first level: 0). */
  distance: number;
}

export interface TiledInstancesOptions {
  name: string;
  /** Tile edge length (m). */
  tileSize?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/**
 * Instances spread over a large area, split into square tiles so each tile
 * can be frustum-culled (main camera AND shadow camera) on its own. With more
 * than one level, every tile becomes a THREE.LOD whose levels share the same
 * per-instance matrix/color buffers (distant tiles use cheap geometry).
 *
 * One InstancedMesh covering a whole circuit is never culled, so its full
 * triangle count is paid twice per frame (color + shadow pass).
 */
export class TiledInstances {
  readonly group = new THREE.Group();
  /** Number of tiles created (≈ potential draw calls per level). */
  readonly tileCount: number;

  constructor(levels: InstanceLevel[], matrices: THREE.Matrix4[], colors: THREE.Color[] | null, options: TiledInstancesOptions) {
    const size = options.tileSize ?? 300;
    this.group.name = options.name;
    const buckets = new Map<string, number[]>();
    const p = new THREE.Vector3();
    matrices.forEach((m, i) => {
      p.setFromMatrixPosition(m);
      const key = `${Math.floor(p.x / size)},${Math.floor(p.z / size)}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(i);
    });

    for (const [key, ids] of buckets) {
      const matrixAttr = new THREE.InstancedBufferAttribute(new Float32Array(ids.length * 16), 16);
      const colorAttr = colors ? new THREE.InstancedBufferAttribute(new Float32Array(ids.length * 3), 3) : null;
      ids.forEach((id, k) => {
        matrices[id].toArray(matrixAttr.array, k * 16);
        if (colorAttr && colors) colors[id].toArray(colorAttr.array, k * 3);
      });

      const meshes = levels.map((level) => {
        if (!level.geometry || !level.material) return null;
        const mesh = new THREE.InstancedMesh(level.geometry, level.material, ids.length);
        mesh.instanceMatrix = matrixAttr;
        if (colorAttr) mesh.instanceColor = colorAttr;
        mesh.castShadow = options.castShadow ?? false;
        mesh.receiveShadow = options.receiveShadow ?? false;
        mesh.computeBoundingSphere();
        mesh.name = `${options.name}[${key}]`;
        return mesh;
      });

      if (meshes.length === 1 && meshes[0]) {
        this.group.add(meshes[0]);
      } else {
        const lod = new THREE.LOD();
        lod.name = `${options.name}[${key}]`;
        // LOD itself has no bounds; position it at the tile center so the level
        // switch uses the distance to the tile, not to the world origin.
        const first = meshes.find((m) => m)!;
        const c = first.boundingSphere!.center.clone();
        lod.position.copy(c);
        meshes.forEach((m, i) => {
          if (m) {
            m.position.copy(c).negate();
            m.updateMatrix();
            m.computeBoundingSphere();
          }
          lod.addLevel(m ?? new THREE.Object3D(), levels[i].distance);
        });
        this.group.add(lod);
      }
    }
    this.tileCount = buckets.size;
  }
}
