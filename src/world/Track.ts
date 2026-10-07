import * as THREE from 'three';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { Pose } from '../vehicle/VehiclePhysics';
import type { TrackLayout } from './TrackLayout';

/**
 * What the game needs from a track. ProceduralTrack implements it from a
 * TrackLayout; a future GltfTrack would implement it from a GLB
 * (visual mesh + trimesh collider + spawn/centerline empties).
 */
export interface Track {
  readonly name: string;
  readonly root: THREE.Object3D;
  /** World-space bounds of the drivable area (used for out-of-world checks). */
  readonly bounds: THREE.Box3;
  getSpawnPose(): Pose;
  /** Pose on the centerline closest to `near`, facing the driving direction. */
  getResetPose(near: THREE.Vector3): Pose;
  /** Closed centerline samples in driving order (AI racing line, lap timing, minimap). */
  getCenterline(): readonly THREE.Vector3[];
  dispose(): void;
}

const UP = new THREE.Vector3(0, 1, 0);
const SPAWN_HEIGHT = 1.2;

/** Deterministic PRNG so scenery is identical across runs (fair perf comparisons). */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ProceduralTrackOptions {
  treeCount: number;
}

export class ProceduralTrack implements Track {
  readonly name: string;
  readonly root = new THREE.Group();
  readonly bounds = new THREE.Box3();

  /** Centerline samples + unit tangents/right vectors (y = 0). */
  private readonly points: THREE.Vector3[] = [];
  private readonly tangents: THREE.Vector3[] = [];
  private readonly rights: THREE.Vector3[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly bodies: import('@dimforge/rapier3d-compat').RigidBody[] = [];

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly layout: TrackLayout,
    options: ProceduralTrackOptions,
  ) {
    this.name = layout.name;
    this.root.name = `Track:${layout.name}`;
    this.sampleCenterline();

    const pad = layout.roadWidth / 2 + layout.runoff + 2;
    for (const p of this.points) this.bounds.expandByPoint(p);
    this.bounds.expandByVector(new THREE.Vector3(pad, 0, pad));
    this.bounds.max.y = 50;
    this.bounds.min.y = -1;

    this.buildGround();
    this.buildRoad();
    this.buildCurbs();
    this.buildBarriers();
    this.buildStartLine();
    if (options.treeCount > 0) this.buildTrees(options.treeCount);
  }

  getSpawnPose(): Pose {
    // A few meters behind the start line.
    const back = Math.round(8 / this.layout.sampleSpacing);
    return this.poseAt((this.points.length - back) % this.points.length);
  }

  getResetPose(near: THREE.Vector3): Pose {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      const d = (p.x - near.x) ** 2 + (p.z - near.z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return this.poseAt(best);
  }

  getCenterline(): readonly THREE.Vector3[] {
    return this.points;
  }

  dispose(): void {
    for (const b of this.bodies) this.physics.world.removeRigidBody(b);
    for (const d of this.disposables) d.dispose();
    this.root.removeFromParent();
  }

  // --------------------------------------------------------------------

  private poseAt(i: number): Pose {
    const t = this.tangents[i];
    // Car forward is -Z: yaw so that (-sin yaw, 0, -cos yaw) == tangent.
    const yaw = Math.atan2(-t.x, -t.z);
    return {
      position: this.points[i].clone().setY(SPAWN_HEIGHT),
      quaternion: new THREE.Quaternion().setFromAxisAngle(UP, yaw),
    };
  }

  private sampleCenterline(): void {
    const ctrl = this.layout.controlPoints.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal');
    const count = Math.max(16, Math.round(curve.getLength() / this.layout.sampleSpacing));
    const pts = curve.getSpacedPoints(count);
    pts.pop(); // closed curve: last == first
    this.points.push(...pts);
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const t = pts[(i + 1) % n].clone().sub(pts[(i - 1 + n) % n]).normalize();
      this.tangents.push(t);
      this.rights.push(new THREE.Vector3().crossVectors(t, UP).normalize());
    }
  }

  private fixedBody() {
    const { rapier, world } = this.physics;
    const body = world.createRigidBody(rapier.RigidBodyDesc.fixed());
    this.bodies.push(body);
    return body;
  }

