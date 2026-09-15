/**
 * Voyage — a film with somewhere to go.
 *
 * Until now a film looked at the galaxy for its whole length. The camera
 * drifts, pushes in, drifts out — beautifully, and always from outside. There
 * is no place in it, and without a place there is no story: nothing to arrive
 * at, nothing to leave.
 *
 * So a film now travels. One star, among a quarter of a million, is chosen by
 * the seed and set inside one of the session's nebulae. The story is five
 * chapters, and it is the depth curve's own shape told as a journey:
 *
 *   OVERTURE    the whole galaxy, as before. Partway through, one star starts
 *               answering the bowls — a glint on each strike — which is the
 *               only foreshadowing there is. Nobody is told to look at it.
 *   APPROACH    the camera turns toward that star and flies to it, a powers-
 *               of-ten flight: equal time for every halving of the distance,
 *               so the galaxy opens around you rather than rushing past.
 *   THE STAR    dwell. The star is light, not a ball — a brilliant point in a
 *               soft halo — and around it is the galaxy again, small: a disc
 *               of motes in the same palette, a faint spiral, the inner edge
 *               turning faster than the outer, and a clear lane where a
 *               world is sweeping it. As above, so below. Strikes send a ring
 *               of light out through it, as they do across the galaxy.
 *   THE WORLD   the camera crosses to the planet and arrives in its daylight —
 *               oceans, land, weather, the star out of frame behind you. Over
 *               the next few minutes it drifts round through the terminator
 *               onto the night side, and as the film reaches its deepest the
 *               star slips up to the edge of the world and partly behind it,
 *               the atmosphere lit from behind. Never a full eclipse: the
 *               frame darkens to a ring of light and that is enough. Before
 *               the return the star eases a little way back out.
 *   RETURN      a long pull back — the world, the star, the arm, the whole
 *               disc — timed to arrive as the depth curve surfaces, so the
 *               film comes up for air where it began.
 *
 * The music is not scheduled around any of this. The chapters follow the film
 * clock; what happens inside them follows the Bus, so a gong still lands
 * wherever it lands and the star answers it.
 *
 * Voyage owns WHERE and WHEN. The camera math lives in CameraRig and the
 * bodies are drawn by StarSystem — both read the state published here.
 */

import * as THREE from "three";
import { SESSION, makeStream } from "./Seed.js";

/* World sizes. Nothing here is to scale — at the galaxy's scale a star is a
   ten-thousandth of a pixel — so these are chosen for the frame instead: at
   the star's dwell distance the disc fills the frame, and from the planet's
   night side the world fills about a quarter of it. The star has no surface;
   starRadius is only how near the camera may come to its light. */
