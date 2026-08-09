/**
 * Tendrils — the GPGPU star field of the galaxy.
 *
 * Two ping-ponged float textures (position, velocity) advanced on the GPU, plus
 * a third static texture of per-particle constants. Each star belongs either to
 * a spiral root or to the bulge; forces are:
 *
 *   orbit        steer onto a flat rotation curve — the shear that makes arms
 *   confinement  a stiff spring to the midplane — the disc is thin
 *   turbulence   flattened curl noise — texture within the arms
 *   churn        spheroidal motion inside the bulge only
 *
 * The name is a holdover from the organism this grew out of. The mechanism did
 * not change — emit from discrete roots, let a flow field do the shaping — only
 * the geometry the roots describe.
 */

import * as THREE from "three";
import { GPUComputationRenderer } from "three/addons/misc/GPUComputationRenderer.js";
import { NOISE_GLSL, PALETTE_GLSL } from "./shaders.js";
import { DISC } from "./Galaxy.js";

/* Simulation size is chosen once at boot. Rebuilding the compute graph mid-run
   to chase a framerate costs more than it saves, so instead we pick a sane tier
   up front and let Organism trim render resolution if frames get long. */
export function pickTier() {
  const q = new URLSearchParams(location.search).get("p");
  if (q && /^\d+$/.test(q)) return Math.max(64, Math.min(1024, +q));
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (mobile) return 256;                                   //  65k
  const mem = navigator.deviceMemory || 8;
  if (mem <= 4) return 320;                                 // 102k
  // Density is what turns discrete motes into substance. Below ~200k the field
  // reads as speckle no matter how the sprites are tuned.
  return 512;                                               // 262k
}

/* Shared disc maths. Every stage — spawn, orbit, render — reads the same
   rotation curve and scale height, or the structure fights itself. */
const DISC_GLSL = /* glsl */ `
  uniform float uDiscRadius, uCoreRadius, uThickness, uOrbitV;

  /* Flat rotation curve: orbital speed is roughly constant with radius outside
     the bulge, rising linearly inside it. This is the actual shape measured in
     spiral galaxies — and visually it is the whole point, because constant
     speed means the inner disc laps the outer one and shears every stream into
     a trailing arc. A Keplerian falloff winds far too fast and smears the arms
     into mush within a minute. */
  float orbitalSpeed(float r){
    return uOrbitV * smoothstep(0.0, uCoreRadius, r);
  }

  /* Scale height flares with radius, as real discs do. */
  float discHeight(float r){
    return uThickness * (0.45 + 0.9 * clamp(r / uDiscRadius, 0.0, 1.4));
  }
`;

/** Body radius in world units. Shared by the sim and the render material — see
    the note on the render side's uRadius for why they must not drift apart. */
const RADIUS = 5.0;

/** Particle count the brightness constants were tuned against; uGain rescales
    every other tier to match it. */
const REF_COUNT = 384 * 384;

const POS_FRAG = /* glsl */ `
  ${NOISE_GLSL}
  ${DISC_GLSL}
  uniform sampler2D uSeed;
  uniform sampler2D uSpine;      // the root texture — now galactic, not a spine
  uniform float uDt, uTime, uBreath;

  vec4 rootAt(float u){ return texture2D(uSpine, vec2(clamp(u, 0.0, 1.0), 0.5)); }

  void main(){
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 pos  = texture2D(texturePosition, uv);
    vec3 vel  = texture2D(textureVelocity, uv).xyz;
    vec4 seed = texture2D(uSeed, uv);

    vec3 p = pos.xyz + vel * uDt;

    // Lifetimes are long here, unlike the organism. A star should complete a
    // meaningful fraction of an orbit before it is recycled, or the arms look
    // like they are boiling rather than turning.
    // Short enough that a star stays near the root that placed it, long enough
    // that turnover is invisible. This is the knob that keeps arms crisp.
    float life = pos.w - uDt * (0.085 / seed.a);

    // NaN / runaway trap. Written as a negated comparison because a NaN fails
    // every comparison, so this catches both a diverged particle and a poisoned
    // one and recycles it. Without it a handful of bad particles persist for
    // the whole session and each one is a permanent bright speck.
    bool bad = !(dot(p, p) < 1.0e7);

    if (life <= 0.0 || bad) {
      vec3 j = vec3(
        hash13(vec3(uv, uTime)) - 0.5,
        hash13(vec3(uv.yx, uTime + 3.1)) - 0.5,
        hash13(vec3(uv, uTime + 7.7)) - 0.5);

      if (seed.r < 0.0) {
        // Bulge: a flattened spheroid, densest at the centre. A gentler
        // exponent spreads it into a glow; crank it and every bulge star piles
        // into a few world units and the nucleus becomes a hard bright dot.
        float rr = pow(abs(hash13(vec3(uv, uTime + 19.3))), 1.35) * uCoreRadius * 1.5;
        vec3 dir = normalize(j + vec3(1e-4));
        p = vec3(dir.x * rr, dir.y * rr * 0.55, dir.z * rr);
      } else {
        vec3 home = rootAt(seed.r).xyz;
        float rr = length(home.xz);
        // Scatter in the plane, but stay flat: vertical spread is the scale
        // height, an order of magnitude smaller than the radial one. Getting
        // this wrong is what turns a galaxy into a spherical blob.
        float spread = 0.6 + 2.4 * seed.g;
        p = home + vec3(j.x * spread, j.y * discHeight(rr) * 0.7, j.z * spread);
      }
      life = 1.0;
    }

    gl_FragColor = vec4(p, life);
  }
`;

