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

/* The film drift's window, in elevation ABOVE THE PLANE. The live drift's
   whole trip is sinking from the grand spiral into the band-of-light view at
   the plane — magnificent in a sit, wrong on film: over the first 20-minute
   take it lived within ~10° of the plane and the disc read as a stretched
   streak. Film holds the register where the spiral is actually on screen. */
const FILM_ELEV_MIN = 25 * Math.PI / 180;
const FILM_ELEV_MAX = 65 * Math.PI / 180;
const FILM_ELEV_BASE = 45 * Math.PI / 180;
const FILM_ELEV_SWING = 10 * Math.PI / 180;

/* How far the camera will hand its breathing over to yours once the mic has
   established a rate. Not 1: the Engine's pacing layer is deliberately leading
   you slower, and a camera locked entirely to the listener would follow them
   back OUT of the deceleration the whole piece is built around. At 0.7 your
   rhythm dominates and the piece still has a hand on the tiller.

   POLARITY: `voiceBreath` peaks at the fullest part of YOUR cycle, which for
   most people breathing audibly is the exhale — whereas the Engine's `breath`
   peaks on the inhale. The camera eases closer as the value rises either way.
   Whether "closer on your exhale" settles or unsettles is a question about
   bodies rather than code, and it is the one number here that wants checking
   by feel; flip the sign of BREATH_FOLLOW's use below if it reads wrong. */
const BREATH_FOLLOW = 0.7;

