/**
 * Analysis — the ear.
 *
 * Everything the Engine handed the visuals for free, it knew because it had
 * written the score. A handpan in the room has no score. This module recovers
 * as much of it as a spectrum can give, and is honest about the rest:
 *
 *   ONSET      spectral flux — how much of the spectrum just got LOUDER. A
 *              level-rise detector (what Mic.js uses for a voice) misses a
 *              second strike inside the ring of the first, because the level
 *              barely moves; the spectrum does.
 *   NOTE       which pitch class a strike was. Taken from what CHANGED in the
 *              chroma at the onset rather than from what is loudest, so a new
 *              D over three ringing bowls still reads as a D.
 *   CHROMA     energy folded into twelve pitch classes. Polyphonic by
 *              construction — a chord is twelve numbers, not one pitch — and
 *              it is what lets a note choose a colour.
 *   TEMPO      inter-onset intervals, and when they agree, a prediction of the
 *              next hit. That prediction is the only route back to
 *              `anticipation`, the one signal a file can never supply, and it
 *              exists only for rhythmic playing. A bowl bath gets none, and
 *              the visuals lean on long release instead.
 *
 * Pure: takes a spectrum in, keeps its own state, touches no audio nodes. That
 * is what makes it testable from node with a synthetic spectrum, which is the
 * only way to know a threshold is right before a handpan is in front of it.
 */

import { follow } from "../audio/Bus.js";

/* Below this a bin is treated as silent. Close to the analyser's own minimum,
   and deliberately NOT a noise gate: an AnalyserNode's dB scale sits some 25
   below dBFS, and a floor set where a laptop's room noise would be (-78) put a
   handpan's mallet click at -85 out of sight entirely — so re-strikes were
   only ever seen by their six-decibel tonal rise. Noise flicker is the
   adaptive knee's job now, not the floor's. */
const FLOOR_DB = -96;

/* The loudest bin must clear this for anything to be called an onset at all.
   On the analyser's scale a played note peaks around -35; a quiet room's
   noise sits below -75. */
const LOUD_DB = -70;

/* Dynamic range. A bin only counts — for flux or for chroma — if its level is
   within this many dB of the loudest thing heard recently. This is what
   separates a strike from texture: a handpan's mallet click lands 20-35 dB
   under its tone, well inside; the Engine's granular layer, the hiss of a
   room, a reverb tail all sit 50 dB and more below the music and are not
   events however sharply they arrive. The reference decays slowly, so soft
   playing after loud playing is heard again within a few seconds rather than
   being held to the standard of the last fortissimo. */
const DYN_DB = 45;
const PEAK_DECAY = 6;    // dB per second the reference falls in silence

/* Where onsets are looked for. Below 60 Hz is handling noise and room rumble;
   above 8 kHz a handpan has nothing but the mallet click, which the mid band
   already carries. */
const FLUX_LO = 60, FLUX_HI = 8000;

/* Where chroma is gathered. Down to A1 for the low bowls, up to where the
   partials of a handpan's top notes have stopped being pitched. */
const CHROMA_LO = 52, CHROMA_HI = 4400;

/* Seconds the flux looks back over. An AnalyserNode's window is 43 ms and the
   spectrum of an attack climbs across it, so a frame-to-frame difference sees
   a fraction of the strike at a time and each fraction can hide under the
   threshold. Against the spectrum from ~50 ms ago the whole rise lands in one
   number.

   In SECONDS, not frames. The first version counted three frames, which is
   50 ms on a 60 Hz display and 25 ms on the 120 Hz one this was first watched
   on — where every re-strike came out a quarter as loud and the ear was
   quietly half deaf. Nothing here may depend on the refresh rate. */
const LAG_SEC = 0.05;
const RING = 12;         // spectra kept; enough for LAG_SEC at 120 Hz with margin

/* How much a bin must rise before it counts, and it is PER BIN and adaptive.
   The breath layer, a reverb tail, a room's air conditioning — any stationary
   noise makes its bins wobble by about five decibels a frame, and a MEAN rise
   over three hundred bins is mostly that wobble. A singing bowl is ten bins
   climbing twenty-five. So each bin's knee follows its own recent wobble: high
   where a bin has been restless, near the floor where it has been quiet or
   steady. Above the knee the excess is SQUARED, so a few bins rising far
   outscore many bins rising a little.

   A single fixed knee was tried first and it cost the handpan its re-strikes:
   a note struck again while it is still ringing lifts its own partials by six
   decibels, and the mallet click that carries such a hit lands in bins that
   were silent — which a fixed knee treated exactly like noise. */
