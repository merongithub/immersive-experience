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
import { NOISE_GLSL, PALETTE_GLSL, POINT_GLSL } from "./shaders.js";
import { DISC } from "./Galaxy.js";
import { SESSION } from "./Seed.js";

/** How many nebula regions the shader is compiled for. */
const NEB = 3;

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

/* A ring crosses the disc in about three seconds and fades over three and a
   half, so it is always most visible in the inner disc where it starts and has
   thinned to nothing by the rim. */
const WAVE_SPEED = 15.0;   // world units per second
const WAVE_LIFE = 3.4;     // seconds from full to gone

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
  uniform float uAttractAmt, uVoice, uVoiced;
  /* Travelling rings launched by phrase onsets: (radius, amplitude). Three,
     so a quick phrase cannot cut off the ring the one before it started. */
  uniform vec2 uWaves[3];
  /* A supernova shell: centre, and (radius, amount). Spherical from a point,
     unlike uWaves which are rings about the galactic axis — ejecta does not
     know where the centre of the galaxy is. */
  uniform vec3 uNovaPos;
  uniform vec2 uNova;
  /* Signed, -1..1. Negative gathers the disc inward, positive spreads it. */
  uniform float uConverge;
  #define DISC_R_FADE 38.0

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

    /* Breath scatters. An airy input lifts the curl field, so an exhale frays
       the arms where a hum tightens them — see the voice block below for the
       other half of the same idea. Scaled by how UNvoiced the input is, so
       this and the gathering term below can never both be at full strength. */
    f *= 1.0 + uVoice * (1.0 - uVoiced) * 1.9;

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

    /* --- your voice ---------------------------------------------------
       A sung note pushes outward everywhere rather than pulling to a point —
       the difference between being touched and being resonated through.

       What is new is that TONE and BREATH now do opposite things, which is
       the one piece of information the mic was already measuring and nothing
       was reading. A hum is periodic, so it orders: the field draws inward and
       flattens toward the plane, and the arms tighten. A whisper is broadband,
       so it scatters: the turbulence lift above frays them instead. Nobody
       needs this explained to them — you find it in about four seconds — and
       that is the only kind of mapping worth having. */
    float vFall = 1.0 - smoothstep(0.2, 1.1, r / uDiscRadius);
    vec3 sung = normalize(vec3(rHat.x, p.y * 0.35, rHat.y)) * uVoice * 2.6 * vFall;

    float gather = uVoice * uVoiced * vFall;
    sung += vec3(-rHat.x, 0.0, -rHat.y) * gather * 1.6;   // draw in
    sung.y -= p.y * gather * 1.3;                         // and flatten

    /* --- the ring -----------------------------------------------------
       A held note is a swell; a new note is an EVENT, and an event should be
       something you can watch travel. Users said the field answers their
       voice, and it did — but as a level, everywhere at once, which is a
       response you feel rather than one you can follow. A ring leaving the
       centre when you start a phrase is the same information made visible.

       No branching: an empty slot has amplitude 0 and contributes nothing,
       which is cheaper than a conditional on every particle. */
    vec3 wave = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      float hit = (1.0 - smoothstep(0.0, 3.6, abs(r - uWaves[i].x))) * uWaves[i].y;
      wave += vec3(rHat.x, 0.0, rHat.y) * hit * 7.5;
    }

    /* --- converge / diverge -------------------------------------------
       The disc as one body drawing in and letting go. A strike spreads the
       stars outward; quiet gathers them back. Both carry the same prograde
       twist, so the motion is a fountain and a drain rather than a zoom —
       stars leave along a spiral and return along one, which is the pattern
       the eye reads as the galaxy doing something, not the camera.

       Spared at the core, where the bulge has its own churn and a radial
       push would hollow it into a ring, and faded at the rim, where the
       disc already frays. Gentle by design: the piece is asked for peace and
       excitement, and a field that lurches on every hit is neither. */
    float cdFall = smoothstep(0.06, 0.30, r / uDiscRadius)
                 * (1.0 - smoothstep(0.85, 1.25, r / uDiscRadius));
    vec2 cdDir = normalize(rHat * uConverge + tHat * 0.55 * abs(uConverge) + vec2(1e-5));
    vec3 cd = vec3(cdDir.x, 0.0, cdDir.y) * abs(uConverge) * 5.0 * cdFall;

    /* --- the shell ----------------------------------------------------
       A shove outward from the detonation, sharply localised at the front so
       the disc is pushed aside in a shell rather than swelling as a ball.
       Falls off with distance as well, or the far side of the galaxy would
       feel a nearby star exploding just as hard as its neighbours do. */
    vec3 toNova = p - uNovaPos;
    float novaD = length(toNova) + 1e-4;
    float front = 1.0 - smoothstep(0.0, 5.0, abs(novaD - uNova.x));
    vec3 nova = (toNova / novaD) * front * uNova.y * 26.0
              * (1.0 - smoothstep(0.0, DISC_R_FADE, novaD));

    v += (orbit + rim + f + churn + you + sung + wave + nova + cd
        + vec3(0.0, vertical, 0.0)) * uDt;
    v *= exp(-uDamp * uDt);
    v = clamp(v, vec3(-40.0), vec3(40.0));

    gl_FragColor = vec4(v, 0.0);
  }
