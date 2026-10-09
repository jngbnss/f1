import type * as THREE from 'three';

/**
 * Breaks up the tiling of photo-scanned ground textures, the way broadcast
 * shots of real circuits look: large soft patches of lighter / drier and
 * darker / lusher grass, mowing stripes, and worn or patched asphalt. All of
 * it is world-space noise in the fragment shader (no extra textures).
 */

const NOISE = /* glsl */ `
varying vec3 vGroundPos;
float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1, 0)), u.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), u.x), u.y);
}
float gFbm(vec2 p) { return 0.5 * gNoise(p) + 0.3 * gNoise(p * 2.07 + 13.1) + 0.2 * gNoise(p * 4.13 + 7.7); }
`;

function patch(material: THREE.Material, key: string, fragment: string): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${fragment}`);
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}

/** Mowed stripes (fixed world direction, like a real groundskeeper) + lush/dry patches. */
export function shadeGrass(material: THREE.Material): void {
  patch(
    material,
    'grass-v2',
    /* glsl */ `{
      vec2 gp = vGroundPos.xz;
      float macro = gFbm(gp / 55.0);
      float fine = gNoise(gp / 6.0);
      // Lush (dark, blue-green) to dry (light, yellow) patches.
      vec3 dry = vec3(1.12, 1.06, 0.8);
      vec3 lush = vec3(0.74, 0.9, 0.8);
      diffuseColor.rgb *= mix(lush, dry, smoothstep(0.3, 0.75, macro));
      diffuseColor.rgb *= 0.92 + 0.16 * fine;
      // Field-sized patches (hay meadow, rough grass, darker damp ground).
      float field = gFbm(gp / 260.0 + 17.0);
      diffuseColor.rgb *= mix(vec3(0.8, 0.88, 0.82), vec3(1.08, 1.0, 0.82), smoothstep(0.35, 0.7, field));
      // Mowing stripes 7 m wide: light/dark from the direction the mower ran; they
      // fade with distance like on TV (and stop reading as a striped carpet from afar).
      float dist = length(vGroundPos - cameraPosition);
      float stripe = step(0.5, fract((gp.x * 0.8 + gp.y * 0.6) / 14.0));
      diffuseColor.rgb *= mix(1.0, mix(0.92, 1.06, stripe), 1.0 - smoothstep(120.0, 600.0, dist));
      // Distant meadows: deeper, less saturated green (aerial perspective does the rest).
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.8, 0.86, 0.84), smoothstep(150.0, 900.0, dist));
    }`,
  );
}

/** Older and newer asphalt patches, darker rubbered-in centre of the road, oil stains. */
export function shadeAsphalt(material: THREE.Material): void {
  patch(
    material,
    'asphalt-v1',
    /* glsl */ `{
      vec2 gp = vGroundPos.xz;
      float macro = gFbm(gp / 40.0);
      diffuseColor.rgb *= mix(0.86, 1.1, macro);
      // Resurfaced rectangles: noise quantised into blocks.
      float block = gHash(floor(gp / vec2(18.0, 11.0)));
      diffuseColor.rgb *= block > 0.93 ? 0.88 : 1.0;
      float stain = smoothstep(0.78, 0.9, gNoise(gp / 2.3 + 40.0));
      diffuseColor.rgb *= 1.0 - 0.18 * stain;
    }`,
  );
}

/** Gravel traps: raked lines and darker damp patches. */
export function shadeGravel(material: THREE.Material): void {
  patch(
    material,
    'gravel-v1',
    /* glsl */ `{
      vec2 gp = vGroundPos.xz;
      diffuseColor.rgb *= mix(0.85, 1.08, gFbm(gp / 12.0));
      diffuseColor.rgb *= 0.95 + 0.05 * sin(gp.x * 2.1 + gp.y * 1.3);
    }`,
  );
}
