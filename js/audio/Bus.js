/**
 * Bus — the single source of truth for "what is the sound doing right now".
 *
 * Every visual in ANIMA reads from here and nothing else. No renderer module
 * ever touches an AnalyserNode or an oscillator. That boundary is the whole
 * architecture: swap the driver (fake envelope now, generative engine in M2,
 * mp3/mic in M3) and not one line of the world changes.
 *
 * All published signals are smoothed and normalised to 0..1 unless noted.
 *
 * MILESTONE 1 ships only FakeDriver: a hand-authored envelope whose sole job
 * is to let us judge the motion language before any audio exists. If the field
 * is not beautiful driven by this, it will not be beautiful driven by music.
 */

/* ------------------------------------------------------------------ signals

   sub bass lowMid mid presence air   spectral bands
   energy                             slow body swell   (the "is it building")
   onset                              transient spike, fast decay
   breath                             0..1 inhale/exhale phase
   breathVel                          d(breath)/dt, signed — direction matters
   warmth                             0..1 cold/violet ... hot/ember
   tempo phase                        beat estimate
   anticipation                       an event is COMING — only a generative
                                      source can supply this; an mp3 cannot
   presenceAmt                        how much of YOU is in the field (M3)
*/

const SIGNALS = [
  "sub", "bass", "lowMid", "mid", "presence", "air",
  "energy", "onset", "breath", "breathVel", "warmth",
  "tempo", "phase", "anticipation", "presenceAmt",
  "voice",       // your loudness, 0..1
  "voiced",      // how tonal it is — humming vs breathing
  "depth",       // 0..1 how far into the session stillness has taken you
  "stillness",   // 0..1 how still you are right now
  "dwell",       // minutes held at full depth
  "away",        // 0..1 you are not looking at this
  "arrival",     // transient, fires on return
];

/**
 * Asymmetric one-pole follower. THE most important function in the project.
 *
 * A symmetric filter makes everything feel mechanical, because in the physical
 * world nothing decays as fast as it attacks. Slow attack reads as anticipation;
 * long release reads as letting go. The ratio between the two is the difference
 * between sensual and twitchy, so it is a parameter, never a constant.
 */