`;

export class Tendrils {
  constructor({ renderer, scene, spine, size = 384, session = SESSION }) {
    this.spine = spine;    // the lanes are drawn against its pattern rotation
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
      uVoiced:     { value: 0 },
      uWaves:      { value: [new THREE.Vector2(), new THREE.Vector2(),
                             new THREE.Vector2()] },
      uNovaPos:    { value: new THREE.Vector3() },
      uNova:       { value: new THREE.Vector2() },
      uConverge:   { value: 0 },
    });

    const err = gpu.init();
    if (err) throw new Error(`GPU compute unavailable: ${err}`);

    /* --- nebulae --------------------------------------------------------
       Regions the stars travel THROUGH and take colour from, rather than
       clouds drawn over the top of them. That distinction is the whole reason
       this is three uniforms and not a set of billboards: a star inside the
       region is tinted, a star in front of it is not, and the parallax between
       them is what makes the disc read as having a volume. */
    this.session = session;
    this._nebPos = [];
    this._nebColor = [];
    this._nebParam = [];
    for (let i = 0; i < NEB; i++) {
      const n = session.nebulae[i];
      this._nebPos.push(new THREE.Vector3());
      this._nebColor.push(new THREE.Vector3(...(n ? n.rgb : [0, 0, 0])));
      // An unused slot gets radius 0, which the falloff turns into a constant
      // zero — cheaper and simpler than compiling a second shader per count.
      // Radius 1 rather than 0 on an unused slot: smoothstep with edge0 equal
      // to edge1 is undefined by the GLSL spec, and one NaN here would spread
      // through the normalise below and take every star's colour with it.
      this._nebParam.push(new THREE.Vector2(n ? n.radius : 1, n ? n.strength : 0));
    }
    this._nebulae = session.nebulae;

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
      // Sprite clamp, in pixels. uPtRef on uPtMin is the live look exactly;
      // setFilmScale() moves all three. See POINT_GLSL.
      uPtMin:  { value: 0.7 },
      uPtMax:  { value: 26.0 },
      uPtRef:  { value: 0.7 },
      uWarmth: { value: 0.4 },
      uEnergy: { value: 0 },
      uBreath: { value: 0 },
      uAir:    { value: 0 },
      uOnset:  { value: 0 },
      // MUST match the sim's values. The render side grades colour by radius,
      // so a mismatch here silently mis-paints the entire galaxy.
      uDiscRadius: { value: DISC.radius },
      uCoreRadius: { value: DISC.coreRadius },
      uTime:   { value: 0 },
      uVoice:  { value: 0 },
      uVoicePitch: { value: 0.5 },
      /* The lanes are cut from the same spiral the roots were laid out on, so
         these MUST track Galaxy.js. A lane geometry that disagrees with the
         arm geometry does not read as a near miss — it reads as a second,
         wrong galaxy overlaid on the first. */
      uPatternRot: { value: 0 },
      uArmPitch:   { value: DISC.pitch },
      uArms:       { value: DISC.arms },
      uArmR0:      { value: DISC.coreRadius * 0.35 },
      /* Nebula regions, seeded per session. Centre, colour, and (radius,
         strength) — three arrays rather than one struct because uniform
         structs are a portability question this project does not need to
         have an opinion about. */
      uNebPos:   { value: this._nebPos },
      uNebColor: { value: this._nebColor },
      uNebParam: { value: this._nebParam },
      uNovaPos:  { value: new THREE.Vector3() },
      uNova:     { value: new THREE.Vector2() },
      uNovaFlash: { value: 0 },
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
        ${POINT_GLSL}
        uniform sampler2D uPos, uVel, uSeed;
        uniform float uSize, uPixel, uEnergy, uBreath, uAir, uOnset, uTime;
        uniform float uDiscRadius, uCoreRadius;
        uniform float uPatternRot, uArmPitch, uArms, uArmR0;
        uniform vec3 uNovaPos;
        uniform vec2 uNova;      // (radius, amount)
        uniform float uNovaFlash;
        uniform vec3 uNebPos[3];
        uniform vec3 uNebColor[3];
        uniform vec2 uNebParam[3];   // (radius, strength)
        attribute vec2 aRef;
        varying float vSpeed;
        varying float vRad;      // normalised galactic radius
        varying float vLife;
        varying float vSpark;
        varying float vNebula;   // nebula tint field sampled at the star
        varying float vDust;     // 0..1 how deep in a lane the star sits
        varying vec3 vNebTint;   // colour of the region this star is inside
        varying float vNebW;     // 0..1 how far inside it is
        varying float vNova;     // 0..1 lit by the detonation
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
          //
          // It DRIFTS, which it did not before. Sampled at a fixed point in
          // world space the field was a birthmark: stars streamed through it
          // for forty minutes and the pattern never once changed. Moving it —
          // slowly enough that you cannot watch it happen — is the difference
          // between a texture and weather.
          vNebula = vnoise3(P.xyz * 0.045 + vec3(uTime * 0.006, uTime * 0.011, 0.0));

          /* Dust lanes.
             Real spiral galaxies carry their dust on the upstream edge of each
             arm: gas piles into the density wave, and the dark band sits just
             ahead of the bright one rather than on top of it. That offset is
             most of what separates a galaxy from a spiral drawn in noise, and
             it is why this is cut from the same log spiral Galaxy.js lays the
             roots on rather than from a second field that merely looks similar.

             The lanes are what the picture has been missing. Everything here
             emits and nothing occludes, so the disc reads as an even smear;
             one dark band in front of a bright arm is all it takes for the
             eye to see one thing IN FRONT OF another, and depth is a far
             stronger cue for mystery than any amount of colour. */
          float th = atan(P.z, P.x) - uPatternRot;
          float ridge = log(max(r, uArmR0 * 1.02) / uArmR0) / uArmPitch;
          float k = 6.2831853 / uArms;
          float d = th - ridge - 0.19;              // upstream of the ridge
          d -= k * floor(d / k + 0.5);              // radians to the nearest lane

          // Widens with radius, exactly as the arm scatter does — a lane of
          // constant angular width would be a hairline at the rim.
          float lw = 0.10 + 0.30 * vRad;
          float lane = 1.0 - smoothstep(0.0, lw, abs(d));

          // No lanes through the bulge, and none past the fraying rim: dust
          // needs a disc to sit in, and the core has blown its own clear.
          lane *= smoothstep(0.09, 0.34, vRad) * (1.0 - smoothstep(0.86, 1.25, vRad));

          // Broken rather than continuous. An unbroken ribbon reads as a
          // drawn line; real lanes are ragged and interrupted, and the same
          // noise drifting through them keeps the raggedness from being fixed.
          vDust = lane * (0.40 + 0.60 *
            vnoise3(P.xyz * 0.085 + vec3(0.0, uTime * 0.010, 0.0)));

          /* Which region is this star in, if any.
             Flattened 3:1 through the disc, because a spherical region in a
             disc this thin would be a ball intersecting a sheet — you would
             see a circle, and a circle is the one shape that says "a function
             drew this". Softened at the edge with the same noise field the
             lanes use so the boundary is ragged rather than a rim. */
          vNebTint = vec3(0.0);
          vNebW = 0.0;
          for (int i = 0; i < 3; i++) {
            vec3 dv = (P.xyz - uNebPos[i]) * vec3(1.0, 3.0, 1.0);
            float w = (1.0 - smoothstep(uNebParam[i].x * 0.25, uNebParam[i].x,
                                        length(dv))) * uNebParam[i].y;
            vNebTint += uNebColor[i] * w;
            vNebW += w;
          }
          // Normalised, so two overlapping regions blend to a colour between
          // them instead of summing into white.
          vNebTint /= max(vNebW, 0.001);
          vNebW = min(vNebW, 1.0) * (0.55 + 0.45 * vNebula);

          /* Lit by the detonation. Two parts, because a supernova does two
             things at very different times: the shell itself, which is
             material being pushed and which glows where it is compressed, and
             the flash, which for the first second lights EVERYTHING near it
             the way a flashbulb lights a room. Without the second the event
             reads as a ring appearing; with it, a star goes off. */
          float nd = length(P.xyz - uNovaPos);
          float shell = (1.0 - smoothstep(0.0, 6.0, abs(nd - uNova.x))) * uNova.y;
          float lit = uNovaFlash * (1.0 - smoothstep(0.0, 26.0, nd));
          vNova = min(1.0, shell + lit * 1.4);

          // Only a scattered few stars twinkle, and only on air energy.
          float pick = step(0.90, fract(seed.b * 71.3 + floor(P.w * 90.0) * 0.618));
          vSpark = pick * (uAir * 0.9 + uOnset * 0.8);

          vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);
          float s = uSize * uPixel * (0.30 + 1.0 * seed.g)
                  * (1.0 + vSpark * 2.4 + vNova * 1.8);
          gl_PointSize = pointSize(s * (1.0 / -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${PALETTE_GLSL}
        uniform float uWarmth, uEnergy, uBreath, uGain;
        uniform float uVoice, uVoicePitch;
        varying float vSpeed;
        varying float vRad;
        varying float vLife;
        varying float vSpark;
        varying float vNebula;
        varying float vDust;
        varying vec3 vNebTint;
        varying float vNebW;
        varying float vNova;
        varying float vCore;
        varying float vPtGain;

        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          float sprite = exp(-r2 * 7.0);

          // Galactic colour gradient, which is real astronomy and also happens
          // to be the most legible cue that this is a galaxy: old cool stars
          // crowd the bulge and read yellow-white, young hot ones live out in
          // the arms and read blue-violet.
          float t = uWarmth + (1.0 - vRad) * 0.55 + vCore * 0.45 - vNebula * 0.30
          // Extinction reddens. Dust scatters blue light out of the line of
          // sight and lets red through, which is why the stars you CAN still
          // see through a lane are warmer than their neighbours. Real, free,
          // and it stops the lanes from reading as flat grey paint.
                  + vDust * 0.26;

          /* Your voice chooses a colour.
             Loudness alone could only ever push the field around. Pitch gives
             it somewhere to go: sing high and the galaxy cools toward violet
             and reaches for bone, sing low and it warms toward ember. Centred
             on 0.5 so the middle of your range is the piece's own colour and
             you have to actually go somewhere to change it — and scaled by
             uVoice, so it is silent when you are. */
          float vp = (uVoicePitch - 0.5) * uVoice;
          t -= vp * 0.55;

          // The nucleus is the one place allowed to reach bone white — and a
          // held high note, which is the one thing worth making an exception
          // for.
          float heat = clamp(vCore * 0.70 + vSpark + vSpeed * 0.045
                           + (1.0 - vRad) * 0.18 + uEnergy * 0.12
                           + max(0.0, vp) * 0.55, 0.0, 1.0);
          vec3 c = anima(t, heat * heat * 0.9);

          /* The regions bend the ramp; they do not replace it.
             Multiplied rather than mixed toward a flat colour, so a star keeps
             its own brightness and only its hue moves — a lerp would flatten
             every star inside a region to the same value and the structure
             would vanish exactly where the colour is most interesting. The
             0.6 ceiling is the guard the palette comment asks for: the field
             leans toward teal or gold and never actually leaves its key. */
          c = mix(c, c * vNebTint * 1.7, clamp(vNebW, 0.0, 1.0) * 0.6);

          // Occlusion. The lanes do most of the work now and the nebula backs
          // them up; a floor of 0.16 keeps a lane dark rather than empty,
          // because stars vanishing outright reads as a hole in the geometry.
          float dust = clamp(1.0 - vDust * 0.66
                                 - smoothstep(0.60, 0.86, vNebula) * 0.26,
                             0.16, 1.0);

          /* Dust near the core is LIT.
             Everything in this piece emits and nothing is lit by anything, and
             for stars that is fine — they are their own light. Dust is not,
             and pure black dust is the giveaway that no light is being
             modelled: in every photograph of a spiral the inner lanes glow
             faintly, because there is an enormous bright nucleus a few
             thousand parsecs away scattering off them. One term, falling off
             with radius, and the lanes stop reading as holes punched in the
             disc and start reading as something standing in front of it. */
          float scatter = vDust * (1.0 - smoothstep(0.05, 0.62, vRad)) * 0.55;

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

          // Scattered light is warm and it is NOT the star's own colour — it
          // is the nucleus, arriving second-hand.
          vec3 lit = anima(0.85, 0.25) * scatter * sprite * vLife * edge * uGain
                   * 0.075 * discLift;

          /* The detonation runs white-hot — the one thing in the piece allowed
             past the nucleus. It is added rather than mixed so it cannot be
             dimmed by anything the star already is: a dust lane in front of a
             supernova does not hide it. */
          vec3 nova = anima(1.0, 1.0) * vNova * vNova * sprite * uGain * 1.5;

          gl_FragColor = vec4((c * i + lit + nova) * vPtGain, 1.0);
        }
      `,
    });

    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);

    /* Ring slots, advanced on the CPU rather than held in a GPU texture: three
       numbers do not need a render target, and keeping them here means the
       radius is readable by anything else that ever wants it. */
    this._waves = this.velVar.material.uniforms.uWaves.value;
    this._waveSlot = 0;
    this._prevAttack = 0;
    this._cd = 0;   // the converge/diverge state, eased

    this._placeNebulae(0);
  }

  /**
   * Walk the regions around the disc.
   *
   * Each on its own rate, so they separate over a long sit rather than turning
   * together as one painted layer — which is what the old single noise field
   * effectively was. Slow enough that you cannot watch it happen and fast
   * enough that the galaxy is a different colour at minute forty than it was
   * at minute five. That is the whole "altering" brief, and it costs three
   * vector writes a frame.
   */
  _placeNebulae(t) {
    for (let i = 0; i < this._nebulae.length; i++) {
      const n = this._nebulae[i];
      const a = n.angle + t * n.drift;
      this._nebPos[i].set(Math.cos(a) * n.dist, n.height, Math.sin(a) * n.dist);
    }
  }

  /** Launch a ring from the centre. Called on a phrase onset. */
  _launchWave() {
    const w = this._waves[this._waveSlot];
    this._waveSlot = (this._waveSlot + 1) % this._waves.length;
    w.set(1.5, 1.0);      // radius, amplitude
  }

  /** Walk the rings outward and retire them at the rim. */
  _stepWaves(dt) {
    for (const w of this._waves) {
      if (w.y <= 0) continue;
      // ~3 seconds from core to rim. Slower reads as a pulse of brightness
      // rather than as something moving; faster and it is gone before the eye
      // has found it.
      w.x += dt * WAVE_SPEED;
      w.y -= dt / WAVE_LIFE;
      if (w.y <= 0 || w.x > DISC.radius * 1.35) w.set(0, 0);
    }
  }

  setPixelRatio(pr) { this.uniforms.uPixel.value = pr; }

  /**
   * Size the sprites for a film frame rather than for a screen.
   *
   * Live, a star's size is in device pixels, which is right for a monitor and
   * wrong for a file: a 4K frame drew the same pixel-sized stars as a 1080 one,
   * so after YouTube's downscale every star was half as wide and a quarter as
   * bright, and the faintest fell below a pixel and shimmered out. Here size
   * is in pixels of a 1080-line frame, and the floor keeps the faintest wide
   * enough to survive being averaged down.
   *
   * @param {number} scale  frame height ÷ 1080
   * @param {number} floor  smallest sprite, in reference pixels
   */
  setFilmScale(scale, floor) {
    this.uniforms.uPixel.value = scale;
    this.uniforms.uPtMin.value = floor * scale;
    this.uniforms.uPtMax.value = 26.0 * scale;
    this.uniforms.uPtRef.value = scale;
  }

  update(t, dt, bus, tuning, presence, nova = null) {
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
      // `force`, not `amount`: the attractor pulls for the music as well as for
      // you, and only Presence knows how those two are currently balanced.
      vu.uAttractAmt.value = presence.force;
    }
    vu.uVoice.value = bus.voice || 0;
    vu.uVoiced.value = bus.voiced || 0;

    /* --- converge / diverge --------------------------------------------
       Derived here from the Bus rather than published by a driver, so every
       source — score, film, a handpan in the room — moves the disc the same
       way. A strike is an outward release, quick to arrive and slow to let
       go; between strikes the field gathers, more strongly the quieter it is
       and a little on each inhale. The rest state is a gentle inward lean,
       so a silent galaxy is one that is slowly closing its hand. */
    const release = Math.min(1, (bus.onset || 0) * 1.1 + (bus.anticipation || 0) * 0.25);
    const gather = 0.35 * (1 - bus.energy) + 0.20 * (bus.breath - 0.5);
    const cdTarget = release - gather * (1 - release);
    const cdTau = cdTarget > this._cd ? 0.12 : 1.8;
    this._cd += (cdTarget - this._cd) * (1 - Math.exp(-step / cdTau));
    vu.uConverge.value = Math.max(-1, Math.min(1, this._cd));

    /* Edge-triggered, not level-triggered. `voiceAttack` decays over ~180 ms,
       so testing the value alone would launch a ring every frame for a tenth
       of a second and spend all three slots on one syllable. */
    const att = bus.voiceAttack || 0;
    if (att > 0.5 && this._prevAttack <= 0.5) this._launchWave();
    this._prevAttack = att;
    this._stepWaves(step);

    this.gpu.compute();

    this.uniforms.uPos.value = this.gpu.getCurrentRenderTarget(this.posVar).texture;
    this.uniforms.uVel.value = this.gpu.getCurrentRenderTarget(this.velVar).texture;
    // The session's resting colour, before the music moves it.
    this.uniforms.uWarmth.value = bus.warmth + this.session.warmthBias;
    this.uniforms.uEnergy.value = bus.energy;
    this.uniforms.uBreath.value = bus.breath;
    this.uniforms.uAir.value = bus.air;
    this.uniforms.uOnset.value = bus.onset;
    this.uniforms.uTime.value = t;
    this._placeNebulae(t);
    this.uniforms.uVoice.value = bus.voice || 0;
    this.uniforms.uVoicePitch.value = bus.voicePitch ?? 0.5;
    // Read from the Galaxy rather than integrated here: two clocks for one
    // rotation is how the lanes would slide off the arms over a long session.
    this.uniforms.uPatternRot.value = this.spine.rotation;

    // The same numbers reach the sim and the render, so what is pushed is
    // exactly what is lit.
    if (nova) {
      vu.uNovaPos.value.copy(nova.pos);
      vu.uNova.value.set(nova.radius, nova.amount);
      this.uniforms.uNovaPos.value.copy(nova.pos);
      this.uniforms.uNova.value.set(nova.radius, nova.amount);
      this.uniforms.uNovaFlash.value = nova.flash;
    }
  }

  dispose() {
    this.gpu.dispose();
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}
