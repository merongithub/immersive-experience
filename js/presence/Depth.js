/**
 * Depth — how far into the session you have gone.
 *
 * The inversion at the heart of ANIMA: this field rewards you for NOT moving.
 * Almost every interactive piece on the web pays out for activity, which is
 * exactly backwards for meditation, yoga or focus — the thing you are trying
 * to do is stop.
 *
 * So stillness accumulates. Depth rises slowly while you are quiet and falls
 * quickly when you move, because moving should cost you something. After
 * several minutes of genuine stillness the piece reaches a state that cannot
 * be reached any other way — not by waiting with the mouse jiggling, not by
 * skipping ahead. There is no control for it. You have to actually be still.
 *
 * Depth is the single owner of session state. Presence pokes it, the Engine
 * and the world read it, and nothing else decides what "deep" means.
 */

/* Seconds of quiet before you count as still at all. Long enough that reading
   the mode list or adjusting volume does not break the spell. */
import { sessionAt } from "../session/Session.js";

const SETTLE_START = 5;
const SETTLE_FULL = 22;

/* Depth is deliberately slow to earn and quick to spend. */
const RISE = 330;   // seconds of unbroken stillness to reach full depth
const FALL = 42;    // seconds of activity to lose it

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * The descent, as a film rather than as a session.
 *
 * A recording has nobody sitting in front of it to be still, so the live rule
 * takes it to full depth after five and a half minutes and leaves it there for
 * the remaining forty — which is true to the piece and useless as a video.
 *
 * So: hold near the surface through the opening, because the first thirty
 * seconds decide whether anyone stays and a video that begins already dimmed
 * has thrown that away. Descend across the body of the piece. Then surface
 * again at the very end, the way the live piece greets you when you come back
 * — a film should come up for air before it stops.
 */
export function filmCurve(u) {
  const down = smoothstep(0.05, 0.74, u) * 0.92;
  const up = 1 - smoothstep(0.90, 1.0, u) * 0.55;
  return Math.max(0, Math.min(1, down * up));
}

export class Depth {
  constructor() {
    this.value = 0;        // 0..1 how deep the session is
    this.stillness = 0;    // 0..1 how still you are right now
    this.dwell = 0;        // minutes spent at or near full depth
    this.away = 0;         // 0..1 you are not looking at this
    this.arrival = 0;      // transient spike on return

    // Zero, not "already still". Arriving IS activity — you just navigated,
    // clicked, moved a mouse. Starting the descent before anyone has settled
    // would hand out the deep state for free and make the whole idea a lie.
    this.sinceActivity = 0;
    this.sessionTime = 0;
    this._wasAway = false;

    // Set by scriptTo() when the piece is being filmed rather than sat in.
    this.scripted = 0;
    this._scriptT = 0;

    // Set when a FilmDriver is reading depth off a rendered score instead.
    this.external = false;

    this._onVis = () => {
      if (document.hidden) this._wasAway = true;
      else if (this._wasAway) {
        this._wasAway = false;
        // Greeted, not resumed. A hard cut back to full brightness after a
        // minute away is jarring; the spike eases the world back toward you.
        this.arrival = 1;
      }
    };
    document.addEventListener("visibilitychange", this._onVis);
  }

  /**
   * Drive depth from a curve over a fixed length instead of from stillness.
   * Pass 0 to hand control back to the room.
   *
   * @param {number} seconds the full length of the film
   */
  scriptTo(seconds, session = null) {
    this.scripted = Math.max(0, seconds || 0);
    this._scriptT = 0;
    this.session = session;
    this.info = null;
  }

  /** 0..1 through the scripted film, for a progress readout. */
  get filmProgress() {
    return this.scripted ? Math.min(1, this._scriptT / this.scripted) : 0;
  }

  /** Any deliberate input. `weight` lets a shout count for more than a nudge. */
  poke(weight = 1) {
    if (weight < 0.02) return;
    this.sinceActivity = 0;
    this._pokeWeight = Math.max(this._pokeWeight || 0, weight);
  }

  update(dt, bus) {
    this.sessionTime += dt;
    this.sinceActivity += dt;

    // Away is driven ONLY by the tab being hidden. It is deliberately not
    // inferred from inactivity: someone sitting perfectly still with their eyes
    // closed is the most present user this app has, and treating them as absent
    // would be precisely wrong.
    const wantAway = document.hidden ? 1 : 0;
    this.away += (wantAway - this.away) * (1 - Math.exp(-dt / 1.6));
    this.arrival += (0 - this.arrival) * (1 - Math.exp(-dt / 2.2));

    if (this.external) {
      /* --- handed over -----------------------------------------------------
         A FilmDriver is reading depth off a rendered score, and its clock is
         the playhead. Depth stops publishing and mirrors instead, so anything
         holding a reference to it still agrees with the Bus — two curves that
         are nearly the same are worse than one, because the drift between them
         has nowhere to show up except in the finished film. */
      this.value = bus.depth || 0;
      this.stillness = bus.stillness ?? 1;
      this.dwell = this.value > 0.94
        ? Math.min(30, this.dwell + dt / 60)
        : Math.max(0, this.dwell - dt / 25);
      bus.dwell = this.dwell;
      bus.away = 0;
      bus.arrival = 0;
      return;
    }

    if (this.scripted) {
      /* --- filmed ---------------------------------------------------------
         The curve owns depth outright. Nothing pokes it, nothing is away, and
         the clock runs whether or not anyone is watching. */
      this._scriptT += dt;
      if (this.session) {
        // A working session has a shape; a bath has a slope. Same machinery.
        this.info = sessionAt(this._scriptT, this.scripted, this.session);
        this.value = this.info.depth;
      } else {
        this.value = filmCurve(this._scriptT / this.scripted);
      }
      this.stillness += (1 - this.stillness) * (1 - Math.exp(-dt / 8));
      this.dwell = this.value > 0.94
        ? Math.min(30, this.dwell + dt / 60)
        : Math.max(0, this.dwell - dt / 25);
    } else {
      // Stillness ramps in over a window rather than switching, so a single
      // twitch does not read as "active".
      const s = (this.sinceActivity - SETTLE_START) / (SETTLE_FULL - SETTLE_START);
      const target = Math.max(0, Math.min(1, s));
      this.stillness += (target - this.stillness) * (1 - Math.exp(-dt / 2.5));

      // Depth is frozen while you are away — stepping out for thirty seconds
      // should not cost you the session you have been building.
      if (this.away < 0.5) {
        if (this.stillness > 0.5) {
          this.value += (dt / RISE) * this.stillness;
        } else {
          this.value -= (dt / FALL) * (1 - this.stillness);
        }
        this.value = Math.max(0, Math.min(1, this.value));

        // Dwell keeps counting past full depth, so the very slowest parameters
        // have somewhere to keep going once depth has topped out. This is what
        // "goes deeper on its own" means for a forty-minute sit.
        this.dwell = this.value > 0.94
          ? Math.min(30, this.dwell + dt / 60)
          : Math.max(0, this.dwell - dt / 25);
      }
    }

    this._pokeWeight = 0;

    bus.depth = this.value;
    bus.stillness = this.stillness;
    bus.dwell = this.dwell;
    bus.away = this.away;
    bus.arrival = this.arrival;
  }

  dispose() {
    document.removeEventListener("visibilitychange", this._onVis);
  }
}