const KNEE_MIN = 2.5;    // dB, a bin that has been perfectly quiet
const KNEE_MAX = 12;     // dB, a bin in heavy noise
const KNEE_GAIN = 2.4;   // knee = KNEE_MIN + wobble * KNEE_GAIN, clamped
const WOBBLE_TAU = 1.5;  // seconds; the wobble tracker outlives any strike

/* Two strikes closer than this are one strike. A fast handpan roll runs at
   maybe 12 hits a second; 60 ms leaves room for that and rejects the two-frame
   double fire a single attack produces as it sweeps up through the bins. */
const REFRACTORY = 0.06;

/* Seconds of flux history the adaptive threshold looks back over. Long enough
   to hold a whole ringing bowl as "the new normal", short enough to reset
   between phrases. */
const HIST_SEC = 1.2;

/* Seconds after an onset before its pitch is trusted. The first instant of a
   strike is the mallet — broadband — and the note settles some 30 ms later.
   Reading it too early names the wrong class about a third of the time. */
const NOTE_SETTLE = 0.035;

/* A pulse is only predicted when the last few intervals agree this closely
   (coefficient of variation). Handpan grooves sit well inside it; free-time
   bowl playing sits well outside, which is the intended outcome. */
/* An onset must reach this fraction of the recent onsets' flux. Absolute
   thresholds cannot tell a faint second event from a strong first one — a
   flicker of flux 2 three hundred milliseconds after a strike of 300 is hand
   noise, a sympathetic ring, or the tail of the attack, and at 1% of what just
   happened it is not a strike. Re-strikes of a ringing note land at 5-30% and
   pass. The reference decays over a couple of seconds so that soft playing
   after a fortissimo is heard again. */
const REL_FLOOR = 0.02;
const REL_TAU = 1.8;

const TEMPO_CV = 0.18;
const IOI_MIN = 0.15, IOI_MAX = 2.6;

const TWO_PI = Math.PI * 2;

