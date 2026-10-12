import * as THREE from 'three';
import type { RacingLine } from './RacingLine';
import type { Track } from './Track';

/**
 * Brake marker boards (150 / 100 / 50 m) before every big stop, as at real
 * circuits and in Monoposto: a beginner learns "brake at the 100 board".
 *
 * Corners come from the racing line's braking profile (`limits`): wherever
 * the speed the car must be down to drops by 60+ km/h, the end of that
 * braking (within 3 m/s of the corner speed) is the corner; boards stand
 * that far back along the line, on the outside of the corner at the edge
 * of the track (on the wall at street circuits), facing the oncoming cars.
 * A board that would land in the previous corner is left out.
 */
const DISTANCES = [150, 100, 50] as const;
/** Smallest braking (m/s) that gets boards: 60 km/h (the esses' lifts get none). */
const MIN_DROP = 16.7;
/** Big enough to read from ~150 m at racing speed (a beginner's cue, not decoration). */
const BOARD_W = 2.2;
const BOARD_H = 1.6;
const BOARD_Y = 0.6;

export interface BrakeBoard {
  distance: (typeof DISTANCES)[number];
  position: THREE.Vector3;
  /** Unit vector the board's face points along (towards the oncoming cars). */
  facing: THREE.Vector3;
}

/** Board spots for a circuit (no meshes): also used by the tests. */
export function brakeBoardSpots(track: Track, line: RacingLine): BrakeBoard[] {
  const pts = line.points;
  const lim = line.limits;
  const n = pts.length;
  const at = (i: number) => ((i % n) + n) % n;
  const step = (i: number) => pts[at(i)].distanceTo(pts[at(i + 1)]);
  const C = track.getCenterline();
  const R = track.getRights();
  const out: BrakeBoard[] = [];

  // Corner speeds: local minima of the braking profile with a big enough stop before them.
  for (let i = 0; i < n; i++) {
    const v = lim[i];
    if (!(v < lim[at(i - 1)] && v <= lim[at(i + 1)])) continue;
    // Walk back up the braking zone to its start (the peak).
    let j = i;
    let d = 0;
    while (d < 800 && lim[at(j - 1)] >= lim[at(j)] - 0.05) {
      d += step(j - 1);
      j--;
    }
    const peak = lim[at(j)];
    if (peak - v < MIN_DROP) continue;
    // The corner = the end of the braking: first point within 3 m/s of the corner speed.
    let ref = j;
    while (lim[at(ref)] > v + 3) ref++;
    // How far back from the corner the approach goes: walking back past the braking zone
    // and the straight, stop where the previous corner's slow part starts.
    let room = 0;
    let top = v;
    for (let k = ref; room < 400; k--) {
      top = Math.max(top, lim[at(k)]);
      if (lim[at(k - 1)] < top - 8) break;
      room += step(k - 1);
    }
    // Outside of the corner: the racing line hugs the inside at the apex.
    const inside = Math.sign(track.lateral(pts[i])) || 1;
    for (const dist of DISTANCES) {
      if (dist > room - 5) continue;
      let k = ref;
      for (let walked = 0; walked < dist; k--) walked += step(k - 1);
      const ci = track.nearestIndex(pts[at(k)]);
      const fwd = C[(ci + 1) % C.length].clone().sub(C[(ci - 1 + C.length) % C.length]).setY(0).normalize();
      // In front of the barrier (else the fence hides it), at most 4 m past the edge; on the wall at street circuits.
      const lateral = Math.max(track.halfWidth + 0.35, Math.min(track.barrierDistance(-inside, ci) - 1.2, track.halfWidth + 4));
      const pos = C[ci].clone().addScaledVector(R[ci], -inside * lateral);
      out.push({ distance: dist, position: pos, facing: fwd.negate() });
    }
    i = Math.max(i, ref);
  }
  return out;
}

/** Board meshes: one instanced face per number, white posts. */
export function buildBrakeBoards(track: Track, line: RacingLine): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  group.name = 'BrakeBoards';
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(o: T) => (owned.push(o), o);
  const spots = typeof document === 'undefined' ? [] : brakeBoardSpots(track, line);
  const faceGeo = own(new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.06));
  const postGeo = own(new THREE.BoxGeometry(0.08, BOARD_Y + BOARD_H * 0.5, 0.08).translate(0, (BOARD_Y + BOARD_H * 0.5) / 2, 0));
  const postMat = own(new THREE.MeshStandardMaterial({ color: 0xd8dadd, roughness: 0.6 }));
  const posts = new THREE.InstancedMesh(postGeo, postMat, spots.length * 2);
  posts.castShadow = true;
  group.add(posts);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const Z = new THREE.Vector3(0, 0, 1);
  const off = new THREE.Vector3();
  let post = 0;
  for (const dist of DISTANCES) {
    const mine = spots.filter((s) => s.distance === dist);
    if (!mine.length) continue;
    const tex = own(boardTexture(dist));
    const face = own(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }));
    const edge = own(new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }));
    // Box faces: +x, -x, +y, -y, +z (the number), -z (plain back).
    const mesh = new THREE.InstancedMesh(faceGeo, [edge, edge, edge, edge, face, edge], mine.length);
    mesh.castShadow = true;
    mine.forEach((s, k) => {
      q.setFromUnitVectors(Z, s.facing);
      m.compose(s.position.clone().setY(s.position.y + BOARD_Y + BOARD_H / 2), q, new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(k, m);
      // Two posts under the board's ends.
      const across = off.set(1, 0, 0).applyQuaternion(q);
      for (const sx of [-BOARD_W * 0.38, BOARD_W * 0.38]) {
        m.makeTranslation(s.position.x + across.x * sx, s.position.y, s.position.z + across.z * sx);
        posts.setMatrixAt(post++, m);
      }
    });
    group.add(mesh);
  }
  posts.count = post;
  return {
    group,
    dispose: () => {
      group.removeFromParent();
      for (const o of owned) o.dispose();
    },
  };
}

/** White board, black number, red band at the bottom (broadcast-style marker board). */
function boardTexture(n: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 192;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4f2';
  g.fillRect(0, 0, 256, 192);
  g.fillStyle = '#d7141a';
  g.fillRect(0, 160, 256, 32);
  g.fillStyle = '#111317';
  g.font = '900 120px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 128, 84);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
