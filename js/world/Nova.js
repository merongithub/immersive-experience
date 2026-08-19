/**
 * Nova — the thing that only happens sometimes.
 *
 * Everything else in this piece is continuous. The field breathes, the arms
 * turn, colour drifts, and all of it is always happening — which is right for
 * something you sit inside and wrong as the only register a piece has. Nothing
 * ever ARRIVES. Forty minutes in, you have seen every kind of thing it does,
 * and a field with no remaining surprises is one you stop looking at even
 * while it is still on the screen.
 *
 * So: a star detonates. Rarely, and never on a timer.
 *
 * WHAT TRIGGERS IT is the point. It fires on a gong — the largest strike the
 * instrument has — and only once the session is deep. Both conditions are
 * read off the Bus, so this is not a visual effect scheduled beside the music;
 * it is the music, arriving in the picture. And because both drivers publish
 * `strike`, a rendered film detonates in exactly the same places as the live
 * piece rather than being a quieter version of it.
 *
 * The depth gate is what makes it worth having. Gongs are not rare — a bath
 * strikes one every 95 seconds or so — but gongs at depth are, because depth
 * costs five and a half minutes of stillness. You cannot seek to this, you
 * cannot click for it, and nothing in the interface admits it exists.
 */

import * as THREE from "three";
import { DISC } from "./Galaxy.js";

/* A gong carries weight 1.6; a bowl 1.15 and a bell rarely more than 1. The
   threshold sits between them, which is only possible because `strike` is the
   raw weight — `onset` saturates at 1 and cannot tell them apart. */
const GONG = 1.4;

/* How deep the session must be. Below this the piece has not earned it. */
const DEPTH_GATE = 0.62;

/* Minimum seconds between detonations. Long: the whole value of this is that
   it is rare, and two in a minute would spend it permanently. At a bath's gong
   rate this is roughly one every eight to ten minutes of DEEP sitting, which
   over a long session is two or three. */
const COOLDOWN = 420;

/* Seconds from detonation to a cold remnant. Slower than anything else in the
   piece reacts to, so the shell is still visibly spreading long after the
   sound that caused it has gone — which is what makes it read as a consequence
   rather than as a flash synced to a hit. */
const LIFE = 26;

export class Nova {
  constructor() {
    this.pos = new THREE.Vector3();
    this.age = 0;
    this.active = false;
    this.flash = 0;        // 0..1 the initial blaze, gone in under a second
    this.radius = 0;       // world units — the shell front
    this.amount = 0;       // 0..1 overall presence, for the sim and the bloom
    this._since = COOLDOWN * 0.5;   // not immediately, not a full wait either
    this._rng = Math.random;
  }

  /** Seeded, so a given galaxy detonates in the same places. */
  useRng(rng) { this._rng = rng || Math.random; }

  /**
   * @param {number} dt
   * @param {object} bus
   * @returns {boolean} whether a detonation began on this frame
   */
  update(dt, bus) {
    this._since += dt;

    let fired = false;
    if (!this.active
        && (bus.strike || 0) >= GONG
        && (bus.depth || 0) >= DEPTH_GATE
        && this._since >= COOLDOWN) {
      this._detonate();
      fired = true;
    }

    if (this.active) {
      this.age += dt;
      const u = this.age / LIFE;

      // The blaze. Very short and very bright — a supernova outshines its
      // whole galaxy for a moment, and the only way to say that here is to
      // let it briefly beat the nucleus.
      this.flash = Math.max(0, 1 - this.age / 0.9);

      /* The shell decelerates. A constant-speed ring reads as a drawn circle
         expanding; real ejecta slams into what is already there and slows,
         and a square-root front is most of what separates the two. */
      this.radius = DISC.radius * 0.75 * Math.sqrt(Math.min(1, u));

      // Long fade, and it never quite reaches the rim before it is gone.
      this.amount = Math.max(0, 1 - u) * (1 - Math.min(1, this.age / 1.6) * 0.55);

      if (this.age >= LIFE) {
        this.active = false;
        this.amount = this.flash = this.radius = 0;
      }
    }

    return fired;
  }

  _detonate() {
    /* Out in the disc, never in the bulge. A star that goes in the core is
       lost against a nucleus that is already the brightest thing on screen,
       and the shell has nothing legible to expand into. */
    const r = DISC.coreRadius * 1.6
            + this._rng() * (DISC.radius * 0.72 - DISC.coreRadius * 1.6);
    const th = this._rng() * Math.PI * 2;
    this.pos.set(Math.cos(th) * r, (this._rng() - 0.5) * DISC.thickness * 1.5,
                 Math.sin(th) * r);
    this.age = 0;
    this.active = true;
    this._since = 0;
  }
}
