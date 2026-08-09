/**
 * Trace — the record of what happened while you sat here.
 *
 * Samples the Bus on a slow cadence and keeps a compact history: how deep you
 * went, how still you were, what colour the piece was, and where the events
 * landed. Everything it needs is already flowing through the Bus, so this costs
 * essentially nothing and stays completely source-agnostic — it works the same
 * whether the sound came from the generative engine, a file, or your voice.
 *
 * Nothing is uploaded. The record lives in memory for the length of the
 * session; the only way it leaves is if you export it yourself.
 */

const SAMPLE_EVERY = 1.5;   // seconds
const MAX_SAMPLES = 4000;   // ~100 minutes; past that we thin rather than grow

export class Trace {
  constructor() {
    this.startedAt = new Date();
    this.elapsed = 0;
    this._acc = 0;
    this._since = 0;

    /** One entry per SAMPLE_EVERY seconds. */
    this.samples = [];
    /** Discrete strikes — bowls, gongs, bells — with their magnitude. */
    this.marks = [];
    /** Which temperaments were used, in order of first use. */
    this.modes = [];

    this.maxDepth = 0;
    this.stillSeconds = 0;
    this.voiceSeconds = 0;
    this._wasOnset = false;

    // Running means for the sample about to be committed, so a 1.5s sample
    // summarises its whole window rather than whatever the last frame held.
    this._sum = { depth: 0, energy: 0, warmth: 0, breath: 0, voice: 0, still: 0, n: 0 };
  }

  update(dt, bus, mode) {
    this.elapsed += dt;

    if (mode && this.modes[this.modes.length - 1] !== mode) this.modes.push(mode);

    this.maxDepth = Math.max(this.maxDepth, bus.depth || 0);
    if ((bus.stillness || 0) > 0.7) this.stillSeconds += dt;
    if ((bus.voice || 0) > 0.15) this.voiceSeconds += dt;

    // Onset is a spike with a fast attack, so an edge test catches each strike
    // once instead of logging every frame of its decay.
    const on = (bus.onset || 0) > 0.45;
    if (on && !this._wasOnset) {
      this.marks.push({ t: this.elapsed, mag: Math.min(1, bus.onset) });
      if (this.marks.length > 2000) this.marks.shift();
    }
    this._wasOnset = on;

    const s = this._sum;
    s.depth += bus.depth || 0;
    s.energy += bus.energy || 0;
    s.warmth += bus.warmth || 0;
    s.breath += bus.breath || 0;
    s.voice += bus.voice || 0;
    s.still += bus.stillness || 0;
    s.n++;

    this._since += dt;
    if (this._since < SAMPLE_EVERY) return;
    this._since = 0;

    const n = Math.max(1, s.n);
    this.samples.push({
      t: this.elapsed,
      depth: s.depth / n,
      energy: s.energy / n,
      warmth: s.warmth / n,
      breath: s.breath / n,
      voice: s.voice / n,
      still: s.still / n,
    });
    s.depth = s.energy = s.warmth = s.breath = s.voice = s.still = s.n = 0;

    // Past the cap, drop every other sample and double the effective interval.
    // A four-hour session degrades in resolution rather than in memory.
    if (this.samples.length > MAX_SAMPLES) {
      this.samples = this.samples.filter((_, i) => i % 2 === 0);
    }
  }

  get minutes() { return this.elapsed / 60; }

  /** Human summary for the caption under the sigil. */
  summary() {
    const mm = Math.floor(this.elapsed / 60);
    const ss = Math.floor(this.elapsed % 60);
    return {
      duration: `${mm}:${String(ss).padStart(2, "0")}`,
      minutes: mm,
      depth: Math.round(this.maxDepth * 100),
      stillPct: this.elapsed > 0 ? Math.round((this.stillSeconds / this.elapsed) * 100) : 0,
      voiced: this.voiceSeconds > 3,
      strikes: this.marks.length,
      modes: this.modes,
      date: this.startedAt,
    };
  }

  /* ---------------------------------------------------------------- share
     A permalink has to fit in a URL, so the trace is resampled to a fixed
     number of slots and quantised to a byte per channel. The sigil redrawn
     from this is not pixel-identical to the live one — it is the same session
     at lower resolution, which is the honest thing for a link to carry. */

  encode(slots = 72) {
    if (!this.samples.length) return "";
    const bytes = new Uint8Array(slots * 3 + 4);
    const mins = Math.min(65535, Math.round(this.elapsed));
    bytes[0] = 1;                       // format version
    bytes[1] = mins & 0xff;
    bytes[2] = (mins >> 8) & 0xff;
    bytes[3] = Math.min(255, this.marks.length);

    for (let i = 0; i < slots; i++) {
      const idx = Math.min(this.samples.length - 1,
        Math.floor((i / slots) * this.samples.length));
      const s = this.samples[idx];
      const o = 4 + i * 3;
      bytes[o]     = Math.round(Math.max(0, Math.min(1, s.energy)) * 255);
      bytes[o + 1] = Math.round(Math.max(0, Math.min(1, s.warmth)) * 255);
      bytes[o + 2] = Math.round(Math.max(0, Math.min(1, s.depth)) * 255);
    }

    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  static decode(str) {
    try {
      const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (bytes[0] !== 1) return null;

      const elapsed = bytes[1] | (bytes[2] << 8);
      const markCount = bytes[3];
      const slots = Math.floor((bytes.length - 4) / 3);

      const t = new Trace();
      t.elapsed = elapsed;
      t.samples = [];
      for (let i = 0; i < slots; i++) {
        const o = 4 + i * 3;
        t.samples.push({
          t: (i / slots) * elapsed,
          energy: bytes[o] / 255,
          warmth: bytes[o + 1] / 255,
          depth: bytes[o + 2] / 255,
          // Not carried in the link; reconstructed so the drawing still breathes.
          breath: 0.5 + 0.5 * Math.sin(i * 0.7),
          voice: 0,
          still: bytes[o + 2] / 255,
        });
        t.maxDepth = Math.max(t.maxDepth, bytes[o + 2] / 255);
      }
      // Marks are not stored individually — their count is, so the redrawn
      // sigil carries the same density of strikes without the exact timing.
      for (let i = 0; i < markCount; i++) {
        t.marks.push({ t: ((i + 0.5) / markCount) * elapsed, mag: 0.7 });
      }
      t.restored = true;
      return t;
    } catch {
      return null;
    }
  }
}
