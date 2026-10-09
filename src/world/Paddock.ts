import * as THREE from 'three';
import { BuildingSoup, buildingMaterial, Facade } from './Buildings';
import { PIT_BUILDING_DEPTH, PIT_BUILDING_FRONT } from './PitBuilding';
import type { PitLaneData } from './PitLane';

/**
 * F1 paddock behind the pit building: a row of team motorhomes (glass
 * hospitality blocks in team colours), the teams' transporters, white
 * hospitality marquees and a TV compound of satellite trucks.
 */

/** Paddock depth behind the pit building (m); OSM buildings and trees are kept out of it. */
export const PADDOCK_DEPTH = 62;

export function buildPaddock(
  pit: PitLaneData,
  rights: readonly THREE.Vector3[],
  teamColors: number[],
  isFree: (x: number, z: number) => boolean,
): { group: THREE.Group; disposables: { dispose(): void }[] } {
  const group = new THREE.Group();
  group.name = 'Paddock';
  const disposables: { dispose(): void }[] = [];
  const soup = new BuildingSoup();
  const up = new THREE.Vector3(0, 1, 0);
  const base = PIT_BUILDING_FRONT + PIT_BUILDING_DEPTH;

  // Positions along the straight part of the lane.
  const k0 = pit.limiterStart + 4;
  const k1 = pit.limiterEnd - 4;
  const frame = (k: number) => {
    const p = pit.path[k];
    const r = rights[pit.pathIndex[k]].clone().multiplyScalar(pit.side);
    const t = pit.path[Math.min(k + 1, pit.path.length - 1)].clone().sub(pit.path[Math.max(k - 1, 0)]).normalize();
    return { p, r, t };
  };
  const at = (k: number, lateral: number) => {
    const { p, r } = frame(k);
    return p.clone().addScaledVector(r, lateral);
  };
  // Distance along the lane -> sample index (path samples are ~ evenly spaced).
  const spacing = pit.path[k0].distanceTo(pit.path[k0 + 1]) || 2.5;
  const kAt = (s: number) => Math.round(k0 + s / spacing);
  const length = (k1 - k0) * spacing;

  // --- motorhomes: one per team, 2-3 storeys of glass in the team colour ---------
  const teams = teamColors.length;
  const slot = Math.min(34, length / Math.max(teams, 1));
  teamColors.forEach((color, i) => {
    const k = kAt((i + 0.5) * slot);
    const c = at(k, base + 14);
    if (!isFree(c.x, c.z)) return;
    const { r, t } = frame(k);
    const w = slot * 0.7;
    const d = 14;
    const floors = 2 + (i % 2);
    const h = floors * 3.6;
    const tint = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.15);
    // Walls with the curtain-wall facade; roof with a light overhang.
    const corners = [
      c.clone().addScaledVector(t, -w / 2).addScaledVector(r, -d / 2),
      c.clone().addScaledVector(t, w / 2).addScaledVector(r, -d / 2),
      c.clone().addScaledVector(t, w / 2).addScaledVector(r, d / 2),
      c.clone().addScaledVector(t, -w / 2).addScaledVector(r, d / 2),
    ];
    for (let e = 0; e < 4; e++) {
      const a = corners[e];
      const b = corners[(e + 1) % 4];
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const out = mid.clone().sub(c).setY(0).normalize();
      const len = a.distanceTo(b);
      const bays = Math.max(1, Math.round(len / 2.2));
      soup.quad(a.clone().setY(0), b.clone().setY(0), b.clone().setY(h), a.clone().setY(h), [0, 0, bays, 0, bays, floors, 0, floors], out, tint, [Facade.Office, floors, i * 7]);
    }
    soup.box(c, t, r, w + 2.4, 0.5, d + 2.4, h, new THREE.Color(0xf2f2f2));
    // Team-colour band on the roof edge.
    soup.box(c, t, r, w + 2.5, 0.9, d + 2.5, h + 0.5, new THREE.Color(color));
  });

  // --- transporters: two articulated trucks per team further back ---------------
  const truckSlot = length / Math.max(teams * 2, 1);
  for (let i = 0; i < teams * 2; i++) {
    const k = kAt((i + 0.5) * truckSlot);
    const c = at(k, base + 31);
    if (!isFree(c.x, c.z)) continue;
    const { r, t } = frame(k);
    const color = new THREE.Color(teamColors[Math.floor(i / 2)]);
    // Trailer (13.6 m) + cab, parked across the paddock.
    soup.box(c, t, r, 2.55, 3.4, 13.6, 0.6, color);
    soup.box(c.clone().addScaledVector(r, 8.2), t, r, 2.5, 2.9, 2.6, 0.5, new THREE.Color(0x1d1f22));
    soup.box(c, t, r, 2.4, 0.6, 13.4, 0, new THREE.Color(0x222222));
  }

  // --- marquees: white hospitality tents with peaked roofs, the TV compound -------
  const white = new THREE.Color(0xf4f4f2);
  const roofWhite = new THREE.Color(0xe9ebee);
  for (let s = 6; s < length - 6; s += 22) {
    const k = kAt(s);
    const c = at(k, base + 50);
    if (!isFree(c.x, c.z)) continue;
    const { r, t } = frame(k);
    const w = 18;
    const d = 12;
    const h = 3;
    soup.box(c, t, r, w, h, d, 0, white, Facade.Plain);
    // Gable roof along t.
    const P = (a: number, b: number, y: number) => c.clone().addScaledVector(t, a).addScaledVector(r, b).setY(y);
    for (const side of [-1, 1]) {
      const n = r.clone().multiplyScalar(side).add(up);
      soup.quad(P(-w / 2, (side * d) / 2, h), P(w / 2, (side * d) / 2, h), P(w / 2, 0, h + 2.4), P(-w / 2, 0, h + 2.4), [0, 0, 1, 0, 1, 1, 0, 1], n, roofWhite, [Facade.Plain, 99, 0]);
    }
    for (const side of [-1, 1]) soup.tri(P((side * w) / 2, -d / 2, h), P((side * w) / 2, d / 2, h), P((side * w) / 2, 0, h + 2.4), [0, 0, 1, 0, 0.5, 1], t.clone().multiplyScalar(side), white, [Facade.Plain, 99, 0]);
  }
  // Satellite dishes on the TV trucks at the end of the paddock.
  for (let i = 0; i < 4; i++) {
    const k = Math.min(k1, kAt(length - 8 - i * 9));
    const c = at(k, base + 31);
    if (!isFree(c.x, c.z)) continue;
    const { r, t } = frame(k);
    soup.box(c, t, r, 2.5, 3.2, 10, 0.5, white);
    soup.box(c.clone().setY(0), t, r, 2.4, 1.6, 2.4, 3.7, new THREE.Color(0xd8dadc));
  }

  if (!soup.empty) {
    const geo = soup.build();
    const mat = buildingMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Paddock';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(geo, mat);
  }
  return { group, disposables };
}
