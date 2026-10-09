import * as THREE from 'three';

/**
 * Pit lane along the start/finish straight (TUMFTM centerlines have none):
 * an entry ramp leaving the track edge, a lane parallel to the straight
 * behind a pit wall with one box per team, and an exit ramp back onto the
 * track. Cars in the pit lane are driven by PitStops (speed limiter, stop,
 * tyre change), like the automatic pit stops of the F1 games.
 */
export interface PitLaneData {
  /** +1 = right of the driving direction, -1 = left. */
  side: number;
  /** Lane centre distance from the track centreline (m). */
  laneOffset: number;
  /** Centreline sample indices where the lane leaves / rejoins the track. */
  entryIndex: number;
  exitIndex: number;
  /** Lane centreline from entry to exit (every ~2.5 m) and its centreline sample index. */
  path: THREE.Vector3[];
  pathIndex: number[];
  /** Path indices: limiter on / off, and each team's box. */
  limiterStart: number;
  limiterEnd: number;
  boxes: number[];
  /** Centreline sample range whose pit-side barrier sits behind the lane. */
  inRange(i: number): boolean;
  /** Pit-side lateral offset of the lane at a centreline sample (0 outside). */
  lateralAt(i: number): number;
}

const ENTRY_BEFORE_LINE = 330;
const EXIT_AFTER_LINE = 230;
const RAMP = 95;
export const PIT_LANE_WIDTH = 6.5;
const BOX_SPACING = 14;
export const PIT_SPEED_LIMIT = 80 / 3.6;

export function buildPitLaneData(
  points: readonly THREE.Vector3[],
  rights: readonly THREE.Vector3[],
  half: number,
  side: number,
  spacing: number,
  teams: number,
): PitLaneData {
  const n = points.length;
  const before = Math.round(ENTRY_BEFORE_LINE / spacing);
  const after = Math.round(EXIT_AFTER_LINE / spacing);
  const entryIndex = (n - before) % n;
  const exitIndex = after % n;
  const laneOffset = half + 2.2 + PIT_LANE_WIDTH / 2;
  const edge = half - 2.5;
  const total = before + after;
  const offsetAtStep = (k: number) => {
    const s = k * spacing;
    const end = total * spacing;
    const t = Math.min(s / RAMP, (end - s) / RAMP, 1);
    const e = t * t * (3 - 2 * t);
    return edge + (laneOffset - edge) * e;
  };
  const path: THREE.Vector3[] = [];
  const pathIndex: number[] = [];
  const lateral = new Map<number, number>();
  for (let k = 0; k <= total; k++) {
    const i = (entryIndex + k) % n;
    const off = offsetAtStep(k);
    path.push(points[i].clone().addScaledVector(rights[i], side * off).setY(0));
    pathIndex.push(i);
    lateral.set(i, off);
  }
  // Boxes centred on the start line, one per team.
  const lineStep = before;
  const boxes = Array.from({ length: teams }, (_, t) => lineStep + Math.round(((t - (teams - 1) / 2) * BOX_SPACING) / spacing));
  return {
    side,
    laneOffset,
    entryIndex,
    exitIndex,
    path,
    pathIndex,
    limiterStart: Math.round(RAMP / spacing),
    limiterEnd: total - Math.round(RAMP / spacing),
    boxes,
    inRange: (i) => lateral.has(i),
    lateralAt: (i) => lateral.get(i) ?? 0,
  };
}

/** Lane surface, white edge lines, box markings and the pit wall (meshes + wall segments for colliders). */
export function buildPitLaneMeshes(
  pit: PitLaneData,
  rights: readonly THREE.Vector3[],
  materials: { asphalt: THREE.Material },
  teamColors: number[],
): { group: THREE.Group; wall: { a: THREE.Vector3; b: THREE.Vector3 }[]; disposables: { dispose(): void }[] } {
  const group = new THREE.Group();
  group.name = 'PitLane';
  const disposables: { dispose(): void }[] = [];
  const strip = (inner: number, outer: number, y: number, from = 0, to = pit.path.length - 1) => {
    const pos: number[] = [];
    for (let k = from; k < to; k++) {
      const quad = [k, k + 1].flatMap((m) => {
        const r = rights[pit.pathIndex[m]];
        const c = pit.path[m];
        return [c.clone().addScaledVector(r, pit.side * inner), c.clone().addScaledVector(r, pit.side * outer)];
      });
      // Winding facing up for either side.
      const [a, b, c, d] = pit.side > 0 ? quad : [quad[1], quad[0], quad[3], quad[2]];
      for (const v of [a, b, c, b, d, c]) pos.push(v.x, y, v.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    disposables.push(g);
    return g;
  };
  const w = PIT_LANE_WIDTH / 2;
  const lane = new THREE.Mesh(strip(-w, w, 0.025), materials.asphalt);
  lane.receiveShadow = true;
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.7 });
  disposables.push(white);
  group.add(lane, new THREE.Mesh(strip(-w, -w + 0.2, 0.03), white), new THREE.Mesh(strip(w - 0.2, w, 0.03), white));
  // Limiter lines across the lane.
  for (const k of [pit.limiterStart, pit.limiterEnd]) group.add(new THREE.Mesh(strip(-w, w, 0.032, k, k + 1), white));

  // Box markings: a team-coloured rectangle per box on the garage side of the lane.
  pit.boxes.forEach((k, t) => {
    const mat = new THREE.MeshStandardMaterial({ color: teamColors[t % teamColors.length], roughness: 0.6 });
    disposables.push(mat);
    group.add(new THREE.Mesh(strip(0.2, w - 0.4, 0.031, k - 2, k + 2), mat));
  });

  // Pit wall: low concrete wall between track and lane along the straight part.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d4, roughness: 0.85 });
  disposables.push(wallMat);
  const wall: { a: THREE.Vector3; b: THREE.Vector3 }[] = [];
  const box = new THREE.BoxGeometry(0.5, 1.1, 1).translate(0, 0.55, 0);
  disposables.push(box);
  const wallMesh = new THREE.InstancedMesh(box, wallMat, pit.limiterEnd - pit.limiterStart);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (let k = pit.limiterStart, c = 0; k < pit.limiterEnd; k++, c++) {
    const r0 = rights[pit.pathIndex[k]];
    const r1 = rights[pit.pathIndex[k + 1]];
    const a = pit.path[k].clone().addScaledVector(r0, -pit.side * (w + 1.1));
    const b = pit.path[k + 1].clone().addScaledVector(r1, -pit.side * (w + 1.1));
    wall.push({ a, b });
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(b.x - a.x, b.z - a.z));
    m.compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, a.distanceTo(b) + 0.05));
    wallMesh.setMatrixAt(c, m);
  }
  wallMesh.castShadow = wallMesh.receiveShadow = true;
  group.add(wallMesh);
  return { group, wall, disposables };
}
