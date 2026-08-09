/**
 * ANIMA — bootstrap.
 *
 * Wires the Bus to the Organism, mounts the chrome, and reveals once the first
 * frame is on screen. The world is fully procedural; nothing is loaded.
 *
 * MILESTONE 2 (Voice): the field is driven by the generative Engine. Audio is
 * synthesised in the browser and the visuals read the score, not just an FFT —
 * so the organism knows an event is coming before you hear it.
 */

import { Bus } from "./audio/Bus.js";
import { Engine, EngineDriver } from "./audio/Engine.js";
import { Organism } from "./world/Organism.js";
import { Mic } from "./presence/Mic.js";
import { Trace } from "./session/Trace.js";
import { Sigil } from "./session/Sigil.js";

const view = document.getElementById("view");
const boot = document.getElementById("boot");
const chrome = document.getElementById("chrome");

/* ------------------------------------------------------------------ reveal */

let revealed = false;
function reveal() {
  if (revealed) return;
  revealed = true;
  document.body.classList.remove("is-loading");
  boot?.setAttribute("aria-busy", "false");
  setTimeout(() => { if (boot) boot.style.display = "none"; }, 1800);
}

function fail(err) {
  console.error(err);
  document.body.classList.remove("is-loading");
  if (!boot) return;
  boot.style.display = "";
  boot.classList.add("is-error");
  boot.querySelector(".boot-word").textContent =
    `The field could not start. ${err.message}`;
}

// rAF is throttled in background tabs; never let the overlay stick.
setTimeout(reveal, 6000);

/* -------------------------------------------------------------------- boot */

let organism = null;
let engine = null;
const bus = new Bus();

try {
  engine = new Engine("meditate");
  bus.setDriver(new EngineDriver(engine));

  organism = new Organism({ view, bus });
  organism.setMode("meditate");
  organism.start();

  organism.whenReady().then(() => setTimeout(reveal, 400));
  window.__anima = { organism, bus, engine };
} catch (err) {
  fail(err);
}

/* ------------------------------------------------------------------ chrome */

