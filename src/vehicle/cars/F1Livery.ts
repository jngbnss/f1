import * as THREE from 'three';

/**
 * Team liveries painted procedurally on the shared F1 body (it has no UVs):
 * the paint shader picks colors from the model-space position (m; x right,
 * y up from the ground, z forward negative, origin between the axles).
 * Colors and layouts follow each team's 2026 look; no logos or sponsors.
 */
export const LiveryStyle = {
  Plain: 0,
  /** Lower body (floor edge, sidepod undercut) in the second color, accent pinstripe at the split. */
  LowerDark: 1,
  /** Fades from the first color at the nose to the second at the rear. */
  FadeRear: 2,
  /** Second color on the sidepods and engine-cover flanks. */
  Sidepods: 3,
  /** Second color band across the engine cover and sidepod tops. */
  Band: 4,
} as const;
export type LiveryStyle = (typeof LiveryStyle)[keyof typeof LiveryStyle];

export interface Livery {
  primary: number;
  secondary: number;
  /** Pinstripes, number, nose tip. */
  accent: number;
  style: LiveryStyle;
  helmet: number;
  /** Two race numbers (one per car of the team). */
  numbers: [number, number];
}

const LIVERIES: Record<string, Livery> = {
  'f1-ferrari': { primary: 0xd40000, secondary: 0x1a1a1a, accent: 0xffffff, style: LiveryStyle.LowerDark, helmet: 0xffd400, numbers: [16, 44] },
  'f1-mercedes': { primary: 0xc0c6cc, secondary: 0x111214, accent: 0x00d2be, style: LiveryStyle.FadeRear, helmet: 0xe8e8e8, numbers: [63, 12] },
  'f1-redbull': { primary: 0x1b2343, secondary: 0xd0021b, accent: 0xffc906, style: LiveryStyle.Band, helmet: 0x1b2343, numbers: [1, 6] },
  'f1-mclaren': { primary: 0xff8000, secondary: 0x232323, accent: 0x47c7fc, style: LiveryStyle.Sidepods, helmet: 0xff8000, numbers: [4, 81] },
  'f1-aston': { primary: 0x00594f, secondary: 0x0b2b27, accent: 0xcedc00, style: LiveryStyle.LowerDark, helmet: 0x00594f, numbers: [14, 18] },
  'f1-alpine': { primary: 0x0a5cd6, secondary: 0xff5fae, accent: 0xffffff, style: LiveryStyle.FadeRear, helmet: 0x0a5cd6, numbers: [10, 43] },
  'f1-williams': { primary: 0x0d2a62, secondary: 0x0093d0, accent: 0xffffff, style: LiveryStyle.Band, helmet: 0x0093d0, numbers: [23, 55] },
  'f1-racingbulls': { primary: 0xf3f3f5, secondary: 0x1d3fa6, accent: 0xe4002b, style: LiveryStyle.Sidepods, helmet: 0xf3f3f5, numbers: [30, 41] },
  'f1-haas': { primary: 0xf4f4f4, secondary: 0x1c1c1c, accent: 0xd0021b, style: LiveryStyle.LowerDark, helmet: 0xd0021b, numbers: [31, 87] },
  'f1-audi': { primary: 0x9aa0a6, secondary: 0x16171a, accent: 0xe2003c, style: LiveryStyle.FadeRear, helmet: 0x16171a, numbers: [27, 5] },
};

export function liveryFor(carId: string, color: number, accent: number): Livery {
  return LIVERIES[carId] ?? { primary: color, secondary: 0x1c1c1c, accent, style: LiveryStyle.Plain, helmet: accent, numbers: [7, 8] };
}

