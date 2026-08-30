/**
 * LiveDriver — a real instrument, published onto the Bus.
 *
 * The fourth driver, beside Fake, Engine and Film, and the one the Bus was
 * drawn for in the first place: "mp3/mic in M3" is written in its header and
 * nobody built it. The world does not learn that the sound is now a handpan
 * in the room. Not one line of Galaxy, Tendrils, Dust, CameraRig or Post
 * changes.
 *
 * Bands, warmth and energy come from readSpectrum(), exactly as they do for
 * the Engine and the film. Onset, note, chroma and (when the playing is
 * rhythmic) anticipation come from Analysis. Breath comes from the Engine when
 * it is accompanying and from a free-running cycle when it is not — a room has
 * no pacing layer, and the field still has to breathe.
 *
 * ACCOMPANIMENT. When the Engine plays under the player, the mic hears both,
 * and the drone would paint the sky as surely as the handpan does. Two
 * defences, both possible only because we know exactly what we played:
 *
 *   REFERENCE SUBTRACTION  the Engine's own spectrum, scaled by how much of it
 *     the mic is hearing, is taken off the mic spectrum before analysis. The
 *     scale is learned as the running MINIMUM of mic/engine energy — the
 *     minimum is when the player is silent and the mic hears only us. Delayed
 *     a few frames, because the room and the output buffer put the speakers
 *     ~100 ms behind the analyser.
 *
 *   SCORE MASKING  the Engine's `upcoming` says when its bells land. An onset
 *     inside ±80 ms of one is not counted. Subtraction handles the sustained
 *     bed well and transients badly; masking is the other half.
 *
 * Headphones make both unnecessary, and the chrome says so.
 */

import { readSpectrum, MODE_ENV } from "../audio/Engine.js";
import { follow } from "../audio/Bus.js";
import { Analysis } from "./Analysis.js";

/* Frames the reference is held back before subtraction. ~100 ms at 60 fps. */
const REF_DELAY = 6;

/* Subtract a little more than measured. Under-subtracting leaves the drone in
   the chroma, which tints every note toward the drone's root; over-subtracting
   costs a little of the quietest playing. The second is the cheaper error. */
const REF_MARGIN = 1.15;

/* Seconds either side of a scheduled Engine event during which an onset is
   presumed to be the Engine's. */
const MASK = 0.08;

const BREATH_PERIOD = 11.0;   // the meditate rate; the room has no temperament

export class LiveDriver {
  /**
   * @param {object}  opts
   * @param {Source}  opts.source
   * @param {Engine=} opts.engine  present when there is a built-in instrument
   *   on the same context — accompanying, or being listened to directly
   * @param {string=} opts.mode    temperament, for the band envelopes
   */
  constructor({ source, engine = null, mode = "meditate" }) {
    this.source = source;
    this.engine = engine;
    this.env = MODE_ENV[mode] || MODE_ENV.meditate;
    this.modeName = mode;

    this.analysis = null;   // built on the first frame the source is ready
    this._ref = null;       // Float32Array[REF_DELAY][bins] of linear magnitudes
    this._refDb = null;
    this._refI = 0;
    this._k = -1;           // learned mic/engine ratio; <0 = not yet
    this.accompany = false; // subtract + mask the Engine? set by the chrome

    this.breathPhase = 0;
    this.prevBreath = 0;
    this._rate = 0;         // strikes per second, smoothed
    this._depthTick = 0;
    this._greeted = false;
  }

  get sensitivity() { return this.analysis?.sensitivity ?? 0.5; }
  set sensitivity(v) { if (this.analysis) this.analysis.sensitivity = v; this._sens = v; }

  setMode(name) {
    if (!MODE_ENV[name]) return;
    this.modeName = name;
    this.env = MODE_ENV[name];
    this.engine?.setMode(name);
  }

