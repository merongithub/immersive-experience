/**
 * Engine — the generative ambient instrument.
 *
 * Nothing is loaded. Every sound here is synthesised in the browser, which buys
 * three things: no licensing, no fixed length, and — the reason it is worth the
 * work — the visuals are driven by the SCORE rather than by guesswork from an
 * FFT. Events are scheduled ahead of when they sound, so the organism can
 * inhale before a chord arrives instead of reacting after it.
 *
 * Layers
 *   drone    detuned voices on a mode; a slow modal DRIFT, not a progression
 *   grains   granular texture from a procedural buffer — the air
 *   bells    sparse tuned partials on a stochastic clock — the events
 *   breath   filtered noise swelling at the pacing rate
 *   pulse    a low thump, dance temperament only
 *
 * Scheduling uses a lookahead loop: a timer wakes periodically and schedules
 * everything due within the next LOOKAHEAD seconds against the audio clock.
 * The window is deliberately generous — ambient music does not need tight
 * timing, and a wide window survives timer throttling without gaps.
 */

const LOOKAHEAD = 1.6;   // seconds of music scheduled in advance
const TICK_MS = 300;     // how often the scheduler wakes

/* Modes are chosen for feel, not theory. The mode IS the mood control — a
   musical choice rather than a slider labelled "intensity". */
const SCALES = {
  aeolian:          [0, 2, 3, 5, 7, 8, 10],   // deep, inward
  dorian:           [0, 2, 3, 5, 7, 9, 10],   // wistful, open
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],   // charged
};