/** White race number with a dark outline on transparent background (canvas, browser only). */
export function numberTexture(n: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  g.font = 'italic 900 104px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 12;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(String(n), 128, 68);
  g.fillStyle = '#ffffff';
  g.fillText(String(n), 128, 68);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Injects the livery into a body paint material. */
export function applyLivery(material: THREE.MeshPhysicalMaterial, livery: Livery, number: THREE.Texture | null): void {
  material.color.set(0xffffff);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.livPrimary = { value: new THREE.Color(livery.primary) };
    shader.uniforms.livSecondary = { value: new THREE.Color(livery.secondary) };
    shader.uniforms.livAccent = { value: new THREE.Color(livery.accent) };
    shader.uniforms.livStyle = { value: livery.style };
    shader.uniforms.livNumber = { value: number };
    shader.uniforms.livHasNumber = { value: number ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLivPos;\nvarying vec3 vLivNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLivPos = position;\nvLivNormal = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vLivPos;
        varying vec3 vLivNormal;
        uniform vec3 livPrimary;
        uniform vec3 livSecondary;
        uniform vec3 livAccent;
        uniform int livStyle;
        uniform sampler2D livNumber;
        uniform int livHasNumber;
        float livLine(float v, float at, float w) { return 1.0 - smoothstep(w * 0.5, w, abs(v - at)); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 p = vLivPos;
        vec3 col = livPrimary;
        float side = abs(p.x);
        if (livStyle == 1) {
          float lower = 1.0 - smoothstep(0.36, 0.40, p.y);
          col = mix(col, livSecondary, lower);
          col = mix(col, livAccent, livLine(p.y, 0.38, 0.018));
        } else if (livStyle == 2) {
          col = mix(col, livSecondary, smoothstep(-0.6, 1.3, p.z));
          col = mix(col, livAccent, livLine(p.y, 0.56, 0.016) * step(0.28, side) * step(-1.2, p.z) * step(p.z, 1.2));
        } else if (livStyle == 3) {
          float pod = step(0.24, side) * smoothstep(-0.95, -0.75, p.z) * (1.0 - smoothstep(1.1, 1.35, p.z)) * step(0.16, p.y);
          col = mix(col, livSecondary, pod);
          col = mix(col, livAccent, livLine(p.z, -0.9, 0.03) * step(0.24, side) * step(0.16, p.y));
        } else if (livStyle == 4) {
          float band = smoothstep(-0.05, 0.05, p.z) * (1.0 - smoothstep(0.65, 0.75, p.z)) * step(0.45, p.y);
          col = mix(col, livSecondary, band);
          col = mix(col, livAccent, livLine(p.z, 0.0, 0.03) * step(0.45, p.y));
        }
        // Nose tip in the accent color.
        col = mix(col, livAccent, 1.0 - smoothstep(-2.65, -2.55, p.z));
        vec3 n = normalize(vLivNormal);
        if (livHasNumber == 1) {
          // Engine-cover flanks (projected along x; mirrored on the right so both sides read correctly).
          vec2 uvS = vec2((p.z - 0.25) / 0.7, (p.y - 0.62) / 0.3);
          if (p.x > 0.0) uvS.x = 1.0 - uvS.x;
          float onSide = step(0.6, abs(n.x)) * step(0.0, uvS.x) * step(uvS.x, 1.0) * step(0.0, uvS.y) * step(uvS.y, 1.0);
          vec4 numS = texture2D(livNumber, vec2(uvS.x, 1.0 - uvS.y));
          col = mix(col, numS.rgb, numS.a * onSide);
          // Nose top, read from the cockpit side.
          vec2 uvN = vec2((p.x + 0.14) / 0.28, (p.z + 1.75) / 0.5);
          float onNose = step(0.6, n.y) * step(0.0, uvN.x) * step(uvN.x, 1.0) * step(0.0, uvN.y) * step(uvN.y, 1.0);
          vec4 numN = texture2D(livNumber, vec2(uvN.x, uvN.y));
          col = mix(col, numN.rgb, numN.a * onNose);
        }
        diffuseColor.rgb *= col;`,
      );
  };
  material.customProgramCacheKey = () => 'f1-livery';
  material.needsUpdate = true;
}

/** Coloured compound band on the tyre sidewall (wheel space: x = axle, radius in y/z). */
export function applyTyreBand(material: THREE.MeshStandardMaterial, color: { value: THREE.Color }): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.bandColor = color;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTyrePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTyrePos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTyrePos;\nuniform vec3 bandColor;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float r = length(vTyrePos.yz);
        float band = smoothstep(0.287, 0.292, r) * (1.0 - smoothstep(0.307, 0.312, r)) * step(0.08, abs(vTyrePos.x));
        diffuseColor.rgb = mix(diffuseColor.rgb, bandColor, band);`,
      );
  };
  material.customProgramCacheKey = () => 'tyre-band';
  material.needsUpdate = true;
}
