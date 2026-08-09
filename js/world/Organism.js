/**
 * Organism — orchestrator for the ANIMA field.
 *
 * Owns the renderer, the scene, the loop, and the per-mode tuning. Reads the
 * Bus; writes to Spine, Tendrils, Membrane, Dust, CameraRig, Post. There are no
 * lights: every surface here emits, and the composite does the rest.
 */

import * as THREE from "three";

import { Galaxy } from "./Galaxy.js";
import { Tendrils, pickTier } from "./Tendrils.js";
import { Dust } from "./Dust.js";
import { Post } from "./Post.js";
import { CameraRig } from "./CameraRig.js";
import { Presence } from "../presence/Presence.js";
import { Depth } from "../presence/Depth.js";

/* Per-temperament physics. Mode never changes what is on screen — only how
   eagerly it moves and how tightly it holds together. */
const TUNING = {
  /* `orbit` is deliberately small. The arms are drawn by the ROOTS, and the
     roots rotate as a pattern; a star's own orbital drift only shears them. Set
     it high and every star laps the disc several times within its lifetime, the
     arms smear into a featureless ring, and all that survives is the bulge. */
  focus:    { flow: 0.28, swirl: 0.7, bind: 1.9, damp: 0.34, orbit: 1.5, size:  92, fov: 46 },
  bath:     { flow: 0.34, swirl: 0.9, bind: 1.7, damp: 0.30, orbit: 1.7, size: 104, fov: 52 },
  meditate: { flow: 0.46, swirl: 1.1, bind: 1.6, damp: 0.30, orbit: 2.1, size: 100, fov: 50 },
  dance:    { flow: 0.95, swirl: 1.8, bind: 1.4, damp: 0.26, orbit: 3.4, size: 112, fov: 58 },
};

export class Organism {
  constructor({ view, bus }) {
    this.view = view;
    this.bus = bus;
    this.mode = "meditate";
    this.tuning = TUNING.meditate;
    // Scratch object reused every frame by _descend; allocating a fresh tuning
    // per frame would churn the GC for no reason.
    this._deep = { ...TUNING.meditate };
    this._disposed = false;
    this.raf = 0;

    // Adaptive render scale: measured, not guessed from a GPU string.
    this._frameAvg = 1 / 60;
    this._scale = 1;
    this._sinceCheck = 0;

    this._initRenderer();
    this._initScene();
    this._build();
    this._initPost();

    this._onResize = () => this._resize();
    addEventListener("resize", this._onResize);
  }