const VEL_FRAG = /* glsl */ `
  ${NOISE_GLSL}
  ${DISC_GLSL}
  uniform sampler2D uSeed;
  uniform sampler2D uSpine;
  uniform float uDt, uTime, uFlow, uNoiseScale, uBind, uSwirl, uDamp, uBreath, uOnset;
  uniform vec3 uAttract;
  uniform float uAttractAmt, uVoice;

  void main(){
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec3 p    = texture2D(texturePosition, uv).xyz;
    vec3 v    = texture2D(textureVelocity, uv).xyz;
    vec4 seed = texture2D(uSeed, uv);

    // Velocity needs the same NaN trap the position shader has. Recycling only
    // the position leaves a poisoned velocity behind, which re-poisons the
    // fresh position on the very next step — the particle never recovers.
    if (!(dot(v, v) < 1.0e8)) v = vec3(0.0);

    // Cylindrical frame about the galactic axis.
    vec2 xz = p.xz;
    float r = length(xz) + 1e-4;
    vec2 rHat = xz / r;
    vec2 tHat = vec2(-rHat.y, rHat.x);   // prograde, +y right-handed

    // --- orbit -----------------------------------------------------------
    // Steer toward the rotation curve rather than integrating gravity. Real
    // gravity would need a softened potential and a much smaller timestep to
    // stay stable; steering toward a known speed is unconditionally stable and
    // produces the same shear, which is the part you can actually see.
    float vt = orbitalSpeed(r) * (1.0 + uBreath * 0.05);
    vec2 targetXZ = tHat * vt;
    vec2 curXZ = v.xz;
    vec3 orbit = vec3((targetXZ.x - curXZ.x), 0.0, (targetXZ.y - curXZ.y)) * uBind;

    // --- disc confinement ------------------------------------------------
    // A stiff spring toward the midplane with heavy local damping. The disc is
    // thin because this is strong, and this being strong is what makes the
    // whole thing read as a galaxy rather than a swarm.
    // Soft, and deliberately underdamped. A stiff critically-damped spring
    // pins every star to y = 0 and the disc becomes a razor with a hard line
    // edge-on. Real discs stay puffed because stars keep vertical velocity —
    // so let them oscillate through the plane instead of sticking to it.
    float h = discHeight(r);
    float vertical = -(p.y / max(h, 0.15)) * 0.85 - v.y * 0.30;

    // --- radial containment ----------------------------------------------
    // Only at the rim, and gently, so the outer disc frays instead of ending.
    float over = smoothstep(uDiscRadius, uDiscRadius * 1.30, r);
    vec3 rim = vec3(-rHat.x, 0.0, -rHat.y) * over * 5.0;

    // --- turbulence ------------------------------------------------------
    // Flattened sampling: features are wide in the plane and shallow through
    // it, so turbulence stirs the arms without puffing up the disc.
    vec3 aniso = vec3(1.0, 3.4, 1.0);
    vec3 f = curl(p * uNoiseScale * aniso + vec3(0.0, uTime * 0.03, 0.0)) * uFlow
           + curl(p * uNoiseScale * 2.7 * aniso + vec3(11.0, 4.0, uTime * 0.09)) * uFlow * 0.35;
    f.y *= 0.55;   // enough vertical stirring to keep the disc from flattening

    // --- core ------------------------------------------------------------
    // Inside the bulge, swap shear for a slow spheroidal churn, otherwise the
    // centre becomes a hard bright disc of stars all moving the same way.
    float core = 1.0 - smoothstep(uCoreRadius * 0.35, uCoreRadius * 1.2, r);
    vec3 churn = vec3(tHat.x, (seed.b - 0.5) * 1.6, tHat.y) * uSwirl * core;

    // --- you ---------------------------------------------------------
    // A local warmth the stars lean toward. The falloff is deliberately tight:
    // a wide pull drags the whole disc off-centre and looks like a bug, while a
    // narrow one reads as the field noticing one place — which is the point.
    vec3 toYou = uAttract - p;
    float youDist = length(toYou) + 1e-4;
    // Wide enough to bend a whole arm as you pass. The first version fell off
    // by 26 units against a 44-unit disc, which was technically a force and
    // visually nothing at all.
    // Wide, but capped near the centre. An uncapped 1/dist-style pull yanks the
    // few stars closest to the cursor into a hard spike while the rest barely
    // move — the falloff has to be zero AT you, not maximum, so the field bends
    // around your hand instead of impaling itself on it.
    float reach = smoothstep(0.0, 7.0, youDist) * (1.0 - smoothstep(6.0, 44.0, youDist));
    vec3 you = (toYou / youDist) * reach * uAttractAmt * 9.0;

    // A sung note pushes outward everywhere rather than pulling to a point —
    // the difference between being touched and being resonated through.
    vec3 sung = normalize(vec3(rHat.x, p.y * 0.35, rHat.y)) * uVoice * 2.6
              * (1.0 - smoothstep(0.2, 1.1, r / uDiscRadius));

    v += (orbit + rim + f + churn + you + sung + vec3(0.0, vertical, 0.0)) * uDt;
    v *= exp(-uDamp * uDt);
    v = clamp(v, vec3(-40.0), vec3(40.0));

    gl_FragColor = vec4(v, 0.0);
  }
`;

