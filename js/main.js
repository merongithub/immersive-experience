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
import { Guide } from "./presence/Guide.js";
import { Trace } from "./session/Trace.js";
import { Sigil } from "./session/Sigil.js";
import { Capture } from "./session/Capture.js";
import { renderFilm, writeWAV, measure } from "./session/Offline.js";
import { FilmDriver } from "./audio/FilmDriver.js";
import { applySession, sessionSeed } from "./world/Seed.js";
import { seedDisc } from "./world/Galaxy.js";
import { Source } from "./listen/Source.js";
import { LiveDriver } from "./listen/LiveDriver.js";

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

/* ---------------------------------------------------------------- film mode
   ?film=1 turns the piece into something being recorded rather than sat in:
   the frame size is fixed, the adaptive downscaler is locked, the chrome goes,
   and depth follows a scripted curve instead of your stillness.

   ?film=1&w=2560&h=1440&mins=30&mbps=40&p=1024
   &save=opfs  skip the save dialog; download the finished take instead
   &grade=0    no film grade (see `grade` below); &floor=0.75 its exposure floor
   &journey=0  no journey (see Voyage.js) — on by default, except in focus
   &at=12      audition from minute 12; a take still starts from the top */
const Q = new URLSearchParams(location.search);

/* ---------------------------------------------------------------- listening
   ?source=mic|file|engine hands the Bus to a LiveDriver: the field is driven by
   what the microphone HEARS rather than by the Engine's score. This is the
   proving ground for creative-space — the same galaxy, a different ear.

   ?source=file&url=take.wav        a recording, fetched (or dropped on the page)
   ?source=mic&accompany=1          the Engine plays under you; its own sound is
                                    subtracted from what the mic hears
   ?source=engine                   listen to the built-in instrument through
                                    the analysis instead of the score
   &sens=0.6                        onset sensitivity, 0..1 */
const SOURCE = Q.get("source");
const ACCOMPANY = Q.get("accompany") === "1";

/* Focus films default to a worked session and a calmed picture; a bath keeps
   the single long descent it was designed around. Every default is
   overridable, but the defaults are the ones you actually want. */
const _isFocus = Q.get("mode") === "focus";
const _session = (Q.get("session") ?? (_isFocus ? "pomodoro" : "none")) !== "none";

const film = Q.get("film") ? {
  session: _session ? {
    work: Math.max(60, +(Q.get("work") || 25) * 60),
    brk:  Math.max(30, +(Q.get("brk") || 5) * 60),
    lead: 90,
  } : null,
  // Off by default while filming: flicker in peripheral vision works against
  // the one thing a work film is for, and 6-10 Hz is the band that carries a
  // photosensitivity risk in front of an audience. The AUDIO pulse stays.
  visualPulse: +(Q.get("vpulse") ?? 0),
  swing: Q.get("swing") !== null ? +Q.get("swing") : (_isFocus ? 0.35 : 1),
  // &cam=drift opts a take back into the live drift camera. Anything else —
  // including nothing — gets the film camera: held elevation, slower orbit,
  // the occasional push-in.
  cam: Q.get("cam") || "film",
  readout: (Q.get("readout") ?? (_session ? "1" : "0")) !== "0",
  width:      Math.max(256, +(Q.get("w") || 2560)),
  height:     Math.max(256, +(Q.get("h") || 1440)),
  pixelRatio: Math.max(0.5, +(Q.get("pr") || 1)),
  minutes:    Math.max(1, +(Q.get("mins") || 30)),
  bitrate:    Math.max(1, +(Q.get("mbps") || 40)) * 1e6,
  fps:        Math.max(12, Math.min(120, +(Q.get("fps") || 60))),
  /* The film grade: what a picture needs to survive an encoder and a phone,
     which the piece on a monitor does not. An exposure floor under the depth
     descent; blacks lifted `lift` 8-bit steps off zero and a static blue-noise
     dither of `dither` steps in place of the animated grain; star sprites
     sized in 1080-line pixels with a floor of `minPx`, so they survive a 4K
     frame being averaged down to a phone. &grade=0 turns all of it off, for
     an A/B against a take without it. */
  grade: Q.get("grade") === "0" ? null : {
    floor: Math.min(1, Math.max(0, +(Q.get("floor") ?? 0.75))),
    lift: 2,
    dither: 1,
    minPx: 1.25,
  },
  /* The journey: the film travels to a star and its world and back — see
     Voyage.js. Off for focus films by default, where a flight across the
     frame is exactly the drama a work film is built to avoid. */
  journey: (Q.get("journey") ?? (_isFocus ? "0" : "1")) !== "0",
  at: Math.max(0, +(Q.get("at") || 0)),
  // The mode list lives in the chrome, and film mode hides the chrome — so
  // without this a film could only ever be rendered in the default
  // temperament. A "sound bath" rendered in `meditate` is bells and no bowls.
  mode:       Q.get("mode") || null,
} : null;

