/**
 * Presence — you, as an input to the field.
 *
 * Pointer, touch and device tilt resolve into a single world-space attractor
 * plus a strength, which Tendrils reads as a force. The Mic is handled
 * separately because it feeds audio as well as the Bus.
 *
 * The motion rule that matters is RELUCTANCE. When you move, the field does
 * not follow immediately — it hesitates for about 150ms, then commits and
 * catches up quickly. Reciprocity that is too eager reads as needy; too slow
 * reads as dead. That single delay is the most-felt number in the project and
 * it lives here, not in the shader.
 */

import * as THREE from "three";
import { DISC } from "../world/Galaxy.js";

const HESITATE = 0.15;   // seconds before the field commits to a new position
const CATCH_UP = 0.28;   // seconds to close the gap once it has committed

/* How fast the field's OWN point of interest travels. Much slower than the
   catch-up to a pointer, because nothing is chasing it. */
const WANDER_CATCH = 0.9;

/* Minimum seconds between strike-driven relocations. Without it, `dance` at
   1.1 bells/second would strobe the attractor across the disc. */
const JUMP_GAP = 3.0;

export class Presence {
  constructor({ domElement, camera, depth }) {
    this.dom = domElement;
    this.camera = camera;
    this.depth = depth;

    this.ndc = new THREE.Vector2(0, 0);      // pointer in clip space
    this.target = new THREE.Vector3();       // where you are pointing, in world
    this.attractor = new THREE.Vector3();    // where the field thinks you are
    this.amount = 0;                         // 0..1 how present you are
    this.speed = 0;                          // pointer speed, normalised
    this.force = 0;                          // 0..1 what the shader actually feels

    /* --- the field's own attention ---------------------------------------
       Where the galaxy is looking when nobody is touching it. Seeded from
       Math.random() rather than from a fixed constant, so the path is
       different every session and cannot be learned. */
    this.auto = new THREE.Vector3();
    this._goal = new THREE.Vector3();
    this._hand = 0;                          // 0..1 how much you own the attractor
    this._wt = Math.random() * 1000;         // wander clock
    this._seed = Math.random() * 1000;
    this._arm = Math.random() * Math.PI * 2;
    this._wasHit = false;
    this._sinceJump = 0;

    this.tilt = new THREE.Vector2(0, 0);
    this.tiltEnabled = false;

    this._active = false;
    this._sinceMove = 99;
    this._hesitation = 0;
    this._prev = new THREE.Vector2(0, 0);

    // The disc plane. The pointer ray is intersected with it so the attractor
    // lands somewhere the galaxy actually is, rather than floating in front.
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._ray = new THREE.Raycaster();
    this._hit = new THREE.Vector3();

    this._bind();
  }

  _bind() {
    this._onMove = (e) => {
      const x = (e.clientX / innerWidth) * 2 - 1;
      const y = -(e.clientY / innerHeight) * 2 + 1;
      const dx = x - this.ndc.x, dy = y - this.ndc.y;
      this.speed = Math.min(1, Math.hypot(dx, dy) * 12);
      this.ndc.set(x, y);
      this._active = true;
      this._sinceMove = 0;
      this.depth?.poke(this.speed);
    };
    this._onLeave = () => { this._active = false; };

    this.dom.addEventListener("pointermove", this._onMove, { passive: true });
    this.dom.addEventListener("pointerleave", this._onLeave, { passive: true });
  }

