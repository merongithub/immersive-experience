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

### Your voice

Optional, permission-gated, and nothing leaves the device. It returns through
the reverb and a delay tuned to a scale degree, so a hummed note blooms into a
sustained drone. Breath is detected from the envelope-of-the-envelope and used
to lead your pacing gently slower. A captured phrase can replace the granular
source, so the texture of the piece becomes your own voice.

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
- `session` — open the sigil
- `?p=512` — override the particle tier

## Requires

WebGL2 with float render targets, and Web Audio. Quality tier is chosen per
device and render scale adapts to measured frame time.

## Licence

MIT
