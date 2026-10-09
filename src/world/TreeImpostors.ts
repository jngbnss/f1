import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Forests of photo-like trees for the price of two triangles each.
 *
 * At load time a few procedural trees are generated with EZ-Tree
 * (dgreenheck/ez-tree, MIT; bark/leaf textures from ambientCG, CC0), each is
 * rendered from FRAMES directions into one atlas, and every tree in the
 * world is an instanced camera-facing card that shows the atlas frame
 * matching the viewing direction ("impostor"). Tens of thousands of trees
 * cost about as much as one detailed tree.
 */

const FRAMES = 8;
const CELL_W = 256;
const CELL_H = 384;

/** EZ-Tree presets used for the park forests around Monza (broadleaf, a few pines). */
const VARIANTS: { preset: string; weight: number; height: [number, number] }[] = [
  { preset: 'Oak Medium', weight: 3, height: [14, 20] },
  { preset: 'Oak Large', weight: 1.5, height: [18, 24] },
  { preset: 'Ash Medium', weight: 3, height: [15, 22] },
  { preset: 'Ash Large', weight: 1.5, height: [18, 25] },
  { preset: 'Aspen Medium', weight: 1.5, height: [14, 20] },
  { preset: 'Pine Medium', weight: 1, height: [16, 24] },
];

interface Atlas {
  texture: THREE.Texture;
  /** Card size (m) per variant: width, height (frustum used when baking), tree height. */
  sizes: [number, number, number][];
  dispose(): void;
}

/**
 * Leaf textures store white in their transparent texels; bilinear filtering
 * at the cut-out edge mixes that in and outlines every crown in white. Paint
 * transparent texels with the mean leaf colour instead (once per texture).
 */
const bled = new WeakSet<THREE.Texture>();
function bleedLeafColor(tex: THREE.Texture): void {
  const img = tex.image as CanvasImageSource & { width: number; height: number };
  if (bled.has(tex) || !img?.width || typeof document === 'undefined') return;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const d = data.data;
  let r = 0;
  let gr = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4)
    if (d[i + 3] > 200) {
      r += d[i];
      gr += d[i + 1];
      b += d[i + 2];
      n++;
    }
  if (!n) return;
  for (let i = 0; i < d.length; i += 4)
    if (d[i + 3] < 128) {
      d[i] = r / n;
      d[i + 1] = gr / n;
      d[i + 2] = b / n;
    }
  g.putImageData(data, 0, 0);
  tex.image = c;
  tex.needsUpdate = true;
  bled.add(tex);
}

/** Waits until every texture used by `root` has its image (EZ-Tree decodes them asynchronously). */
async function texturesReady(root: THREE.Object3D, timeoutMs = 5000): Promise<void> {
  const maps: THREE.Texture[] = [];
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!m) return;
    for (const t of [m.map, m.normalMap, m.roughnessMap, m.aoMap, m.alphaMap]) if (t) maps.push(t);
  });
  const start = performance.now();
  while (maps.some((t) => !t.image) && performance.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 30));
}

async function bakeAtlas(renderer: THREE.WebGLRenderer): Promise<Atlas> {
  const { Tree } = await import('@dgreenheck/ez-tree');
  const rows = VARIANTS.length;
  const target = new THREE.WebGLRenderTarget(CELL_W * FRAMES, CELL_H * rows, { samples: 4 });
  target.texture.generateMipmaps = true;
  target.texture.minFilter = THREE.LinearMipmapLinearFilter;
  target.texture.magFilter = THREE.LinearFilter;

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfeaff, 0x3d4a2a, 2.2));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
  sun.position.set(0.4, 1, 0.8);
  scene.add(sun);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);

  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevShadow = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();

  const sizes: [number, number, number][] = [];
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  for (let v = 0; v < rows; v++) {
    const tree = new Tree();
    tree.loadPreset(VARIANTS[v].preset);
    tree.generate();
    await texturesReady(tree);
    tree.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m?.map && m.alphaTest > 0) bleedLeafColor(m.map);
    });
    scene.add(tree);
    box.setFromObject(tree);
    box.getSize(size);
    // Card frustum: horizontal extent of the crown, keeping the cell aspect.
    const halfW = Math.max(size.x, size.z) / 2;
    const h = Math.max(size.y, (halfW * 2 * CELL_H) / CELL_W);
    const w = (h * CELL_W) / CELL_H;
    sizes.push([w, h, size.y]);
    camera.left = -w / 2;
    camera.right = w / 2;
    camera.bottom = box.min.y;
    camera.top = box.min.y + h;
    camera.position.set(0, 0, 200);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    for (let f = 0; f < FRAMES; f++) {
      tree.rotation.y = (f / FRAMES) * Math.PI * 2;
      tree.updateMatrixWorld(true);
      target.viewport.set(f * CELL_W, v * CELL_H, CELL_W, CELL_H);
      target.scissor.set(f * CELL_W, v * CELL_H, CELL_W, CELL_H);
      target.scissorTest = true;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    }
    scene.remove(tree);
    tree.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
    });
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.shadowMap.enabled = prevShadow;
  return { texture: target.texture, sizes, dispose: () => target.dispose() };
}

