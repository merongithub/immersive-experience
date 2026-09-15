/**
 * Source — where the sound the ear listens to comes from.
 *
 * Three kinds, one AnalyserNode:
 *
 *   mic     the room. A handpan, a bowl, a voice, whatever is there.
 *   file    a recording, dropped on the page or fetched by URL. This is the
 *           development workhorse: a real handpan recording at the desk, ten
 *           times over, is how the thresholds get set — not by guessing at a
 *           synth.
 *   engine  the built-in instrument, tapped after its compressor. A regression
 *           test for the ear: drive the visuals from the ANALYSIS of the
 *           Engine and they should move nearly the way they do from its score.
 *
 * Everything downstream reads `analyser` and nothing else, so LiveDriver does
 * not know or care which of the three is open. That is the same boundary the
 * Bus draws one layer up, and it is drawn here for the same reason.
 *
 * The context is shared with the Engine when there is one, so an accompaniment
 * and the mic hearing it sit on one clock and the reference spectrum used to
 * subtract it is measured at the same sample rate.
 */

const FFT = 2048;

export class Source {
  /** @param {BaseAudioContext=} ctx  omit to create one on open() */
  constructor(ctx = null) {
    this.ctx = ctx;
    this.kind = null;
    this.ready = false;
    this.analyser = null;
    this.stream = null;
    this._nodes = [];
    this.label = "";
    this.duration = 0;   // file only
  }

  _ensureContext() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error("Web Audio is not available in this browser.");
    this.ctx = new AC({ latencyHint: "interactive" });
    return this.ctx;
  }

  _analyser() {
    const a = this.ctx.createAnalyser();
    a.fftSize = FFT;
    /* Low. The Engine's analyser smooths at 0.72 because it is read for
       bands, and bands want to be slow. This one is read for onsets, and an
       onset smeared over five frames is not an onset. The asymmetric followers
       downstream do the shaping, as they do everywhere else in the piece. */
    a.smoothingTimeConstant = 0.3;
    a.minDecibels = -100;
    a.maxDecibels = -10;
    this.analyser = a;
    this.db = new Float32Array(a.frequencyBinCount);
    this.freq = new Uint8Array(a.frequencyBinCount);
    this.wave = new Uint8Array(a.fftSize);
    return a;
  }

  /**
   * @param {"mic"|"file"|"engine"} kind
   * @param {object=} opts  {engine} for engine; {file} or {url} for file
   */
  async open(kind, opts = {}) {
    this.close();
    const ctx = this._ensureContext();
    await ctx.resume();
    const a = this._analyser();

    if (kind === "mic") {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // On: we may be playing an accompaniment out of the speakers, and
          // the browser's canceller knows what the device is outputting.
          echoCancellation: true,
          // Off: suppression eats the ring of a bowl as readily as it eats
          // fan noise, and AGC would fight the flux threshold every phrase.
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const src = ctx.createMediaStreamSource(this.stream);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 60;   // handling noise, desk thumps, room rumble
      src.connect(hp);
      hp.connect(a);
      this._nodes.push(src, hp);
      this.label = "mic";

    } else if (kind === "engine") {
      const e = opts.engine;
      if (!e?.comp) throw new Error("Start the sound first, then listen to it.");
      // A tap, not a reroute: the Engine still reaches the speakers itself.
      e.comp.connect(a);
      this._tapped = e.comp;
      this.label = "built-in";

    } else if (kind === "file") {
      let ab;
      if (opts.file) ab = await opts.file.arrayBuffer();
      else if (opts.url) {
        const r = await fetch(opts.url);
        if (!r.ok) throw new Error(`could not fetch ${opts.url}`);
        ab = await r.arrayBuffer();
      } else throw new Error("no recording given");
      const buf = await ctx.decodeAudioData(ab);
      this.duration = buf.duration;

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      this.gain = ctx.createGain();
      this.gain.gain.value = 0.8;
      src.connect(this.gain);
      this.gain.connect(a);
      this.gain.connect(ctx.destination);   // you have to be able to hear it
      src.start();
      this._nodes.push(src, this.gain);
      this.label = opts.file?.name || opts.url?.split("/").pop() || "recording";

    } else {
      throw new Error(`unknown source "${kind}"`);
    }

    this.kind = kind;
    this.ready = true;
    return this;
  }

  /** File playback level. The mic and the engine tap have no level of their own. */
  setVolume(v) {
    if (this.gain) this.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.2);
  }

  close() {
    this.ready = false;
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.stream = null;
    for (const n of this._nodes) {
      try { n.stop?.(); } catch { /* not a source */ }
      try { n.disconnect(); } catch { /* already gone */ }
    }
    this._nodes = [];
    if (this._tapped && this.analyser) {
      try { this._tapped.disconnect(this.analyser); } catch { /* already gone */ }
      this._tapped = null;
    }
    this.gain = null;
    this.kind = null;
  }
}
