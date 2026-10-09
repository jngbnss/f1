import * as THREE from 'three';

/**
 * Breaks up the tiling of photo-scanned ground textures, the way broadcast
 * shots of real circuits look: large soft patches of lighter / drier and
 * darker / lusher grass, mowing stripes, and worn or patched asphalt. All of
 * it is world-space noise in the fragment shader (no extra textures).
 *
 * The weather drives two more terms through GROUND_FX: wetness (darker,
 * glossy surfaces, standing water on the asphalt) and night lighting
 * (floodlight pools from a light map baked over the circuit).
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

/**
 * Weather inputs shared by every ground material (set by world/Weather.ts):
 * wetness (0 dry .. 1 soaked) and night lighting from the floodlights, baked
 * into a light map over the circuit (R = light; rect = world x, z, width, depth).
 */
export const GROUND_FX = {
  uWet: { value: 0 },
  uNight: { value: 0 },
  uLightMap: { value: blankTexture() as THREE.Texture },
  uLightRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  /** Mirror image of cars and lights for the soaked asphalt (render/WetReflection.ts). */
  uReflOn: { value: 0 },
  uReflMap: { value: blankTexture() as THREE.Texture },
  uReflMatrix: { value: new THREE.Matrix4() },
};

function blankTexture(): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

const FX_DECL = /* glsl */ `
uniform float uWet;
uniform float uNight;
uniform sampler2D uLightMap;
uniform vec4 uLightRect;
uniform float uReflOn;
uniform sampler2D uReflMap;
varying vec4 vReflUv;
`;

/** Floodlit at night: the light map adds warm-white light on top of the (dim) scene lighting. */
const NIGHT_LIGHT = /* glsl */ `
if (uNight > 0.0) {
  vec2 luv = (vGroundPos.xz - uLightRect.xy) / uLightRect.zw;
  float lit = texture2D(uLightMap, luv).r;
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.95, 0.86) * lit * uNight * 2.6;
}`;

/**
 * `fragment` shades the albedo; `wet` runs after it while it rains and sets
 * gWetRough, the roughness the surface tends to when soaked.
 */
/**
 * Wet mirror (asphalt only): the reflection image, rippled by the surface and
 * sharper in standing water, blended in by wetness and the Fresnel term.
 */
const WET_MIRROR = /* glsl */ `
if (uReflOn > 0.0 && uWet > 0.0) {
  vec2 ruv = vReflUv.xy / vReflUv.w;
  vec2 ripple = vec2(gNoise(vGroundPos.xz * 1.9), gNoise(vGroundPos.zx * 1.9 + 7.0)) - 0.5;
  ruv += ripple * mix(0.018, 0.004, gPuddle);
  vec3 refl = texture2D(uReflMap, ruv).rgb;
  float ndv = max(dot(normalize(cameraPosition - vGroundPos), vec3(0.0, 1.0, 0.0)), 0.0);
  float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  float k = uWet * mix(0.3, 0.85, gPuddle) * clamp(fres * 2.2 + 0.12, 0.0, 1.0);
  outgoingLight = mix(outgoingLight, refl, k);
}`;

function patch(material: THREE.Material, key: string, fragment: string, wet: string, mirror = false): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, GROUND_FX);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;\nvarying vec4 vReflUv;\nuniform mat4 uReflMatrix;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvReflUv = uReflMatrix * vec4(vGroundPos, 1.0);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE}\n${FX_DECL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${fragment}\nfloat gWetRough = 1.0;\nfloat gPuddle = 0.0;\nif (uWet > 0.0) { ${wet} }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, min(roughnessFactor, gWetRough), uWet);')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${NIGHT_LIGHT}`)
      .replace('#include <opaque_fragment>', `${mirror ? WET_MIRROR : ''}\n#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}

/** Mowed stripes (fixed world direction, like a real groundskeeper) + lush/dry patches. */
export function shadeGrass(material: THREE.Material): void {
  patch(
    material,
    'grass-v4',
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
    // Wet grass: deeper, slightly blue-green, a soft sheen.
    'diffuseColor.rgb *= mix(vec3(1.0), vec3(0.74, 0.84, 0.78), uWet); gWetRough = 0.5;',
  );
}

/** Older and newer asphalt patches, darker rubbered-in centre of the road, oil stains. */
export function shadeAsphalt(material: THREE.Material): void {
  patch(
    material,
    'asphalt-v3',
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
    // Soaked asphalt: much darker and glossy; standing water in the dips is a mirror.
    /* glsl */ `
      vec2 wp = vGroundPos.xz;
      float puddle = smoothstep(0.58, 0.68, gFbm(wp / 9.0 + 3.1)) * smoothstep(0.25, 0.6, gNoise(wp / 2.5));
      float streak = gNoise(wp * vec2(0.6, 0.12));
      diffuseColor.rgb *= mix(1.0, mix(0.5, 0.32, puddle), uWet);
      gWetRough = mix(0.14 + 0.14 * streak, 0.025, puddle);
      gPuddle = puddle;
    `,
    true,
  );
}

/** Gravel traps: raked lines and darker damp patches. */
export function shadeGravel(material: THREE.Material): void {
  patch(
    material,
    'gravel-v3',
    /* glsl */ `{
      vec2 gp = vGroundPos.xz;
      diffuseColor.rgb *= mix(0.85, 1.08, gFbm(gp / 12.0));
      diffuseColor.rgb *= 0.95 + 0.05 * sin(gp.x * 2.1 + gp.y * 1.3);
    }`,
    'diffuseColor.rgb *= mix(1.0, 0.68, uWet); gWetRough = 0.45;',
  );
}