  /** iOS requires a user gesture before it will hand over orientation data. */
  async enableTilt() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === "function") {
      const res = await DOE.requestPermission();
      if (res !== "granted") return false;
    }
    this._onTilt = (e) => {
      // beta: front-back (-180..180), gamma: left-right (-90..90)
      this.tilt.set(
        Math.max(-1, Math.min(1, (e.gamma || 0) / 35)),
        Math.max(-1, Math.min(1, ((e.beta || 0) - 45) / 35))
      );
      this._active = true;
      this._sinceMove = 0;
    };
    addEventListener("deviceorientation", this._onTilt, true);
    this.tiltEnabled = true;
    return true;
  }

  /**
   * The field's own point of interest, walked by the SCORE rather than by a
   * clock.
   *
   * This exists because the piece contradicted itself: Depth rewards you for
   * sitting still, but the attractor only had a position worth having while
   * the pointer was moving — so doing the thing the piece asks for made the
   * arms go inert. The sound is already the most alive input in the system;
   * it should be the one bending the disc when your hands are in your lap.
   */
  _wander(dt, bus) {
    // Speed from energy, so a resting passage is a resting field. Depth nearly
    // stops it, like everything else in the descent.
    const slow = 1 - bus.depth * 0.78;
    this._wt += dt * (0.030 + bus.energy * 0.115) * slow;
    this._sinceJump += dt;

    // A strike relocates the attention, so a bowl visibly lands somewhere
    // instead of merely being heard. Roughly an arm's width, either direction.
    const hit = (bus.onset || 0) > 0.5;
    if (hit && !this._wasHit && this._sinceJump > JUMP_GAP) {
      this._arm += ((Math.PI * 2) / DISC.arms)
                 * (0.6 + Math.random() * 0.9)
                 * (Math.random() < 0.5 ? -1 : 1);
      this._sinceJump = 0;
    }
    this._wasHit = hit;

    // Two incommensurate clocks over the seeded offset: the path never repeats
    // within a session and never repeats across them either.
    const th = this._arm + this._wt * 0.85
             + Math.sin(this._wt * 0.41 + this._seed) * 1.7;
    const rn = 0.34 + 0.50 * (0.5 + 0.5 * Math.sin(this._wt * 0.63 + this._seed * 1.7));
    const r = DISC.radius * rn * (1 - bus.breath * 0.13);   // the inhale draws it inward

    this.auto.set(
      Math.cos(th) * r,
      Math.sin(this._wt * 0.77 + this._seed) * DISC.thickness * 1.6,
      Math.sin(th) * r
    );
  }

  update(dt, bus) {
    this._sinceMove += dt;

    // Where are you pointing, in the disc plane?
    this._ray.setFromCamera(this.ndc, this.camera);
    if (this._ray.ray.intersectPlane(this._plane, this._hit)) {
      this.target.copy(this._hit);
    }

    // Tilt nudges the attractor as well, so a phone on a mat still has reach.
    if (this.tiltEnabled) {
      this.target.x += this.tilt.x * 26;
      this.target.z += this.tilt.y * 26;
    }

    this._wander(dt, bus);

    /* --- reluctance ---------------------------------------------------
       Hold still for HESITATE seconds of continuous movement before the field
       admits it has noticed, then close the distance quickly. The gap between
       "you moved" and "it responded" is the whole feeling. */
    const moving = this._sinceMove < 0.25 && this._active;
    this._hesitation = moving
      ? Math.min(HESITATE, this._hesitation + dt)
      : Math.max(0, this._hesitation - dt * 0.7);

    const committed = this._hesitation >= HESITATE * 0.98;

    /* --- the hand-off --------------------------------------------------
       `_hand` is how much of the attractor belongs to you rather than to the
       field. It rises only once the hesitation has completed, so that 150ms is
       untouched, and it falls over seconds — letting go is a release back into
       the drift, not a cut. */
    this._hand += ((committed ? 1 : 0) - this._hand)
                * (1 - Math.exp(-dt / (committed ? CATCH_UP : 2.6)));

    this._goal.copy(this.auto).lerp(this.target, this._hand);
    // Slow when it is moving itself, quick when it is following you.
    const chase = WANDER_CATCH + (CATCH_UP - WANDER_CATCH) * this._hand;
    this.attractor.lerp(this._goal, 1 - Math.exp(-dt / chase));

    // Presence fades over several seconds of stillness rather than switching
    // off — the field should look like it is still waiting for you.
    const want = moving ? Math.min(1, 0.45 + this.speed * 0.9) : 0;
    const tau = want > this.amount ? 0.5 : 3.5;
    this.amount += (want - this.amount) * (1 - Math.exp(-dt / tau));

    this.speed *= Math.exp(-dt / 0.18);

    /* --- what the shader feels ------------------------------------------
       `amount` stays what it always was: how present YOU are, which is what
       Depth and the palette want. `force` is separate, because the attractor
       now has a reason to pull even when you are perfectly still — and
       conflating the two would either kill the field's own motion or tell the
       rest of the system that an empty room is full of someone. */
    const self = (0.28 + bus.energy * 0.55 + (bus.onset || 0) * 0.40)
               * (1 - bus.depth * 0.60);
    this.force = self * (1 - this._hand) + this.amount * this._hand;

    // Presence owns this signal outright. It used to be max()'d here and again
    // in Mic, which only worked because of module update order — a collision
    // waiting to break the first time something was reordered. Mic publishes
    // `voice` instead, and anything wanting "how present is the person" reads
    // Depth, which is the one place that combines them.
    bus.presenceAmt = this.amount;
  }

  dispose() {
    this.dom.removeEventListener("pointermove", this._onMove);
    this.dom.removeEventListener("pointerleave", this._onLeave);
    if (this._onTilt) removeEventListener("deviceorientation", this._onTilt, true);
  }
}