export class Tendrils {
  constructor({ renderer, scene, spine, size = 384 }) {
    this.size = size;
    this.count = size * size;

    const gpu = new GPUComputationRenderer(size, size, renderer);
    this.gpu = gpu;

    /* --- static per-particle constants --------------------------------
       r: home u along the spine
       g: shell radius scale, biased low so density falls off from the core
       b: swirl phase
       a: lifespan multiplier                                           */
    const seedTex = gpu.createTexture();
    const s = seedTex.image.data;
    const dtPos = gpu.createTexture();
    const dtVel = gpu.createTexture();
    const P = dtPos.image.data;
    const V = dtVel.image.data;

    /* Every particle is assigned to one of the galaxy's discrete roots. Sharing
       a root means sharing a birthplace, so differential rotation shears the
       whole group into the same trailing arc — which is what an arm is. Give
       each particle an independent random position instead and the statistics
       are identical but there is no visible structure at all. */
    const ROOTS = 512;

    for (let i = 0; i < this.count; i++) {
      const o = i * 4;

      // An eighth of the population belongs to the bulge rather than the arms.
      // Marked with u = -1, which rootAt() clamps to texel 0; the spawn branch
      // reads the flag, not the root, so the bulge gets its own geometry.
      const isCore = Math.random() < 0.13;
      const root = Math.floor(Math.random() * ROOTS) / (ROOTS - 1);

      s[o] = isCore ? -1.0 : root;
      s[o + 1] = Math.pow(Math.random(), 0.85);  // scatter width at birth
      s[o + 2] = Math.random();                  // churn phase / colour jitter
      s[o + 3] = 0.55 + Math.random() * 1.1;     // lifespan multiplier

      // Seeded flat and wide so the first seconds are the disc settling into
      // rotation rather than a ball collapsing.
      const rr = Math.pow(Math.random(), 0.6) * 44;
      const th = Math.random() * Math.PI * 2;
      P[o]     = Math.cos(th) * rr;
      P[o + 1] = (Math.random() + Math.random() - 1) * 1.4;
      P[o + 2] = Math.sin(th) * rr;
      P[o + 3] = Math.random();          // staggered life so death is continuous

      V[o] = V[o + 1] = V[o + 2] = V[o + 3] = 0;
    }
    seedTex.needsUpdate = true;

    this.posVar = gpu.addVariable("texturePosition", POS_FRAG, dtPos);
    this.velVar = gpu.addVariable("textureVelocity", VEL_FRAG, dtVel);
    gpu.setVariableDependencies(this.posVar, [this.posVar, this.velVar]);
    gpu.setVariableDependencies(this.velVar, [this.posVar, this.velVar]);

    const shared = {
      uSeed:       { value: seedTex },
      uSpine:      { value: spine.tex },
      uDt:         { value: 0 },
      uTime:       { value: 0 },
      uBreath:     { value: 0 },
      uDiscRadius: { value: DISC.radius },
      uCoreRadius: { value: DISC.coreRadius },
      uThickness:  { value: DISC.thickness },
      uOrbitV:     { value: 6.5 },
    };
    Object.assign(this.posVar.material.uniforms, shared);
    Object.assign(this.velVar.material.uniforms, {
      ...shared,
      uFlow: { value: 0.55 },
      // Features must be smaller than the disc, or the curl field just
      // translates the whole galaxy instead of stirring texture into the arms.
      uNoiseScale: { value: 0.10 },
      // How hard a star is steered onto the rotation curve. High enough to hold
      // the disc together, low enough that turbulence still shows.
      uBind:  { value: 1.6 },
      uSwirl: { value: 1.1 },
      uDamp:  { value: 0.30 },   // low: orbits must persist, not settle
      uOnset: { value: 0 },
      uAttract:    { value: new THREE.Vector3() },
      uAttractAmt: { value: 0 },
      uVoice:      { value: 0 },
    });

    const err = gpu.init();
    if (err) throw new Error(`GPU compute unavailable: ${err}`);

    /* --- render -------------------------------------------------------- */
    const g = new THREE.BufferGeometry();
    const ref = new Float32Array(this.count * 2);
    const dummy = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      ref[i * 2]     = (i % size) / size;
      ref[i * 2 + 1] = Math.floor(i / size) / size;
    }
    g.setAttribute("position", new THREE.BufferAttribute(dummy, 3));
    g.setAttribute("aRef", new THREE.BufferAttribute(ref, 2));
    g.setDrawRange(0, this.count);

