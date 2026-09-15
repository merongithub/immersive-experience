/**
 * StarSystem — the place a Voyage goes.
 *
 * What is there when you arrive has to be made of the same thing as what you
 * left, or the journey is from one piece into another. The galaxy is light:
 * motes on a palette ramp, a spiral, bloom. So the star is light too, and
 * what surrounds it is the galaxy again, small.
 *
 *   THE STAR   no surface. A brilliant point in a soft halo — the thing every
 *              star in the field already is, seen close. From far off it is
 *              a glint of fixed screen size, the one star that answers a
 *              strike, which is how the audience first finds it. From the
 *              world's night side it is a point sliding up to the limb, the
 *              way a sunrise looks from orbit.
 *   THE DISC   the galaxy in miniature. Motes on the same ramp — bone at the
 *              centre, ember, violet at the rim — orbiting at Kepler's rate,
 *              so the inner edge turns visibly faster than the outer, with a
 *              faint two-arm density wave they stream through the way the
 *              galaxy's stars stream through its arms. Seeded rings and gaps
 *              like the ALMA images of discs where planets are forming, and
 *              a clear lane at the world's orbit — the world is sweeping it.
 *              A bowl or a gong sends a ring of light out through it.
 *   THE WORLD  oceans, land, and cloud from the same noise the field uses, lit
 *              by the star with a soft terminator; an atmosphere that glows on
 *              the day side and burns as a crescent when the star is behind.
 *   THE RING   on about half of all seeds, banded, with the world's shadow.
 */

import * as THREE from "three";
import { NOISE_GLSL, PALETTE_GLSL } from "./shaders.js";
import { BODY } from "./Voyage.js";
import { makeStream } from "./Seed.js";

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* Inside this distance the system is its full size; beyond it, it shrinks
   faster than perspective alone would shrink it. Nothing here is to scale,
   and at the galaxy view a true-size disc would be a second small galaxy in
   the sky before the story has said a word. Shrunk, the star is a point
   among points until the approach, and then the disc GROWS into the frame
   as you arrive, which is how arriving at something should look anyway. */
const FULL_SIZE_WITHIN = 16;

/* How many motes in the disc. Enough that it reads as substance rather than
   as speckle at the star's dwell distance; a rounding error beside the
   galaxy's quarter of a million. */
const DISC_MOTES = 64000;

/* Kepler: angular speed ∝ r^-1.5, pinned so the motes at the world's orbit
   keep pace with the world and its lane stays open. */
const OMEGA0 = (Math.PI * 2 / BODY.planetPeriod) * Math.pow(BODY.planetOrbit, 1.5);

/* How far the star's halo reaches, world units. */
const HALO_EXTENT = 3.0;

