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
const SETTLE_START = 5;
const SETTLE_FULL = 22;

/* Depth is deliberately slow to earn and quick to spend. */
const RISE = 330;   // seconds of unbroken stillness to reach full depth
const FALL = 42;    // seconds of activity to lose it

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
