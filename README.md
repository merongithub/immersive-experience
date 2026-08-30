# ANIMA

A generative galaxy that responds to sound, to your voice, and to your stillness.

Browser-native, zero-build. No audio files, no textures, no dependencies beyond
three.js from a CDN. Everything you see and hear is synthesised at runtime.

## Run

```bash
python3 -m http.server 8137
# open http://localhost:8137/
```

Press **begin** (or spacebar). Headphones recommended, especially with voice on.

## What it is

A spiral galaxy of ~262k GPU-simulated stars, driven by a generative ambient
instrument. Four temperaments — `focus`, `sound bath`, `meditate`, `dance` —
each change the mode, voicing, event density, breath rate, palette and disc
physics together.

The piece **rewards you for not moving**. Stillness accumulates: the galaxy
slows, the frame narrows, the score thins, the reverb opens and the image dims
until it is something you mostly hear. Depth takes about five and a half
minutes of quiet to earn and forty seconds of fidgeting to spend.

Which is why **the field moves itself**. The attractor that bends the arms used
to exist only while the pointer was moving, so doing the thing the piece asks
for made it go inert — a contradiction at the centre of the design. Its point
of interest is now walked by the score instead of by a clock: speed from
`energy`, drawn inward on the inhale, and relocated about an arm's width by
each strike, so a bowl visibly lands somewhere. The path is seeded per session
and never repeats. Touch it and you take over, through the same 150 ms of
reluctance; let go and it is a release back into the drift rather than a cut.

## Architecture

```
Bus                     the single source of truth for "what is the sound doing"
 ├─ Engine              generative instrument; schedules ahead of the ear
 └─ EngineDriver        publishes score + analysis onto the Bus

Presence / Mic / Depth  you, as an input
World                   Galaxy · Tendrils · Dust · CameraRig · Post
Session                 Trace · Sigil
```

No renderer module ever touches an `AnalyserNode` or an oscillator. Swap the
driver and not one line of the world changes.

| Piece | File |
|---|---|
| Feature bus | `js/audio/Bus.js` |
| Generative instrument | `js/audio/Engine.js` |
| Microphone + voice return | `js/presence/Mic.js` |
| Guidance in your own voice | `js/presence/Guide.js` |
| Pointer / tilt | `js/presence/Presence.js` |
| Stillness → depth | `js/presence/Depth.js` |
| Spiral roots | `js/world/Galaxy.js` |
| GPGPU star field | `js/world/Tendrils.js` |
| Camera drift | `js/world/CameraRig.js` |
| Bloom / grain / vignette | `js/world/Post.js` |
| Session record | `js/session/Trace.js` |
| Keepsake | `js/session/Sigil.js` |

### The instrument

Drone voices on a mode with slow **modal drift** rather than a chord
progression; granular texture; struck bells; singing bowls with inharmonic
partials at 1 : 2.72 : 5.18 : 8.42 : 12.28, each split into two oscillators a
fraction of a hertz apart so they beat the way a real bowl does; a gong that
blooms after the strike; a pacing layer that decelerates toward the coherence
rate.

Because events are **scheduled ahead** on the audio clock, the visuals know a
strike is coming before you hear it — the bloom lifts and the field draws
breath in anticipation. A streamed file cannot do this.

Tuned to **A = 432 Hz**. Everything derives from one `mtof()`, so that constant
is the only place tuning lives. It is an aesthetic choice and not a
physiological one — the piece's actual claim on your nervous system is the
pacing layer, which decelerates toward roughly 5.5 breaths per minute.

### Entrainment

The sustained beds — drone and breath — pass through an **isochronic** stage: a
half-wave-rectified pulse at 6 Hz in `sound bath` and `meditate`, 10 Hz in
`focus`, easing a quarter slower as the session descends. `dance` has none; it
has a pulse already. Monaural rather than binaural, so it survives a laptop
speaker instead of collapsing to nothing.

The phase lives on the Engine, next to breath, for the same reason: the bloom
throbs from that one number too, and a flicker you can see slightly ahead of
the one you can hear is worse than no flicker at all. The struck layers stay
out of it — pulsing a bowl would chop the thirty-second tail that is the entire
reason a bowl is there.

### Your voice