/* The galaxy for this session, drawn before anything is built — Galaxy and
   Tendrils both read the structure at construction, and a seed applied after
   that point would give arms in one place and dust lanes in another.

   A film pins it, or two takes of the same piece would be two different
   galaxies and no note anywhere would say why. */
const session = applySession(Q.get("seed") || sessionSeed());
seedDisc(session);
console.info(`[ANIMA] seed ${session.label} · ${session.arms} arms · `
  + session.nebulae.map((n) => n.hue).join(", "));

try {
  engine = new Engine("meditate");
  bus.setDriver(new EngineDriver(engine));
  /* One context for everything when listening: the mic, the file, and any
     accompaniment share a clock and a sample rate, which the reference
     subtraction depends on. Engine.start() adopts a context it already has. */
  if (SOURCE) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) engine.ctx = new AC({ latencyHint: "interactive" });
  }

  organism = new Organism({ view, bus, film });
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

  /* --- the ear ---
     When a source is named, `begin` opens it instead of (or as well as) the
     Engine, and the Bus is handed to the LiveDriver. Pausing suspends the
     shared context, which stops everything on it at once. */
  let source = null, live = null;
  const listenEl = document.getElementById("listen");
  const fileInput = document.getElementById("listen-file");

  async function openSource(file = null) {
    source = source || new Source(engine.ctx);
    if (SOURCE === "engine" || ACCOMPANY) {
      if (!engine.running) { await engine.start(); engine.setVolume(volume); }
    }
    if (SOURCE === "file") {
      const url = Q.get("url");
      if (!file && !url) { listenEl.textContent = "drop a recording here"; return false; }
      await source.open("file", file ? { file } : { url });
      source.setVolume(volume);
    } else {
      await source.open(SOURCE, { engine });
    }
    if (!live) {
      live = new LiveDriver({ source, engine, mode: organism.mode });
      live.accompany = ACCOMPANY;
      if (Q.get("sens") !== null) live.sensitivity = Math.max(0, Math.min(1, +Q.get("sens")));
      bus.setDriver(live);
      window.__anima.live = live;
    }
    listenEl.textContent = `listening · ${source.label}`
      + (ACCOMPANY ? " · accompanied" : "");
    return true;
  }

  async function toggleListen() {
    const ctx = engine.ctx;
    if (source?.ready && ctx.state === "running") {
      if (engine.running) await engine.pause();
      await ctx.suspend();
      play.textContent = "resume";
      document.body.classList.remove("is-playing");
      return;
    }
    play.textContent = "···";
    await ctx.resume();
    if (source?.ready) {
      if (ACCOMPANY && !engine.running) { await engine.start(); engine.setVolume(volume); }
    } else if (!(await openSource())) {
      play.textContent = "begin";
      return;
    }
    play.textContent = "pause";
    document.body.classList.add("is-playing");
  }

  if (SOURCE) {
    listenEl.hidden = false;
    listenEl.textContent = SOURCE === "file" && !Q.get("url")
      ? "drop a recording here" : `ready · ${SOURCE}`;
    if (SOURCE === "file") {
      listenEl.classList.add("hover");
      listenEl.addEventListener("click", () => fileInput?.click());
      fileInput?.addEventListener("change", async () => {
        const f = fileInput.files?.[0];
        if (f) { await engine.ctx.resume(); await openSource(f); play.textContent = "pause"; document.body.classList.add("is-playing"); }
      });
      addEventListener("dragover", (e) => e.preventDefault());
      addEventListener("drop", async (e) => {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (f) { await engine.ctx.resume(); await openSource(f); play.textContent = "pause"; document.body.classList.add("is-playing"); }
      });
    }
  }

  async function toggle() {
    if (SOURCE) {
      try { await toggleListen(); }
      catch (err) { console.error(err); play.textContent = "begin"; listenEl.textContent = err.message; }
      return;
    }
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
      source?.setVolume(volume);
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

  /* --- guidance ---
     You speak the lines; the piece says them back to you, through the reverb,
     at long intervals. Same hold-to-record gesture as the loop, and the same
     privacy story: the phrases are AudioBuffers in memory and nothing else. */
  const guide = new Guide(engine);
  organism.guide = guide;

  const gRec = document.getElementById("guide-rec");
  const gPlay = document.getElementById("guide-play");
  const gClear = document.getElementById("guide-clear");
  const gCount = document.getElementById("guide-count");

  function drawGuide() {
    if (!gCount) return;
    const n = guide.count;
    gCount.textContent = n
      ? `${n} line${n === 1 ? "" : "s"} · ${guide.on ? "guiding you" : "silent"}`
      : "";
    if (gPlay) {
      gPlay.hidden = n === 0;
      gPlay.textContent = guide.on ? "let it be quiet" : "let it guide you";
      gPlay.classList.toggle("is-rec", guide.on);
    }
    if (gClear) gClear.hidden = n === 0;
  }
  drawGuide();

  const gStart = (e) => {
    e.preventDefault();
    if (!mic.enabled) return;
    if (mic.startPhrase()) {
      gRec.classList.add("is-rec");
      gRec.textContent = "listening···";
    }
  };
  const gStop = async () => {
    if (!mic.speaking) return;
    gRec.classList.remove("is-rec");
    gRec.textContent = "hold to speak a line";
    const buf = await mic.stopPhrase();
    // A phrase under a second is a slip of the finger, not a line.
    if (buf && buf.duration > 1.0) {
      guide.add(buf);
      // The first line switches guidance on by itself. Recording something and
      // then having to find a second control to hear it is a step too many.
      if (guide.count === 1) guide.setOn(true);
      drawGuide();
    }
  };
  gRec?.addEventListener("pointerdown", gStart);
  addEventListener("pointerup", gStop);
  addEventListener("pointercancel", gStop);

  gPlay?.addEventListener("click", () => { guide.setOn(!guide.on); drawGuide(); });
  gClear?.addEventListener("click", () => { guide.clear(); drawGuide(); });

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
  trace.seed = session.label;
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
    const url = `${location.origin}${location.pathname}`
              + `?seed=${encodeURIComponent(session.label)}&s=${trace.encode()}`;
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

      // What the ear just heard, while it is fresh. The class is only
      // meaningful while `note` is still decaying, hence the gate.
      if (live && source?.ready) {
        const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
        const n = bus.note > 0.15 && bus.noteClass >= 0 ? ` · ♪ ${NAMES[bus.noteClass]}` : "";
        const tempo = bus.tempoConf > 0.3 ? ` · ${bus.tempo.toFixed(0)} bpm` : "";
        listenEl.textContent = `listening · ${source.label}${ACCOMPANY ? " · accompanied" : ""}${n}${tempo}`;
      }

      // Show the measured rate only once it is trustworthy — a number that
      // jitters every second reads as broken, however accurate it is.
      if (vRate && mic.enabled) {
        vRate.textContent = mic.breathRate
          ? `breathing ${mic.breathRate.toFixed(1)}/min · leading you slower`
          : "listening for your breath···";
      }
    }, 90);
  }

  /* --- film ---
     A take, rather than a session. Depth follows the scripted curve so the
     opening stays bright and the piece surfaces before the video ends, and the
     recording stops itself at length — an hour-long take is not something you
     want to have to sit and watch in order to end it. */
  if (film) {
    document.body.classList.add("is-film");
    if (film.mode) setMode(film.mode);
    organism.depth.scriptTo(film.minutes * 60, film.session, film.at * 60);

    const hud = document.getElementById("film-hud");
    const fRec = document.getElementById("film-rec");
    const fRead = document.getElementById("film-read");
    hud.hidden = false;

    const fRender = document.getElementById("film-render");
    const fSave = document.getElementById("film-save");

    const capture = new Capture({
      canvas: view, source: engine, bitrate: film.bitrate, fps: film.fps,
      // &save=opfs: no save dialog, straight to private storage, downloaded at
      // the end — a take that can be started by a script and left alone.
      picker: Q.get("save") !== "opfs",
    });
    organism.capture = capture;

    // State the take before it is taken. The temperament decides whether this
    // is a bath or something else entirely, and it is the one setting you
    // cannot see once the chrome is hidden.
    const voyage = organism.voyage;
    const baseRead =
      `${organism.mode} · ${film.minutes}:00 · ${film.width}×${film.height}`
      + (film.session
          ? ` · ${film.session.work / 60}/${film.session.brk / 60} pomodoro`
          : " · continuous")
      + (film.visualPulse ? " · visual pulse ON" : "")
      + (film.grade ? "" : " · grade OFF")
      + (voyage ? ` · journey to ${voyage.name}` : "");
    fRead.textContent = baseRead;

    const clock = (s) =>
      `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    const stamp = () =>
      new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

    /* --- the master ---
       Render the score offline, then play THAT rather than performing it live.
       Nothing can drop a sample in an OfflineAudioContext, and the score it
       emits alongside keeps the visuals' foreknowledge intact — see FilmDriver
       for why that matters more than it sounds like it should. */
    let master = null;        // { buffer, score }
    let takeLabel = "";       // what the running take actually contains
    let filmDriver = null;
    let playCtx = null;

    async function renderMaster() {
      fRender.textContent = "···";
      try {
        // The generative engine must stop; the film is the performance now.
        if (engine.running) await engine.pause();

        const t0 = performance.now();
        master = await renderFilm({
          mode: organism.mode,
          minutes: film.minutes,
          // The audio has to fall quiet at the moment the picture falls dark,
          // so both read the same session config.
          session: film.session,
          onProgress: (u) => {
            fRead.textContent = `rendering ${(u * 100).toFixed(0)}%`;
          },
        });

        fRead.textContent = "encoding···";
        await new Promise((r) => setTimeout(r, 0));

        // A live context to play it back through. The click is the gesture.
        playCtx = playCtx || new (window.AudioContext || window.webkitAudioContext)(
          { latencyHint: "playback" });
        await playCtx.resume();

        filmDriver = new FilmDriver(playCtx, master.buffer, master.score);
        bus.setDriver(filmDriver);
        capture.source = filmDriver;
        organism.depth.external = true;   // the score owns depth now
        organism.attachPacer(playCtx);    // the take survives a hidden tab

        const m = measure(master.buffer);
        const took = (performance.now() - t0) / 1000;
        fRender.textContent = "re-render";
        fSave.hidden = false;
        drawPlay();
        fRead.textContent =
          `master ready · ${clock(master.score.duration)} · `
          + `peak ${m.peakDb.toFixed(1)} dBFS · rms ${m.rmsDb.toFixed(1)} · `
          + `rendered in ${took.toFixed(0)}s`;
      } catch (err) {
        console.error(err);
        fRender.textContent = "render master";
        fRead.textContent = err.message;
      }
    }

    async function saveMaster() {
      if (!master) return;
      if (!window.showSaveFilePicker) {
        fRead.textContent = "this browser cannot stream a file to disk — use Chrome";
        return;
      }
      try {
        const handle = await showSaveFilePicker({
          suggestedName: `anima-${film.minutes}min-${stamp()}.wav`,
          types: [{ description: "WAV", accept: { "audio/wav": [".wav"] } }],
        });
        const w = await handle.createWritable();
        await writeWAV(master.buffer, w, (u) => {
          fRead.textContent = `writing wav ${(u * 100).toFixed(0)}%`;
        });
        await w.close();

        // The score travels with it — the visuals cannot be re-driven without it.
        const blob = new Blob([JSON.stringify(master.score)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `anima-${film.minutes}min-${stamp()}.score.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 8000);

        fRead.textContent = "wav + score saved";
      } catch (err) {
        console.error(err);
        fRead.textContent = err.message;
      }
    }

    fRender?.addEventListener("click", renderMaster);
    fSave?.addEventListener("click", saveMaster);

    /* --- audition ---
       Film mode hides the chrome, and the chrome is where `begin` and the
       volume live — so without this there is no way to hear a master short of
       recording one, which is a poor way to discover you rendered the wrong
       temperament. Plays the rendered master if there is one, and the live
       instrument if there is not. */
    const fPlay = document.getElementById("film-play");

    function drawPlay() {
      const on = filmDriver ? filmDriver.playing : engine.running;
      fPlay.textContent = on ? "stop" : "listen";
      fPlay.classList.toggle("is-on", on);
    }

    async function toggleListen() {
      if (filmDriver) {
        filmDriver.playing ? filmDriver.stop() : filmDriver.start(0);
      } else {
        await toggle();
      }
      drawPlay();
    }

    fPlay?.addEventListener("click", toggleListen);

    async function startTake() {
      try {
        /* Recorder first, film second, and the order is load-bearing.
           capture.start() awaits a save dialog that can sit open for as long
           as it takes to pick a folder — starting playback before that lets
           the master run that far ahead of the picture, and lining the
           pristine WAV up with the video is the entire reason to render
           offline in the first place. */
        await capture.start(`anima-${film.minutes}min-${stamp()}`);

        if (filmDriver) {
          filmDriver.stop();
          filmDriver.start(0);
        } else {
          // No master rendered — fall back to filming the live performance,
          // where the recorded audio IS the audio and sync is inherent.
          if (!engine.running) {
            await toggle();
            if (!engine.running) { fRead.textContent = "audio would not start"; return; }
          }
          organism.attachPacer(engine.ctx);
          organism.depth.scriptTo(film.minutes * 60, film.session);
        }

        // Whatever gap remains between the recorder opening and the film
        // starting, measured rather than assumed — it is what you pass to
        // ffmpeg's -itsoffset when muxing the master back over the video.
        capture.leadIn = (performance.now() - capture.startedAt) / 1000;

        /* State what is in this take, and keep stating it.
           A rendered master plays in its own AudioContext and the mic lives in
           the Engine's, so the two cannot meet: rendering a master and then
           singing over it produces a take with none of your voice in it, and
           nothing about the running recording would have said so. This is the
           one mistake here that costs a whole take. */
        takeLabel = filmDriver
          ? (mic.enabled ? " · VOICE NOT RECORDED (master)" : " · master")
          : (mic.enabled ? " · live + your voice" : " · live");
        if (filmDriver && mic.enabled) {
          console.warn("[ANIMA] recording a rendered master — the mic is in a "
            + "different AudioContext and will NOT be in this take. Reload "
            + "without rendering a master to film with your voice.");
        }

        // The camera belongs to the drift for the length of the take. If it
        // was in free look when record was pressed, it is released first.
        if (organism.rig.mode !== "drift") organism.rig._resume();
        organism.rig.locked = true;

        fRec.textContent = "stop";
        fRec.classList.add("is-rec");
        drawPlay();
      } catch (err) {
        console.error(err);
        fRead.textContent = err.message;
      }
    }

    async function endTake() {
      fRec.textContent = "···";
      fRec.classList.remove("is-rec");
      const out = await capture.stop();
      filmDriver?.stop();
      organism.rig.locked = false;
      drawPlay();
      fRec.textContent = "record";
      if (out) {
        const lead = capture.leadIn ? ` · lead-in ${capture.leadIn.toFixed(3)}s` : "";
        fRead.textContent =
          `${out.saved ? "saved" : "downloaded"} · ${clock(out.seconds)} · `
          + `${(out.bytes / 1e9).toFixed(2)} GB${lead}`;
      }
    }

    fRec?.addEventListener("click", () => {
      capture.recording ? endTake() : startTake();
    });

    if (!Capture.supported) {
      fRec.hidden = true;
      fRead.textContent = "this browser cannot record — use Chrome";
    }

    setInterval(() => {
      const s = capture.stats();
      // Between takes, say where in the story the audition is — the chapter
      // is otherwise something you can only infer from the picture.
      if (!s) {
        if (voyage && fRead.textContent.startsWith(baseRead.slice(0, 12))) {
          fRead.textContent = `${baseRead} · ${clock(organism.bus.filmT || 0)} ${voyage.chapter}`;
        }
        return;
      }
      // End on the PLAYHEAD when there is a master, not on wall-clock: if the
      // renderer stutters the take runs long, and cutting it by the clock
      // would clip the last strike off the end of the film.
      const done = filmDriver
        ? filmDriver.ended
        : s.seconds >= film.minutes * 60;
      if (done) { endTake(); return; }
      // Reporting measured fps matters: this is the one number that tells you
      // whether the take is worth keeping before you have watched it back.
      fRead.textContent =
        `${clock(s.seconds)} / ${film.minutes}:00 · ${s.fps.toFixed(1)} fps · `
        + `${s.gb.toFixed(2)} GB${s.saved ? "" : " · in memory"}${takeLabel}`
        + (voyage ? ` · ${voyage.chapter}` : "");
    }, 1000);

    // rAF halts in a hidden tab, which freezes breath and the pulse while the
    // scheduler keeps playing bowls. That is an unusable take, so say so
    // rather than letting it be discovered in the edit.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && capture.recording) {
        console.warn("[ANIMA] tab hidden while recording — the frame is frozen");
      }
    });
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