if (organism) {
  /* --- modes --- */
  const buttons = [...document.querySelectorAll(".mode")];
  function setMode(name) {
    bus.setMode(name);       // reaches the Engine through the driver
    organism.setMode(name);
    for (const b of buttons) b.classList.toggle("is-on", b.dataset.mode === name);
  }
  for (const b of buttons) {
    b.addEventListener("click", () => setMode(b.dataset.mode));
  }
  setMode("meditate");

  /* --- transport ---
     An AudioContext cannot start without a user gesture, so the gate is part
     of the design rather than an apology for it: one word, same type as the
     rest, and the field is already breathing behind it. */
  const play = document.getElementById("play");
  const volRead = document.getElementById("vol-read");
  let volume = 0.42;

  function drawVolume() {
    const cells = 4;
    const g = ["·", "▁", "▃", "▅", "▇"];
    let s = "";
    for (let i = 0; i < cells; i++) {
      s += g[Math.round(Math.max(0, Math.min(1, volume * cells - i)) * (g.length - 1))];
    }
    if (volRead) volRead.textContent = s;
  }
  drawVolume();

  async function toggle() {
    try {
      if (engine.running) {
        await engine.pause();
        play.textContent = "resume";
        document.body.classList.remove("is-playing");
      } else {
        play.textContent = "···";
        await engine.start();
        engine.setVolume(volume);
        play.textContent = "pause";
        document.body.classList.add("is-playing");
      }
    } catch (err) {
      console.error(err);
      play.textContent = "audio unavailable";
    }
  }

  play?.addEventListener("click", toggle);

  for (const b of document.querySelectorAll(".vol")) {
    b.addEventListener("click", () => {
      volume = Math.max(0, Math.min(1, volume + Number(b.dataset.vol) * 0.08));
      engine.setVolume(volume);
      drawVolume();
    });
  }

  // Space toggles; the canvas has no other use for it.
  addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat) { e.preventDefault(); toggle(); }
  });

  /* --- voice ---
     Opt-in, and gated behind the sound already running: the Mic needs the
     Engine's AudioContext and its reverb bus to return you to the room. */
  const mic = new Mic(engine, organism.depth);
  const panel = document.getElementById("voice-panel");
  const vToggle = document.getElementById("voice-toggle");
  const vControls = document.getElementById("voice-controls");
  const vRec = document.getElementById("voice-rec");
  const vClear = document.getElementById("voice-clear");
  const vRate = document.getElementById("voice-rate");

  async function voiceOn() {
    if (!engine.running) {
      await toggle();                        // starting audio is a prerequisite
      if (!engine.running) return;
    }
    vToggle.textContent = "···";
    try {
      await mic.enable();
      organism.mic = mic;                    // Organism ticks it each frame
      panel.classList.add("is-on");
      vToggle.textContent = "your voice is in";
      vControls.hidden = false;
    } catch (err) {
      console.error(err);
      vToggle.textContent = err.name === "NotAllowedError"
        ? "microphone declined"
        : "microphone unavailable";
    }
  }

  function voiceOff() {
    mic.disable();
    organism.mic = null;
    panel.classList.remove("is-on");
    vToggle.textContent = "add your voice";
    vControls.hidden = true;
    vRate.textContent = "";
  }

  vToggle?.addEventListener("click", () => (mic.enabled ? voiceOff() : voiceOn()));

  // Hold to record: press and hold, release to commit. A press-to-start /
  // press-to-stop pair invites eight minutes of accidental silence.
  const recStart = (e) => {
    e.preventDefault();
    if (!mic.enabled) return;
    if (mic.startRecording()) vRec.classList.add("is-rec");
  };
  const recStop = () => {
    if (!mic.recording) return;
    vRec.classList.remove("is-rec");
    if (mic.stopRecording()) {
      vRec.textContent = "re-record";
      vClear.hidden = false;
    }
  };
  vRec?.addEventListener("pointerdown", recStart);
  addEventListener("pointerup", recStop);
  addEventListener("pointercancel", recStop);

  vClear?.addEventListener("click", () => {
    mic.clearRecording();
    vRec.textContent = "hold to record";
    vClear.hidden = true;
  });

  // Tilt, on devices that have it. Asked for once, on a real gesture.
  if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
    view.addEventListener("pointerdown", function once() {
      organism.presence.enableTilt();
      view.removeEventListener("pointerdown", once);
    }, { once: true });
  }

  const elVoice = document.getElementById("r-voice");
  const elDepth = document.getElementById("r-depth");

  /* --- session trace + keepsake ---
     The trace records; the sigil draws. Both are entirely local — the record
     lives in memory and only leaves if you export it yourself. */
  const trace = new Trace();
  organism.trace = trace;

  const overlay = document.getElementById("sigil-overlay");
  const holder = document.getElementById("sigil-holder");
  const sessionBtn = document.getElementById("session");
  const sessionTime = document.getElementById("session-time");
  let currentCanvas = null;

  function showSigil(t) {
    holder.innerHTML = "";
    currentCanvas = Sigil.render(t, 1400);
    holder.appendChild(currentCanvas);
    overlay.hidden = false;
  }

  sessionBtn?.addEventListener("click", () => showSigil(trace));
  document.getElementById("sigil-close")?.addEventListener("click", () => {
    overlay.hidden = true;
  });

  document.getElementById("sigil-save")?.addEventListener("click", () => {
    if (!currentCanvas) return;
    const s = trace.summary();
    const stamp = s.date.toISOString().slice(0, 10);
    Sigil.save(currentCanvas, `anima-${stamp}-${s.minutes}min.png`);
  });

  document.getElementById("sigil-link")?.addEventListener("click", async (e) => {
    const url = `${location.origin}${location.pathname}?s=${trace.encode()}`;
    try {
      await navigator.clipboard.writeText(url);
      e.target.textContent = "link copied";
    } catch {
      // Clipboard access is refused in plenty of contexts; putting the URL in
      // the address bar is a worse-but-working fallback rather than a dead end.
      history.replaceState(null, "", url);
      e.target.textContent = "link in address bar";
    }
    setTimeout(() => { e.target.textContent = "copy link"; }, 2600);
  });

  // Escape closes; it is the one modal in the piece.
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) overlay.hidden = true;
  });

  // A shared session opens straight into its sigil.
  const shared = new URLSearchParams(location.search).get("s");
  if (shared) {
    const restored = Trace.decode(shared);
    if (restored) setTimeout(() => showSigil(restored), 1400);
  }

  /* --- idle fade ---
     Six seconds of stillness and the type recedes to 9%. It never disappears —
     you can always find it — but it stops competing with the field. */
  let idleTimer = 0;
  function wake() {
    document.body.classList.remove("is-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add("is-idle"), 6000);
  }
  for (const ev of ["pointermove", "pointerdown", "keydown", "wheel"]) {
    addEventListener(ev, wake, { passive: true });
  }
  wake();

  /* --- readout ---
     Eight-cell monospace meters. Deliberately a text instrument, not a graphic:
     it belongs to the chrome, and the chrome is type. */
  const elBreath = document.getElementById("r-breath");
  const elEnergy = document.getElementById("r-energy");
  const CELLS = 8;
  const GLYPHS = ["·", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

  function meter(v) {
    let s = "";
    for (let i = 0; i < CELLS; i++) {
      const local = Math.max(0, Math.min(1, v * CELLS - i));
      s += GLYPHS[Math.round(local * (GLYPHS.length - 1))];
    }
    return s;
  }

  if (elBreath && elEnergy) {
    setInterval(() => {
      if (document.hidden) return;
      elBreath.textContent = meter(bus.breath);
      elEnergy.textContent = meter(bus.energy);
      if (elVoice) elVoice.textContent = meter(bus.voice || 0);
      if (elDepth) elDepth.textContent = meter(bus.depth || 0);
      document.body.classList.toggle("is-descending", (bus.depth || 0) > 0.06);
      if (sessionTime) sessionTime.textContent = trace.summary().duration;

      // Show the measured rate only once it is trustworthy — a number that
      // jitters every second reads as broken, however accurate it is.
      if (vRate && mic.enabled) {
        vRate.textContent = mic.breathRate
          ? `breathing ${mic.breathRate.toFixed(1)}/min · leading you slower`
          : "listening for your breath···";
      }
    }, 90);
  }

  /* --- camera mode in the hint line --- */
  const hint = document.getElementById("hint");
  organism.onCameraMode = (m) => {
    if (!hint) return;
    hint.innerHTML = m === "free"
      ? `<em>r</em> release to the drift`
      : `<em>drag</em> look &middot; <em>scroll</em> near &middot; <em>r</em> release`;
  };
}
