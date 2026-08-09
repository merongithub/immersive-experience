/**
 * Post — HDR composite: bloom, then grain/aberration/vignette, then output.
 *
 * The whole look depends on this. Every material in ANIMA writes values well
 * above 1.0 into a half-float target; bloom is what turns those into light.
 * A low threshold is correct here because the scene is almost entirely black —
 * there is nothing to protect from blooming.
 */

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { PostFXShader } from "./shaders.js";

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      1.05,  // strength
      0.85,  // radius — wide and soft; this is breath, not a lens flare
      0.08   // threshold — low, so the faint disc blooms and not just the core
    );
    this.composer.addPass(this.bloom);

    this.fx = new ShaderPass(PostFXShader);
    this.composer.addPass(this.fx);

    this.composer.addPass(new OutputPass());
  }

  setCamera(camera) {
    this.camera = camera;
    this.renderPass.camera = camera;
  }

  update(t, dt, bus) {
    this.fx.uniforms.uTime.value = t;
    this.fx.uniforms.uBreath.value = bus.breath;
    // Bloom swells with the body. Small range — past ~1.6 it stops reading as
    // light and starts reading as a blown-out image.
    //
    // The anticipation term is the whole argument for a generative source: the
    // glow starts lifting a beat BEFORE the event sounds, because the event is
    // already scheduled. Reacting to an FFT can only ever arrive late.
    // Bloom widens as the session deepens even as exposure drops, so the image
    // gets softer and more diffuse rather than merely darker — closer to what
    // you see behind closed eyelids than to a screen being turned down.
    this.bloom.strength = 0.82
      + bus.energy * 0.55
      + bus.breath * 0.20
      + bus.onset * 0.25
      + bus.anticipation * 0.18
      + bus.depth * 0.30;

    this.fx.uniforms.uVignette.value = 1.15 + bus.depth * 0.55;
  }

  render(dt) { this.composer.render(dt); }

  setSize(w, h) {
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  dispose() { this.composer.dispose?.(); }
}