export class StarSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {import("./Voyage.js").Voyage} voyage
   */
  constructor(scene, voyage) {
    this.voyage = voyage;
    this.group = new THREE.Group();
    scene.add(this.group);

    const neb = new THREE.Vector3(...voyage.nebula.rgb);
    const seed = voyage.planetSeed;

    /* ------------------------------------------------------------- star
       A camera-facing quad, sized in the vertex shader: a core of fixed
       screen size — so it is a point at any distance — and a halo of world
       size, faded in as the system resolves. Depth tested, so the world
       passes in front of it; not written, so it never hides anything. */
    this.heartU = {
      uHalf:   { value: 1 },      // quad half-extent, world units
      uHalfPx: { value: 10 },     // quad half-extent, pixels
      uCorePx: { value: 2.2 },    // core radius, pixels
      uCore:   { value: 0 },      // HDR intensity of the core
      uHaloW:  { value: 0.1 },    // halo radius, in quad units
      uHalo:   { value: 0 },      // HDR intensity of the halo
      uT:      { value: voyage.starHeat },
    };
    this.heart = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: this.heartU,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uHalf;
        varying vec2 vUv;
        void main(){
          vUv = position.xy;
          vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          c.xy += position.xy * uHalf;
          gl_Position = projectionMatrix * c;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${PALETTE_GLSL}
        uniform float uHalfPx, uCorePx, uCore, uHaloW, uHalo, uT;
        varying vec2 vUv;
        void main(){
          float q = length(vUv);
          if (q > 1.0) discard;
          float px = q * uHalfPx / uCorePx;
          float core = exp(-px * px * 1.4) + exp(-px * 0.8) * 0.10;
          // A soft power-law halo, the shape light scattered in dust makes.
          float hr = q / uHaloW;
          float halo = pow(1.0 + hr * hr, -1.3) * (1.0 - smoothstep(0.7, 1.0, q));
          vec3 warm = mix(C_EMBER, C_BONE, 0.40 + 0.35 * uT);
          gl_FragColor = vec4(C_BONE * core * uCore + warm * halo * uHalo, 1.0);
        }
      `,
    }));
    this.heart.frustumCulled = false;   // sized in the shader; its bounds lie
    this.heart.renderOrder = 1;         // over the disc it sits in
    this.group.add(this.heart);

    /* ------------------------------------------------------------- disc */
    this._buildDisc(voyage);
    this._wave = { r: 0, a: 0, cool: 0 };

    /* ------------------------------------------------------------- world */
    const atmo = neb.clone().multiplyScalar(0.55).add(new THREE.Vector3(0.20, 0.34, 0.62));
    this._planetW = new THREE.Vector3();   // where the world is drawn, scaled
    this.planetU = {
      uTime:    { value: 0 },
      uSeed:    { value: seed },
      uStarPos: { value: voyage.star },
      uLight:   { value: 1.2 },
      uStarCol: { value: new THREE.Vector3(1.0, 0.86, 0.66) },
      uOcean:   { value: neb.clone().multiplyScalar(0.10).add(new THREE.Vector3(0.01, 0.02, 0.05)) },
      uLand:    { value: new THREE.Vector3(0.30, 0.19, 0.12) },
      uAtmo:    { value: atmo },
    };
    this.planet = new THREE.Mesh(
      new THREE.SphereGeometry(BODY.planetRadius, 128, 96),
      new THREE.ShaderMaterial({
        uniforms: this.planetU,
        vertexShader: /* glsl */ `
          varying vec3 vObj, vNw, vPw;
          void main(){
            vObj = normalize(position);
            vNw = normalize(mat3(modelMatrix) * normal);
            vec4 w = modelMatrix * vec4(position, 1.0);
            vPw = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          ${NOISE_GLSL}
          uniform float uTime, uSeed, uLight;
          uniform vec3 uStarPos, uStarCol, uOcean, uLand, uAtmo;
          varying vec3 vObj, vNw, vPw;
          void main(){
            vec3 N = normalize(vNw);
            vec3 L = normalize(uStarPos - vPw);
            vec3 V = normalize(cameraPosition - vPw);
            float ndl = dot(N, L);
            // A soft terminator: an atmosphere carries light a little way
            // past the edge of day.
            float day = smoothstep(-0.06, 0.32, ndl);

            vec3 q = vObj * 2.2 + uSeed;
            float h = vnoise3(q) * 0.55 + vnoise3(q * 2.3) * 0.28 + vnoise3(q * 5.1) * 0.17;
            float land = smoothstep(0.50, 0.55, h);
            vec3 surf = mix(uOcean, uLand * (0.75 + 0.5 * vnoise3(q * 9.0)), land);

            float cl = vnoise3(vObj * 3.3 + vec3(uTime * 0.010, 0.0, uSeed)) * 0.65
                     + vnoise3(vObj * 8.5 + vec3(0.0, uTime * 0.016, uSeed)) * 0.35;
            cl = smoothstep(0.50, 0.74, cl);
            surf = mix(surf, vec3(0.80, 0.78, 0.76), cl * 0.75);

            vec3 H = normalize(L + V);
            float spec = pow(max(dot(N, H), 0.0), 70.0) * (1.0 - land) * (1.0 - cl) * day;

            vec3 col = surf * uStarCol * day * uLight + uStarCol * spec * uLight * 0.5;

            // The atmosphere seen through the disc: brightest at the limb,
            // on the day side, and when the star is behind — forward
            // scattering, which is what makes a backlit world a ring of light.
            float rim = pow(1.0 - max(dot(N, V), 0.0), 4.0);
            float fwd = pow(max(dot(-V, L), 0.0), 5.0);
            float side = smoothstep(-0.45, 0.45, ndl);
            col += uAtmo * rim * side * (0.22 + fwd * 0.30) * uLight;
            col += uAtmo * 0.004;   // the night side is not quite nothing
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      })
    );
    this.group.add(this.planet);

    /* The atmosphere's outer edge: a slightly larger shell, back faces only,
       added. Its brightness runs from the limb of the world to nothing at the
       shell's own edge, lit the same way the rim inside the disc is. */
    this.atmoU = {
      uStarPos: { value: voyage.star },
      uAtmo:    { value: atmo },
      uLight:   { value: 1.2 },
    };
    this.atmo = new THREE.Mesh(
      new THREE.SphereGeometry(BODY.planetRadius * 1.12, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: this.atmoU,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */ `
          varying vec3 vNw, vPw;
          void main(){
            vNw = normalize(mat3(modelMatrix) * normal);
            vec4 w = modelMatrix * vec4(position, 1.0);
            vPw = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform vec3 uStarPos, uAtmo;
          uniform float uLight;
          varying vec3 vNw, vPw;
          void main(){
            vec3 N = normalize(vNw);
            vec3 V = normalize(cameraPosition - vPw);
            vec3 L = normalize(uStarPos - vPw);
            // -N.V is 0.45 at the world's limb for a 1.12 shell, 0 at its edge.
            float g = pow(clamp(-dot(N, V) / 0.45, 0.0, 1.0), 1.6);
            // Lit on the limb nearest the star. Forward scattering only adds
            // where there is light to scatter, so the ring of light is a
            // crescent toward the star — and becomes a full ring only as the
            // star lines up behind the world.
            float lit = smoothstep(-0.45, 0.45, dot(N, L));
            float fwd = pow(max(dot(-V, L), 0.0), 4.0);
            gl_FragColor = vec4(uAtmo * g * lit * (0.16 + fwd * 0.42) * uLight, 1.0);
          }
        `,
      })
    );
    this.group.add(this.atmo);

    /* -------------------------------------------------------------- ring */
    this.ring = null;
    if (voyage.ringed) {
      this.ringU = {
        uStarPos:   { value: voyage.star },
        uPlanetPos: { value: this._planetW },
        uRp:        { value: BODY.planetRadius },
        uRingN:     { value: new THREE.Vector3(0, 1, 0) },
        uLight:     { value: 1.2 },
        uSeed:      { value: seed },
        uCol:       { value: new THREE.Vector3(0.78, 0.70, 0.60).lerp(neb, 0.25) },
      };
      const Rp = BODY.planetRadius;
      this.ring = new THREE.Mesh(
        new THREE.RingGeometry(Rp * 1.45, Rp * 2.5, 256, 1),
        new THREE.ShaderMaterial({
          uniforms: this.ringU,
          side: THREE.DoubleSide,
          transparent: true,
          depthWrite: false,
          vertexShader: /* glsl */ `
            uniform float uRp;
            varying vec3 vPw;
            varying float vR;
            void main(){
              vR = length(position.xy) / uRp;
              vec4 w = modelMatrix * vec4(position, 1.0);
              vPw = w.xyz;
              gl_Position = projectionMatrix * viewMatrix * w;
            }
          `,
          fragmentShader: /* glsl */ `
            precision highp float;
            ${NOISE_GLSL}
            uniform vec3 uStarPos, uPlanetPos, uRingN, uCol;
            uniform float uRp, uLight, uSeed;
            varying vec3 vPw;
            varying float vR;
            void main(){
              float b = vnoise3(vec3(vR * 16.0, uSeed, 0.0)) * 0.6
                      + vnoise3(vec3(vR * 55.0, uSeed + 3.0, 0.0)) * 0.4;
              float a = smoothstep(1.45, 1.56, vR) * smoothstep(2.5, 2.3, vR)
                      * (0.10 + 0.42 * smoothstep(0.3, 0.7, b));
              a *= 1.0 - 0.9 * smoothstep(0.035, 0.0, abs(vR - 2.02));   // the gap

              vec3 L = normalize(uStarPos - vPw);
              // The world's shadow: does the ray to the star pass through it?
              vec3 toP = uPlanetPos - vPw;
              float along = dot(toP, L);
              float perp2 = dot(toP, toP) - along * along;
              float shadow = along > 0.0
                ? smoothstep(uRp * uRp * 0.80, uRp * uRp * 1.05, perp2) : 1.0;

              vec3 V = normalize(cameraPosition - vPw);
              float face = 0.30 + 0.70 * abs(dot(uRingN, L));
              float fwd = pow(max(dot(-V, L), 0.0), 6.0);
              vec3 c = uCol * uLight * (face * 0.16 + fwd * 0.22) * shadow;
              gl_FragColor = vec4(c, a);
            }
          `,
        })
      );
      this.ring.rotation.set(-Math.PI / 2 + voyage.ringTilt, 0, voyage.ringTilt * 0.4);
      this.group.add(this.ring);
    }
  }

  /** The disc's motes: radius, phase, brightness, height — all fixed at
      birth. Where each one is on a given frame is computed in the shader
      from the clock, so the disc costs nothing on the CPU after this. */
  _buildDisc(voyage) {
    const rng = makeStream(voyage.session, "disc");
    const { discInner: r0, discOuter: r1, planetOrbit } = BODY;

    /* Rings and gaps, seeded. The lane at the world's orbit is the one that
       is always there and always nearly empty; the others are the disc's
       own weather. */
    const rings = [];
    const nRings = 5 + Math.floor(rng() * 3);
    while (rings.length < nRings) {
      const r = r0 + 0.2 + rng() * (r1 - r0 - 0.6);
      if (Math.abs(r - planetOrbit) < 0.45) continue;
      rings.push({ r, w: 0.05 + rng() * 0.16, s: 0.9 + rng() * 1.6 });
    }
    const gaps = [
      { r: planetOrbit, w: 0.20, d: 0.97 },
      { r: 0.9 + rng() * 1.6, w: 0.05 + rng() * 0.08, d: 0.75 },
    ];
    const profile = (r) => {
      let f = 0.14;
      for (const g of rings) f += g.s * Math.exp(-(((r - g.r) / g.w) ** 2));
      for (const g of gaps) f *= 1 - g.d * Math.exp(-(((r - g.r) / g.w) ** 2));
      return f * smooth(r1, r1 * 0.78, r) * smooth(r0, r0 * 1.6, r) * Math.pow(r, -0.35);
    };
    // Sampled by area — p(r) ∝ r·profile(r) — so a ring is as dense at the
    // rim as at the centre, not thinned by the circumference it has to fill.
    let pmax = 0;
    for (let r = r0; r <= r1; r += 0.005) pmax = Math.max(pmax, r * profile(r));

    const N = DISC_MOTES;
    const aR = new Float32Array(N), aTh = new Float32Array(N);
    const aSeed = new Float32Array(N), aY = new Float32Array(N);
    for (let i = 0; i < N;) {
      const r = r0 + rng() * (r1 - r0);
      if (rng() * pmax > r * profile(r)) continue;
      aR[i] = r;
      aTh[i] = rng() * Math.PI * 2;
      aSeed[i] = rng();
      aY[i] = (rng() + rng() + rng() - 1.5) * 0.018 * r;   // flares, as a disc does
      i++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute("aR", new THREE.BufferAttribute(aR, 1));
    g.setAttribute("aTh", new THREE.BufferAttribute(aTh, 1));
    g.setAttribute("aSeed", new THREE.BufferAttribute(aSeed, 1));
    g.setAttribute("aY", new THREE.BufferAttribute(aY, 1));

    this.discU = {
      uClock:     { value: 0 },
      uOmega0:    { value: OMEGA0 },
      uTilt:      { value: voyage.planetTilt },
      uOuter:     { value: r1 },
      uPx:        { value: 1 },
      uPxPerUnit: { value: 1000 },
      uScale:     { value: 1 },
      uNearFade:  { value: 0.5 },
      uBreath:    { value: 0 },
      uEnergy:    { value: 0 },
      uWaveR:     { value: 0 },
      uWaveA:     { value: 0 },
      uPat:       { value: 0 },
      uVis:       { value: 0 },
    };
    this.disc = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.discU,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uClock, uOmega0, uTilt, uOuter, uPx, uPxPerUnit, uScale;
        uniform float uNearFade, uBreath, uEnergy, uWaveR, uWaveA, uPat, uVis;
        attribute float aR, aTh, aSeed, aY;
        varying float vI, vU;
        void main(){
          vU = aR / uOuter;
          float th = aTh + uOmega0 * pow(aR, -1.5) * uClock;
          // In the system's plane — the same basis the world's orbit uses
          // (Voyage.update), so the lane is where the world is.
          float st = sin(uTilt), ct = cos(uTilt);
          float x = cos(th) * aR, z = sin(th) * aR;
          vec3 q = vec3(x, z * st + aY * ct, z * ct - aY * st);
          vec4 mv = modelViewMatrix * vec4(q, 1.0);
          float d = max(-mv.z, 1e-3);
          // Soft and overlapping rather than pinpoint: up close the disc
          // should read as a surface of light with grain in it, not as grain.
          gl_PointSize = clamp(0.055 * uScale * uPxPerUnit / d, 1.25 * uPx, 7.0 * uPx);

          // The density wave the motes flow through — fixed in the frame and
          // turning slowly, as the galaxy's arms are, not painted on them.
          float spiral = 0.68 + 0.32 * cos(2.0 * (th - log(aR) / 0.42 - uPat));
          // Hotter and brighter toward the star, as the galaxy is toward its
          // nucleus.
          float hot = 1.0 + 1.8 * pow(1.0 - vU, 3.0);
          float wave = 1.0 + uWaveA * 1.4 * exp(-pow((aR - uWaveR) / 0.25, 2.0));
          float near = smoothstep(uNearFade * 0.3, uNearFade, d);
          vI = (0.3 + 0.7 * aSeed * aSeed) * spiral * hot * wave * near * uVis
             * (0.85 + 0.30 * uBreath + 0.20 * uEnergy);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${PALETTE_GLSL}
        varying float vI, vU;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          float sp = exp(-r2 * 8.0);
          // The galaxy's ramp, run from the centre out: bone, ember, violet.
          vec3 c = anima(0.95 - vU * 0.85, (1.0 - vU) * (1.0 - vU) * 0.7);
          gl_FragColor = vec4(c * sp * vI * 0.034, 1.0);
        }
      `,
    }));
    this.disc.frustumCulled = false;
    this.group.add(this.disc);
  }

  /**
   * @param {THREE.Camera} camera
   * @param {number} pxPerUnit  pixels per world unit at distance 1
   * @param {number} pxScale    frame height ÷ 1080, so the glint is the same
   *   size in a 4K film as in a 1080 one
   */
  update(t, dt, bus, camera, pxPerUnit, pxScale = 1) {
    const v = this.voyage;
    const dist = Math.max(1e-3, camera.position.distanceTo(v.star));
    const s = Math.min(1, Math.pow(FULL_SIZE_WITHIN / dist, 1.6));

    // The whole system scales about its star; the world keeps its place on
    // the orbit, just nearer in.
    this.group.position.copy(v.star);
    this.group.scale.setScalar(s);
    this.planet.position.subVectors(v.planet, v.star);
    this.atmo.position.copy(this.planet.position);
    this._planetW.copy(this.planet.position).multiplyScalar(s).add(v.star);
    this.planet.rotation.y = t * 0.018;

    /* How resolved the system is: the disc's radius on screen, in 1080-line
       pixels. Below a few dozen it is a point in the sky and is drawn as one;
       by a couple of hundred it is a place. */
    const discPx = (BODY.discOuter * s / dist) * pxPerUnit / pxScale;
    const res = smooth(40, 260, discPx);

    /* The star answers the music: it breathes, it swells a little before a
       strike (the anticipation only a score can give), and it flares on one.
       Gently — it is one voice in the frame, not a light show. */
    const swell = 1 + bus.breath * 0.07 + bus.anticipation * 0.06
                + bus.onset * 0.16 + (bus.voice || 0) * 0.18;

    const h = this.heartU;
    const corePx = Math.max(2.2 * pxScale, (0.05 * s / dist) * pxPerUnit);
    const half = Math.max(HALO_EXTENT * s, (corePx * 6 * dist) / pxPerUnit);
    h.uHalf.value = half;
    h.uHalfPx.value = (half / dist) * pxPerUnit;
    h.uCorePx.value = corePx;
    h.uHaloW.value = (0.3 * s) / half;
    /* Before the story picks it out it is simply a bright star. After, every
       strike reaches it — which, among a quarter of a million stars that do
       not, is how the eye finds it. Up close the point is brilliant. */
    const glint = 0.10 + v.glint * (0.08 + bus.onset * 0.9 + bus.anticipation * 0.2);
    h.uCore.value = glint + (2.6 * swell - glint) * res;
    h.uHalo.value = res * 0.35 * swell;

    /* A bowl or a gong sends a ring out through the disc. One at a time and
       not too often — the galaxy already does this, and the disc is where
       you are, so it should be the gentler of the two. */
    const w = this._wave;
    w.cool -= dt;
    if ((bus.strike || 0) >= 1.1 && w.cool <= 0) { w.r = BODY.discInner; w.a = 1; w.cool = 5; }
    if (w.a > 0) {
      w.r += dt * 0.8;
      w.a = Math.max(0, w.a - dt / 7);
    }

    const d = this.discU;
    d.uClock.value = v.clock;
    d.uPx.value = pxScale;
    d.uPxPerUnit.value = pxPerUnit;
    d.uScale.value = s;
    d.uBreath.value = bus.breath;
    d.uEnergy.value = bus.energy;
    d.uWaveR.value = w.r;
    d.uWaveA.value = w.a;
    d.uPat.value = v.clock * 0.004;
    d.uVis.value = res;

    const light = 1.0 * swell;
    this.planetU.uTime.value = t;
    this.planetU.uLight.value = light;
    this.atmoU.uLight.value = light;
    if (this.ring) {
      this.ring.position.copy(this.planet.position);
      this.ringU.uRp.value = BODY.planetRadius * s;
      this.ringU.uLight.value = light;
      this.ringU.uRingN.value.set(0, 0, 1).applyQuaternion(this.ring.quaternion);
    }
  }

  dispose() {
    this.group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    this.group.removeFromParent();
  }
}
