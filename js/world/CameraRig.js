/**
 * CameraRig — a drift that breathes, handing off to free look on any input.
 *
 * Direct descendant of the Neon Rain City rig, with one change that matters:
 * the city moved along its path at a constant 7.5 u/s. Here the drift speed and
 * the orbit radius are both driven by the Bus, so the camera is not observing
 * the organism — it is breathing with it. On the inhale it eases closer.
 *
 * Modes: DRIFT → (any input) → FREE → (r) → RESUMING → DRIFT.
 * Only one of them writes to the camera in a given frame, ever.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const RESUME_TIME = 1.6;  // longer than the city's 0.8: nothing here snaps

export class CameraRig {
  constructor({ camera, domElement, onMode }) {
    this.camera = camera;
    this.dom = domElement;
    this.onMode = onMode || (() => {});
    this.mode = "drift";

    this.theta = 0.4;             // azimuth
    this.phi = Math.PI * 0.30;    // base elevation — above the plane, looking down
    this.radius = 96;             // frames the whole disc with sky around it
    this._dt = 1 / 60;

    this.lookTarget = new THREE.Vector3(0, 0, 0);
    this._fromPos = new THREE.Vector3();
    this._fromLook = new THREE.Vector3();
    this._blend = 0;

    this.controls = null;
    this._bind();
  }

  _bind() {
    this._onDown = () => this._enterFree();
    this._onWheel = () => this._enterFree();
    this._onKey = (e) => { if (e.key === "r" || e.key === "R") this._resume(); };
    this.dom.addEventListener("pointerdown", this._onDown);
    this.dom.addEventListener("wheel", this._onWheel, { passive: true });
    addEventListener("keydown", this._onKey);
  }

  _ensureControls() {
    if (this.controls) return;
    const c = new OrbitControls(this.camera, this.dom);
    c.enableDamping = true;
    c.dampingFactor = 0.055;   // heavier than the city's: the hand should feel weight
    c.rotateSpeed = 0.5;
    c.zoomSpeed = 0.7;
    c.minDistance = 6;
    c.maxDistance = 240;
    c.enablePan = false;       // there is one thing to look at
    c.enabled = false;
    this.controls = c;
  }

  _enterFree() {
    if (this.mode === "free") return;
    this._ensureControls();
    this.controls.target.copy(this.lookTarget);
    this.controls.enabled = true;
    this.controls.update();
    this.mode = "free";
    this.onMode("free");
  }

  _resume() {
    if (this.mode === "drift") return;
    // Adopt the current spherical coords so the drift picks up exactly where
    // the hand left off — no teleport, no re-framing.
    const p = this.camera.position;
    this.radius = Math.max(6, p.length());
    this.theta = Math.atan2(p.z, p.x);
    this.phi = Math.acos(THREE.MathUtils.clamp(p.y / this.radius, -1, 1));

    this._fromPos.copy(p);
    this._fromLook.copy(this.controls ? this.controls.target : this.lookTarget);
    this._blend = 0;
    if (this.controls) this.controls.enabled = false;
    this.mode = "resuming";
    this.onMode("drift");
  }

  _driftPoint(t, bus, out) {
    // Azimuth creeps; elevation wanders on slower, incommensurate clocks so the
    // path never repeats within a session.
    // The drift slows almost to a stop as the session deepens. Motion is what
    // keeps a scene demanding attention, so removing it is most of how the
    // piece stops asking to be watched.
    const speed = (0.018 + bus.energy * 0.030) * (1 - bus.depth * 0.72);
    this.theta += speed * this._dt;

    // The elevation swing is the whole trip. On a very long cycle the camera
    // rises to look down on the grand spiral, then sinks almost into the plane
    // where the disc collapses into a band of light across the sky — which is
    // the view from inside a galaxy, the one everybody actually recognises.
    // The elevation swing narrows with depth too, settling into the plane
    // rather than continuing to tour the structure.
    const swing = Math.sin(t * 0.021) * (1 - bus.depth * 0.45);
    const phi = this.phi + swing * 0.68 + Math.sin(t * 0.047) * 0.06 + bus.depth * 0.30;

    // Closer on the inhale, and further out as the music builds so the whole
    // structure comes into view on a swell.
    const r = this.radius * (1.0 - bus.breath * 0.055 + bus.energy * 0.10);

    return out.set(
      r * Math.sin(phi) * Math.cos(this.theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(this.theta)
    );
  }

  update(t, dt, bus) {
    this._dt = dt;

    if (this.mode === "free") {
      this.controls.update();
      this.lookTarget.copy(this.controls.target);
      return;
    }

    const pos = this._driftPoint(t, bus, _v1);

    // Aim a little off-centre, wandering — a locked centre reads as a tripod.
    // Scaled to the disc: at galactic size a two-unit wander is invisible.
    const look = _v2.set(
      Math.sin(t * 0.061) * 6.0,
      Math.sin(t * 0.044) * 3.0,
      Math.cos(t * 0.052) * 6.0
    );

    if (this.mode === "resuming") {
      this._blend = Math.min(1, this._blend + dt / RESUME_TIME);
      const k = this._blend * this._blend * (3 - 2 * this._blend);
      this.camera.position.lerpVectors(this._fromPos, pos, k);
      this.lookTarget.lerpVectors(this._fromLook, look, k);
      this.camera.lookAt(this.lookTarget);
      if (this._blend >= 1) this.mode = "drift";
      return;
    }

    this.camera.position.copy(pos);
    this.lookTarget.lerp(look, 1 - Math.exp(-1.6 * dt));
    this.camera.lookAt(this.lookTarget);
  }

  dispose() {
    this.dom.removeEventListener("pointerdown", this._onDown);
    this.dom.removeEventListener("wheel", this._onWheel);
    removeEventListener("keydown", this._onKey);
    this.controls?.dispose();
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