export const BODY = {
  starRadius: 0.08,
  planetRadius: 0.15,
  planetOrbit: 3.2,
  planetPeriod: 540,   // seconds — slow enough to read as still while we look
  discInner: 0.35,
  discOuter: 5.4,
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/* Smootherstep: zero velocity AND acceleration at both ends. A flight that
   starts with a jerk reads as a cut, however slow the rest of it is. */
const ease = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export class Voyage {
  constructor(session = SESSION) {
    const rng = makeStream(session, "voyage");
    this.session = session;

    /* Inside the strongest nebula, off its centre. A region's colour is the
       one thing about the destination the audience has already seen from
       outside, so that is where it lives: "a star in the teal". Placed in
       the region's own drifting frame, so the nebula carries it. */
    const neb = session.nebulae.reduce((a, b) => (b.strength > a.strength ? b : a));
    this.nebula = neb;
    this._dr = (rng() - 0.5) * neb.radius * 0.5;
    this._dth = (rng() - 0.5) * 0.35;
    this._y = neb.height * 0.5 + (rng() - 0.3) * 0.8;

    /* The star's temperature on the palette ramp, and the world's. */
    this.starHeat = 0.62 + rng() * 0.34;       // ember-gold to bone
    this.planetTilt = (rng() - 0.5) * 0.5;     // orbit plane, radians
    this.planetPhase = rng() * Math.PI * 2;
    this.ringed = rng() < 0.55;
    this.ringTilt = 0.25 + rng() * 0.45;
    this.planetSeed = rng() * 100;

    this.star = new THREE.Vector3();
    this.planet = new THREE.Vector3();
    /* The system's plane — the world's orbit and the disc share it. Up out of
       the disc; see the orbit in update() for the basis it comes from. */
    this.normal = new THREE.Vector3(0, Math.cos(this.planetTilt), -Math.sin(this.planetTilt));
    /* The clock the system turns on: the film's when there is one. The disc
       reads it too, so the world and the lane it clears stay together. */
    this.clock = 0;

    // 0..1 progress of each move, eased. See CameraRig._voyage.
    this.approach = 0;   // galaxy → star
    this.cross = 0;      // star → world
    this.back = 0;       // world → galaxy
    this.glint = 0;      // the star has been picked out
    this.night = 0;      // 0 in the world's daylight, 1 with the star at its limb
    this.chapter = "overture";
    this.active = false;

  }

  /** Where each chapter begins and how long each move takes, for a film of
      `T` seconds. Moves are clamped in absolute time — a flight should not
      take nine minutes because the film is long, nor four seconds because it
      is a test. */
  plan(T) {
    const inDur = clamp(0.09 * T, 20, 140);
    const inAt = 0.17 * T;
    const crossDur = clamp(0.05 * T, 12, 75);
    const crossAt = Math.max(inAt + inDur + 10, 0.44 * T);
    const backDur = clamp(0.12 * T, 25, 180);
    const backAt = Math.max(crossAt + crossDur + 10, 0.70 * T);
    return { glintAt: 0.10 * T, inAt, inDur, crossAt, crossDur, backAt, backDur };
  }

  /**
   * @param {number} t    the world clock — the one the nebulae drift on
   * @param {object} bus  reads filmT / filmLen
   */
  update(t, dt, bus) {
    /* Position first, every frame: the region drifts, and the star with it.
       MUST match Tendrils._placeNebulae, or the star wanders out of its own
       nebula over a long film. */
    const n = this.nebula;
    const a = n.angle + t * n.drift + this._dth;
    const r = n.dist + this._dr;
    this.star.set(Math.cos(a) * r, this._y, Math.sin(a) * r);

    const T = bus.filmLen || 0;
    const ft = bus.filmT || 0;

    /* On the film clock when there is one, so a take and its retake put the
       world in the same place on its orbit — the whole of the world's dwell
       is framed from it. */
    this.clock = T ? ft : t;
    const pa = this.planetPhase + this.clock * (Math.PI * 2 / BODY.planetPeriod);
    const R = BODY.planetOrbit;
    this.planet.set(
      Math.cos(pa) * R,
      Math.sin(pa) * R * Math.sin(this.planetTilt),
      Math.sin(pa) * R * Math.cos(this.planetTilt)
    ).add(this.star);

    if (!T) { this.active = false; return; }
    const p = this.plan(T);

    this.glint = smooth(p.glintAt, p.glintAt + 25, ft);
    this.approach = ease(p.inAt, p.inAt + p.inDur, ft);
    this.cross = ease(p.crossAt, p.crossAt + p.crossDur, ft);
    this.back = ease(p.backAt, p.backAt + p.backDur, ft);

    /* Day into night across the world's dwell: round to the night side over
       the first half, held at the limb through the deepest stretch, eased a
       little way back before the return so the star has come out from behind
       the world when we leave it. */
    const d0 = p.crossAt + p.crossDur, d1 = p.backAt;
    const u = clamp((ft - d0) / Math.max(1, d1 - d0), 0, 1);
    this.night = smooth(0, 0.55, u) * (1 - 0.25 * smooth(0.8, 1.0, u));

    this.active = this.approach > 0 || this.glint > 0;
    this.chapter =
        ft >= p.backAt + p.backDur ? "coda"
      : ft >= p.backAt ? "return"
      : ft >= p.crossAt ? "the world"
      : ft >= p.inAt + p.inDur ? "the star"
      : ft >= p.inAt ? "approach"
      : "overture";
  }

  /** The destination, for a readout: "a star in the teal". */
  get name() { return `a star in the ${this.nebula.hue}`; }
}
