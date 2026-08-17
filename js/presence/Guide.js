/**
 * Guide — your own voice, leading the session.
 *
 * You speak a handful of short lines once; from then on the piece returns them
 * to you at long intervals, through the reverb and a darkening feedback delay,
 * so a sentence dissolves into the room rather than being announced over it.
 *
 * Why your voice and not a synthesised one: `speechSynthesis` output cannot be
 * routed into an AudioContext in any browser — there is no MediaStream from
 * it — so a text-to-speech line would necessarily be DRY, sitting on top of
 * the bath instead of inside it. A voice that cannot be put in the same room
 * as the music is not guidance, it is a notification.
 *
 * Privacy is unchanged from Mic: the phrases are AudioBuffers in memory. They
 * are never uploaded, never written to disk, and they die with the tab.
 *
 * Pacing: guidance is for the way IN. It thins as the session deepens and
 * stops entirely near full depth, because by then you are not being led
 * anywhere and a voice arriving would be an intrusion.
 */

/* Seconds between lines at the surface, per temperament. `dance` has no
   guidance — nobody is being talked into a dance. */
const PACE = { bath: 78, meditate: 96, focus: 130, dance: 0 };

/* How long after switching it on the first line arrives. Long enough that it
   does not feel like a button did it. */
const LEAD_IN = 9;

/* Past this depth, silence. */
const DEPTH_CEILING = 0.88;

export class Guide {
  constructor(engine) {
    this.engine = engine;
    this.lines = [];
    this.on = false;
    this._since = 0;
    this._next = 0;
    this._first = true;
    this._restore = 0;
  }

  get count() { return this.lines.length; }

  /** Built lazily: there is no AudioContext until the piece has been started. */
  _build() {
    if (this.gain || !this.engine.ctx) return;
    const ctx = this.engine.ctx;

    this.gain = ctx.createGain();
    this.gain.gain.value = 1.0;

    // Present, but in the room rather than in your ear. A loud dry return
    // would read as an instruction; this has to be part of the bath.
    this.vDry = ctx.createGain();
    this.vDry.gain.value = 0.30;
    this.gain.connect(this.vDry);
    this.vDry.connect(this.engine.dry);

    this.vWet = ctx.createGain();
    this.vWet.gain.value = 0.95;
    this.gain.connect(this.vWet);
    this.vWet.connect(this.engine.verb);

    /* The dreamy part. A long feedback delay that darkens on every pass, so
       the line does not repeat as clean copies — it loses its consonants
       first, then its words, and what is left is the shape of your own voice
       decaying into the reverb. Repeats going mostly to the convolver rather
       than to the dry bus is what keeps it from sounding like a delay pedal. */
    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = this._echoTime();
    this.damp = ctx.createBiquadFilter();
    this.damp.type = "lowpass";
    this.damp.frequency.value = 1700;
    this.fb = ctx.createGain();
    this.fb.gain.value = 0.46;

    this.gain.connect(this.delay);
    this.delay.connect(this.damp);
    this.damp.connect(this.fb);
    this.fb.connect(this.delay);          // the loop
    this.damp.connect(this.engine.verb);

    this.echoDry = ctx.createGain();
    this.echoDry.gain.value = 0.18;
    this.damp.connect(this.echoDry);
    this.echoDry.connect(this.engine.dry);
  }

  /** The echo sits on the piece's own clock: a 24th of a breath. At the
      meditate period that is ~0.46s, which is slow enough to read as space
      rather than as a slapback. */
  _echoTime() {
    return Math.max(0.12, Math.min(1.8, (this.engine.breathPeriod || 11) / 24));
  }

  /** @param {AudioBuffer} buffer a phrase captured by Mic.stopPhrase() */
  add(buffer) {
    if (!buffer || !buffer.duration) return false;
    this._build();
    this.lines.push(buffer);
    return true;
  }

  clear() {
    this.lines = [];
    this._next = 0;
    this.on = false;
  }

  setOn(on) {
    this.on = on && this.lines.length > 0;
    this._since = 0;
    this._first = true;
    if (!on) this.engine.unduck();
  }

  update(dt, bus, mode) {
    if (!this.on || !this.lines.length) return;
    if (!this.engine.running || !this.gain) return;

    const base = PACE[mode] ?? PACE.meditate;
    if (!base) return;
    if ((bus.depth || 0) > DEPTH_CEILING) return;

    // Sparser as you settle. A line every ~80s at the surface becomes one
    // every ~2.5 minutes once the descent is underway.
    const gap = this._first ? LEAD_IN : base * (1 + (bus.depth || 0) * 1.1);

    this._since += dt;
    if (this._since < gap) return;
    this._since = 0;
    this._first = false;

    this._speak(this.lines[this._next % this.lines.length]);
    this._next++;
  }

  _speak(buf) {
    const ctx = this.engine.ctx;
    const at = ctx.currentTime + 0.05;

    this.delay.delayTime.setTargetAtTime(this._echoTime(), at, 0.5);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(at);
    src.stop(at + buf.duration + 0.1);

    this.engine.duck();

    // Hold the beds down until the tail has rung out, or the music swells back
    // over the last word of every line.
    clearTimeout(this._restore);
    this._restore = setTimeout(
      () => this.engine.unduck(),
      (buf.duration + 3.0) * 1000
    );
  }

  dispose() {
    clearTimeout(this._restore);
    this.lines = [];
    try {
      this.gain?.disconnect();
      this.delay?.disconnect();
      this.damp?.disconnect();
      this.fb?.disconnect();
    } catch { /* already torn down */ }
  }
}