    this.uniforms = {
      uPos:    { value: null },
      uVel:    { value: null },
      uSeed:   { value: seedTex },
      uSize:   { value: 95.0 },
      uPixel:  { value: 1 },
      uWarmth: { value: 0.4 },
      uEnergy: { value: 0 },
      uBreath: { value: 0 },
      uAir:    { value: 0 },
      uOnset:  { value: 0 },
      // MUST match the sim's values. The render side grades colour by radius,
      // so a mismatch here silently mis-paints the entire galaxy.
      uDiscRadius: { value: DISC.radius },
      uCoreRadius: { value: DISC.coreRadius },
      // Additive brightness is a SUM over particles, so a denser tier is a
      // brighter image unless gain compensates. Normalising against a reference
      // count keeps the look identical from a 256 phone tier to a 512 desktop
      // one, instead of needing hand-tuned exposure per tier.
      uGain:   { value: (REF_COUNT / (size * size)) },
    };

    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
      vertexShader: /* glsl */ `
        ${NOISE_GLSL}
        uniform sampler2D uPos, uVel, uSeed;
        uniform float uSize, uPixel, uEnergy, uBreath, uAir, uOnset;
        uniform float uDiscRadius, uCoreRadius;
        attribute vec2 aRef;
        varying float vSpeed;
        varying float vRad;      // normalised galactic radius
        varying float vLife;
        varying float vSpark;
        varying float vNebula;   // nebula tint field sampled at the star
        varying float vCore;

        void main(){
          vec4 P = texture2D(uPos, aRef);
          vec3 v = texture2D(uVel, aRef).xyz;
          vec4 seed = texture2D(uSeed, aRef);

          float r = length(P.xz);
          vSpeed = length(v);
          vRad = clamp(r / uDiscRadius, 0.0, 1.6);
          vCore = 1.0 - smoothstep(uCoreRadius * 0.25, uCoreRadius * 1.35, r);

          // Long, symmetric fade. Stars should not visibly pop in or out; with
          // orbital lifetimes this is the only thing hiding the turnover.
          vLife = smoothstep(1.0, 0.88, P.w) * smoothstep(0.0, 0.16, P.w);

          // Nebula: a slow 3D noise field sampled in the disc plane. Cheaper and
          // far more convincing than billboard clouds, because it colours the
          // stars themselves rather than hazing over them.
          vNebula = vnoise3(P.xyz * 0.045 + vec3(0.0, 0.0, 0.0));

          // Only a scattered few stars twinkle, and only on air energy.
          float pick = step(0.90, fract(seed.b * 71.3 + floor(P.w * 90.0) * 0.618));
          vSpark = pick * (uAir * 0.9 + uOnset * 0.8);

          vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);
          float s = uSize * uPixel * (0.30 + 1.0 * seed.g) * (1.0 + vSpark * 2.4);
          gl_PointSize = clamp(s * (1.0 / -mv.z), 0.7, 26.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${PALETTE_GLSL}
        uniform float uWarmth, uEnergy, uBreath, uGain;
        varying float vSpeed;
        varying float vRad;
        varying float vLife;
        varying float vSpark;
        varying float vNebula;
        varying float vCore;

        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          float sprite = exp(-r2 * 7.0);

          // Galactic colour gradient, which is real astronomy and also happens
          // to be the most legible cue that this is a galaxy: old cool stars
          // crowd the bulge and read yellow-white, young hot ones live out in
          // the arms and read blue-violet.
          float t = uWarmth + (1.0 - vRad) * 0.55 + vCore * 0.45 - vNebula * 0.30;

          // The nucleus is the one place allowed to reach bone white.
          float heat = clamp(vCore * 0.70 + vSpark + vSpeed * 0.045
                           + (1.0 - vRad) * 0.18 + uEnergy * 0.12, 0.0, 1.0);
          vec3 c = anima(t, heat * heat * 0.9);

          // Dust lanes. Nebula noise both tints AND occludes, so the arms get
          // dark veins through them instead of reading as an even smear.
          float dust = 1.0 - smoothstep(0.52, 0.80, vNebula) * 0.55;

          // Fray the rim rather than ending the disc at a hard circle.
          float edge = 1.0 - smoothstep(0.92, 1.35, vRad);

          // Compensate for projected density. Bulge stars are packed into a few
          // world units and disc stars are spread over thousands, so grading on
          // heat alone makes the nucleus the only thing on screen — which is
          // exactly what a real long exposure of a galaxy does NOT look like.
          float discLift = 0.55 + 0.85 * smoothstep(0.08, 0.55, vRad);

          float i = sprite * vLife * edge * dust * uGain
                  * (0.135 + 0.075 * uEnergy + 0.040 * uBreath)
                  * (0.30 + 1.15 * heat) * discLift
                  * (1.0 + vSpark * 7.0);

          gl_FragColor = vec4(c * i, 1.0);
        }
      `,
    });

    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  setPixelRatio(pr) { this.uniforms.uPixel.value = pr; }

  update(t, dt, bus, tuning, presence) {
    const pu = this.posVar.material.uniforms;
    const vu = this.velVar.material.uniforms;

    // Clamp the step: a long frame must not let the integrator explode.
    const step = Math.min(dt, 1 / 30);

    pu.uDt.value = step;   vu.uDt.value = step;
    pu.uTime.value = t;    vu.uTime.value = t;
    pu.uBreath.value = bus.breath;
    vu.uBreath.value = bus.breath;
    vu.uOnset.value = bus.onset;

    vu.uFlow.value  = tuning.flow * (0.55 + bus.energy * 1.35 + bus.onset * 0.5);
    vu.uSwirl.value = tuning.swirl * (0.6 + bus.energy * 0.9);
    vu.uBind.value  = tuning.bind;
    vu.uDamp.value  = tuning.damp;
    // The galaxy turns faster as the music works. A small range: past about
    // 1.2x the arms start to visibly wind up within a single session.
    vu.uOrbitV.value = tuning.orbit * (0.92 + bus.energy * 0.22);

    if (presence) {
      vu.uAttract.value.copy(presence.attractor);
      vu.uAttractAmt.value = presence.amount;
    }
    vu.uVoice.value = bus.voice || 0;

    this.gpu.compute();

    this.uniforms.uPos.value = this.gpu.getCurrentRenderTarget(this.posVar).texture;
    this.uniforms.uVel.value = this.gpu.getCurrentRenderTarget(this.velVar).texture;
    this.uniforms.uWarmth.value = bus.warmth;
    this.uniforms.uEnergy.value = bus.energy;
    this.uniforms.uBreath.value = bus.breath;
    this.uniforms.uAir.value = bus.air;
    this.uniforms.uOnset.value = bus.onset;
  }

  dispose() {
    this.gpu.dispose();
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}