export class Analysis {
  /**
   * @param {number} sampleRate
   * @param {number} binCount  analyser.frequencyBinCount
   */
  constructor(sampleRate, binCount) {
    this.sr = sampleRate;
    this.n = binCount;
    this.binHz = (sampleRate / 2) / binCount;

    /* 0..1. Higher fires on smaller rises. Exposed rather than fixed because
       the right value for a handpan in a kitchen is not the right value for a
       gong in a hall, and pretending one constant serves both is how an
       "ear" ends up either deaf or jumpy. */
    this.sensitivity = 0.5;

    this.mag = new Float32Array(binCount);        // linear, after subtraction
    this.log = new Float32Array(binCount);        // dB, floored
    this._logs = Array.from({ length: RING }, () => new Float32Array(binCount).fill(FLOOR_DB));
    this._logT = new Float64Array(RING).fill(-1e9);   // when each slot was written
    this._logI = 0;                                    // next slot to write
    this._wobble = new Float32Array(binCount);   // per-bin |frame-to-frame| dB
    this.peakRef = FLOOR_DB;     // the recent loudest bin, slowly decaying

    this.fluxLo = Math.max(1, Math.round(FLUX_LO / this.binHz));
    this.fluxHi = Math.min(binCount - 1, Math.round(FLUX_HI / this.binHz));
    /* A tilt toward the top. A note re-struck while it is still ringing barely
       moves its own partials — six decibels, against thirty for a fresh one —
       but the mallet contact is broadband and brief and lives up here, on
       every strike alike. Weighting the highs is how the second hit on the
       same note still counts. */
    this.fluxW = new Float32Array(binCount);
    let wsum = 0;
    for (let i = this.fluxLo; i <= this.fluxHi; i++) {
      this.fluxW[i] = 1 + (i * this.binHz) / 3000;
      wsum += this.fluxW[i];
    }
    this._fluxNorm = 1 / wsum;
    this.chromaLo = Math.max(1, Math.round(CHROMA_LO / this.binHz));
    this.chromaHi = Math.min(binCount - 2, Math.round(CHROMA_HI / this.binHz));

    /* --- onset --- */
    this.flux = 0;
    this.threshold = 0;
    this.onset = false;          // true on the frame a strike is detected
    this.strength = 0;           // 0..1 how far over the threshold it was
    this._since = 9;             // seconds since the last onset
    /* Re-armed only once the flux has fallen back under the threshold. The
       refractory alone is not enough: with a lagged flux an attack stays
       "rising" for four or five frames, and the frame after the refractory
       expired was firing a second, smaller onset off the tail of the first —
       which then poisoned the tempo estimate with 60 ms intervals. */
    this._armed = true;
    this._recentFlux = 0;        // decaying peak of onset flux; the relative floor
    this._hist = new Float32Array(Math.ceil(HIST_SEC * 90));
    this._sorted = new Float32Array(this._hist.length);
    this._histN = 0;
    this._histI = 0;
    this.loud = false;           // is there anything here at all

    /* --- chroma / note --- */
    this.chromaRaw = new Float32Array(12);   // this frame, AGC-normalised
    this.chroma = new Float32Array(12);      // smoothed, published
    this._chromaSlow = new Float32Array(12); // what the note is compared to
    this._agc = 1e-3;
    this.hue = 0;
    this._hx = 0; this._hy = 0;
    this.tonal = 0;
    this.note = -1;              // set on the frame a note is named, else -1
    this.noteStrength = 0;
    this._pending = -1;          // seconds until the pending onset is named; <0 none

    /* --- tempo --- */
    this._onsets = [];           // recent onset times
    this.ioi = 0;                // median inter-onset interval, seconds
    this.tempoConf = 0;
    this.nextIn = Infinity;      // seconds to the predicted next strike
    this._predicted = -1;

    this.t = 0;
    this.energy = 0;             // mean linear magnitude, for the AGC and beating
  }

  /**
   * @param {number} dt
   * @param {Float32Array} db   analyser.getFloatFrequencyData output
   * @param {Float32Array=} ref linear reference spectrum to subtract (what we
   *   are playing out of the speakers ourselves), or null
   * @param {number=} k         how much of `ref` the mic is hearing
   * @param {boolean=} suppress do not fire an onset this frame — the caller
   *   knows something struck that was not the player (the accompaniment's own
   *   bell, from its score). A masked frame still updates every follower.
   */
  update(dt, db, ref = null, k = 0, suppress = false) {
    this.t += dt;
    this._since += dt;
    const n = this.n;
    const mag = this.mag, log = this.log;
    /* The reference spectrum is the newest one at least LAG_SEC old — chosen
       by time, whatever the frame rate. `prev1` is simply the last frame. */
    const newest = (this._logI + RING - 1) % RING;
    const prev1 = this._logs[newest];
    let slot = newest;
    for (let k = 1; k < RING; k++) {
      const j = (newest + RING - k) % RING;
      slot = j;
      if (this.t - this._logT[j] >= LAG_SEC || this._logT[j] < -1e8) break;
    }
    const prev = this._logs[slot];
    const wob = this._wobble;
    const wk = 1 - Math.exp(-dt / WOBBLE_TAU);

    /* --- magnitude, with the accompaniment removed --------------------- */
    let peak = FLOOR_DB, sum = 0;
    for (let i = 0; i < n; i++) {
      let m = Math.pow(10, db[i] / 20);
      if (ref) m = Math.max(0, m - ref[i] * k);
      mag[i] = m;
      sum += m;
      const l = m > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(m)) : FLOOR_DB;
      log[i] = l;
      if (l > peak) peak = l;
    }
    this.energy = sum / n;
    this.loud = peak > LOUD_DB;

    // Rises at once, falls at PEAK_DECAY. The gate below is measured from it.
    this.peakRef = Math.max(peak, this.peakRef - PEAK_DECAY * dt);
    const gate = this.peakRef - DYN_DB;