export class CameraRig {
  constructor({ camera, domElement, onMode }) {
    this.camera = camera;
    this.dom = domElement;
    this.onMode = onMode || (() => {});
    this.mode = "drift";

    this.theta = 0.4;             // azimuth
    this.phi = Math.PI * 0.30;    // base elevation — above the plane, looking down
    this.radius = 96;             // frames the whole disc with sky around it

    /* How far the camera is allowed to tour. A focus film turns this well down:
       the elevation swing is the most dramatic motion in the piece, and drama
       in peripheral vision is exactly what a work film must not have. Beside a
       code editor it should be close to a held shot that drifts. */
    this.swing = 1;
    this._dt = 1 / 60;

    /* The film camera. A different drift, not a tuning of the live one: the
       live drift is built around the descent into the plane, and film needs
       the opposite — a held register where the spiral stays on screen. */
    this.cinema = false;
    this._push = 0;   // 0..1 how far into a push toward the nucleus we are

    /* A film's journey, if it has one — see Voyage. The drift keeps running
       underneath it the whole time: the journey leaves from wherever the
       drift has got to and returns to wherever it has got to since, so there
       is never a moment the camera is being put back. */
    this.voyage = null;

    /* While a take is recording the camera is not for touching. A scroll on
       the page mid-take — the operator reaching for something else — handed
       the whole remaining film to free look, parked ten units inside the disc
       in a white wash, and film mode has no chrome to say so. The lock is set
       by the take, not by film mode as such: auditioning a master should still
       let you look around. */
    this.locked = false;

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
    if (this.locked || this.mode === "free") return;
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
    const swing = Math.sin(t * 0.021) * (1 - bus.depth * 0.45) * this.swing;
    const phi = this.phi + swing * 0.68
              + Math.sin(t * 0.047) * 0.06 * this.swing
              + bus.depth * 0.30;

    /* Closer on the inhale, and further out as the music builds so the whole
       structure comes into view on a swell.

       Once the mic is confident about your rate, the breath the camera moves
       on becomes YOURS. Blended rather than summed: two breath curves running
       near each other would beat against one another at the difference of
       their rates, which over a long sit is a slow wallowing that nothing on
       screen explains. */
    const br = bus.breath
             + (bus.voiceBreath - bus.breath)
               * (bus.voiceBreathAmt || 0) * BREATH_FOLLOW;
    const r = this.radius * (1.0 - br * 0.055 + bus.energy * 0.10);

    return out.set(
      r * Math.sin(phi) * Math.cos(this.theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(this.theta)
    );
  }

  /* The film drift. What the first film taught, applied:

     ELEVATION IS HELD, NOT TOURED. ±10° on a cycle slower than most takes is
     half a cycle of, clamped to 25–65° above the plane whatever swing and
     depth ask for — so the spiral is on screen for the whole film instead of
     almost never. Depth settles the shot a few degrees, and the clamp is what
     lets it: the camera can lean toward the plane without ever reaching it.

     THE ORBIT IS SLOWER than the eye can catch moving. On film, motion you
     can see is motion YouTube's encoder has to spend its budget on.

     THE PUSH-IN is the one event. Now and then the camera travels in to
     dwell on the nucleus, then drifts back out — most of a minute each way,
     a smoothstepped slow sine, so both ends are easings and nothing ever
     cuts. The first lands a few minutes into a take; a second sine on an
     incommensurate clock scales how deep each one goes, so some barely lean
     in and some arrive, and none of it is a metronome. The aim wander stills
     as the camera does; elevation stays clamped, so the push comes in over
     the disc, never into it. */
  _driftPointFilm(t, bus, out) {
    const speed = (0.008 + bus.energy * 0.010) * (1 - bus.depth * 0.35);
    this.theta += speed * this._dt;

    const elev = THREE.MathUtils.clamp(
      FILM_ELEV_BASE
        + Math.sin(t * 0.0075) * FILM_ELEV_SWING * this.swing
        + Math.sin(t * 0.019) * 0.02 * this.swing   // never quite repeats
        - bus.depth * 0.10,
      FILM_ELEV_MIN, FILM_ELEV_MAX
    );
    const phi = Math.PI / 2 - elev;

    const pushWave = Math.sin(t * 0.011 - 1.2)
                   * (0.78 + 0.22 * Math.sin(t * 0.0023 + 0.7));
    this._push = THREE.MathUtils.smoothstep(pushWave, 0.82, 0.99);

    // Breath still moves the radius — the camera breathing with the piece is
    // its signature — but at half the live amplitude: on a fixed frame size
    // there is no downscaler hiding small oscillations.
    const br = bus.breath
             + (bus.voiceBreath - bus.breath)
               * (bus.voiceBreathAmt || 0) * BREATH_FOLLOW;
    const r = this.radius
            * (1.0 - br * 0.03 + bus.energy * 0.05)
            * (1.0 - this._push * 0.45);

    return out.set(
      r * Math.sin(phi) * Math.cos(this.theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(this.theta)
    );
  }

  /* The journey, as three held shots and the flights between them.

     THE STAR: far enough out to hold its whole disc, 28° above the disc's
     own plane — measured from the disc, not the galaxy, or a seed with a
     tilted system would see it edge-on — and on the side away from the
     nucleus, so the galaxy's core glows behind it. Aimed a touch toward the
     core, so the star sits off-centre and the home it came from is in the
     frame with it. A slow creep around it, and the breath still moves the
     distance.

     THE WORLD: `night` walks the camera round the planet. At 0 it is 77°
     off the star's line — the day side, a broad lit crescent of oceans and
     cloud, the star out of frame behind the camera's shoulder. At 1 it is
     11° off, on the night side looking back at the world with the star just
     at its limb and partly behind it — never all the way; the angle stops
     short. The aim leans toward the star only as the star comes into frame,
     so both are composed together.

     Each is posed around a FOCUS — what it is orbiting — and `_flight`
     moves between poses by distance from the focus rather than by position,
     which is what makes them powers-of-ten flights instead of straight
     lines. Composed in order, galaxy → star → world → galaxy, and since a
     flight at 0 is its start and at 1 its end, the chain is only ever doing
     one move at a time. */
  _voyage(t, bus, pos, look) {
    const v = this.voyage, s = v.star, p = v.planet;

    _G.pos.copy(pos); _G.look.copy(look); _G.focus.copy(look);

    const br = bus.breath
             + (bus.voiceBreath - bus.breath)
               * (bus.voiceBreathAmt || 0) * BREATH_FOLLOW;
    const n = v.normal;
    // Outward from the nucleus, laid into the disc's plane, then turned a
    // little way round it.
    _e.set(s.x, 0, s.z).normalize();
    _e.addScaledVector(n, -_e.dot(n)).normalize();
    _e.applyAxisAngle(n, 0.55 + t * 0.006);
    const el = 0.49;
    _S.focus.copy(s);
    _S.pos.copy(_e).multiplyScalar(Math.cos(el)).addScaledVector(n, Math.sin(el))
      .multiplyScalar(STAR_DIST * (1 - br * 0.03)).add(s);
    _d.set(-s.x, 0, -s.z).normalize();
    _S.look.copy(s).addScaledVector(_d, 1.2);

    const away = _d.subVectors(p, s).normalize();
    const side = _e.crossVectors(v.normal, away);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const alpha = 1.35 - 1.15 * v.night;
    _P.focus.copy(p);
    _P.pos.copy(away).multiplyScalar(Math.cos(alpha))
      .addScaledVector(side, Math.sin(alpha))
      .addScaledVector(v.normal, 0.12).normalize()
      .multiplyScalar(PLANET_DIST * (1 - br * 0.02)).add(p);
    _P.look.lerpVectors(p, s, 0.22 * (1 - THREE.MathUtils.smoothstep(alpha, 0.35, 0.9)));

    _flight(_G, _S, v.approach, _A);
    _flight(_A, _P, v.cross, _B);
    _flight(_B, _G, v.back, _C);
    pos.copy(_C.pos);
    look.copy(_C.look);
  }

  update(t, dt, bus) {
    this._dt = dt;

    if (this.mode === "free") {
      this.controls.update();
      this.lookTarget.copy(this.controls.target);
      return;
    }

    const pos = this.cinema
      ? this._driftPointFilm(t, bus, _v1)
      : this._driftPoint(t, bus, _v1);

    // Aim a little off-centre, wandering — a locked centre reads as a tripod.
    // Scaled to the disc: at galactic size a two-unit wander is invisible.
    // On film the wander is slower and smaller — closer to a held shot — and
    // it stills as a push-in arrives, so dwelling on the nucleus reads as
    // deliberate rather than as the camera losing its aim.
    const calm = this.cinema ? 1 - this._push * 0.75 : 1;
    const look = this.cinema
      ? _v2.set(
          Math.sin(t * 0.017) * 4.0 * calm,
          Math.sin(t * 0.012) * 2.0 * calm,
          Math.cos(t * 0.015) * 4.0 * calm
        )
      : _v2.set(
          Math.sin(t * 0.061) * 6.0,
          Math.sin(t * 0.044) * 3.0,
          Math.cos(t * 0.052) * 6.0
        );

    if (this.voyage && this.voyage.approach > 0) this._voyage(t, bus, pos, look);

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

/* Dwell distances from the body being looked at. See Voyage.BODY for why the
   bodies are the size they are. */
const STAR_DIST = 7.8;
const PLANET_DIST = 1.1;

const pose = () => ({
  pos: new THREE.Vector3(), look: new THREE.Vector3(), focus: new THREE.Vector3(),
});
const _G = pose(), _S = pose(), _P = pose(), _A = pose(), _B = pose(), _C = pose();
const _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _da = new THREE.Vector3(), _db = new THREE.Vector3();

/**
 * Move between two poses, a powers-of-ten flight.
 *
 * Distance from the focus is interpolated in log space, so every halving
 * takes the same time: the far end of a flight is long and the near end
 * unhurried, the galaxy opening out rather than rushing by. The focus and the
 * aim move in proportion to the distance CLOSED rather than to time — flying
 * in, the camera turns toward where it is going almost at once, while the
 * star is still a point; flying out, it keeps its eyes on the world until
 * it is small, and only then lifts them to the galaxy. Direction around the
 * focus is a normalised lerp: the poses never face each other, so it never
 * passes through zero.
 */
function _flight(A, B, e, out) {
  if (e <= 0) { out.pos.copy(A.pos); out.look.copy(A.look); out.focus.copy(A.focus); return; }
  if (e >= 1) { out.pos.copy(B.pos); out.look.copy(B.look); out.focus.copy(B.focus); return; }
  const dA = Math.max(1e-3, _da.subVectors(A.pos, A.focus).length());
  const dB = Math.max(1e-3, _db.subVectors(B.pos, B.focus).length());
  _da.divideScalar(dA);
  _db.divideScalar(dB);
  const d = Math.exp(Math.log(dA) + (Math.log(dB) - Math.log(dA)) * e);
  const f = Math.abs(dA - dB) < 1e-3
    ? e : THREE.MathUtils.clamp((dA - d) / (dA - dB), 0, 1);
  out.focus.lerpVectors(A.focus, B.focus, f);
  _da.lerp(_db, e);
  if (_da.lengthSq() < 1e-8) _da.copy(_db);
  out.pos.copy(out.focus).addScaledVector(_da.normalize(), d);
  out.look.lerpVectors(A.look, B.look, f);
}