const VOICING = {
  focus: {
    scale: "aeolian", root: 33,          // A1
    voices: [0, 0, 4, 7, 11],            // scale-degree indices
    octaves: [0, 12, 12, 24, 24],
    cutoff: [240, 1400], drift: [55, 95],// filter sweep range, drift period range
    bellRate: 0.16, bellOct: [24, 45],
    grainRate: 6, grainGain: 0.26,
    droneGain: 0.42, pulse: false,
  },
  /* Sound bath. Bowls and a gong carry it; the drone drops back to a shruti-box
     bed and the bells step aside entirely. Long decays are the point — a bowl
     that rings for thirty seconds is what separates a bath from ambient music. */
  bath: {
    scale: "dorian", root: 33,
    voices: [0, 4, 0, 4],
    octaves: [0, 0, 12, 12],
    cutoff: [200, 1100], drift: [70, 130],
    bellRate: 0, bellOct: [24, 36],
    grainRate: 3.5, grainGain: 0.20,
    droneGain: 0.30, pulse: false,
    bowlRate: 1 / 14, gongRate: 1 / 95, chimeRate: 1 / 26,
  },
  meditate: {
    scale: "dorian", root: 33,
    voices: [0, 2, 4, 7, 9],
    octaves: [0, 12, 12, 24, 24],
    cutoff: [280, 2000], drift: [34, 70],
    bellRate: 0.30, bellOct: [24, 48],
    grainRate: 11, grainGain: 0.32,
    droneGain: 0.42, pulse: false,
  },
  dance: {
    scale: "phrygianDominant", root: 31, // G1 — a touch darker under the pulse
    voices: [0, 3, 4, 7, 10, 11],
    octaves: [0, 0, 12, 12, 24, 24],
    cutoff: [320, 3200], drift: [16, 30],
    bellRate: 1.10, bellOct: [24, 43],
    grainRate: 20, grainGain: 0.36,
    droneGain: 0.36, pulse: true,
  },
};

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export class Engine {
  constructor(mode = "meditate") {
    this.ctx = null;
    this.modeName = mode;
    this.cfg = VOICING[mode];
    this.running = false;
    this.timer = 0;

    // Breath is owned by the engine, not the driver: the pacing layer is an
    // actual sound, so its phase has to be authoritative for both ear and eye.
    this.breathPhase = 0;
    this.breathPeriod = 11.0;
    this.targetPeriod = 11.0;

    this.nextBell = 0;
    this.nextGrain = 0;
    this.nextPulse = 0;
    this.nextDrift = 0;
    this.nextBowl = 0;
    this.nextGong = 0;
    this.nextChime = 0;

    /** Events already scheduled, ahead of when they sound. The driver reads
        this to give the visuals foreknowledge. */
    this.upcoming = [];
    this.lastBellAt = -99;
  }

  /* --------------------------------------------------------------- start */

  /** Must be called from a user gesture — browsers refuse otherwise. */
  async start() {
    if (this.running) return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error("Web Audio is not available in this browser.");
      this.ctx = new AC({ latencyHint: "playback" });
      this._build();
    }
    await this.ctx.resume();
    this.running = true;

    const t = this.ctx.currentTime;
    this.nextBell = t + 2.0;
    this.nextGrain = t + 0.4;
    this.nextPulse = t + 1.0;
    this.nextDrift = t + 12.0;
    this.nextBowl = t + 3.0;    // first bowl lands early — it is the invitation
    this.nextGong = t + 42.0;   // the gong is an event; it has to be earned
    this.nextChime = t + 20.0;

    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(0.0001, t);
    this.master.gain.exponentialRampToValueAtTime(this.volume, t + 6.0);

    this._startDrone();
    this.timer = setInterval(() => this._schedule(), TICK_MS);
    this._schedule();
  }

  async pause() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    setTimeout(() => { if (!this.running) this.ctx.suspend(); }, 1600);
  }

  /* --------------------------------------------------------------- graph */

  _build() {
    const ctx = this.ctx;
    this.volume = 0.72;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0001;

    // Gentle ceiling. Granular layers stack unpredictably and a stray peak in
    // a meditation app is worse than a little compression.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 26;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.02;
    comp.release.value = 0.5;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.wave = new Uint8Array(this.analyser.fftSize);

    this.master.connect(comp);
    comp.connect(this.analyser);
    comp.connect(ctx.destination);

    // Space. A procedural impulse response — noise under an exponential decay,
    // darkened, so the tail sits behind the drone instead of on top of it.
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._impulse(4.2, 2.6);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.55;
    this.verb.connect(this.wet);
    this.wet.connect(this.master);

    this.dry = ctx.createGain();
    this.dry.gain.value = 0.90;
    this.dry.connect(this.master);

    // Per-layer buses so temperament can rebalance without touching voices.
    this.droneBus = ctx.createGain();
    this.grainBus = ctx.createGain();
    this.bellBus = ctx.createGain();
    this.breathBus = ctx.createGain();
    this.bowlBus = ctx.createGain();
    for (const b of [this.droneBus, this.grainBus, this.bellBus, this.breathBus, this.bowlBus]) {
      b.connect(this.dry);
      b.connect(this.verb);
    }
    this.bowlBus.gain.value = 0.60;
    this.droneBus.gain.value = this.cfg.droneGain;
    this.grainBus.gain.value = this.cfg.grainGain;
    this.bellBus.gain.value = 0.55;
    this.breathBus.gain.value = 0.28;

    this.grainBuffer = this._texture(3.0);
    this.noiseBuffer = this._noise(2.0);
    this._buildBreath();
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const env = Math.pow(1 - i / n, decay);
        // One-pole lowpass on the noise darkens the tail.
        lp += ((Math.random() * 2 - 1) - lp) * 0.22;
        d[i] = lp * env;
      }
    }
    return buf;
  }

  /** Procedural grain source: inharmonic partials under pink-ish noise.
   *
   *  The partial series reaches well into the top octaves on purpose. Grains
   *  are the only wideband layer — the drone is behind a lowpass and the bells
   *  are narrow — so if this buffer is dark, the whole mix is dark, the `air`
   *  band reads zero, and the spark layer in the visuals can never fire. */
  _texture(seconds) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    const parts = [1, 2.01, 3.02, 4.98, 7.03, 10.9, 16.2, 23.7, 34.1];
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / ctx.sampleRate;
        let s = 0;
        for (let k = 0; k < parts.length; k++) {
          // Slow per-partial tremolo keeps the buffer from sounding like a
          // static chord when grains happen to land on the same offset.
          const wob = 0.75 + 0.25 * Math.sin(2 * Math.PI * (0.07 + k * 0.013) * t + k);
          s += Math.sin(2 * Math.PI * 110 * parts[k] * t + c * 0.7) * wob / (k + 2);
        }
        lp += ((Math.random() * 2 - 1) - lp) * 0.42;   // gently tilted, not dark
        d[i] = s * 0.17 + lp * 0.34;
      }
    }
    return buf;
  }

  _noise(seconds) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  /* --------------------------------------------------------------- drone */

  _startDrone() {
    if (this.drone) return;
    const ctx = this.ctx;
    const cfg = this.cfg;
    const scale = SCALES[cfg.scale];

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = cfg.cutoff[0];
    this.filter.Q.value = 1.6;
    this.filter.connect(this.droneBus);

    this.drone = cfg.voices.map((degIdx, i) => {
      const midi = cfg.root + cfg.octaves[i] + scale[degIdx % scale.length];
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.filter);

      // Two oscillators per voice, detuned a few cents. The beating between
      // them is what keeps a sustained drone from sounding synthetic.
      const oscs = [0, 1].map((k) => {
        const o = ctx.createOscillator();
        o.type = i < 2 ? "triangle" : "sawtooth";
        o.frequency.value = mtof(midi);
        o.detune.value = (k === 0 ? -1 : 1) * rnd(3, 9);
        o.connect(g);
        o.start();
        return o;
      });

      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(rnd(0.16, 0.30) * (2.6 / cfg.voices.length), t + rnd(5, 14));

      return { oscs, gain: g, degIdx, octave: cfg.octaves[i], midi };
    });
  }

  /** Modal drift: one upper voice migrates to a neighbouring scale degree over
      tens of seconds. The root holds. This is what gives the piece direction
      without ever committing to a chord progression. */
  _drift(when) {
    const cfg = this.cfg;
    const scale = SCALES[cfg.scale];
    const candidates = this.drone.filter((v) => v.octave > 0);
    if (!candidates.length) return;
    const v = pick(candidates);

    const step = Math.random() < 0.5 ? -1 : 1;
    const nextIdx = Math.max(0, Math.min(scale.length - 1, v.degIdx + step));
    if (nextIdx === v.degIdx) return;

    v.degIdx = nextIdx;
    const midi = cfg.root + v.octave + scale[nextIdx];
    v.midi = midi;
    const glide = rnd(7, 16);
    for (const o of v.oscs) {
      o.frequency.cancelScheduledValues(when);
      o.frequency.setValueAtTime(o.frequency.value, when);
      o.frequency.exponentialRampToValueAtTime(mtof(midi), when + glide);
    }
    // Announced ahead so the visuals can lean into it before it is audible.
    this.upcoming.push({ type: "drift", at: when, weight: 1, glide });
  }

  /* --------------------------------------------------------------- voices */

  _bell(when) {
    const ctx = this.ctx;
    const cfg = this.cfg;
    const scale = SCALES[cfg.scale];
    const deg = pick(scale);
    const oct = Math.round(rnd(cfg.bellOct[0], cfg.bellOct[1]) / 12) * 12;
    const f = mtof(cfg.root + oct + deg);
    const decay = rnd(2.6, 6.5);
    const amp = rnd(0.16, 0.34);

    const pan = ctx.createStereoPanner();
    pan.pan.value = rnd(-0.75, 0.75);
    pan.connect(this.bellBus);

    // Fundamental plus an inharmonic partial: the 2.76 ratio is what makes a
    // sine read as struck metal rather than as a test tone.
    [[1, amp], [2.76, amp * 0.30], [5.4, amp * 0.14], [8.9, amp * 0.07]].forEach(([ratio, a]) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(a, when + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, when + decay / ratio);
      o.connect(g); g.connect(pan);
      o.start(when);
      o.stop(when + decay + 0.2);
    });

    this.upcoming.push({ type: "bell", at: when, weight: amp / 0.26, decay });
  }

  /* ----------------------------------------------------------- sound bath */

  /**
   * Singing bowl. Two details do all the work:
   *
   *   inharmonic partials — a bowl's overtones sit at roughly 1 : 2.7 : 5.2 :
   *   8.4 : 12.3, nothing like a harmonic series. Stack harmonics instead and
   *   you get an organ, not a bowl.
   *
   *   beating — each partial is TWO oscillators a fraction of a hertz apart.
   *   Real bowls are never perfectly circular, so each mode splits into two
   *   close frequencies that drift in and out of phase. That slow pulsing is
   *   the sound people mean when they say a bowl "breathes".
   */
  _bowl(when) {
    const ctx = this.ctx;
    const cfg = this.cfg;
    const scale = SCALES[cfg.scale];
    const f = mtof(cfg.root + pick([12, 24, 24, 36]) + pick(scale));
    const decay = rnd(20, 40);
    const amp = rnd(0.20, 0.32);

    const pan = ctx.createStereoPanner();
    pan.pan.value = rnd(-0.45, 0.45);
    pan.connect(this.bowlBus);

    const RATIOS = [1, 2.72, 5.18, 8.42, 12.28];
    RATIOS.forEach((ratio, k) => {
      const a = amp * Math.pow(0.52, k);
      const d = decay * Math.pow(0.70, k);      // upper partials fade first
      const beat = rnd(0.22, 1.05);             // hertz between the two halves
      for (const sgn of [-1, 1]) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f * ratio + sgn * beat * 0.5;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(a * 0.5, when + 0.015 + k * 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, when + d);
        o.connect(g); g.connect(pan);
        o.start(when);
        o.stop(when + d + 0.3);
      }
    });

    // The mallet. Without a little noise at the contact point the bowl sounds
    // like it faded in rather than like it was struck.
    const strike = ctx.createBufferSource();
    strike.buffer = this.noiseBuffer;
    const sf = ctx.createBiquadFilter();
    sf.type = "bandpass"; sf.frequency.value = f * 4.2; sf.Q.value = 1.4;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, when);
    sg.gain.exponentialRampToValueAtTime(amp * 0.30, when + 0.006);
    sg.gain.exponentialRampToValueAtTime(0.0001, when + 0.28);
    strike.connect(sf); sf.connect(sg); sg.connect(pan);
    strike.start(when, Math.random() * 1.0, 0.4);
    strike.stop(when + 0.45);

    this.upcoming.push({ type: "bowl", at: when, weight: 1.15, decay });
  }

  /**
   * Gong. A dense inharmonic cluster that BLOOMS — it gets louder for a couple
   * of seconds after the strike as energy migrates up through the modes, then
   * decays for the best part of a minute. Giving it a fast attack like a bell
   * is the usual mistake and it kills the whole effect.
   */
  _gong(when) {
    const ctx = this.ctx;
    const cfg = this.cfg;
    const f0 = mtof(cfg.root + 12 + pick(SCALES[cfg.scale]));
    const decay = rnd(30, 52);
    const amp = 0.26;

    const pan = ctx.createStereoPanner();
    pan.pan.value = rnd(-0.3, 0.3);
    pan.connect(this.bowlBus);

    const N = 17;
    for (let k = 0; k < N; k++) {
      const ratio = 1 + Math.pow(k / N, 1.35) * 12.5 + rnd(-0.18, 0.18);
      const o = ctx.createOscillator();
      o.type = "sine";
      // A shallow upward bend: the metal tightens as it rings.
      o.frequency.setValueAtTime(f0 * ratio * 0.988, when);
      o.frequency.linearRampToValueAtTime(f0 * ratio, when + rnd(1.5, 4.5));

      const a = amp * Math.pow(0.83, k) * rnd(0.55, 1.0);
      const d = decay * Math.pow(0.93, k);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(a, when + rnd(0.35, 2.6));  // the bloom
      g.gain.exponentialRampToValueAtTime(0.0001, when + d);
      o.connect(g); g.connect(pan);
      o.start(when);
      o.stop(when + d + 0.4);
    }

    this.upcoming.push({ type: "gong", at: when, weight: 1.6, decay });
  }

  /** Koshi-style chime: bright, short, sparse. The punctuation. */
  _chime(when) {
    const ctx = this.ctx;
    const cfg = this.cfg;
    const scale = SCALES[cfg.scale];
    const pan = ctx.createStereoPanner();
    pan.pan.value = rnd(-0.85, 0.85);
    pan.connect(this.bellBus);

    // Two or three notes in quick succession, like a chime being brushed.
    const n = 2 + ((Math.random() * 2) | 0);
    for (let i = 0; i < n; i++) {
      const t = when + i * rnd(0.10, 0.34);
      const f = mtof(cfg.root + pick([36, 48]) + pick(scale));
      const decay = rnd(1.8, 4.0);
      [[1, 0.13], [2.76, 0.05], [5.4, 0.02]].forEach(([ratio, a]) => {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f * ratio;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(a, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + decay / ratio);
        o.connect(g); g.connect(pan);
        o.start(t); o.stop(t + decay + 0.2);
      });
    }
    this.upcoming.push({ type: "chime", at: when, weight: 0.7 });
  }

  _grain(when) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.grainBuffer;
    // Quantised to semitones so grains stay in key with the drone, and skewed
    // upward — the top of the range is where the shimmer lives.
    src.playbackRate.value = Math.pow(2, Math.round(rnd(-12, 26)) / 12);

    const dur = rnd(0.09, 0.30);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(rnd(0.07, 0.20), when + dur * 0.45);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);

    const pan = ctx.createStereoPanner();
    pan.pan.value = rnd(-0.9, 0.9);

    src.connect(g); g.connect(pan); pan.connect(this.grainBus);
    src.start(when, Math.random() * (this.grainBuffer.duration - dur - 0.01), dur + 0.02);
    src.stop(when + dur + 0.05);
  }

  _pulseHit(when) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(96, when);
    o.frequency.exponentialRampToValueAtTime(42, when + 0.10);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.42, when + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.42);
    o.connect(g); g.connect(this.dry);
    o.start(when); o.stop(when + 0.5);
    this.upcoming.push({ type: "pulse", at: when, weight: 1 });
  }

  /** Pacing layer: filtered noise that swells with the breath. In meditate the
      period decelerates toward ~5.5 breaths/min, and you follow it without
      being told to. */
  _buildBreath() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 520;
    bp.Q.value = 0.9;

    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0.0001;

    src.connect(bp); bp.connect(this.breathGain);
    this.breathGain.connect(this.breathBus);
    src.start();
    this.breathFilter = bp;
  }

  /* ------------------------------------------------------------ scheduler */

  _schedule() {
    if (!this.running) return;
    const ctx = this.ctx;
    const until = ctx.currentTime + LOOKAHEAD;
    const cfg = this.cfg;

    // bellRate 0 means "this temperament has no bells" — guard the divide, or
    // nextBell advances by Infinity and never recovers if the mode changes.
    // Depth thins the event layers. Guarded against zero so a fully-descended
    // session slows the score rather than stalling the scheduler in a loop.
    const rs = Math.max(0.12, this._rateScale ?? 1);

    if (cfg.bellRate > 0) {
      while (this.nextBell < until) {
        this._bell(this.nextBell);
        this.nextBell += rnd(0.45, 2.1) / (cfg.bellRate * rs);
      }
    } else {
      this.nextBell = until;
    }

    if (cfg.bowlRate > 0) {
      while (this.nextBowl < until) {
        this._bowl(this.nextBowl);
        // Bowls thin far less than everything else — they are the anchor of a
        // deep session, not decoration to be stripped out of it.
        this.nextBowl += rnd(0.6, 1.7) / (cfg.bowlRate * (0.55 + 0.45 * rs));
      }
    } else { this.nextBowl = until; }

    if (cfg.gongRate > 0) {
      while (this.nextGong < until) {
        this._gong(this.nextGong);
        this.nextGong += rnd(0.7, 1.5) / cfg.gongRate;
      }
    } else { this.nextGong = until; }

    if (cfg.chimeRate > 0) {
      while (this.nextChime < until) {
        this._chime(this.nextChime);
        this.nextChime += rnd(0.5, 1.9) / (cfg.chimeRate * rs);
      }
    } else { this.nextChime = until; }
    while (this.nextGrain < until) {
      this._grain(this.nextGrain);
      this.nextGrain += rnd(0.5, 1.8) / (cfg.grainRate * rs);
    }
    if (cfg.pulse) {
      while (this.nextPulse < until) {
        this._pulseHit(this.nextPulse);
        this.nextPulse += 60 / 112 * 2;   // half-time: a heartbeat, not a beat
      }
    } else {
      this.nextPulse = until;
    }
    while (this.nextDrift < until) {
      this._drift(this.nextDrift);
      this.nextDrift += rnd(cfg.drift[0], cfg.drift[1]);
    }

    // Filter sweep follows the breath, one cycle ahead.
    const c = cfg.cutoff;
    const now = ctx.currentTime;
    this.filter?.frequency.cancelScheduledValues(now);
    this.filter?.frequency.setTargetAtTime(
      c[0] + (c[1] - c[0]) * (0.25 + 0.75 * this._breathValue()), now, 1.6
    );

    // Drop events that have already sounded.
    this.upcoming = this.upcoming.filter((e) => e.at > now - 0.5);
  }

  _breathValue() {
    const p = this.breathPhase;
    const IN = 0.4;
    return p < IN
      ? 0.5 - 0.5 * Math.cos(Math.PI * (p / IN))
      : 0.5 + 0.5 * Math.cos(Math.PI * ((p - IN) / (1 - IN)));
  }

  /** Called every animation frame by the driver. Audio scheduling does NOT
      happen here — only the continuous parameters. */
  tick(dt) {
    if (!this.running || !this.ctx) return;

    // Deceleration toward the coherence rate, slow enough to be unnoticeable.
    // _deepPeriod is the depth-stretched form of targetPeriod, so a long dwell
    // keeps slowing the pacing after depth itself has topped out.
    const aim = this._deepPeriod || this.targetPeriod;
    this.breathPeriod += (aim - this.breathPeriod) * (1 - Math.exp(-dt / 45));
    this.breathPhase = (this.breathPhase + dt / this.breathPeriod) % 1;

    const b = this._breathValue();
    const now = this.ctx.currentTime;
    this.breathGain.gain.setTargetAtTime(0.0001 + b * 0.20, now, 0.12);
    this.breathFilter.frequency.setTargetAtTime(380 + b * 520, now, 0.3);
  }

  setMode(name) {
    if (!VOICING[name] || name === this.modeName) return;
    this.modeName = name;
    this.cfg = VOICING[name];
    this.targetPeriod =
      name === "dance" ? 5.2 :
      name === "focus" ? 12.0 :
      name === "bath"  ? 13.5 :   // slowest of all — a bath sets the pace
      11.0;

    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.droneBus.gain.setTargetAtTime(this.cfg.droneGain, t, 2.0);
    this.grainBus.gain.setTargetAtTime(this.cfg.grainGain, t, 2.0);

    // Re-voice the drone onto the new mode by gliding, never by restarting.
    const scale = SCALES[this.cfg.scale];
    this.drone?.forEach((v, i) => {
      const degIdx = this.cfg.voices[i % this.cfg.voices.length];
      const octave = this.cfg.octaves[i % this.cfg.octaves.length];
      v.degIdx = degIdx; v.octave = octave;
      const midi = this.cfg.root + octave + scale[degIdx % scale.length];
      v.midi = midi;
      for (const o of v.oscs) {
        o.frequency.cancelScheduledValues(t);
        o.frequency.setValueAtTime(o.frequency.value, t);
        o.frequency.exponentialRampToValueAtTime(mtof(midi), t + rnd(6, 12));
      }
    });
    this.nextBell = Math.min(this.nextBell, t + 1.0);
  }

  /**
   * The music descends with you.
   *
   * Depth does not just dim the picture — it changes what is played. Events
   * thin out and lengthen, the drone darkens, the room grows. This is the
   * difference between a soundtrack that happens to be playing near you and a
   * piece that is responding to the fact that you have settled.
   */
  setDepth(d, dwell = 0) {
    this._depth = d;
    if (!this.ctx || !this.running) return;
    const t = this.ctx.currentTime;

    // Sparser and more spacious. Bowls stay — they are the anchor — but bells
    // and grains step back so silence has room to do its work.
    this._rateScale = 1 - d * 0.55;

    // Darker as you go down, and darker still through a long dwell.
    const c = this.cfg.cutoff;
    const open = 0.25 + 0.75 * this._breathValue();
    const dark = 1 - d * 0.55 - Math.min(0.2, dwell * 0.012);
    this.filter?.frequency.setTargetAtTime(
      Math.max(120, (c[0] + (c[1] - c[0]) * open) * dark), t, 3.0
    );

    // The room gets larger. Wet up, dry down — you end up inside the reverb
    // rather than in front of the source.
    this.wet?.gain.setTargetAtTime(0.55 + d * 0.30, t, 4.0);
    this.dry?.gain.setTargetAtTime(0.90 - d * 0.30, t, 4.0);
    this.breathBus?.gain.setTargetAtTime(0.28 + d * 0.22, t, 4.0);

    // Pacing keeps slowing as the dwell extends — the "goes deeper on its own"
    // part, and the only parameter with somewhere to go after depth tops out.
    const base = MODE_ENV[this.modeName] ? this.targetPeriod : 11;
    this._deepPeriod = base * (1 + d * 0.22 + Math.min(0.35, dwell * 0.02));
  }

  /** A single chime to acknowledge you came back. Never more than one. */
  greet() {
    if (!this.running || !this.ctx) return;
    this._chime(this.ctx.currentTime + 0.12);
  }

  setVolume(v) {
    this.volume = Math.max(0.0001, Math.min(1, v));
    if (this.running) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.3);
    }
  }
}

