/**
 * Offline — the piece, rendered as a master rather than performed.
 *
 * An OfflineAudioContext runs the whole score faster than real time and cannot
 * drop a sample: no scheduler jitter, no garbage-collection pause, no CPU spike
 * from the renderer competing for the same machine. What comes out is what the
 * Engine actually meant.
 *
 * The trick that makes it possible is that every voice already schedules with
 * absolute times — start(when) / stop(when) and AudioParam ramps. So instead of
 * waking a timer every 300 ms, we walk a virtual clock across the whole
 * duration and call the SAME _schedule() and tick() the live path calls, at the
 * rates they would have run at. There is no second implementation of the piece
 * to disagree with the first one.
 *
 * Alongside the audio it emits a SCORE: every event with its timestamp, plus
 * the breath, pulse and depth tracks. That is what lets the visuals be driven
 * with foreknowledge during playback — an analyser can tell you a bell just
 * rang, but only the score can tell you one is about to.
 */

import { Engine } from "../audio/Engine.js";
import { filmCurve } from "../presence/Depth.js";
import { sessionAt } from "./Session.js";

const STEP = 1 / 60;        // continuous-parameter grid, matching a 60fps tick
const SCHED_EVERY = 1.0;    // virtual seconds between scheduler wakes
const TRACK_HZ = 60;        // score track resolution

/* Long enough for the slowest voice to ring out. The gong decays for up to 52
   seconds and bowls for 40, so a film that stops at its nominal length chops
   the last strike off mid-decay. */
const TAIL = 64;

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param {object}   opts
 * @param {string}   opts.mode      temperament to render
 * @param {number}   opts.minutes   film length, excluding the tail
 * @param {number=}  opts.volume    master level; leave headroom for mastering
 * @param {object=}  opts.session   pomodoro config; null for one long descent
 * @param {function=} opts.onProgress  called with 0..1 during scheduling
 * @returns {Promise<{buffer: AudioBuffer, score: object}>}
 */
export async function renderFilm({
  mode = "bath",
  minutes = 30,
  volume = 0.8,
  sampleRate = 48000,
  session = null,
  onProgress,
} = {}) {
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("This browser cannot render offline audio.");
  }

  const duration = minutes * 60;
  const total = duration + TAIL;

  const ctx = new OfflineAudioContext(2, Math.ceil(total * sampleRate), sampleRate);
  const engine = new Engine(mode, ctx);
  engine.prepareOffline(volume);

  /* Capture every event as it is scheduled. Reading `upcoming` would not work:
     _schedule() prunes it to what is still ahead of the playhead, which is
     right for driving visuals live and useless for building a score. */
  const events = [];
  engine.onEvent = (e) => {
    if (e.at <= duration) {
      events.push({ t: Math.round(e.at * 1000) / 1000, type: e.type, w: e.weight ?? 1 });
    }
  };

  const n = Math.ceil(duration * TRACK_HZ);
  const breath = new Uint8Array(n);
  const pulse = new Uint8Array(n);
  const depth = new Uint8Array(n);

  let nextSched = 0;
  let nextDepth = 0;
  let dwell = 0;
  let i = 0;
  let sinceYield = 0;

  for (let t = 0; t < duration; t += STEP) {
    engine._vnow = t;

    if (t >= nextSched) { engine._schedule(); nextSched += SCHED_EVERY; }

    /* The same curve Depth uses when filming, imported rather than copied: if
       the audio descended on a different schedule from the picture, the film
       would come apart in the middle and nothing would say why. The event gate
       travels with it for exactly the same reason — the block has to fall
       quiet in the ear at the moment it falls dark in the eye. */
    let d, gate = 1;
    if (session) {
      const s = sessionAt(t, duration, session);
      d = s.depth;
      gate = s.gate;
    } else {
      d = filmCurve(t / duration);
    }
    dwell = d > 0.94 ? Math.min(30, dwell + STEP / 60) : Math.max(0, dwell - STEP / 25);
    if (t >= nextDepth) {
      engine.setEventGate(gate);
      engine.setDepth(d, dwell);
      nextDepth += 0.5;
    }

    engine.tick(STEP);

    const k = Math.floor(t * TRACK_HZ);
    if (k < n) {
      breath[k] = Math.round(engine._breathValue() * 255);
      pulse[k] = Math.round((engine.pulseValue || 0) * 255);
      depth[k] = Math.round(d * 255);
    }

    // Scheduling a 30-minute piece is ~108k iterations. Yield often enough
    // that the tab stays alive and the progress readout actually moves.
    if (++i - sinceYield >= 900) {
      sinceYield = i;
      onProgress?.(t / duration);
      await yieldToUI();
    }
  }

  engine.onEvent = null;
  onProgress?.(1);

  const buffer = await ctx.startRendering();

  return {
    buffer,
    score: {
      version: 1,
      mode,
      duration,
      tail: TAIL,
      trackHz: TRACK_HZ,
      sampleRate,
      events,
      tracks: {
        breath: b64(breath),
        pulse: b64(pulse),
        depth: b64(depth),
      },
    },
  };
}

