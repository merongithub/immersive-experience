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

    /* --- capture ring -------------------------------------------------- */
    this.ringLen = Math.floor(ctx.sampleRate * CAPTURE_SECONDS);
    this.ring = new Float32Array(this.ringLen);
    this.ringWrite = 0;

    this.enabled = true;
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
    } catch { /* already torn down */ }
    this.level = this.bright = this.voiced = 0;
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

    // Speaking or singing is activity; quiet breathing is not — the threshold
    // sits above breath level on purpose, so someone breathing steadily with
    // their eyes closed keeps descending rather than resetting their session.
    if (this.level > 0.28) this.depth?.poke(this.level);
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