  /** The Engine's shape of a breath, so a room breathes the way the piece does. */
  _breathValue() {
    const p = this.breathPhase, IN = 0.4;
    return p < IN
      ? 0.5 - 0.5 * Math.cos(Math.PI * (p / IN))
      : 0.5 + 0.5 * Math.cos(Math.PI * ((p - IN) / (1 - IN)));
  }

  _build() {
    const a = this.source.analyser;
    this.analysis = new Analysis(this.source.ctx.sampleRate, a.frequencyBinCount);
    if (this._sens !== undefined) this.analysis.sensitivity = this._sens;
  }

  /* The Engine's spectrum, linear, delayed. Returns null when there is nothing
     to subtract — no engine, not running, not accompanying, or the two
     analysers disagree about their size. */
  _reference(dt) {
    const e = this.engine;
    if (!this.accompany || !e?.running || !e.analyser || this.source.kind !== "mic") {
      this._k = -1;
      return null;
    }
    const n = e.analyser.frequencyBinCount;
    if (n !== this.analysis.n) return null;

    if (!this._ref) {
      this._ref = Array.from({ length: REF_DELAY }, () => new Float32Array(n));
      this._refDb = new Float32Array(n);
    }
    e.analyser.getFloatFrequencyData(this._refDb);
    const slot = this._ref[this._refI];
    let refE = 0;
    for (let i = 0; i < n; i++) {
      const m = Math.pow(10, this._refDb[i] / 20);
      slot[i] = m;
      refE += m;
    }
    this._refI = (this._refI + 1) % REF_DELAY;
    const delayed = this._ref[this._refI];

    // Learn how much of us the mic hears. Down instantly, up slowly.
    let micE = 0;
    const db = this.source.db;
    for (let i = 0; i < n; i++) micE += Math.pow(10, db[i] / 20);
    if (refE > 1e-7) {
      const ratio = micE / refE;
      if (this._k < 0 || ratio < this._k) this._k = ratio;
      else this._k += (ratio - this._k) * (1 - Math.exp(-dt / 25));
    }
    return delayed;
  }

  _masked() {
    const e = this.engine;
    if (!this.accompany || !e?.running || !e.ctx) return false;
    const now = e.ctx.currentTime;
    for (const ev of e.upcoming) {
      if (Math.abs(ev.at - now) < MASK) return true;
    }
    return false;
  }

