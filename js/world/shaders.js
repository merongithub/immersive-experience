/**
 * shaders.js — GLSL shared across the ANIMA field.
 * Zero-build: plain template strings injected into ShaderMaterials.
 */

/** Cheap 3D value noise + a curl field built on it. Prefix where needed. */
export const NOISE_GLSL = /* glsl */ `
  float hash13(vec3 p3){
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  float vnoise3(vec3 x){
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + vec3(0.0,0.0,0.0));
    float n100 = hash13(i + vec3(1.0,0.0,0.0));
    float n010 = hash13(i + vec3(0.0,1.0,0.0));
    float n110 = hash13(i + vec3(1.0,1.0,0.0));
    float n001 = hash13(i + vec3(0.0,0.0,1.0));
    float n101 = hash13(i + vec3(1.0,0.0,1.0));
    float n011 = hash13(i + vec3(0.0,1.0,1.0));
    float n111 = hash13(i + vec3(1.0,1.0,1.0));
    return mix(
      mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
      mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
  }

  vec3 potential(vec3 p){
    return vec3(
      vnoise3(p + vec3( 31.41,  0.00,  0.00)),
      vnoise3(p + vec3(  0.00, 57.13,  0.00)),
      vnoise3(p + vec3(  0.00,  0.00, 17.37)));
  }

  /* Curl of the potential field → divergence-free flow, so the cloud never
     collapses into permanent voids the way a raw noise-as-velocity field does.
     Forward differences (4 potential() taps rather than 6): the bias is
     invisible at these scales and it is a third cheaper per particle. */
  vec3 curl(vec3 p){
    const float e = 0.14;
    vec3 p0 = potential(p);
    vec3 px = potential(p + vec3(e, 0.0, 0.0));
    vec3 py = potential(p + vec3(0.0, e, 0.0));
    vec3 pz = potential(p + vec3(0.0, 0.0, e));
    return vec3(
      (py.z - p0.z) - (pz.y - p0.y),
      (pz.x - p0.x) - (px.z - p0.z),
      (px.y - p0.y) - (py.x - p0.x)) / e;
  }
`;

/** The palette, as a single ramp. Every module colours through this one function
    so the whole field can never drift out of key: black → violet → ember → bone. */
export const PALETTE_GLSL = /* glsl */ `
  const vec3 C_VIOLET = vec3(0.36, 0.13, 0.78);
  const vec3 C_EMBER  = vec3(1.00, 0.34, 0.11);
  const vec3 C_BONE   = vec3(1.00, 0.93, 0.85);

  /* t: 0 = cold and inward, 1 = hot and reaching.
     h: 0..1 extra lift toward bone for the hottest cores.

     The ramp is deliberately reluctant to leave violet, and the lift to bone is
     capped well below 1. Both guard the same failure: additive blending plus
     bloom will drive anything toward white, and a field that has gone white has
     no temperature left to express. */
  vec3 anima(float t, float h){
    vec3 c = mix(C_VIOLET, C_EMBER, smoothstep(0.12, 1.02, t));
    return mix(c, C_BONE, clamp(h, 0.0, 1.0) * 0.62);
  }
`;

/** A point sprite's size, clamped — and the brightness that keeps its light.
    Vertex shaders only; the fragment side declares `varying float vPtGain` and
    multiplies it in.

    A sprite's total light goes as the square of its size, so every clamp is
    also a change of brightness. Live, uPtRef sits on uPtMin and the gain is
    exactly 1: the piece looks as it always has. A film raises the floor so
    the faintest stars cover enough pixels to survive a 4K→1080 downscale, and
    the gain gives back what the floor would otherwise add — the same light,
    spread wider. uPtRef is the size a star below the floor was really drawn
    at: one hardware pixel, in the film's reference pixels.

    Clamping at the ceiling is left alone, as it always was. A nova-lit star
    pinned at the maximum gets dimmer, not brighter. */
export const POINT_GLSL = /* glsl */ `
  uniform float uPtMin, uPtMax, uPtRef;
  varying float vPtGain;
  float pointSize(float s){
    float S = clamp(s, uPtMin, uPtMax);
    float k = max(min(s, uPtMax), uPtRef) / S;
    vPtGain = k * k;
    return S;
  }
`;

/* ---------------------------------------------------------------- POST FX
   One full-screen pass: chromatic aberration + film grain + vignette.
   Runs before OutputPass, which owns tone-mapping and sRGB. */
export const PostFXShader = {
  uniforms: {
    tDiffuse:   { value: null },
    uTime:      { value: 0 },
    uAberration:{ value: 0.0018 },
    uGrain:     { value: 0.048 },
    uVignette:  { value: 1.15 },
    uBreath:    { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime, uAberration, uGrain, uVignette, uBreath;

    float hash21(vec2 p){
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main(){
      vec2 uv  = vUv;
      vec2 dir = uv - 0.5;
      float r2 = dot(dir, dir);

      // Aberration widens as the field inhales — the lens strains with it.
      float a = uAberration * (0.35 + r2 * 3.2) * (1.0 + uBreath * 0.85);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dir * a).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dir * a).b;

      // Vignette breathes open a little on the inhale.
      float vig = smoothstep(0.98, 0.18, r2 * (uVignette - uBreath * 0.16));
      col *= mix(0.30, 1.0, vig);

      // Animated grain. Against true black this is most of what stops the
      // darks from banding into visible steps. A film zeroes it and dithers
      // after the tone curve instead — see FilmGradeShader.
      float g = hash21(uv * vec2(1920.0, 1080.0) + fract(uTime) * 91.7);
      col += (g - 0.5) * uGrain;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/* ---------------------------------------------------------------- FILM GRADE
   The last pass of a film, AFTER OutputPass — so it works on the tone-mapped,
   sRGB-encoded values that are about to be quantised to 8 bits, which is the
   only place a dither can do its job.

   Two things, both for the encoder and the phone rather than for the eye:

   - Blacks lifted a hair off zero. At true black half of any dither is
     clipped away, so the darkest gradients — bloom falling off into the void,
     most of this picture — are exactly where it stops working. A couple of
     8-bit steps of pedestal gives it room on both sides.
   - A static blue-noise dither, one step of 8-bit, the same on every frame.
     It replaces the animated grain: grain that changes every frame is noise
     an encoder cannot predict, so it eats the bitrate and comes back as
     mush, while a fixed pattern costs nearly nothing after the first frame.

   Monochrome, so it lands in luma: chroma is subsampled and coarsely coded
   and a coloured dither would be spent there for nothing. No colorspace or
   tonemapping include, deliberately — three adds neither to a ShaderMaterial
   that does not ask, so this writes its input through as it arrives. */
export const FilmGradeShader = {
  uniforms: {
    tDiffuse:   { value: null },
    uNoise:     { value: null },
    uNoiseSize: { value: 64 },
    uLift:      { value: 2 / 255 },
    uDither:    { value: 1 / 255 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse, uNoise;
    uniform float uNoiseSize, uLift, uDither;

    void main(){
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      col = uLift + col * (1.0 - uLift);

      // Screen-locked, so it holds still while the picture moves under it.
      // Remapped from uniform to triangular on [-1, 1]: a flat distribution
      // leaves the noise floor louder in some tones than others, a triangular
      // one does not.
      float n = texture2D(uNoise, gl_FragCoord.xy / uNoiseSize).r * 2.0 - 1.0;
      n = sign(n) * (1.0 - sqrt(1.0 - abs(n)));
      col += n * uDither;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
