import { N8AOPostPass } from 'n8ao';
import { BloomEffect, Effect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import * as THREE from 'three';

/**
 * Post-processing chain (pmndrs/postprocessing, Zlib + N8AO, ISC):
 * scene -> ambient occlusion (contact shadows under cars, between rails,
 * around buildings: what makes boxes stop looking like floating boxes) ->
 * soft bloom on bright highlights -> AgX tone mapping -> contrast/saturation -> vignette ->
 * SMAA anti-aliasing. The renderer's own tone mapping and MSAA are off
 * while this runs (they would apply twice).
 */
export class PostFx {
  private readonly composer: EffectComposer;
  private readonly ao: N8AOPostPass;
  private pixelRatio: number;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) {
    this.pixelRatio = renderer.getPixelRatio();
    renderer.toneMapping = THREE.NoToneMapping;
    // The chain renders several passes per frame: count the whole frame, not the last pass.
    renderer.info.autoReset = false;
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    const size = renderer.getSize(new THREE.Vector2());
    this.composer.addPass(new RenderPass(scene, camera));

    this.ao = new N8AOPostPass(scene, camera, size.x, size.y);
    this.ao.configuration.aoRadius = 2.5;
    this.ao.configuration.distanceFalloff = 1.2;
    this.ao.configuration.intensity = 2.2;
    this.ao.configuration.halfRes = true;
    this.ao.configuration.depthAwareUpsampling = true;
    this.ao.setQualityMode('Performance');
    // Gamma is applied at the end of the chain, not by the AO pass.
    this.ao.configuration.gammaCorrection = false;
    this.composer.addPass(this.ao);

    // One NaN/Inf pixel (some PBR paths hit them at grazing angles) would be blown up by
    // the bloom mip chain into big white blocks: scrub them before anything blurs.
    const sanitize = new Effect(
      'Sanitize',
      /* glsl */ `void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        bool bad = any(isnan(inputColor)) || any(isinf(inputColor));
        outputColor = bad ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(clamp(inputColor.rgb, 0.0, 64.0), inputColor.a);
      }`,
    );
    this.composer.addPass(new EffectPass(camera, sanitize));

    const bloom = new BloomEffect({ intensity: 0.35, luminanceThreshold: 0.9, luminanceSmoothing: 0.2, mipmapBlur: true });
    // AgX keeps saturated liveries and grass from washing out the way ACES does;
    // a touch of contrast and colour afterwards gives the broadcast look. (The stock
    // BrightnessContrast/HueSaturation effects turned near-black pixels white.)
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    const grade = new Effect(
      'Grade',
      /* glsl */ `void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = clamp(inputColor.rgb, 0.0, 1.0);
        c = clamp((c - 0.5) * 1.12 + 0.5, 0.0, 1.0);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        outputColor = vec4(clamp(mix(vec3(l), c, 1.15), 0.0, 1.0), inputColor.a);
      }`,
    );
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.35 });
    this.composer.addPass(new EffectPass(camera, bloom, tone, grade, vignette));
    this.composer.addPass(new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM })));
  }

  render(dt: number): void {
    // Dynamic resolution changes the renderer's pixel ratio: resize the buffers with it.
    const ratio = this.renderer.getPixelRatio();
    if (ratio !== this.pixelRatio) {
      this.pixelRatio = ratio;
      const size = this.renderer.getSize(new THREE.Vector2());
      this.composer.setSize(size.x, size.y, false);
    }
    this.renderer.info.reset();
    this.composer.render(dt);
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height, false);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