  _initRenderer() {
    const r = new THREE.WebGLRenderer({
      canvas: this.view,
      antialias: false,          // bloom eats the aliasing; AA is wasted cost here
      powerPreference: "high-performance",
    });
    // 1.5 rather than 2: the particle load is fill-bound, and on a black field
    // the extra density buys almost nothing visible.
    this._basePR = Math.min(devicePixelRatio, 1.5);
    r.setPixelRatio(this._basePR);
    r.setSize(innerWidth, innerHeight);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.setClearColor(0x000000, 1);
    this.renderer = r;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.clock = new THREE.Clock();

    // Far plane must clear the background star shell at r = 260, with margin.
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 1200);
    this.camera.position.set(0, 55, 80);
    this.camera.lookAt(0, 0, 0);
  }

  _build() {
    this.galaxy = new Galaxy();
    this.tendrils = new Tendrils({
      renderer: this.renderer,
      scene: this.scene,
      spine: this.galaxy,     // the root-texture provider; see Galaxy.js
      size: pickTier(),
    });
    this.dust = new Dust(this.scene);

    this.tendrils.setPixelRatio(this._basePR);
    this.dust.setPixelRatio(this._basePR);

    this.rig = new CameraRig({
      camera: this.camera,
      domElement: this.view,
      onMode: (m) => this.onCameraMode?.(m),
    });

    this.depth = new Depth();
    this.presence = new Presence({
      domElement: this.view,
      camera: this.camera,
      depth: this.depth,
    });

    // Camera input is activity too, or leaning in to look would deepen you.
    for (const ev of ["pointerdown", "wheel", "keydown"]) {
      addEventListener(ev, () => this.depth.poke(1), { passive: true });
    }
  }

  _initPost() {
    this.post = new Post(this.renderer, this.scene, this.camera);
  }

  /**
   * Blend the mode's tuning toward its deep-session form.
   *
   * Depth is a slow descent, not a preset: the galaxy turns down, the
   * turbulence quiets, the frame narrows, and — the part that matters most for
   * eyes closed — the whole image DIMS. A meditation app that keeps a bright
   * screen burning next to someone who is not looking at it has misunderstood
   * what it is for. After several minutes still, this becomes something you
   * mostly hear, and the light stops competing with the dark room it is in.
   */
  _descend(bus) {
    const d = bus.depth;
    const t = this.tuning;
    const k = 1 - d;

    this._deep.flow  = t.flow  * (0.35 + 0.65 * k);
    this._deep.swirl = t.swirl * (0.45 + 0.55 * k);
    this._deep.orbit = t.orbit * (0.42 + 0.58 * k);
    this._deep.bind  = t.bind;
    this._deep.damp  = t.damp;
    this._deep.size  = t.size * (1.0 + d * 0.18);   // fewer, softer, larger motes

    // Narrower frame with depth — the world closes in rather than receding.
    const fov = t.fov - d * 7;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.tendrils.uniforms.uSize.value = this._deep.size;

    // Arrival briefly lifts everything back up, so returning is a greeting
    // rather than a jump-cut into whatever state you left.
    const lift = bus.arrival * 0.5;
    this.renderer.toneMappingExposure = (1.0 - d * 0.55) * (1 + lift) * (1 - bus.away * 0.7);

    return this._deep;
  }

  setMode(name) {
    if (!TUNING[name]) return;
    this.mode = name;
    this.tuning = TUNING[name];
    this.tendrils.uniforms.uSize.value = this.tuning.size;
    this.camera.fov = this.tuning.fov;
    this.camera.updateProjectionMatrix();
  }

  whenReady() {
    if (!this._ready) {
      this._ready = new Promise((res) => { this._resolveReady = res; });
    }
    return this._ready;
  }

  start() {
    const loop = () => {
      if (this._disposed) return;
      this.raf = requestAnimationFrame(loop);
      this._tick();
    };
    loop();
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const bus = this.bus;

    bus.update(dt);

    // Presence must resolve BEFORE the sim reads it, or the field is always
    // responding to where you were one frame ago on top of its own hesitation.
    // Depth runs last of the three: it consumes the pokes the other two filed.
    this.presence.update(dt, bus);
    this.mic?.update(dt, bus);
    this.depth.update(dt, bus);
    this.trace?.update(dt, bus, this.mode);

    const tuning = this._descend(bus);

    this.galaxy.update(t, dt, bus);
    this.tendrils.update(t, dt, bus, tuning, this.presence);
    this.dust.update(t, dt, bus);
    this.rig.update(t, dt, bus);
    this.post.update(t, dt, bus);

    this.post.render(dt);

    this._adapt(dt);

    if (this._resolveReady) {
      const done = this._resolveReady;
      this._resolveReady = null;
      requestAnimationFrame(() => done());
    }
  }

  /* Drop render scale before dropping particle count: the field's silhouette is
     the point, and a slightly softer image costs far less than a thinner body. */
  _adapt(dt) {
    this._frameAvg += (dt - this._frameAvg) * 0.05;
    this._sinceCheck += dt;
    if (this._sinceCheck < 2.5) return;
    this._sinceCheck = 0;

    const fps = 1 / Math.max(this._frameAvg, 1e-4);
    let next = this._scale;
    if (fps < 42 && this._scale > 0.62) next = this._scale - 0.18;
    else if (fps > 57 && this._scale < 1) next = Math.min(1, this._scale + 0.12);

    if (next !== this._scale) {
      this._scale = next;
      const pr = this._basePR * next;
      this.renderer.setPixelRatio(pr);
      this.tendrils.setPixelRatio(pr);
      this.dust.setPixelRatio(pr);
      this._resize();
    }
  }

  _resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.post.setSize(innerWidth, innerHeight);
  }

  destroy() {
    this._disposed = true;
    cancelAnimationFrame(this.raf);
    removeEventListener("resize", this._onResize);
    this.rig?.dispose();
    this.presence?.dispose();
    this.depth?.dispose();
    this.mic?.disable();
    this.galaxy?.dispose();
    this.tendrils?.dispose();
    this.dust?.dispose();
    this.post?.dispose();
    this.renderer.dispose();
  }
}