export function follow(current, target, attack, release, dt) {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Deterministic scalar hash — same shape as the GLSL side, for parity. */
function hash11(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth pseudo-noise in 0..1 at a given rate. Cheap, stable, no allocations. */
function wobble(t, rate, seed) {
  const x = t * rate + seed * 37.7;
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash11(i) * (1 - u) + hash11(i + 1) * u;
}

/* -------------------------------------------------------------- temperament

   One world, three temperaments. Mode does not change what is on screen — it
   changes how eagerly the field responds and where it sits on the palette. */

export const MODES = {
  focus: {
    label: "focus",
    breathPeriod: 12.0,   // seconds; long and unhurried, but not led
    swell: 0.42,          // how far energy travels
    swellRate: 0.055,     // how often phrases arrive
    onsetRate: 0.10,      // events per second
    warmthBias: 0.14,     // cool, inward, violet
    attack: 2.6,
    release: 5.5,
  },
  bath: {
    label: "bath",
    breathPeriod: 13.5,   // slowest of all — a sound bath sets the pace
    swell: 0.50,
    swellRate: 0.045,
    onsetRate: 0.07,      // bowls are rare and enormous
    warmthBias: 0.18,
    attack: 2.2,
    release: 6.5,
  },
  meditate: {
    label: "meditate",
    breathPeriod: 11.0,   // 5.45 breaths/min — near the coherence rate
    swell: 0.55,
    swellRate: 0.075,
    onsetRate: 0.18,
    warmthBias: 0.30,
    attack: 1.8,
    release: 4.0,
  },
  dance: {
    label: "dance",
    breathPeriod: 5.2,
    swell: 0.85,
    swellRate: 0.35,
    onsetRate: 1.30,
    warmthBias: 0.78,     // ember, reaching
    attack: 0.35,
    release: 0.9,
  },
};

/* ------------------------------------------------------------------ the bus */

export class Bus {
  constructor() {
    for (const k of SIGNALS) this[k] = 0;
    this.warmth = 0.4;
    this.breath = 0;
    this.time = 0;
    this.driver = null;
    this.mode = "meditate";
  }

  setDriver(driver) {
    this.driver = driver;
    driver.attach?.(this);
  }

  setMode(name) {
    if (!MODES[name]) return;
    this.mode = name;
    this.driver?.setMode?.(name);
  }

  update(dt) {
    this.time += dt;
    this.driver?.update(this, dt);
  }
}

/* ------------------------------------------------------------- fake driver */

export class FakeDriver {
  constructor(mode = "meditate") {
    this.m = MODES[mode];
    this.t = 0;
    this.breathPhase = 0;
    this.nextOnset = 1.5;
    this.energyRaw = 0;
    this.prevBreath = 0;
  }

  setMode(name) {
    this.m = MODES[name] || this.m;
  }

  update(bus, dt) {
    const m = this.m;
    this.t += dt;

    /* --- breath ---------------------------------------------------------
       Not a sine. Real breath is asymmetric: the inhale takes ~40% of the
       cycle and the exhale ~60%, and the turn at the top is sharper than the
       turn at the bottom. We build it from two raised cosines with different
       widths so the shape itself carries the feeling. */
    this.breathPhase = (this.breathPhase + dt / m.breathPeriod) % 1;
    const p = this.breathPhase;
    const IN = 0.4;
    const breath = p < IN
      ? 0.5 - 0.5 * Math.cos(Math.PI * (p / IN))              // rise
      : 0.5 + 0.5 * Math.cos(Math.PI * ((p - IN) / (1 - IN))); // longer fall

    bus.breathVel = (breath - this.prevBreath) / Math.max(dt, 1e-4);
    this.prevBreath = breath;
    bus.breath = breath;

    /* --- energy ---------------------------------------------------------
       Phrases, not a level. Two slow wobbles at incommensurate rates so the
       pattern never audibly loops, biased low so that rest is the default
       state and a swell is an event. */
    const a = wobble(this.t, m.swellRate, 1);
    const b = wobble(this.t, m.swellRate * 0.37, 9);
    const phrase = Math.pow(clamp01(a * 0.65 + b * 0.55 - 0.18), 1.6);
    // Floor. "Rest" must mean quiet, not dead: with no baseline, breath and
    // energy occasionally hit their troughs together and the field vanishes
    // for ten seconds, which reads as a bug rather than as stillness.
    this.energyRaw = (0.22 + 0.78 * phrase) * m.swell;
    bus.energy = follow(bus.energy, this.energyRaw, m.attack, m.release, dt);

    /* --- onsets ---------------------------------------------------------
       Sparse, stochastic, and they decay far faster than they rise. In M2
       these become real scheduled bell events, which is why they are already
       modelled as discrete strikes rather than as a continuous band. */
    this.nextOnset -= dt;
    if (this.nextOnset <= 0) {
      const gap = 1 / Math.max(m.onsetRate, 0.01);
      this.nextOnset = gap * (0.45 + hash11(this.t * 3.3) * 1.5);
      bus.onset = Math.min(1, bus.onset + 0.55 + 0.45 * hash11(this.t * 7.1));
    }
    bus.onset = follow(bus.onset, 0, 0.02, 0.34, dt);

    /* --- bands ----------------------------------------------------------
       Standing in for an FFT. Low bands track the body (energy + breath);
       high bands track the sparkle (onsets) and move much faster. */
    const e = bus.energy;
    const br = breath;

    bus.sub      = follow(bus.sub,      clamp01(0.18 + e * 0.75 + br * 0.30),                    0.5,  1.4, dt);
    bus.bass     = follow(bus.bass,     clamp01(0.14 + e * 0.85 + br * 0.22),                    0.35, 1.0, dt);
    bus.lowMid   = follow(bus.lowMid,   clamp01(0.10 + e * 0.55 + wobble(this.t, 0.31, 3) * 0.35), 0.22, 0.7, dt);
    bus.mid      = follow(bus.mid,      clamp01(0.08 + e * 0.40 + wobble(this.t, 0.53, 5) * 0.40), 0.15, 0.5, dt);
    bus.presence = follow(bus.presence, clamp01(0.05 + bus.onset * 0.60 + e * 0.25),             0.06, 0.35, dt);
    bus.air      = follow(bus.air,      clamp01(0.04 + bus.onset * 0.80 + wobble(this.t, 1.7, 7) * 0.22), 0.03, 0.22, dt);

    /* --- warmth ---------------------------------------------------------
       Stands in for spectral centroid. Cold when resting, warm when the field
       is working. Slow on purpose: colour temperature should feel like a
       season changing, never like a light being switched. */
    const warmTarget = clamp01(m.warmthBias + e * 0.42 + bus.presenceAmt * 0.30 - 0.12);
    bus.warmth = follow(bus.warmth, warmTarget, 3.0, 4.5, dt);

    bus.tempo = m.breathPeriod > 8 ? 60 : 112;
    bus.phase = (bus.phase + dt * (bus.tempo / 60)) % 1;
  }
}