Optional, permission-gated, and nothing leaves the device. It returns through
the reverb and a delay tuned to a scale degree, so a hummed note blooms into a
sustained drone. Breath is detected from the envelope-of-the-envelope and used
to lead your pacing gently slower. A captured phrase can replace the granular
source, so the texture of the piece becomes your own voice.

### Guidance

Speak a few short lines once and the piece returns them to you at long
intervals, through the reverb and a darkening feedback delay — the line loses
its consonants first, then its words, and what is left is the shape of your own
voice dissolving into the room. The beds duck under it; the bowls do not.

It is your voice rather than a synthesised one for a hard reason:
`speechSynthesis` output cannot be routed into an `AudioContext` in any
browser, so a text-to-speech line would necessarily be dry, sitting on top of
the bath instead of inside it.

Guidance is for the way in. It thins as you descend and stops near full depth,
where being spoken to would be an intrusion.

### The keepsake

Each session is drawn as a single continuous spiral, one turn per minute —
thickness from energy, colour from warmth, wobble from breath, fraying from
restlessness, ticks for every strike, and a nucleus sized by the deepest point
reached. Exportable as PNG, or as a ~320-character permalink.

## Controls

- `begin` / `pause` — also spacebar
- `focus` · `sound bath` · `meditate` · `dance`
- drag to look · scroll to move nearer · `r` to release back into the drift
- `add your voice` — microphone, hold to record a loop
- `hold to speak a line` — record guidance; it plays back through the reverb
- `session` — open the sigil
- `?p=512` — override the particle tier

## Listening

`?source=` hands the Bus to a `LiveDriver`: the field is driven by what the
microphone **hears** rather than by the Engine's score. This is the ear for
creative-space, proven on the galaxy first.

```
?source=mic                      the room — a handpan, a bowl, a voice
?source=mic&accompany=1          the Engine plays under you; its own sound is
                                 subtracted from what the mic hears and its
                                 scheduled strikes are masked
?source=file&url=take.wav        a recording, fetched — or drop one on the page
?source=engine                   the built-in instrument, through the analysis
                                 instead of the score
&sens=0.6                        onset sensitivity, 0..1
```

What a live instrument gives that the Engine never needed to: `strike` and
`onset` from **spectral flux** (a level follower misses a second hit inside the
ring of the first; the spectrum does not), `noteClass` from what *changed* in
the **chroma** at the strike (so a D over three ringing bowls still reads as a
D), `chroma` and `hue` for colour, and — when the playing is rhythmic —
`anticipation` from **inter-onset prediction**, which is the only route back to
the pre-echo a file can never supply. Free-time bowl playing gets none, by
design.

Onsets are scored per bin as the *squared* rise above an adaptive knee, and
only within 45 dB of the loudest thing heard recently — so a soft bowl is heard
over a noise bed while a room's hiss is not an event however sharply it
arrives. Strikes that arrive densely weigh less each, so a groove reads as
rhythm rather than lightning. `?source=engine` will hear the Engine's own
granular layer as a stream of small strikes; it is one, and there is nothing to
subtract it against there. That mode is a plumbing check, not a benchmark.

Pitch classes come from interpolated spectral peaks rather than bins: at 2048
points a bin is 23 Hz wide and a semitone at D4 is 17, so a raw bin names the
handpan's D a semitone wrong, reliably.

| Piece | File |
|---|---|
| Source (mic / file / engine tap) | `js/listen/Source.js` |
| Onset · chroma · note · tempo | `js/listen/Analysis.js` |
| Publishing onto the Bus | `js/listen/LiveDriver.js` |

## Filming

`?film=1` turns the piece into something being recorded rather than sat in.

```
?film=1&w=2560&h=1440&mins=30&mbps=40&p=1024
```

`w`/`h` set the drawing buffer, so the frame size is what lands in the file
whatever the window is doing. `mins` sets the film length — it drives the depth
curve *and* stops the recording by itself. `p` is the particle tier.

Video comes off the canvas and audio off the Engine's compressor, into one
`MediaRecorder`. Both from the same clock, so there is nothing to re-sync over
an hour. Chunks stream to a file handle as they arrive rather than piling up in
memory. The chrome is not in the recording — `captureStream` reads the canvas
alone. `&save=opfs` skips the save dialog: the take streams to the origin's
private storage and is downloaded when it ends, so a long take can be started
by a script and left alone.

