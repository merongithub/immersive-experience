/**
 * Galaxy — the structure the field is grown from.
 *
 * Replaces Spine as the source geometry. Same contract: bake root positions
 * into a 1D float texture that Tendrils samples by `u`. Nothing downstream had
 * to learn what a galaxy is — the roots simply moved from a wandering curve to
 * a set of points scattered along logarithmic spiral arms.
 *
 * Real spiral arms are a density wave, not a structure made of fixed stars:
 * the pattern rotates slowly while individual stars orbit through it at their
 * own, much faster speed. That is exactly what the emission model gives us for
 * free — the roots ARE the density wave, and the particles are stars streaming
 * through. Differential rotation then shears each root's stream into an arc,
 * which is where the arms come from.
 */

import * as THREE from "three";

export const DISC = {
  radius: 44,        // outer edge of the star-forming disc
  coreRadius: 7.5,   // bulge
  thickness: 1.5,    // scale height at the sun-equivalent radius
  arms: 2,
  // Higher is a more open spiral. Below ~0.5 the two arms wrap past a full turn,
  // overlap themselves, and read as concentric rings rather than as a spiral.
  pitch: 0.66,
  patternSpeed: 0.028, // radians/sec the arm pattern turns — ~3.7 min per turn
};

const N_ROOTS = 512;   // texels baked; also the number of emission points

export class Galaxy {
  constructor() {
    this.rotation = 0;

    /* Roots are laid out once in polar form, then rotated into world space each
       frame. Storing them polar keeps the per-frame bake to a rotation. */
    this.polar = new Float32Array(N_ROOTS * 3);   // r, theta, y
    for (let i = 0; i < N_ROOTS; i++) {
      const o = i * 3;

      // Bias toward the middle of the disc: the inner disc is bright and busy,
      // the rim thins out. sqrt keeps area density roughly even, then a bias
      // pulls it inward.
      const s = Math.pow(Math.random(), 0.62);
      const r = DISC.coreRadius * 0.35 + s * (DISC.radius - DISC.coreRadius * 0.35);

      // Logarithmic spiral: theta = ln(r) / pitch, one branch per arm.
      const arm = i % DISC.arms;
      const base = Math.log(r / (DISC.coreRadius * 0.35)) / DISC.pitch
                 + (arm / DISC.arms) * Math.PI * 2;

      // Scatter across the arm, wider further out so the rim frays.
      const spread = 0.16 + 0.42 * (r / DISC.radius);
      const theta = base + (Math.random() - 0.5) * spread * 2;

      // Disc flares gently with radius, as real ones do.
      const h = DISC.thickness * (0.45 + 0.9 * (r / DISC.radius));
      const y = (Math.random() + Math.random() - 1) * h;

      this.polar[o] = r;
      this.polar[o + 1] = theta;
      this.polar[o + 2] = y;
    }

    this.data = new Float32Array(N_ROOTS * 4);
    this.tex = new THREE.DataTexture(
      this.data, N_ROOTS, 1, THREE.RGBAFormat, THREE.FloatType
    );
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this._bake();
  }

  /* Nearest filtering is deliberate here, unlike the old spine texture. Roots
     are discrete emission points scattered in 2D; interpolating between two
     unrelated roots would place particles in the empty space between arms. */
  _bake() {
    for (let i = 0; i < N_ROOTS; i++) {
      const p = i * 3, o = i * 4;
      const r = this.polar[p];
      const th = this.polar[p + 1] + this.rotation;
      this.data[o] = Math.cos(th) * r;
      this.data[o + 1] = this.polar[p + 2];
      this.data[o + 2] = Math.sin(th) * r;
      this.data[o + 3] = r / DISC.radius;   // normalised radius, free for shaders
    }
    this.tex.needsUpdate = true;
  }

  update(t, dt, bus) {
    // The pattern turns slowly and swells a little on the breath — the whole
    // galaxy inhales, which is the one liberty taken with the astronomy.
    this.rotation += dt * DISC.patternSpeed * (0.8 + bus.energy * 0.5);
    this._bake();
  }

  dispose() { this.tex.dispose(); }
}
