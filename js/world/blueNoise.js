/**
 * blueNoise — a tileable blue-noise threshold map, synthesised at load.
 *
 * The film grade's dither. Blue noise rather than white because its energy is
 * all at high frequency: at one step of 8-bit it breaks a gradient's banding
 * without any clumps the eye can assemble into a texture, and an encoder sees
 * a fine, even floor rather than a pattern worth spending bits on.
 *
 * Void-and-cluster (Ulichney 1993). Grown here rather than shipped as an
 * image, because nothing in ANIMA is loaded that could be made: 64² is a few
 * tens of milliseconds, once.
 *
 * Seeded with a constant, so every film carries the same static pattern and
 * two takes differ only in what they are of.
 */

import * as THREE from "three";
import { makeRng } from "./Seed.js";

/**
 * @param {number} n      tile side, in pixels
 * @param {number} sigma  the energy filter's width. 1.5 is the paper's value;
 *   narrower is noisier, wider starts to show structure.
 * @returns {Float32Array} n×n ranks mapped to (0, 1), row-major
 */
export function voidAndCluster(n = 64, sigma = 1.5) {
  const N = n * n;
  const rng = makeRng(0x0b1ae);

  // Toroidal Gaussian, one entry per offset — so the tile wraps without a seam.
  const lut = new Float32Array(N);
  for (let y = 0; y < n; y++) {
    const dy = Math.min(y, n - y);
    for (let x = 0; x < n; x++) {
      const dx = Math.min(x, n - x);
      lut[y * n + x] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }
  }

  const bits = new Uint8Array(N);
  const energy = new Float32Array(N);
  const splat = (p, sign) => {
    const px = p % n, py = (p / n) | 0;
    for (let y = 0; y < n; y++) {
      const row = ((y - py + n) % n) * n;
      for (let x = 0; x < n; x++) {
        energy[y * n + x] += sign * lut[row + (x - px + n) % n];
      }
    }
  };
  // Tightest cluster: the densest set pixel. Largest void: the emptiest
  // unset one. With a linear filter the second is also the densest cluster of
  // UNSET pixels, which is why one loop fills the whole second half below.
  const tightest = () => {
    let best = -1, e = -Infinity;
    for (let i = 0; i < N; i++) if (bits[i] && energy[i] > e) { e = energy[i]; best = i; }
    return best;
  };
  const emptiest = () => {
    let best = -1, e = Infinity;
    for (let i = 0; i < N; i++) if (!bits[i] && energy[i] < e) { e = energy[i]; best = i; }
    return best;
  };

  // Initial pattern: a sparse random scatter, then relaxed — move the tightest
  // point into the largest void until the move would undo itself. It settles
  // in a few hundred moves; the cap is only there so it cannot fail to.
  let ones = 0;
  while (ones < N / 10) {
    const p = (rng() * N) | 0;
    if (!bits[p]) { bits[p] = 1; splat(p, 1); ones++; }
  }
  for (let guard = 0; guard < N; guard++) {
    const c = tightest();
    bits[c] = 0; splat(c, -1);
    const v = emptiest();
    bits[v] = 1; splat(v, 1);
    if (v === c) break;
  }
  const proto = bits.slice(), protoEnergy = energy.slice(), protoOnes = ones;

  const rank = new Uint32Array(N);

  // Phase 1: unpick the prototype, densest first, ranking downward.
  for (let r = protoOnes - 1; r >= 0; r--) {
    const c = tightest();
    bits[c] = 0; splat(c, -1);
    rank[c] = r;
  }

  // Phase 2: from the prototype, fill voids until every pixel is set.
  bits.set(proto); energy.set(protoEnergy);
  for (let r = protoOnes; r < N; r++) {
    const v = emptiest();
    bits[v] = 1; splat(v, 1);
    rank[v] = r;
  }

  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = (rank[i] + 0.5) / N;
  return out;
}

/** The map as a nearest-sampled, repeating texture, for gl_FragCoord lookup. */
export function blueNoiseTexture(n = 64) {
  const tex = new THREE.DataTexture(voidAndCluster(n), n, n,
                                    THREE.RedFormat, THREE.FloatType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
