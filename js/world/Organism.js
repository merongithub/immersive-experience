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
import { Readout } from "./Readout.js";
import { Nova } from "./Nova.js";
import { SESSION } from "./Seed.js";
import { Voyage, BODY } from "./Voyage.js";
import { StarSystem } from "./StarSystem.js";

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
  /**
   * @param {object}  opts
   * @param {object=} opts.film  capture mode: {width, height, pixelRatio}. Sets
   *   the render size explicitly and LOCKS the adaptive downscaler — see
   *   _adapt() for why leaving that running would ruin a take.
   */
  constructor({ view, bus, film = null }) {
    this.view = view;
    this.bus = bus;
    this.film = film;
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
    //
    // A film sets both explicitly instead. Backing store is width × height ×
    // pixelRatio, and that is exactly what canvas.captureStream() records, so
    // the numbers you pass are the numbers you get regardless of the window.
    this._basePR = this.film ? (this.film.pixelRatio || 1)
                             : Math.min(devicePixelRatio, 1.5);
    r.setPixelRatio(this._basePR);
    // updateStyle false: the canvas keeps filling the window via CSS while the
    // drawing buffer renders at film resolution.
    r.setSize(this._w(), this._h(), !this.film);
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
    this.camera = new THREE.PerspectiveCamera(50, this._w() / this._h(), 0.5, 1200);
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

    /* Seeded from the session, so a given galaxy detonates in the same places
       — which is what makes a shared seed a shared experience rather than the
       same arms with different luck. */
    this.nova = new Nova();
    this.nova.useRng(SESSION.rng);

    this.tendrils.setPixelRatio(this._basePR);
    this.dust.setPixelRatio(this._basePR);
    const grade = this.film?.grade;
    if (grade) {
      // Sprites in pixels of a 1080-line frame, so a 4K take holds the same
      // stars a 1080 one does. Frame height, not width: the framing is set by
      // the vertical field of view.
      const scale = (this.film.height * (this.film.pixelRatio || 1)) / 1080;
      this.tendrils.setFilmScale(scale, grade.minPx);
      this.dust.setFilmScale(scale, grade.minPx);
    }

    this.rig = new CameraRig({
      camera: this.camera,
      domElement: this.view,
      onMode: (m) => this.onCameraMode?.(m),
    });

    /* A film with somewhere to go — see Voyage. The camera flies it; the
       place itself is drawn by StarSystem. */
    this.voyage = this.film?.journey ? new Voyage() : null;
    if (this.voyage) {
      this.system = new StarSystem(this.scene, this.voyage);
      this.rig.voyage = this.voyage;
    }

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
    this.post = new Post(this.renderer, this.scene, this.camera,
                         { grade: this.film?.grade });

    /* A focus film turns the picture down in two specific ways, both because
       motion and flicker in peripheral vision are what pull eyes off work. The
       audio pulse and the camera drift are untouched; only their visible
       amplitude changes. */
    if (this.film) {
      this.post.pulseAmount = this.film.visualPulse ?? 1;
      this.rig.swing = this.film.swing ?? 1;
      // Film gets the film camera unless the take explicitly asks for the
      // live drift (&cam=drift) — the descent into the plane that drift is
      // built around is exactly what ruined the first film's framing.
      this.rig.cinema = this.film.cam !== "drift";
      if (this.film.readout) {
        this.readout = new Readout();
        this.readout.setSize(this._w(), this._h());
      }
    }
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

    /* A film has a floor. Live, full depth dims to 0.45, which is right in a
       dark room with your eyes closed and near-black on a phone in daylight —
       where most of a film's audience is. The descent is rescaled to land on
       the floor rather than clamped at it: a clamp would reach it a third of
       the way down and sit there, and the dimming is the shape of the piece. */
    const floor = this.film?.grade?.floor ?? 0;
    const dim = Math.min(0.55, 1 - floor);
    this.renderer.toneMappingExposure = Math.max(floor,
      (1.0 - d * dim) * (1 + lift) * (1 - bus.away * 0.7));

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

  /**
   * Keep a take alive while the tab is hidden.
   *
   * requestAnimationFrame halts the moment a tab is covered — and on a Mac a
   * window behind the terminal counts as covered — while the master plays on.
   * The first twenty-minute take lost two minutes of picture to exactly that,
   * with nothing on screen to say so. Audio does not stop in a hidden tab, so
   * a processing node on the playback context is a clock that keeps ticking,
   * and while rAF is asleep it drives the frame instead. Frames are paced to
   * the film rate; when the tab is visible it does nothing at all.
   *
   * ScriptProcessorNode is deprecated and it is the right tool here: an
   * AudioWorklet would need a second file fetched at runtime for a callback
   * that only ever forwards a tick. 256 frames is ~5 ms at 48 kHz: frames can
   * only land on callback boundaries, and at 512 the nearest boundary past a
   * 60 fps period was 21 ms — a take paced at 47 fps, measured.
   *
   * @param {BaseAudioContext} ctx  the context the film's audio plays on
   */
  attachPacer(ctx) {
    if (!this.film || !ctx || this._pacer) return;
    const sp = ctx.createScriptProcessor(256, 1, 1);
    const period = 1000 / this.film.fps;
    let last = performance.now();
    sp.onaudioprocess = () => {
      if (this._disposed) return;
      if (!document.hidden) { last = performance.now(); return; }
      const now = performance.now();
      if (now - last >= period - 1) { last = now; this._tick(); }
    };
    sp.connect(ctx.destination);   // silent; a node must be connected to run
    this._pacer = sp;
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
    if (this.mic) this.mic.update(dt, bus);
    else this._releaseVoice(dt, bus);
    this.guide?.update(dt, bus, this.mode);
    this.depth.update(dt, bus);
    this.trace?.update(dt, bus, this.mode);

    const tuning = this._descend(bus);

    // After Depth and the driver, which between them publish the film clock.
    this.voyage?.update(t, dt, bus);

    // Before the world reads it, so the frame a nova fires on is the frame it
    // is visible on. Reading the Bus only, which is why a film detonates in
    // the same places the live piece does.
    this.nova.update(dt, bus);

    this.galaxy.update(t, dt, bus);
    this.tendrils.update(t, dt, bus, tuning, this.presence, this.nova);
    this.dust.update(t, dt, bus);
    this.rig.update(t, dt, bus);
    if (this.voyage) this._closeUp(t, dt, bus);
    this.post.update(t, dt, bus, this.nova, this._close || 0);

    this.post.render(dt);

    // After the composite and BEFORE the capture, so the type is crisp in the
    // file rather than bloomed, and present in it at all.
    if (this.readout) {
      this.readout.update(this.depth.info, bus.depth);
      this.readout.render(this.renderer);
    }

    // One recorded frame per rendered frame, taken right after the composite.
    this.capture?.frame();

    this._adapt(dt);

    if (this._resolveReady) {
      const done = this._resolveReady;
      this._resolveReady = null;
      requestAnimationFrame(() => done());
    }
  }

  /**
   * What changes when the camera is among the stars rather than above them.
   *
   * Star sprites resolve into points and the nearest clear away (see
   * Tendrils.setCloseUp); the near plane comes in with the camera, from the
   * half unit that is plenty for a galaxy to the few hundredths a world
   * three tenths of a unit wide needs. And the bodies are told how big a
   * pixel is, so the star knows whether it is a disc yet or still a glint.
   */
  _closeUp(t, dt, bus) {
    const v = this.voyage, cam = this.camera;
    const dStar = cam.position.distanceTo(v.star);
    const dWorld = cam.position.distanceTo(v.planet);

    const k = Math.min(1, Math.max(0, (22 - dStar) / (22 - 8)));
    const closeness = k * k * (3 - 2 * k);
    this.tendrils.setCloseUp(closeness, closeness * 2.8);
    this._close = closeness;

    const nearest = Math.min(dStar - BODY.starRadius,
                             dWorld - BODY.planetRadius * 2.6);   // ring's edge
    const near = Math.min(0.5, Math.max(0.02, nearest * 0.3));
    if (Math.abs(cam.near - near) > near * 0.01) {
      cam.near = near;
      cam.updateProjectionMatrix();
    }

    const H = this.renderer.getDrawingBufferSize(_size).y;
    const pxPerUnit = (H / 2) / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    this.system.update(t, dt, bus, cam, pxPerUnit, H / 1080);
  }

  /**
   * Ease the voice signals to rest when there is nobody on the mic.
   *
   * Mic is the only publisher of these, and it stops being ticked the moment
   * the listener turns their voice off — which left every one of them frozen
   * at whatever it held on the last frame, for the rest of the session. Turn
   * the mic off mid-note and the field kept a permanent outward push, the
   * readout sat at a level nobody was producing, and the camera went on
   * breathing someone else's rhythm at full confidence.
   *
   * Faded rather than zeroed. A hard cut would snap the arms back the instant
   * the button was pressed, and letting go of a note should look like letting
   * go of it.
   */
  _releaseVoice(dt, bus) {
    if (!bus.voice && !bus.voiceBreathAmt) return;   // already at rest
    const k = 1 - Math.exp(-dt / 0.6);
    bus.voice -= bus.voice * k;
    bus.voiced -= bus.voiced * k;
    bus.voiceAttack -= bus.voiceAttack * k;
    // Trust decays first, so the breath curve is ignored before it is unwound
    // — the reverse order would hand the camera a collapsing breath to follow.
    bus.voiceBreathAmt -= bus.voiceBreathAmt * (1 - Math.exp(-dt / 0.35));
    bus.voiceBreath -= (bus.voiceBreath - 0.5) * k;
    bus.voicePitch -= (bus.voicePitch - 0.5) * k;   // back to the neutral hue
  }

  /* Drop render scale before dropping particle count: the field's silhouette is
     the point, and a slightly softer image costs far less than a thinner body.

     Locked while filming, and it has to be. A capture run sits under 42fps most
     of the time, so this fires, drops the scale 18%, and then cannot climb back
     because recovery needs 57fps — it ratchets down and stays there. The video
     goes visibly soft a few minutes in and never recovers. */
  _adapt(dt) {
    if (this.film) return;
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

  _w() { return this.film ? this.film.width : innerWidth; }
  _h() { return this.film ? this.film.height : innerHeight; }

  _resize() {
    // A film's frame size is fixed by the take, not by the window. Dragging the
    // browser mid-recording must not change the shape of the video.
    const w = this._w(), h = this._h();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, !this.film);
    this.post.setSize(w, h);
    this.readout?.setSize(w, h);
  }

  destroy() {
    this._disposed = true;
    cancelAnimationFrame(this.raf);
    try { this._pacer?.disconnect(); } catch { /* already gone */ }
    removeEventListener("resize", this._onResize);
    this.rig?.dispose();
    this.presence?.dispose();
    this.depth?.dispose();
    this.mic?.disable();
    this.galaxy?.dispose();
    this.tendrils?.dispose();
    this.dust?.dispose();
    this.system?.dispose();
    this.post?.dispose();
    this.renderer.dispose();
  }
}

const _size = new THREE.Vector2();