Three things film mode changes, each because it would otherwise ruin a take:

- **The adaptive downscaler is locked.** It drops render scale under 42fps and
  only recovers above 57, so a capture run ratchets it down and never recovers.
- **Depth follows a scripted curve** instead of your stillness: bright through
  the opening, descending across the body, surfacing again before the end. The
  live rule would reach full depth at five and a half minutes and sit there.
- **Resolution is set outright**, rather than capped at window × 1.5.

Keep the tab visible. `requestAnimationFrame` halts in a hidden tab, which
freezes breath and the pulse while the scheduler carries on playing bowls.

Master to about −14 LUFS with `ffmpeg -af loudnorm` before uploading; the raw
output sits well below it, and YouTube turns loud uploads down but never lifts
quiet ones.

### Rendering a master

`render master` runs the whole piece through an `OfflineAudioContext`, faster
than real time, where nothing can drop a sample — no scheduler jitter, no GC
pause, no fight with the renderer for the same machine.

It works because every voice already schedules against absolute times. So
instead of waking a timer every 300 ms, the renderer walks a virtual clock
across the duration and calls **the same** `_schedule()` and `tick()` the live
path calls, at the rates they would have run at. There is no second
implementation of the piece to disagree with the first.

Alongside the audio it emits a **score**: every event with its timestamp, plus
the breath, pulse and depth tracks. `FilmDriver` then plays the master and
publishes it onto the Bus — bands and warmth from an analyser as usual, but
onset and anticipation from the score. That is what keeps the bloom lifting
*before* a bowl lands. An FFT can only tell you what already happened, and the
pre-echo would otherwise be the one thing lost by turning the piece into a file.

`save wav` streams 24-bit PCM straight to disk a chunk at a time — a half-hour
master is around 500 MB and the buffer it reads from is already holding 700 MB
of float, so assembling it in memory first is how a render that worked at ten
minutes dies at thirty. The score JSON saves next to it; the visuals cannot be
re-driven without it.

Practical ceiling is roughly 25–30 minutes per render. Longer needs segmenting,
and segments cannot be butt-spliced: bowls ring for 40 seconds and the gong for
52, so they have to overlap and sum or every seam is audible.

### Films for working

`&mode=focus` switches the defaults from a bath to a working session.

```
?film=1&mode=focus&mins=100&w=2560&h=1440&p=512&fps=60
```

The single long descent becomes **pomodoro blocks** — descend into a work
block, surface for the break, descend again a little deeper than last time.
`&work=25&brk=5` in minutes; `&session=none` restores the slope.

Three things change because motion and events are what pull attention off
work:

- **Events are gated.** Through the body of a block the struck layers drop to a
  tenth. They return over the last minute, so the piece tells you the block is
  ending rather than a timer doing it. The gate is a *probability that a due
  event plays*, not a multiplier on the interval — stretching the interval sets
  the next cursor from the rate in force when the last event fired, so one bell
  inside a quiet block pushes the cursor clean over the break and the gate can
  only ever remove events, never give them back.
- **The visible pulse is off** (`&vpulse=1` restores it). Flicker in peripheral
  vision works against the one thing a work film is for, and 6–10 Hz carries a
  photosensitivity risk in front of an audience. The audio pulse is untouched.
- **The camera barely tours.** `&swing=` scales the elevation swing, 0.35 by
  default here against 1 for a bath.

A `Readout` states the phase and the time left in the corner, drawn *into* the
canvas — `captureStream` records the canvas alone, so anything in the DOM would
be visible while filming and absent from the file.

| Piece | File |
|---|---|
| Recording | `js/session/Capture.js` |
| Offline render | `js/session/Offline.js` |
| Rendered playback | `js/audio/FilmDriver.js` |
| Session shape | `js/session/Session.js` |
| In-frame readout | `js/world/Readout.js` |
| Mastering | `tools/master.sh` |

## Requires

WebGL2 with float render targets, and Web Audio. Quality tier is chosen per
device and render scale adapts to measured frame time.

## Licence

MIT
