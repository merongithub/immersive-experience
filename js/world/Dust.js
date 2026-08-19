/**
 * Dust — sparse motes in the surrounding dark.
 *
 * Cheap, and it earns its cost twice over: against pure black with a single
 * object floating in it, the camera can drift for ten seconds and you cannot
 * tell it moved. Parallax needs something to parallax against. These also give
 * the bloom a faint ambient floor so the void never looks like a dead pixel.
 */

import * as THREE from "three";
import { PALETTE_GLSL } from "./shaders.js";

const COUNT = 9000;
const SHELL = 260;   // far outside the disc: this is the sky, not the galaxy

export class Dust {
  constructor(scene) {
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      // Hollow shell far beyond the disc, so background stars never mix with
      // galaxy stars and the parallax between them reads as real distance.
      const r = SHELL * (0.55 + Math.random() * 0.45);
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3]     = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph);
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      // Skewed so most stars are faint and a few are bright — a magnitude
      // distribution. An even one looks like static.
      seed[i] = Math.pow(Math.random(), 2.4);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));

    this.uniforms = {
      uTime:   { value: 0 },
      uPixel:  { value: 1 },
      uWarmth: { value: 0.4 },
      uEnergy: { value: 0 },
      uBreath: { value: 0 },
      uVoice:  { value: 0 },
    };

    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
      vertexShader: /* glsl */ `
        uniform float uTime, uPixel, uBreath, uVoice;
        attribute float aSeed;
        varying float vTw;
        varying float vMag;
        void main(){
          // Background stars do NOT drift. At this distance any motion reads as
          // the stars sliding rather than the camera moving, which flattens the
          // depth the shell exists to create.
          vec3 p = position;

          // Slow, per-star twinkle, gently gathered by the breath.
          vTw = 0.30 + 0.70 * pow(0.5 + 0.5 * sin(uTime * (0.13 + aSeed * 0.5) + aSeed * 90.0), 2.0);
          /* The sky answers too. Without this the voice reaches the disc and
             stops at its edge, so singing lit the galaxy and left the field it
             sits in dead — and the shell is most of the frame. Half the
             strength of the breath term: background stars should stir, not
             flash, or the whole point of a quiet sky is spent. */
          vTw *= 0.75 + 0.45 * uBreath + uVoice * 0.30;
          vMag = aSeed;

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // Fixed screen size, not distance-attenuated: a star is a point source
          // and should stay a point whatever the camera does.
          gl_PointSize = clamp(uPixel * (1.0 + aSeed * 4.5), 0.8, 5.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${PALETTE_GLSL}
        uniform float uWarmth, uEnergy;
        varying float vTw;
        varying float vMag;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          float sprite = exp(-r2 * 9.0);
          // Brighter stars run cooler-white, faint ones stay violet — a rough
          // stand-in for stellar colour that keeps the sky in the palette.
          vec3 c = anima(0.18 + vMag * 0.30, 0.30 + vMag * 0.55);
          gl_FragColor = vec4(c * sprite * vTw * (0.16 + 0.10 * vMag + 0.04 * uEnergy), 1.0);
        }
      `,
    });

    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  setPixelRatio(pr) { this.uniforms.uPixel.value = pr; }

  update(t, dt, bus) {
    this.uniforms.uTime.value = t;
    this.uniforms.uWarmth.value = bus.warmth;
    this.uniforms.uEnergy.value = bus.energy;
    this.uniforms.uBreath.value = bus.breath;
    this.uniforms.uVoice.value = bus.voice || 0;
  }

  dispose() {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}