/* ---------------------------------------------------------------- driver */

/**
 * EngineDriver — publishes the Engine's state onto the Bus.
 *
 * Bands and warmth come from the analyser (so the same path will serve an mp3
 * or a microphone in M3). Onset, anticipation and breath come from the SCORE,
 * because they are known exactly and known early.
 */
export class EngineDriver {
  constructor(engine) {
    this.engine = engine;
    this.prevBreath = 0;
    this._lastFired = 0;
  }

  setMode(name) { this.engine.setMode(name); }

  update(bus, dt) {
    const e = this.engine;
    e.tick(dt);

    // Depth reaches the score, not just the picture. Applied on a slow tick —
    // these are setTargetAtTime ramps measured in seconds, so re-issuing them
    // every frame would be pure waste.
    this._depthTick = (this._depthTick || 0) + dt;
    if (this._depthTick > 0.5) {
      this._depthTick = 0;
      e.setDepth(bus.depth || 0, bus.dwell || 0);
    }
    // A single chime on return. Edge-triggered, so coming back is greeted once
    // rather than for as long as the arrival envelope is decaying.
    if ((bus.arrival || 0) > 0.6 && !this._greeted) { this._greeted = true; e.greet(); }
    if ((bus.arrival || 0) < 0.15) this._greeted = false;

    // Hoisted: both the warmth bias and the energy envelope read from this, and
    // they sit either side of the centroid maths.
    const m = MODE_ENV[e.modeName] || MODE_ENV.meditate;

    if (!e.running || !e.ctx) {
      // Silent but not frozen — the body keeps breathing while paused.
      bus.breath = e._breathValue();
      bus.energy += (0.06 - bus.energy) * (1 - Math.exp(-dt / 3));
      bus.onset += (0 - bus.onset) * (1 - Math.exp(-dt / 0.4));
      bus.anticipation = 0;
      return;
    }

    const A = e.analyser;
    A.getByteFrequencyData(e.freq);
    const f = e.freq;
    const n = f.length;
    const nyquist = e.ctx.sampleRate / 2;
    const binOf = (hz) => Math.max(0, Math.min(n - 1, Math.round((hz / nyquist) * n)));

    const band = (lo, hi) => {
      const a = binOf(lo), b = binOf(hi);
      let s = 0;
      for (let i = a; i <= b; i++) s += f[i];
      return (s / Math.max(1, b - a + 1)) / 255;
    };

    const raw = {
      sub:      band(20, 60),
      bass:     band(60, 180),
      lowMid:   band(180, 500),
      mid:      band(500, 1600),
      presence: band(1600, 5000),
      air:      band(5000, 14000),
    };

    // Bands keep their asymmetric envelopes: the analyser is already smoothed,
    // but smoothing is not the same as shaping, and the shape is the feeling.
    bus.sub      = follow(bus.sub,      raw.sub,      0.5,  1.4, dt);
    bus.bass     = follow(bus.bass,     raw.bass,     0.35, 1.0, dt);
    bus.lowMid   = follow(bus.lowMid,   raw.lowMid,   0.22, 0.7, dt);
    bus.mid      = follow(bus.mid,      raw.mid,      0.15, 0.5, dt);
    bus.presence = follow(bus.presence, raw.presence, 0.06, 0.35, dt);
    bus.air      = follow(bus.air,      raw.air,      0.03, 0.22, dt);

    // Spectral centroid → warmth. Normalised against a musically useful span
    // rather than the full nyquist, which would sit near zero forever.
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { const v = f[i]; num += v * i; den += v; }
    const centroidHz = den > 0 ? (num / den) * (nyquist / n) : 0;
    const bright = Math.max(0, Math.min(1, (centroidHz - 200) / 4800));
    // Temperament sets where the palette RESTS; the centroid only moves it from
    // there. Mapping brightness straight onto warmth pins the field at full
    // ember, and a body that is always hot has no warmth left to express.
    bus.warmth = follow(bus.warmth, m.warmthBias + bright * 0.45, 3.0, 4.5, dt);

    // Energy from RMS, with the long release that makes rest mean something.
    A.getByteTimeDomainData(e.wave);
    let acc = 0;
    for (let i = 0; i < e.wave.length; i++) { const d = (e.wave[i] - 128) / 128; acc += d * d; }
    const rms = Math.sqrt(acc / e.wave.length);
    bus.energy = follow(bus.energy, Math.min(1, 0.10 + rms * 3.4), m.attack, m.release, dt);

    /* --- the payoff -----------------------------------------------------
       Events are already scheduled, so we know both what just happened and
       what is about to. An mp3 can only ever give us the first. */
    const now = e.ctx.currentTime;
    let strike = 0;
    let soonest = Infinity;
    for (const ev of e.upcoming) {
      if (ev.at <= now && ev.at > this._lastFired) strike = Math.max(strike, ev.weight);
      if (ev.at > now) soonest = Math.min(soonest, ev.at - now);
    }
    this._lastFired = now;
    if (strike > 0) bus.onset = Math.min(1, bus.onset + 0.5 + 0.5 * strike);
    bus.onset = follow(bus.onset, 0, 0.02, 0.34, dt);

    // Rises over the second before an event lands, then releases with it.
    bus.anticipation = follow(
      bus.anticipation,
      soonest < 1.0 ? 1 - soonest : 0,
      0.55, 0.9, dt
    );

    bus.breath = e._breathValue();
    bus.breathVel = (bus.breath - this.prevBreath) / Math.max(dt, 1e-4);
    this.prevBreath = bus.breath;

    bus.tempo = 60 / e.breathPeriod * 60;
    bus.phase = e.breathPhase;
  }
}

const MODE_ENV = {
  focus:    { attack: 2.6,  release: 5.5, warmthBias: 0.08 },
  bath:     { attack: 2.2,  release: 6.5, warmthBias: 0.18 },
  meditate: { attack: 1.8,  release: 4.0, warmthBias: 0.22 },
  dance:    { attack: 0.35, release: 0.9, warmthBias: 0.44 },
};

function follow(current, target, attack, release, dt) {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}