    /* --- flux ------------------------------------------------------------
       Half-wave rectified: only rises count. A decay is not an event. */
    let flux = 0;
    for (let i = this.fluxLo; i <= this.fluxHi; i++) {
      // Track this bin's restlessness from the last frame alone, so the
      // measure is of texture, not of the strike being judged.
      wob[i] += (Math.abs(log[i] - prev1[i]) - wob[i]) * wk;
      if (log[i] < gate) continue;              // texture, not an event
      const knee = Math.min(KNEE_MAX, KNEE_MIN + wob[i] * KNEE_GAIN);
      const d = log[i] - prev[i] - knee;
      if (d > 0) flux += d * d * this.fluxW[i];
    }
    flux *= this._fluxNorm;                   // weighted mean squared excess
    this._logs[this._logI].set(log);          // record this frame
    this._logT[this._logI] = this.t;
    this._logI = (this._logI + 1) % RING;
    this.flux = flux;

    // Adaptive threshold: a margin over the recent median. Median rather than
    // mean so the onsets themselves do not raise the bar for the next one.
    this._hist[this._histI] = flux;
    this._histI = (this._histI + 1) % this._hist.length;
    if (this._histN < this._hist.length) this._histN++;
    this._sorted.set(this._hist.subarray(0, this._histN));
    const sorted = this._sorted.subarray(0, this._histN).sort();
    const median = sorted[this._histN >> 1] || 0;
    /* In the flux's own units (weighted mean squared excess), measured against
       a real AnalyserNode rather than a model of one: the noise floor's own
       flicker sits near 0.03, a granular shimmer bed at 0.4-1.4, the softest
       real events — a brushed chime, a bowl under a drone, a handpan note
       re-struck while ringing — from about 5, a fresh handpan strike anywhere
       from 50 to 400. The default margin of 3 sits between texture and the
       softest strike; sensitivity moves it either way. */
    const margin = 1.0 + (1 - this.sensitivity) * 4.0;
    this._recentFlux *= Math.exp(-dt / REL_TAU);
    this.threshold = Math.max(median * 2.5 + margin, this._recentFlux * REL_FLOOR);

    this.onset = false;
    this.strength = 0;
    if (!this._armed && flux < this.threshold * 0.6) this._armed = true;
    if (flux > this.threshold && this.loud && this._armed
        && this._since >= REFRACTORY && !suppress) {
      this.onset = true;
      this._armed = false;
      this._since = 0;
      this._recentFlux = Math.max(this._recentFlux, flux);
      /* Logarithmic, over the measured range: a soft bowl over a bed scores
         around 5, a handpan re-strike tens, a fresh fortissimo three hundred.
         A linear scale saturates at the first firm hit and every strike after
         it is "the loudest kind". */
      this.strength = Math.min(1, Math.log10(Math.max(1, flux / this.threshold)) / 2.8);
      this._pending = NOTE_SETTLE;
      this._onOnset();
    }