/**
 * Builds the forest: one InstancedMesh of cards. `positions` are tree bases
 * (x, z); `groundY` gives the terrain height there.
 */
export async function buildImpostorForest(
  renderer: THREE.WebGLRenderer,
  positions: readonly [number, number][],
  groundY: (x: number, z: number) => number,
  seed = 99,
): Promise<{ mesh: THREE.InstancedMesh; dispose(): void }> {
  const atlas = await bakeAtlas(renderer);
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const totalWeight = VARIANTS.reduce((a, v) => a + v.weight, 0);
  const pickVariant = () => {
    let r = rand() * totalWeight;
    for (let i = 0; i < VARIANTS.length; i++) if ((r -= VARIANTS[i].weight) <= 0) return i;
    return 0;
  };

  // Fixed crossed cards instead of a camera-facing one: each tree is CROSS
  // vertical planes through its trunk, plane k showing the atlas frame baked
  // from its own direction. Nothing turns or swaps frames as the camera moves,
  // so trees stay put and slide past with real parallax (a camera-facing card
  // visibly changed shape whenever its frame flipped).
  const CROSS = FRAMES / 2;
  const planes: THREE.BufferGeometry[] = [];
  for (let k = 0; k < CROSS; k++) {
    const plane = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateY((-k * Math.PI * 2) / FRAMES);
    plane.setAttribute('treeFrame', new THREE.Float32BufferAttribute(new Array(plane.attributes.position.count).fill(k), 1));
    planes.push(plane);
  }
  const geometry = mergeGeometries(planes)!;
  planes.forEach((p) => p.dispose());
  const material = new THREE.MeshBasicMaterial({ map: atlas.texture, alphaTest: 0.45, transparent: false, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 treeData;\nattribute float treeFrame;\nvarying vec2 vAtlasUv;`)
      .replace(
        '#include <project_vertex>',
        `vec4 tCenter = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 tScale = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
        float cy = cos(treeData.y);
        float sy = sin(treeData.y);
        vec2 xz = vec2(cy * position.x + sy * position.z, -sy * position.x + cy * position.z) * tScale.x;
        vec3 world = tCenter.xyz + vec3(xz.x, position.y * tScale.y, xz.y);
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vAtlasUv = vec2((treeFrame + uv.x) / ${FRAMES.toFixed(1)}, (treeData.x + uv.y) / ${VARIANTS.length.toFixed(1)});`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vAtlasUv;`)
      .replace(
        '#include <map_fragment>',
        // Gaps inside a crown would show the bright sky as white specks: fill them with
        // shaded foliage taken from a blurrier mip (the crown's outline stays cut out).
        `vec4 tex = texture2D(map, vAtlasUv);
        vec4 blurred = texture2D(map, vAtlasUv, 2.5);
        if (tex.a < 0.45 && blurred.a > 0.6) tex = vec4(blurred.rgb / blurred.a * 0.6, 1.0);
        diffuseColor *= tex;`,
      );
  };
  material.customProgramCacheKey = () => 'tree-impostor-cross';

  const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
  mesh.name = 'ImpostorForest';
  const data = new Float32Array(positions.length * 2);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  positions.forEach(([x, z], i) => {
    const v = pickVariant();
    // Presets are built at their own (often oversized) scale: normalize to real park tree heights.
    const [w, h, treeH] = atlas.sizes[v];
    const [h0, h1] = VARIANTS[v].height;
    const scale = (h0 + rand() * (h1 - h0)) / treeH;
    p.set(x, groundY(x, z) - 0.2, z);
    sc.set(w * scale, h * scale, 1);
    m.compose(p, q, sc);
    mesh.setMatrixAt(i, m);
    data[i * 2] = v;
    data[i * 2 + 1] = rand() * Math.PI * 2;
  });
  geometry.setAttribute('treeData', new THREE.InstancedBufferAttribute(data, 2));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return {
    mesh,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      atlas.dispose();
    },
  };
}