  private addMesh(geometry: THREE.BufferGeometry, material: THREE.Material, receiveShadow = true): THREE.Mesh {
    this.disposables.push(geometry, material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = receiveShadow;
    this.root.add(mesh);
    return mesh;
  }

  /** Grass plane + one big box collider. Beyond its edge the car falls and resets. */
  private buildGround(): void {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    this.bounds.getSize(size);
    this.bounds.getCenter(center);
    const w = size.x + 60;
    const d = size.z + 60;

    const geo = new THREE.PlaneGeometry(w, d);
    geo.rotateX(-Math.PI / 2);
    const mesh = this.addMesh(geo, new THREE.MeshStandardMaterial({ color: 0x4f7d3a, roughness: 1 }));
    mesh.position.set(center.x, 0, center.z);
    mesh.name = 'Grass';

    const { rapier, world } = this.physics;
    const body = this.fixedBody();
    world.createCollider(
      rapier.ColliderDesc.cuboid(w / 2, 1, d / 2).setTranslation(center.x, -1, center.z).setFriction(1.0),
      body,
    );
  }

  /**
   * Builds a ribbon along the centerline between two lateral offsets.
   * `color(i)` (optional) gives per-segment vertex colors (hard edges).
   */
  private ribbon(inner: number, outer: number, y: number, color?: (i: number) => THREE.Color): THREE.BufferGeometry {
    const n = this.points.length;
    const positions: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    let dist = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const quad = [
        [i, inner],
        [i, outer],
        [j, inner],
        [j, outer],
      ] as const;
      const v: THREE.Vector3[] = quad.map(([k, off]) =>
        new THREE.Vector3().copy(this.points[k]).addScaledVector(this.rights[k], off).setY(y),
      );
      const seg = this.points[i].distanceTo(this.points[j]);
      // two triangles, counter-clockwise seen from above (normals +Y)
      for (const k of [0, 1, 2, 1, 3, 2]) {
        positions.push(v[k].x, v[k].y, v[k].z);
        uvs.push(k % 2, (dist + (k >= 2 ? seg : 0)) / 10);
        if (color) {
          const c = color(i);
          colors.push(c.r, c.g, c.b);
        }
      }
      dist += seg;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    if (color) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return geo;
  }

  private buildRoad(): void {
    const half = this.layout.roadWidth / 2;
    const asphalt = this.addMesh(
      this.ribbon(-half, half, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.92 }),
    );
    asphalt.name = 'Asphalt';

    const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8 });
    this.addMesh(this.ribbon(-half + 0.3, -half + 0.55, 0.03), lineMat);
    this.addMesh(this.ribbon(half - 0.55, half - 0.3, 0.03), lineMat.clone());
  }

  private buildCurbs(): void {
    const half = this.layout.roadWidth / 2;
    const red = new THREE.Color(0xc8102e);
    const white = new THREE.Color(0xf4f4f4);
    const color = (i: number) => (i % 2 === 0 ? red : white);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
    this.addMesh(this.ribbon(-half - 1.1, -half, 0.025, color), mat);
    this.addMesh(this.ribbon(half, half + 1.1, 0.025, color), mat.clone());
  }

  /** Tyre-wall style barriers as one InstancedMesh (1 draw call) + box colliders. */
  private buildBarriers(): void {
    const { rapier, world } = this.physics;
    const n = this.points.length;
    const offset = this.layout.roadWidth / 2 + this.layout.runoff;
    const height = 1.1;
    const thickness = 0.7;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
    this.disposables.push(geo, mat);
    const mesh = new THREE.InstancedMesh(geo, mat, n * 2);
    mesh.name = 'Barriers';
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const body = this.fixedBody();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const colA = new THREE.Color(0xd23c3c);
    const colB = new THREE.Color(0xeeeeee);
    let k = 0;

    for (const side of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        a.copy(this.points[i]).addScaledVector(this.rights[i], side * offset);
        b.copy(this.points[j]).addScaledVector(this.rights[j], side * offset);
        const len = a.distanceTo(b) + 0.35; // small overlap closes gaps on curves
        p.addVectors(a, b).multiplyScalar(0.5).setY(height / 2);
        const yaw = Math.atan2(b.x - a.x, b.z - a.z);
        q.setFromAxisAngle(UP, yaw);
        s.set(thickness, height, len);
        m.compose(p, q, s);
        mesh.setMatrixAt(k, m);
        mesh.setColorAt(k, Math.floor(i / 2) % 2 === 0 ? colA : colB);
        k++;

        world.createCollider(
          rapier.ColliderDesc.cuboid(thickness / 2, height / 2, len / 2)
            .setTranslation(p.x, p.y, p.z)
            .setRotation(q)
            .setFriction(0.05)
            .setRestitution(0.2),
          body,
        );
      }
    }
    mesh.computeBoundingSphere();
    this.root.add(mesh);
  }

  private buildStartLine(): void {
    const w = this.layout.roadWidth;
    const p = this.points[0];
    const yaw = Math.atan2(this.tangents[0].x, this.tangents[0].z);

    // Checkered strip via a tiny nearest-filtered texture.
    const cols = 16;
    const rows = 2;
    const data = new Uint8Array(cols * rows * 4);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const v = (x + y) % 2 === 0 ? 255 : 20;
        data.set([v, v, v, 255], (y * cols + x) * 4);
      }
    const tex = new THREE.DataTexture(data, cols, rows);
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.disposables.push(tex);

    const geo = new THREE.PlaneGeometry(w, 1.6);
    geo.rotateX(-Math.PI / 2);
    const strip = this.addMesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
    strip.position.set(p.x, 0.035, p.z);
    strip.rotation.y = yaw;
    strip.name = 'StartLine';

    // Gantry over the start line.
    const gantry = new THREE.Group();
    const postGeo = new THREE.BoxGeometry(0.4, 6, 0.4);
    const beamGeo = new THREE.BoxGeometry(w + 2 * this.layout.runoff, 1.2, 0.5);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.5, metalness: 0.5 });
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x1565c0, roughness: 0.5 });
    this.disposables.push(postGeo, beamGeo, postMat, beamMat);
    const off = w / 2 + this.layout.runoff;
    for (const sx of [-off, off]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(sx, 3, 0);
      post.castShadow = true;
      gantry.add(post);
    }
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.set(0, 6, 0);
    beam.castShadow = true;
    gantry.add(beam);
    gantry.position.set(p.x, 0, p.z);
    gantry.rotation.y = yaw;
    gantry.name = 'StartGantry';
    this.root.add(gantry);
  }

  /** Instanced trees (2 draw calls total) outside the barriers. No colliders. */
  private buildTrees(count: number): void {
    const rand = mulberry32(1337);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    this.bounds.getSize(size);
    this.bounds.getCenter(center);
    const minDist = this.layout.roadWidth / 2 + this.layout.runoff + 4;
    const minDistSq = minDist * minDist;
    const spreadX = size.x + 50;
    const spreadZ = size.z + 50;

    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 2, 6);
    trunkGeo.translate(0, 1, 0);
    const leafGeo = new THREE.ConeGeometry(1.8, 5, 7);
    leafGeo.translate(0, 4.5, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f6b34, roughness: 0.9 });
    this.disposables.push(trunkGeo, leafGeo, trunkMat, leafMat);

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, count);
    trunks.name = 'TreeTrunks';
    leaves.name = 'TreeLeaves';
    trunks.castShadow = leaves.castShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    let placed = 0;
    for (let attempt = 0; attempt < count * 20 && placed < count; attempt++) {
      p.set(center.x + (rand() - 0.5) * spreadX, 0, center.z + (rand() - 0.5) * spreadZ);
      let ok = true;
      for (let i = 0; i < this.points.length; i += 2) {
        const c = this.points[i];
        if ((c.x - p.x) ** 2 + (c.z - p.z) ** 2 < minDistSq) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const scale = 0.7 + rand() * 0.8;
      q.setFromAxisAngle(UP, rand() * Math.PI * 2);
      s.setScalar(scale);
      m.compose(p, q, s);
      trunks.setMatrixAt(placed, m);
      leaves.setMatrixAt(placed, m);
      placed++;
    }
    trunks.count = leaves.count = placed;
    trunks.computeBoundingSphere();
    leaves.computeBoundingSphere();
    this.root.add(trunks, leaves);
  }
}