  update(bus, dt) {
    const s = this.source;
    const e = this.engine;

    // The accompaniment is still an instrument; somebody has to tick it.
    if (e?.running) {
      e.tick(dt);
      this._depthTick += dt;
      if (this._depthTick > 0.5) {
        this._depthTick = 0;
        e.setDepth(bus.depth || 0, bus.dwell || 0);
      }
      if ((bus.arrival || 0) > 0.6 && !this._greeted) { this._greeted = true; e.greet(); }
      if ((bus.arrival || 0) < 0.15) this._greeted = false;
    }

    if (!s?.ready) {
      // Silent but not frozen, as every other driver does when it has nothing.
      this.breathPhase = (this.breathPhase + dt / BREATH_PERIOD) % 1;
      bus.breath = this._breathValue();
      bus.energy += (0.06 - bus.energy) * (1 - Math.exp(-dt / 3));
      bus.onset += (0 - bus.onset) * (1 - Math.exp(-dt / 0.4));
      bus.anticipation = 0;
      bus.pulse = 0;
      bus.note *= Math.exp(-dt / 0.25);
      return;
    }
    if (!this.analysis) this._build();

    /* --- what the room sounds like ------------------------------------- */
    readSpectrum(bus, dt, s.analyser, s.freq, s.wave, s.ctx.sampleRate, this.env);

    /* --- what happened in it ------------------------------------------- */
    s.analyser.getFloatFrequencyData(s.db);
    const ref = this._reference(dt);
    const A = this.analysis;
    A.update(dt, s.db, ref, ref ? this._k * REF_MARGIN : 0, this._masked());

    /* Same envelope as EngineDriver, so a struck pan blooms like a struck bowl
       — with one difference the Engine never needed. Its bowls arrive every
       fourteen seconds; a handpan groove arrives twice a second, and a picture
       that flares on every one of those is a strobe, not a sky. So the weight
       of a strike falls as strikes get denser: the first hit after silence
       lands at full weight, and a steady pulse settles to something the eye
       reads as rhythm rather than as lightning. */
    // Only firm strikes count toward density. A run of faint texture hits must
    // not talk the picture out of flaring for the one real bowl among them.
    const firm = A.onset && A.strength > 0.25;
    this._rate = follow(this._rate, firm ? 1 / Math.max(dt, 1e-3) : 0, 0.6, 2.0, dt);
    if (A.onset) {
      let dense = 1 / (1 + Math.max(0, this._rate - 0.4) * 0.9);
      // An accent inside a groove is the one hit that SHOULD pop. The harder
      // the strike, the less the compression is allowed to take from it.
      dense += (1 - dense) * A.strength * 0.6;
      const w = (0.6 + A.strength * 1.0) * dense;   // 0.6 .. 1.6 when sparse
      bus.onset = Math.min(1, bus.onset + (0.5 + 0.5 * w) * dense);
      bus.strike = w;
      /* An accent sends a ring. The field already launches one on a voice
         attack; a real accent borrows the same path, and only an accent —
         at a lower bar a groove sent eleven rings in ten seconds, three on
         screen at all times and none of them legible. */
      if (A.strength > 0.75) bus.voiceAttack = 1;
    } else {
      bus.strike = 0;
    }
    bus.voiceAttack *= Math.exp(-dt / 0.18);
    bus.onset = follow(bus.onset, 0, 0.02, 0.34, dt);

    bus.chroma.set(A.chroma);
    bus.hue = A.hue;
    bus.tonal = A.tonal;

    /* A stand-in, until a world exists that reads `hue` directly. The galaxy
       already lets a voice choose its colour through `voicePitch`, so the
       instrument borrows that path: where the chroma sits on the circle
       becomes where the palette leans, and how tonal the sound is becomes how
       much it leans. It also gives the disc the voice's gentle outward push,
       which is acceptable in a test rig and wrong for the piece — this line
       goes when creative-space has its own palette. */
    bus.voicePitch = A.hue;
    bus.voice = follow(bus.voice, Math.min(1, A.tonal * 0.7) * Math.min(1, bus.energy * 1.6), 0.15, 1.2, dt);
    bus.voiced = A.tonal;
    if (A.note >= 0) {
      bus.note = 1;
      bus.noteClass = A.note;
    } else {
      bus.note *= Math.exp(-dt / 0.25);
    }

    /* --- what is about to happen, when that can be known --------------- */
    const soon = A.nextIn < 1.0 && A.tempoConf > 0.3 ? (1 - A.nextIn) * A.tempoConf : 0;
    bus.anticipation = follow(bus.anticipation, soon, 0.55, 0.9, dt);
    bus.tempoConf = A.tempoConf;
    if (A.tempoConf > 0.3 && A.ioi > 0) bus.tempo = 60 / A.ioi;

    /* --- breath ---------------------------------------------------------
       The accompaniment's when there is one, because that breath is audible
       and the picture must not breathe against it. Otherwise free-running. */
    if (e?.running) {
      bus.breath = e._breathValue();
      bus.pulse = e.pulseValue || 0;
      bus.phase = e.breathPhase;
    } else {
      this.breathPhase = (this.breathPhase + dt / BREATH_PERIOD) % 1;
      bus.breath = this._breathValue();
      bus.pulse = 0;
      bus.phase = this.breathPhase;
    }
    bus.breathVel = (bus.breath - this.prevBreath) / Math.max(dt, 1e-4);
    this.prevBreath = bus.breath;
  }

  dispose() {
    this.source?.close();
  }
}
