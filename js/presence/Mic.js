/**
 * Mic — you, in the piece.
 *
 * One capture, four jobs:
 *
 *   1. HEARD     your voice returns through the reverb and a tuned delay, so
 *                humming sustains and becomes part of the bath
 *   2. RESPONDS  level and brightness feed the Bus, so the galaxy reacts
 *   3. PACES     the slow envelope-of-the-envelope estimates your breathing
 *                rate, and the pacing bed decelerates from YOUR rate toward
 *                the coherence rate instead of imposing one
 *   4. LOOPS     a captured phrase can replace the granular source, so the
 *                texture of the piece becomes your own voice
 *
 * Privacy: nothing is uploaded, stored, or written to disk. The audio exists
 * only as Web Audio nodes and one in-memory ring buffer, and both are torn
 * down on disable(). This is worth stating plainly in the UI too — asking for
 * a microphone during a meditation session deserves an explanation.
 *
 * Feedback: we are playing sound out of speakers and capturing it back. The
 * dry path is kept low and mostly diffuse (reverb rather than direct), and
 * echoCancellation stays on. Headphones remain the honest recommendation.
 */

import { A4 } from "../audio/Engine.js";

const CAPTURE_SECONDS = 8;

/* The singing range, as the ends of the colour ramp. Deliberately wider than
   any one person's range: the mapping should place a low voice low and a high
   voice high, not stretch whatever three notes somebody happens to use across
   the entire palette. */
const PITCH_LO = 75;    // Hz — below a bass's low D
const PITCH_HI = 620;   // Hz — above a soprano's comfortable top

/* Autocorrelation window, after decimating by DECIM. Pitch lives two decades
   below Nyquist, so throwing away three of every four samples costs nothing
   and makes the search four times cheaper in both axes. */
const DECIM = 4;
const ACF_N = 512;      // analysis window

export class Mic {
  constructor(engine, depth) {
    this.engine = engine;
    this.depth = depth;
    this.enabled = false;
    this.stream = null;

    /* published to the Bus */
    this.level = 0;        // 0..1 smoothed loudness
    this.bright = 0;       // 0..1 spectral tilt — sung vowel vs breath noise
    this.breathRate = 0;   // breaths per minute, 0 until confident
    this.voiced = 0;       // 0..1 how tonal the input is right now
    this.pitch = 0;        // 0..1 log-scaled position in your range
    this.pitchHz = 0;      // the raw estimate, 0 when nothing tonal is there
    this.clarity = 0;      // 0..1 how confident the pitch estimate is
    this.attack = 0;       // transient, spikes when a phrase begins

    /* pitch detection state */
    this._prevLevel = 0;
    this._lastAttack = -9;
    this._sincePitch = 0;

    /* breath detection state */
    this._slow = 0;        // heavily smoothed envelope
    this._slower = 0;      // the baseline it is compared against
    this._wasAbove = false;
    this._lastCross = 0;
    this._periods = [];
    this._t = 0;

    /* capture ring */
    this.recording = false;
    this.captured = null;
  }

  /* -------------------------------------------------------------- enable */

