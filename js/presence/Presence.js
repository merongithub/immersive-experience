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

const HESITATE = 0.15;   // seconds before the field commits to a new position
const CATCH_UP = 0.28;   // seconds to close the gap once it has committed

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

    /* --- reluctance ---------------------------------------------------
       Hold still for HESITATE seconds of continuous movement before the field
       admits it has noticed, then close the distance quickly. The gap between
       "you moved" and "it responded" is the whole feeling. */
    const moving = this._sinceMove < 0.25 && this._active;
    this._hesitation = moving
      ? Math.min(HESITATE, this._hesitation + dt)
      : Math.max(0, this._hesitation - dt * 0.7);

    const committed = this._hesitation >= HESITATE * 0.98;
    if (committed) {
      this.attractor.lerp(this.target, 1 - Math.exp(-dt / CATCH_UP));
    }

    // Presence fades over several seconds of stillness rather than switching
    // off — the field should look like it is still waiting for you.
    const want = moving ? Math.min(1, 0.45 + this.speed * 0.9) : 0;
    const tau = want > this.amount ? 0.5 : 3.5;
    this.amount += (want - this.amount) * (1 - Math.exp(-dt / tau));

    this.speed *= Math.exp(-dt / 0.18);

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
