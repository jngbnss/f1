import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Suzuka's landmark: the big Ferris wheel of the circuit's amusement park,
 * seen over the trees from the main straight. White steel rim and spokes on
 * an A-frame, a ring of coloured gondolas; it turns slowly (`update`).
 * Three draw calls, gondolas stay upright while the wheel turns.
 */
export interface FerrisWheel {
  group: THREE.Group;
  update(time: number): void;
  disposables: { dispose(): void }[];
}

export function buildFerrisWheel(x: number, groundY: number, z: number, faceYaw: number, diameter = 64): FerrisWheel {
  const group = new THREE.Group();
  group.name = 'FerrisWheel';
  const r = diameter / 2;
  const hub = r + 6;
  group.position.set(x, groundY, z);
  group.rotation.y = faceYaw;
  const disposables: { dispose(): void }[] = [];

  const steel = new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.45, metalness: 0.35 });
  const frame = new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.5, metalness: 0.4 });
  disposables.push(steel, frame);

  // A-frame legs (both sides of the wheel) and the axle.
  const legs: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1])
    for (const lean of [-1, 1]) {
      const len = Math.hypot(hub, r * 0.55);
      const g = new THREE.CylinderGeometry(0.45, 0.7, len, 8);
      g.rotateZ(lean * Math.atan2(r * 0.55, hub));
      g.translate(lean * r * 0.275, hub / 2, side * 3.2);
      legs.push(g);
    }
  legs.push(new THREE.CylinderGeometry(0.9, 0.9, 7.6, 12).rotateX(Math.PI / 2).translate(0, hub, 0));
  const legGeo = mergeGeometries(legs)!;
  legs.forEach((g) => g.dispose());
  disposables.push(legGeo);
  const legMesh = new THREE.Mesh(legGeo, frame);
  legMesh.castShadow = true;
  group.add(legMesh);

  // Turning part: two rims, spokes, cross ties.
  const wheel = new THREE.Group();
  wheel.position.y = hub;
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1.6, 1.6]) parts.push(new THREE.TorusGeometry(r, 0.35, 6, 72).translate(0, 0, side));
  const SPOKES = 32;
  for (let k = 0; k < SPOKES; k++) {
    const a = (k / SPOKES) * Math.PI * 2;
    for (const side of [-1.6, 1.6]) {
      const g = new THREE.CylinderGeometry(0.09, 0.09, r, 4);
      g.translate(0, r / 2, side);
      g.rotateZ(a);
      parts.push(g);
    }
    const tie = new THREE.CylinderGeometry(0.12, 0.12, 3.2, 4).rotateX(Math.PI / 2).translate(Math.cos(a) * r, Math.sin(a) * r, 0);
    parts.push(tie);
  }
  const wheelGeo = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  disposables.push(wheelGeo);
  const wheelMesh = new THREE.Mesh(wheelGeo, steel);
  wheelMesh.castShadow = true;
  wheel.add(wheelMesh);
  group.add(wheel);

  // Gondolas: one instanced mesh, positions updated as the wheel turns (they hang upright).
  const GONDOLAS = 32;
  const cab = new THREE.BoxGeometry(2.0, 2.4, 2.6).translate(0, -1.6, 0);
  disposables.push(cab);
  const cabMat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 });
  disposables.push(cabMat);
  const cabs = new THREE.InstancedMesh(cab, cabMat, GONDOLAS);
  const colors = [0xe63946, 0xf4a261, 0xffd166, 0x06d6a0, 0x118ab2, 0x8338ec, 0xff70a6, 0xffffff];
  for (let k = 0; k < GONDOLAS; k++) cabs.setColorAt(k, new THREE.Color(colors[k % colors.length]));
  cabs.position.y = hub;
  cabs.frustumCulled = false;
  group.add(cabs);
  const m = new THREE.Matrix4();
  const place = (angle: number) => {
    for (let k = 0; k < GONDOLAS; k++) {
      const a = angle + (k / GONDOLAS) * Math.PI * 2;
      m.makeTranslation(Math.cos(a) * r, Math.sin(a) * r, 0);
      cabs.setMatrixAt(k, m);
    }
    cabs.instanceMatrix.needsUpdate = true;
  };
  place(0);
  return {
    group,
    disposables,
    update: (time: number) => {
      // One turn in ~15 minutes, like the real thing.
      const angle = time * ((Math.PI * 2) / 900);
      wheel.rotation.z = angle;
      place(angle);
    },
  };
}