/* ------------------------------------------------------------------ score */

function b64(bytes) {
  let s = "";
  const CH = 0x8000;   // chunked: apply() on a megabyte-long array overflows
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

/** Inverse of b64(), for the FilmDriver. */
export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* -------------------------------------------------------------------- wav
   24-bit PCM. Float32 would be simpler but doubles a file that is already
   hundreds of megabytes, and 24-bit is what a mastering chain wants anyway —
   the truncation error sits around -144 dB, well under the noise floor of
   anything in the piece, so no dither is warranted. */

const HEADER = 44;

function wavHeader(frames, channels, sampleRate) {
  const bytesPerSample = 3;
  const dataBytes = frames * channels * bytesPerSample;
  const buf = new ArrayBuffer(HEADER);
  const v = new DataView(buf);
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };

  tag(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);              // PCM chunk size
  v.setUint16(20, 1, true);               // format: PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bytesPerSample, true);
  v.setUint16(32, channels * bytesPerSample, true);
  v.setUint16(34, 8 * bytesPerSample, true);
  tag(36, "data");
  v.setUint32(40, dataBytes, true);
  return buf;
}

/**
 * Stream an AudioBuffer to disk as a WAV, a chunk at a time.
 *
 * Written incrementally rather than assembled into one Blob because a
 * half-hour stereo master is around 500 MB — and the AudioBuffer it is being
 * read from is already holding 700 MB of float. Building the whole file in
 * memory first is how a render that worked at ten minutes dies at thirty.
 *
 * @param {AudioBuffer} buffer
 * @param {FileSystemWritableFileStream} writable
 */
export async function writeWAV(buffer, writable, onProgress) {
  const ch = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;

  await writable.write(wavHeader(frames, ch, buffer.sampleRate));

  const L = buffer.getChannelData(0);
  const R = ch > 1 ? buffer.getChannelData(1) : L;

  const CHUNK = 1 << 16;   // frames per write
  const bytes = new Uint8Array(CHUNK * ch * 3);

  for (let start = 0; start < frames; start += CHUNK) {
    const count = Math.min(CHUNK, frames - start);
    let o = 0;
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, (c === 0 ? L : R)[start + i]));
        // Asymmetric scaling: 24-bit signed runs -8388608..8388607, so using
        // the positive maximum for both directions clips the negative peaks.
        const v = Math.round(s < 0 ? s * 8388608 : s * 8388607);
        bytes[o++] = v & 0xff;
        bytes[o++] = (v >> 8) & 0xff;
        bytes[o++] = (v >> 16) & 0xff;
      }
    }
    await writable.write(bytes.subarray(0, o));
    onProgress?.(start / frames);
  }
  onProgress?.(1);
}

/** Peak and integrated-ish RMS, in dBFS. A sanity check before mastering. */
export function measure(buffer) {
  const ch = Math.min(2, buffer.numberOfChannels);
  let peak = 0, acc = 0, n = 0;
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 7) {   // sampled: exactness is not the point
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      acc += d[i] * d[i];
      n++;
    }
  }
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(acc / Math.max(1, n))) };
}
