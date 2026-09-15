/**
 * FilmDriver — publishes a rendered master onto the Bus.
 *
 * The third driver, beside FakeDriver and EngineDriver, and the reason the Bus
 * exists at all: the world does not learn that the sound is now a file. Not one
 * line of Galaxy, Tendrils, Dust, CameraRig or Post changes.
 *
 * What it does that a plain file player cannot: it carries the SCORE. Bands,
 * warmth and energy come from an analyser on the playing buffer, exactly as
 * they do live. But `onset`, `anticipation`, `breath`, `pulse` and `depth` come
 * from the timeline the offline render emitted — so the bloom still lifts a
 * beat BEFORE a bowl lands. An FFT can only ever tell you what already
 * happened; that pre-echo is the piece's whole argument for a generative
 * source, and it would have been lost the moment the audio became a file.
 */

import { MODE_ENV, readSpectrum } from "./Engine.js";
import { unb64 } from "../session/Offline.js";

function follow(current, target, attack, release, dt) {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export class FilmDriver {
  /**
   * @param {AudioContext} ctx
   * @param {AudioBuffer}  buffer  the rendered master
   * @param {object}       score   as emitted by renderFilm()
   */
  constructor(ctx, buffer, score) {
    this.ctx = ctx;
    this.buffer = buffer;
    this.score = score;
    this.playing = false;
    this.startedAt = 0;

    this.trackHz = score.trackHz || 60;
    this.breath = unb64(score.tracks.breath);
    this.pulse = unb64(score.tracks.pulse);
    this.depth = unb64(score.tracks.depth);

    // Sorted once so the playhead can walk it with a cursor instead of
    // scanning thousands of events every frame.
    this.events = [...score.events].sort((a, b) => a.t - b.t);
    this.cursor = 0;

    this.env = MODE_ENV[score.mode] || MODE_ENV.meditate;

    this.gain = ctx.createGain();
    this.gain.gain.value = 1;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.wave = new Uint8Array(this.analyser.fftSize);

    this.gain.connect(this.analyser);
    this.gain.connect(ctx.destination);

    this.prevBreath = 0;
    this._lastAt = 0;
  }

  /** Bus calls this on a mode button. A film's temperament is already baked. */
  setMode() {}

  /** A recording tap, matching Engine.tap() so Capture does not care which
      of the two is currently making sound. */
  tap() {
    const dest = this.ctx.createMediaStreamDestination();
    this.gain.connect(dest);
    return dest;
  }

  start(offset = 0) {
    if (this.playing) return;
    this.src = this.ctx.createBufferSource();
    this.src.buffer = this.buffer;
    this.src.connect(this.gain);
    this.src.start(this.ctx.currentTime, offset);
    this.startedAt = this.ctx.currentTime - offset;
    this.playing = true;
    this.cursor = 0;
    this._lastAt = offset;
  }

  stop() {
    if (!this.playing) return;
    try { this.src.stop(); } catch { /* already ended */ }
    this.playing = false;
  }

  get playhead() {
    return this.playing ? this.ctx.currentTime - this.startedAt : 0;
  }

  get ended() {
    return this.playing && this.playhead >= this.score.duration;
  }

  _track(arr, t) {
    const i = Math.floor(t * this.trackHz);
    if (i < 0) return arr[0] / 255;
    if (i >= arr.length) return arr[arr.length - 1] / 255;
    return arr[i] / 255;
  }

  update(bus, dt) {
    if (!this.playing) {
      // Still breathing while stopped, the way the Engine does when paused.
      bus.energy += (0.06 - bus.energy) * (1 - Math.exp(-dt / 3));
      bus.onset += (0 - bus.onset) * (1 - Math.exp(-dt / 0.4));
      bus.anticipation = 0;
      bus.pulse = 0;
      return;
    }

    const t = this.playhead;

    readSpectrum(bus, dt, this.analyser, this.freq, this.wave,
      this.ctx.sampleRate, this.env);

    /* --- from the score ------------------------------------------------- */

    bus.breath = this._track(this.breath, t);
    bus.pulse = this._track(this.pulse, t);
    bus.depth = this._track(this.depth, t);
    bus.stillness = 1;
    // The playhead is the film's clock here, as it is depth's.
    bus.filmT = t;
    bus.filmLen = this.score.duration;

    bus.breathVel = (bus.breath - this.prevBreath) / Math.max(dt, 1e-4);
    this.prevBreath = bus.breath;

    // Every event that fell due since the last frame, taken once. The cursor
    // only moves forward, so a long frame cannot skip a strike and a short one
    // cannot fire the same strike twice.
    let strike = 0;
    while (this.cursor < this.events.length && this.events[this.cursor].t <= t) {
      strike = Math.max(strike, this.events[this.cursor].w);
      this.cursor++;
    }
    if (strike > 0) bus.onset = Math.min(1, bus.onset + 0.5 + 0.5 * strike);
    bus.onset = follow(bus.onset, 0, 0.02, 0.34, dt);
    // Matches EngineDriver exactly. A rendered film has the same events in the
    // same places, so anything keyed to a particular strike must fire there
    // too — otherwise the piece and the film of the piece are different works.
    bus.strike = strike;

    // The payoff. `cursor` already points at the next event, so knowing what is
    // coming costs one array lookup.
    const next = this.events[this.cursor];
    const soonest = next ? next.t - t : Infinity;
    bus.anticipation = follow(bus.anticipation, soonest < 1.0 ? 1 - soonest : 0,
      0.55, 0.9, dt);

    this._lastAt = t;
  }

  dispose() {
    this.stop();
    try { this.gain.disconnect(); } catch { /* already torn down */ }
  }
}
