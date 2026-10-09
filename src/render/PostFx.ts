import { N8AOPostPass } from 'n8ao';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import * as THREE from 'three';

/**
 * Post-processing chain (pmndrs/postprocessing, Zlib + N8AO, ISC):
 * scene -> ambient occlusion (contact shadows under cars, between rails,
 * around buildings: what makes boxes stop looking like floating boxes) ->
 * soft bloom on bright highlights -> ACES filmic tone mapping -> vignette ->
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

    const bloom = new BloomEffect({ intensity: 0.35, luminanceThreshold: 0.9, luminanceSmoothing: 0.2, mipmapBlur: true });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.35 });
    this.composer.addPass(new EffectPass(camera, bloom, tone, vignette));
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