    /* --- chroma ----------------------------------------------------------
       From spectral PEAKS, not from bins. At 2048 points a bin is 23 Hz wide
       and a semitone at D4 is 17 Hz, so the D of a handpan lands between a
       bin that says C# and one that says D# — and the note is named wrong by
       a semitone, reliably, in exactly the octave the instrument lives in.
       A parabola through the three bins around a local maximum places the
       peak to within a hertz or two, which is far inside a semitone anywhere
       above the lowest bowls. */
    const raw = this.chromaRaw;
    raw.fill(0);
    let total = 0;
    const lo = this.chromaLo, hi = this.chromaHi;
    for (let i = lo; i <= hi; i++) {
      const b = log[i];
      if (b < gate || b <= FLOOR_DB + 10) continue;   // same range as the flux
      const a = log[i - 1], c = log[i + 1];
      if (b <= a || b < c) continue;                 // not a peak
      const den = a - 2 * b + c;
      const off = den !== 0 ? 0.5 * (a - c) / den : 0;
      const f = (i + (Math.abs(off) < 1 ? off : 0)) * this.binHz;
      const midi = 69 + 12 * Math.log2(f / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      // Upper partials are mostly fifths and thirds of the fundamental and
      // would smear the class; tilt the weight toward the low end.
      const w = mag[i] / (1 + f / 1500);
      raw[pc] += w;
      total += w;
    }
    // Slow automatic gain, so a quiet passage still fills the range and a
    // loud one does not pin everything at 1. Fast up, slow down.
    this._agc = follow(this._agc, Math.max(total, 1e-6), 0.02, 6.0, dt);
    let mx = 0;
    for (let c = 0; c < 12; c++) {
      raw[c] /= this._agc + 1e-6;
      if (raw[c] > mx) mx = raw[c];
    }

    /* --- the note -------------------------------------------------------
       Named NOTE_SETTLE frames after the onset, from what rose against the
       slow chroma. Compared before the slow follower is updated with this
       frame, or the new note would already be part of the baseline. */
    this.note = -1;
    if (this._pending >= 0) {
      this._pending -= dt;
      if (this._pending < 0) {
        let best = -1, bestD = 0;
        for (let c = 0; c < 12; c++) {
          const d = raw[c] - this._chromaSlow[c];
          if (d > bestD) { bestD = d; best = c; }
        }
        // A rise smaller than this is a mallet click or a breath of noise,
        // not a pitch. Better to say nothing than to colour it wrong.
        if (best >= 0 && bestD > 0.06) {
          this.note = best;
          this.noteStrength = Math.min(1, bestD * 2.5);
        }
      }
    }

    for (let c = 0; c < 12; c++) {
      this._chromaSlow[c] = follow(this._chromaSlow[c], raw[c], 0.35, 0.35, dt);
      this.chroma[c] = follow(this.chroma[c], raw[c], 0.04, 0.55, dt);
    }

    // Hue as a circular mean, smoothed on the vector rather than the angle so
    // a chord straddling C does not spin the colour the long way round.
    let hx = 0, hy = 0, cs = 0;
    for (let c = 0; c < 12; c++) {
      const v = this.chroma[c];
      hx += v * Math.cos((c / 12) * TWO_PI);
      hy += v * Math.sin((c / 12) * TWO_PI);
      cs += v;
    }
    this._hx = follow(this._hx, hx, 0.08, 0.8, dt);
    this._hy = follow(this._hy, hy, 0.08, 0.8, dt);
    const ang = Math.atan2(this._hy, this._hx) / TWO_PI;
    this.hue = ang < 0 ? ang + 1 : ang;

    // Peakedness: one clear class against a flat wash. A single bowl sits
    // near 1; a crash of a hand on the pan's shell sits near 0.
    const mean = cs / 12;
    const tonalRaw = mean > 1e-4 ? Math.min(1, (mx / mean - 1) / 7) : 0;
    this.tonal = follow(this.tonal, tonalRaw, 0.1, 0.6, dt);

    this._tempo(dt);
  }

  _onOnset() {
    const o = this._onsets;
    o.push(this.t);
    if (o.length > 6) o.shift();
  }

  /* Predict the next strike from the recent intervals, and only when they
     agree. The moment they stop agreeing — a fill, a pause, a new figure —
     confidence drains and the prediction with it, because an anticipation
     that lifts for a hit that never comes is worse than none. */
  _tempo(dt) {
    const o = this._onsets;
    let target = 0;
    if (o.length >= 4) {
      const iois = [];
      // Intervals under IOI_MIN are one strike heard twice, not a rhythm.
      for (let i = 1; i < o.length; i++) {
        const d = o[i] - o[i - 1];
        if (d >= IOI_MIN) iois.push(d);
      }
      if (iois.length < 3) { this.tempoConf = follow(this.tempoConf, 0, 0.3, 0.9, dt); this.nextIn = Infinity; return; }
      const last = iois.slice(-4).sort((a, b) => a - b);
      const med = last[last.length >> 1];
      if (med >= IOI_MIN && med <= IOI_MAX) {
        let v = 0;
        for (const x of last) v += (x - med) * (x - med);
        const cv = Math.sqrt(v / last.length) / med;
        target = Math.max(0, 1 - cv / TEMPO_CV);
        if (target > 0) {
          this.ioi = med;
          this._predicted = o[o.length - 1] + med;
        }
      }
    }
    // A prediction that has come and gone unfulfilled is wrong; let it go.
    if (this._predicted > 0 && this.t > this._predicted + this.ioi * 0.35) target = 0;
    this.tempoConf = follow(this.tempoConf, target, 0.3, 0.9, dt);
    this.nextIn = this._predicted > this.t ? this._predicted - this.t : Infinity;
  }
}