  async enable() {
    if (this.enabled) return;
    const ctx = this.engine.ctx;
    if (!ctx) throw new Error("Start the sound first, then add your voice.");

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,   // we are playing audio out; this is not optional
        noiseSuppression: false,  // suppression eats sung tone and breath alike
        autoGainControl: false,   // AGC would fight our own envelope tracking
      },
    });

    const src = ctx.createMediaStreamSource(this.stream);

    // Rumble, handling noise and desk thumps all live below ~85 Hz and would
    // otherwise dominate the envelope that drives breath detection.
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 85;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.3;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.time = new Float32Array(this.analyser.fftSize);

    src.connect(hp);
    hp.connect(this.analyser);

    /* --- the return path: how you are heard --------------------------- */

    // A gate, so room noise between phrases does not sit in the reverb tail.
    this.gate = ctx.createGain();
    this.gate.gain.value = 0.0001;
    hp.connect(this.gate);

    // Mostly diffuse. A loud dry return is both a feedback risk and, more to
    // the point, it sounds like a PA rather than like the room singing back.
    this.voiceDry = ctx.createGain();
    this.voiceDry.gain.value = 0.12;
    this.gate.connect(this.voiceDry);
    this.voiceDry.connect(this.engine.dry);

    this.voiceWet = ctx.createGain();
    this.voiceWet.gain.value = 0.85;
    this.gate.connect(this.voiceWet);
    this.voiceWet.connect(this.engine.verb);

    // A tuned feedback delay. The delay time is set to the period of a scale
    // degree, so repeats reinforce at that pitch and a hummed note blooms into
    // a sustained drone instead of echoing as discrete copies.
    this.delay = ctx.createDelay(1.0);
    this.delay.delayTime.value = 4 / A4;   // A2 in the piece's own tuning
    this.fb = ctx.createGain();
    this.fb.gain.value = 0.80;
    this.damp = ctx.createBiquadFilter();
    this.damp.type = "lowpass";
    this.damp.frequency.value = 2600;   // each pass darkens, so it decays warm

    this.gate.connect(this.delay);
    this.delay.connect(this.damp);
    this.damp.connect(this.fb);
    this.fb.connect(this.delay);        // the loop
    this.damp.connect(this.engine.verb);

    /* --- shimmer -------------------------------------------------------
       An octave up, fed back into itself, so a held note does not merely
       sustain — it climbs. Each pass through the loop is another octave, and
       the lowpass means each octave is darker than the last, so the ascent
       thins into air rather than piling up into a scream. It is the oldest
       trick in ambient music and it is the one that makes an ordinary hum
       sound like something worth making.

       Wet only. A shimmer you can hear dry is an effect; a shimmer that
       arrives entirely through the reverb is the room answering you. */
    this.shim = this._shifter(12, 0.11);

    this.shimIn = ctx.createGain();
    this.shimIn.gain.value = 0.55;
    this.gate.connect(this.shimIn);
    this.shimIn.connect(this.shim.input);

    this.shimDamp = ctx.createBiquadFilter();
    this.shimDamp.type = "lowpass";
    this.shimDamp.frequency.value = 2800;
    this.shim.output.connect(this.shimDamp);

    // The ascent. Below ~0.5 the octaves die before the second one lands;
    // above ~0.6 they outlast the phrase that started them and the piece is
    // still ringing three lines later.
    this.shimFb = ctx.createGain();
    this.shimFb.gain.value = 0.44;
    this.shimDamp.connect(this.shimFb);
    this.shimFb.connect(this.shim.input);

    this.shimOut = ctx.createGain();
    this.shimOut.gain.value = 0.50;
    this.shimDamp.connect(this.shimOut);
    this.shimOut.connect(this.engine.verb);

    /* --- sub -----------------------------------------------------------
       An octave down, lowpassed hard, at a level you feel rather than hear.
       This is the "deep" half of the request: the shimmer gives the voice
       somewhere to rise to, and without a floor underneath it the whole
       return floats and thins. No feedback here — one octave down is a
       foundation, two is a rumble.

       A little dry, unlike everything else in the return path, because a sub
       arriving only through a 4-second reverb tail is a wash rather than a
       floor. Kept very low: it is the one part of the voice return that could
       feed back on speakers. */
    this.sub = this._shifter(-12, 0.16);

    this.subIn = ctx.createGain();
    this.subIn.gain.value = 0.70;
    this.gate.connect(this.subIn);
    this.subIn.connect(this.sub.input);

    this.subDamp = ctx.createBiquadFilter();
    this.subDamp.type = "lowpass";
    this.subDamp.frequency.value = 380;
    this.sub.output.connect(this.subDamp);

    this.subOut = ctx.createGain();
    this.subOut.gain.value = 0.42;
    this.subDamp.connect(this.subOut);
    this.subOut.connect(this.engine.verb);

    this.subDry = ctx.createGain();
    this.subDry.gain.value = 0.06;
    this.subDamp.connect(this.subDry);
    this.subDry.connect(this.engine.dry);

    /* --- capture ring -------------------------------------------------- */
    this.ringLen = Math.floor(ctx.sampleRate * CAPTURE_SECONDS);
    this.ring = new Float32Array(this.ringLen);
    this.ringWrite = 0;

    this.enabled = true;
  }

  /**
   * A pitch shifter, built from two crossfaded delay lines.
   *
   * Web Audio has no shifter node and this project has no build step, so a
   * worklet would mean a second file fetched at runtime for one effect. Two
   * delay lines is the classic alternative and it is entirely adequate here,
   * because everything this feeds goes through a four-second reverb that
   * hides what artefacts remain.
   *
   * The mechanism: reading out of a delay line whose delay time is changing
   * resamples the signal, and the pitch ratio IS the rate of change —
   * d(delay)/dt = 1 - ratio. So a delay that shortens by one second per second
   * plays back an octave up. That can only run until the delay hits zero,
   * hence a sweep of `windowSec` and then a jump back to the start.
   *
   * The jump is the whole problem, and the fix is two lines sweeping half a
   * period apart, each windowed so it is silent exactly where the other one
   * wraps. Hann windows at half-period overlap sum to exactly 1 — not
   * approximately, exactly — which is why the seam is inaudible rather than
   * merely quiet. An equal-power crossfade would ripple by 1.5 dB at the grain
   * rate, and at 8 grains a second that reads as tremolo.
   *
   * @param {number} semitones  positive shifts up, negative down
   * @param {number} windowSec  grain length. Longer is smoother and more
   *   smeared; shorter is tighter and more obviously granular.
   * @returns {{input: GainNode, output: GainNode, sources: AudioBufferSourceNode[]}}
   */
  _shifter(semitones, windowSec = 0.12) {
    const ctx = this.engine.ctx;
    const sr = ctx.sampleRate;
    const ratio = Math.pow(2, semitones / 12);

    // Seconds for the delay to traverse the whole window at this ratio.
    const period = windowSec / Math.abs(1 - ratio);
    const n = Math.max(128, Math.floor(period * sr));

    /* Two control buffers, shared by both branches. They are normalised 0..1
       and scaled on the way to their targets, so the same pair of buffers
       drives both the delay sweep and the crossfade. */
    const ramp = ctx.createBuffer(1, n, sr);
    const win = ctx.createBuffer(1, n, sr);
    const rd = ramp.getChannelData(0);
    const wd = win.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const u = i / n;
      // Shifting UP means the delay must shorten, so the ramp descends.
      rd[i] = ratio > 1 ? 1 - u : u;
      wd[i] = 0.5 * (1 - Math.cos(2 * Math.PI * u));    // Hann
    }

    const input = ctx.createGain();
    const output = ctx.createGain();
    const sources = [];

    for (let b = 0; b < 2; b++) {
      const delay = ctx.createDelay(windowSec + 0.05);
      // Never exactly zero: a delay line at 0 is a special case in more than
      // one implementation, and 4 ms costs nothing.
      delay.delayTime.value = 0.004;

      const depth = ctx.createGain();
      depth.gain.value = windowSec;

      const rs = ctx.createBufferSource();
      rs.buffer = ramp;
      rs.loop = true;
      rs.connect(depth);
      depth.connect(delay.delayTime);

      // Starts at 0 and is driven entirely by the window buffer — a signal
      // connected to an AudioParam adds to its value rather than replacing it.
      const g = ctx.createGain();
      g.gain.value = 0;

      const ws = ctx.createBufferSource();
      ws.buffer = win;
      ws.loop = true;
      ws.connect(g.gain);

      input.connect(delay);
      delay.connect(g);
      g.connect(output);

      // The second branch runs half a period ahead, so its window peaks
      // exactly where the first one's ramp wraps.
      const offset = (b * period) / 2;
      rs.start(0, offset);
      ws.start(0, offset);
      sources.push(rs, ws);
    }

    return { input, output, sources };
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    // Stop the recorder before the tracks, or it fires an error rather than
    // ending cleanly — and the half-captured phrase is discarded either way.
    try { this._rec?.stop(); } catch { /* already stopped */ }
    this._rec = null;
    this._muted = false;
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.stream = null;
    try {
      this.gate.disconnect();
      this.voiceDry.disconnect();
      this.voiceWet.disconnect();
      this.delay.disconnect();
      this.damp.disconnect();
      this.fb.disconnect();

      /* The shifters' modulator sources are the only things in this module
         that keep running on their own. Left alive they would go on sweeping
         four delay lines for the rest of the session, silently, every time
         somebody toggled their voice off and on again. */
      for (const sh of [this.shim, this.sub]) {
        if (!sh) continue;
        for (const src of sh.sources) {
          try { src.stop(); } catch { /* already stopped */ }
          src.disconnect();
        }
        sh.input.disconnect();
        sh.output.disconnect();
      }
      for (const n of [this.shimIn, this.shimDamp, this.shimFb, this.shimOut,
                       this.subIn, this.subDamp, this.subOut, this.subDry]) {
        n?.disconnect();
      }
    } catch { /* already torn down */ }
    this.shim = this.sub = null;
    this.level = this.bright = this.voiced = 0;
    this.pitch = this.pitchHz = this.clarity = this.attack = 0;
    this.ring = null;
  }

  /* --------------------------------------------------------------- tick */

  update(dt, bus) {
    if (!this.enabled) return;
    this._t += dt;

    const A = this.analyser;
    A.getFloatTimeDomainData(this.time);
    A.getByteFrequencyData(this.freq);

    /* --- loudness ---------------------------------------------------- */
    let acc = 0;
    for (let i = 0; i < this.time.length; i++) acc += this.time[i] * this.time[i];
    const rms = Math.sqrt(acc / this.time.length);

    // Perceptual-ish: a linear RMS makes quiet breathing invisible next to
    // speech. The cube root compresses the range into something usable.
    const loud = Math.min(1, Math.pow(rms * 7.5, 0.34));
    this.level += (loud - this.level) * (1 - Math.exp(-dt / (loud > this.level ? 0.05 : 0.35)));

    /* --- voiced vs breathy -------------------------------------------
       A sung vowel has energy concentrated low with clear harmonic peaks; an
       exhale is broadband hiss. The ratio separates them well enough to tell
       "someone is toning" from "someone is breathing", which is all we need. */
    const n = this.freq.length;
    let lo = 0, hi = 0;
    const mid = Math.floor(n * 0.10);
    for (let i = 2; i < mid; i++) lo += this.freq[i];
    for (let i = mid; i < n; i++) hi += this.freq[i];
    lo /= Math.max(1, mid - 2);
    hi /= Math.max(1, n - mid);
    const ratio = lo / Math.max(1, lo + hi);
    this.voiced += (Math.min(1, Math.max(0, (ratio - 0.45) * 3.2)) - this.voiced)
                 * (1 - Math.exp(-dt / 0.25));
    this.bright += (Math.min(1, hi / 90) - this.bright) * (1 - Math.exp(-dt / 0.4));

    /* --- pitch --------------------------------------------------------
       Loudness can only ever push the field outward. Pitch is what lets a
       voice CHOOSE something — sing high and the field cools toward bone,
       sing low and it warms toward ember — and that is the difference between
       being detected and being listened to.

       Run at 20 Hz rather than per frame. Autocorrelation is the one genuinely
       expensive thing this module does, and a colour that settles over a
       tenth of a second is indistinguishable from one that settles instantly.
       Held, not zeroed, when the estimate is poor: taking a breath mid-phrase
       should not lurch the palette back to the middle. */
    this._sincePitch += dt;
    if (this._sincePitch >= 0.05) {
      this._sincePitch = 0;
      const hz = this._detectPitch();
      if (hz > 0) {
        this.pitchHz = hz;
        const p = Math.log2(hz / PITCH_LO) / Math.log2(PITCH_HI / PITCH_LO);
        this.pitch += (Math.max(0, Math.min(1, p)) - this.pitch)
                    * (1 - Math.exp(-dt / 0.12));
      }
    }

    /* --- attack -------------------------------------------------------
       The moment a phrase begins, which `level` cannot give you: by the time
       a smoothed envelope has risen the transient is already several frames
       gone. Taken from the RISE rather than the value, so a note started
       quietly still counts and a note held loudly does not re-trigger. */
    const rise = this.level - this._prevLevel;
    this._prevLevel = this.level;
    if (rise > 0.05 && this.level > 0.2 && this._t - this._lastAttack > 0.35) {
      this.attack = 1;
      this._lastAttack = this._t;
    }
    this.attack *= Math.exp(-dt / 0.18);

    /* --- gate ---------------------------------------------------------
       Opens fast so a phrase is never clipped at the front, closes slowly so
       the tail of a hum is allowed to decay into the reverb rather than being
       cut off mid-breath. */
    // Held shut while a guidance phrase is being captured: hearing yourself
    // bloom through the reverb is lovely when you are toning and impossible to
    // speak over when you are trying to say a sentence.
    const open = !this._muted && this.level > 0.13;
    const target = open ? 0.9 : 0.0001;
    const tau = open ? 0.04 : 0.8;
    this.gate.gain.setTargetAtTime(target, this.engine.ctx.currentTime, tau);

    /* --- tune the delay to the mode ---------------------------------- */
    const f = this._degreeHz();
    if (f > 0) this.delay.delayTime.setTargetAtTime(1 / f, this.engine.ctx.currentTime, 0.6);

    /* --- breath -------------------------------------------------------
       The envelope of the envelope. Breathing shows up at 0.05–0.5 Hz, far
       below anything in the voice itself, so two nested one-poles at very
       different time constants isolate it: `_slow` follows the breath, and
       `_slower` is the baseline it crosses. Counting upward crossings gives
       the period directly. */
    this._slow += (this.level - this._slow) * (1 - Math.exp(-dt / 0.55));
    this._slower += (this._slow - this._slower) * (1 - Math.exp(-dt / 6.0));

    const above = this._slow > this._slower * 1.06;
    if (above && !this._wasAbove) {
      const gap = this._t - this._lastCross;
      // Plausible human range only: 2.5s (24/min) to 20s (3/min). Anything
      // outside it is a cough, a word, or a chair creaking.
      if (gap > 2.5 && gap < 20 && this._lastCross > 0) {
        this._periods.push(gap);
        if (this._periods.length > 6) this._periods.shift();
      }
      this._lastCross = this._t;
    }
    this._wasAbove = above;

    if (this._periods.length >= 3) {
      // Median, not mean: one held note or one cough should not move the
      // estimate that the whole pacing layer is about to follow.
      const s = [...this._periods].sort((a, b) => a - b);
      const median = s[s.length >> 1];
      this.breathRate = 60 / median;

      // Lead, do not impose. The engine eases from the listener's own rate
      // toward the coherence rate over minutes, slow enough to go unnoticed.
      const own = median;
      const target = 11.0;
      this.engine.targetPeriod = own + (target - own) * 0.55;
    }

    /* --- capture ------------------------------------------------------ */
    if (this.recording && this.ring) {
      const fresh = Math.min(this.time.length, Math.floor(dt * this.engine.ctx.sampleRate));
      const start = this.time.length - fresh;
      for (let i = 0; i < fresh; i++) {
        this.ring[this.ringWrite] = this.time[start + i];
        this.ringWrite = (this.ringWrite + 1) % this.ringLen;
      }
    }

    /* --- publish ------------------------------------------------------
       Mic owns `voice` and `voiced` only. It used to also max() into
       presenceAmt, which collided with Presence and depended on update order;
       Depth is now the one place that decides what counts as you being here. */
    bus.voice = this.level;
    bus.voiced = this.voiced;
    bus.voicePitch = this.pitch;
    bus.voiceAttack = this.attack;

    // Speaking or singing is activity; quiet breathing is not — the threshold
    // sits above breath level on purpose, so someone breathing steadily with
    // their eyes closed keeps descending rather than resetting their session.
    if (this.level > 0.28) this.depth?.poke(this.level);
  }

  /**
   * Pitch, by autocorrelation.
   *
   * Not from the FFT the rest of this module uses. At fftSize 4096 the bins
   * are ~12 Hz apart, and a semitone at the bottom of a voice is about 6 —
   * so the spectrum can tell you someone is singing and cannot reliably tell
   * you what. Autocorrelation works in the time domain and resolves far finer
   * than the bin spacing, which is why it is worth the extra pass.
   *
   * @returns {number} Hz, or 0 when nothing tonal is present
   */
  _detectPitch() {
    const src = this.time;
    const sr = this.engine.ctx.sampleRate;
    const rate = sr / DECIM;

    const minLag = Math.max(2, Math.floor(rate / PITCH_HI));
    const maxLag = Math.floor(rate / PITCH_LO);
    const need = ACF_N + maxLag;
    if (need * DECIM > src.length) return 0;

    if (!this._pbuf || this._pbuf.length < need) {
      this._pbuf = new Float32Array(need);
      this._acf = new Float32Array(maxLag + 2);
    }
    const b = this._pbuf;

    /* Decimate by averaging rather than by picking every fourth sample. A box
       filter is a poor anti-alias but it is not NO anti-alias, and hiss
       folding down into the search range is exactly what produces confident
       nonsense at 300 Hz. */
    const start = src.length - need * DECIM;
    for (let i = 0; i < need; i++) {
      const o = start + i * DECIM;
      b[i] = (src[o] + src[o + 1] + src[o + 2] + src[o + 3]) * 0.25;
    }

    let e0 = 0;
    for (let i = 0; i < ACF_N; i++) e0 += b[i] * b[i];
    if (e0 < 1e-6) { this.clarity = 0; return 0; }

    const acf = this._acf;
    let peak = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0, e1 = 0;
      for (let i = 0; i < ACF_N; i++) {
        const v = b[i + lag];
        sum += b[i] * v;
        e1 += v * v;
      }
      // Normalised, so the score is a correlation rather than an energy —
      // otherwise a loud note always beats a quiet one at the wrong lag.
      const v = sum / Math.sqrt(e0 * e1 + 1e-12);
      acf[lag] = v;
      if (v > peak) peak = v;
    }

    if (peak < 0.5) { this.clarity = 0; return 0; }

    /* The FIRST peak within reach of the best one, not the best one itself.
       A periodic signal correlates just as well at twice its period, and
       taking the global maximum is how a pitch tracker reports an octave
       too low — audibly, and on the one signal the user is watching. */
    let best = 0;
    const floor = peak * 0.86;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (acf[lag] >= floor && acf[lag] > acf[lag - 1] && acf[lag] >= acf[lag + 1]) {
        best = lag;
        break;
      }
    }
    if (!best) { this.clarity = 0; return 0; }

    this.clarity = acf[best];

    // Parabolic interpolation across the peak. The lag grid is coarse after
    // decimation — a whole semitone wide up at the top of the range — so
    // without this the pitch would visibly quantise as someone slid a note.
    const a = acf[best - 1], c0 = acf[best], c = acf[best + 1];
    const den = a - 2 * c0 + c;
    const adj = den !== 0 ? (0.5 * (a - c)) / den : 0;
    const lag = best + (Math.abs(adj) < 1 ? adj : 0);

    return rate / lag;
  }

  /** Nearest scale degree to whatever is being sung, as a frequency. */
  _degreeHz() {
    const cfg = this.engine.cfg;
    if (!cfg) return 0;
    // Peak bin of the low half — good enough to pick an octave and a degree,
    // and far cheaper than real pitch detection for what it drives.
    const n = this.freq.length;
    const nyq = this.engine.ctx.sampleRate / 2;
    let best = 0, bestI = 0;
    const top = Math.floor(n * 0.10);
    for (let i = 3; i < top; i++) {
      if (this.freq[i] > best) { best = this.freq[i]; bestI = i; }
    }
    if (best < 60) return 0;
    return (bestI / n) * nyq;
  }

  /* -------------------------------------------------------------- record */

  startRecording() {
    if (!this.enabled) return false;
    this.ring.fill(0);
    this.ringWrite = 0;
    this.recording = true;
    return true;
  }

  /**
   * Stop recording and hand the captured audio to the Engine as its granular
   * source. From here on the texture of the piece is the listener's own voice.
   */
  stopRecording() {
    if (!this.recording) return false;
    this.recording = false;
    const ctx = this.engine.ctx;

    const buf = ctx.createBuffer(2, this.ringLen, ctx.sampleRate);
    // Rotate the ring so the buffer starts where writing began, then window the
    // first and last 150ms. Grains pick random offsets, so an un-windowed seam
    // would eventually be hit and would click.
    const fade = Math.floor(ctx.sampleRate * 0.15);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < this.ringLen; i++) {
        let v = this.ring[(this.ringWrite + i) % this.ringLen];
        if (i < fade) v *= i / fade;
        if (i > this.ringLen - fade) v *= (this.ringLen - i) / fade;
        d[i] = v * 1.6;
      }
    }
    this.captured = buf;
    this.engine.grainBuffer = buf;
    return true;
  }

  clearRecording() {
    this.captured = null;
    this.engine.grainBuffer = this.engine._texture(3.0);
  }

  /* ------------------------------------------------------- spoken phrases
   *
   * Guidance is captured through MediaRecorder rather than through the ring
   * above, and the difference matters. The ring copies whatever the analyser
   * happens to be holding once per animation frame — roughly 800 of its 4096
   * samples at 60fps — so it drops and duplicates a little at every frame
   * boundary. That is inaudible inside a 200ms grain and it is the difference
   * between a sentence and a stutter. MediaRecorder takes the stream itself.
   */

  /** True while a guidance phrase is being captured. */
  get speaking() { return !!this._rec; }

  /** Hold to speak. @returns {boolean} whether capture actually began. */
  startPhrase() {
    if (!this.enabled || this._rec) return false;
    if (typeof MediaRecorder === "undefined") return false;

    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      .find((m) => MediaRecorder.isTypeSupported?.(m));

    this._rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this._chunks = [];
    this._rec.ondataavailable = (e) => { if (e.data.size) this._chunks.push(e.data); };
    this._rec.start();
    this.muteReturn(true);
    return true;
  }

  /** Release. @returns {Promise<AudioBuffer|null>} the phrase, decoded. */
  async stopPhrase() {
    const rec = this._rec;
    if (!rec) return null;
    this._rec = null;

    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.stop();
    await stopped;
    this.muteReturn(false);

    if (!this._chunks.length) return null;
    const blob = new Blob(this._chunks, { type: rec.mimeType });
    this._chunks = [];
    try {
      return await this.engine.ctx.decodeAudioData(await blob.arrayBuffer());
    } catch {
      return null;
    }
  }

  muteReturn(on) {
    this._muted = on;
    if (on && this.gate) {
      this.gate.gain.setTargetAtTime(0.0001, this.engine.ctx.currentTime, 0.05);
    }
  }
}
