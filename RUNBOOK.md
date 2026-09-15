# ANIMA runbook

How to run the piece, every URL parameter it reads, and the recipes for
recording a film. Parameters are read once at boot; change one and reload.

## Run

```
python3 tools/serve.py          # http://localhost:8137/
python3 tools/serve.py 9000     # another port
```

Use `tools/serve.py`, not `python3 -m http.server`. It sends `Cache-Control:
no-store`, which is what stops Chrome running one freshly edited module against
one stale one after a reload.

## Parameters

Every parameter is a query string on the page URL:

```
http://localhost:8137/?film=1&mins=30&seed=abc123
```

### Always available

| Param | Values | Default | What it does |
|---|---|---|---|
| `seed` | up to 12 chars | random | Pins the galaxy: arm count, pitch, nebula colours, the voyage's star and world. Printed to the console at boot as `[ANIMA] seed …`. Pass the same seed to get the same galaxy across takes. |
| `p` | 64 to 1024 | 512 desktop, 320 on 4 GB machines, 256 mobile | Particle tier. The disc has `p²` motes: 512 is 262k, 1024 is 1M. Chosen once at boot. |
| `mode` | `focus`, `bath`, `meditate`, `dance` | `meditate` | The temperament. Live, the chrome can change it. In film mode this is the only way to pick it, since the chrome is hidden. `focus` also flips several film defaults, listed below. |
| `s` | encoded trace | none | A shared session. Opens straight into that session's sigil (the keepsake). Produced by the share action, not typed by hand. |

#### What a seed can be

Any string. It is cut to 12 characters, hashed (FNV-1a, case-sensitive), and
the hash drives every deterministic draw. So `teal-sunrise`, `take7`, `A`, and
`a` are all valid, and the last two are different galaxies. Without one, the
app draws a random base-36 label of one to six characters and prints it to the
console. About four billion distinct galaxies exist; nothing is rejected.

A seed decides:

- arm count: 2 half the time, 3 about a third, 4 the rest
- how open the spiral is, and the palette's resting warmth
- two or three nebulae drawn from five hues: teal, magenta, gold, rose, ice,
  with their size, position, height, drift, and strength
- the voyage's star, which sits in the strongest nebula, plus the world's
  colour, tilt, rings, and orbit phase

The label and nebula hues are printed at boot as `[ANIMA] seed …`, so a good
one seen once can be typed back in.

Ten seeds and what they produce, computed from `Seed.js`. The destination is
the nebula the voyage's star sits in.

| Seed | Arms | Nebulae | Destination | Star | World |
|---|---|---|---|---|---|
| `anima` | 3 | teal, gold | teal | golden | ringed |
| `voyage` | 2 | teal, rose | teal | golden | ringed |
| `neptune` | 4 | magenta, rose | magenta | ember-gold | ringed |
| `take7` | 3 | ice, rose, magenta | magenta | near white | ringed |
| `bath30` | 2 | rose, ice | rose | white | ringed |
| `ronz` | 3 | teal, magenta, ice | ice | pale gold | ringed |
| `dawn` | 2 | rose, ice | ice | golden | no ring |
| `glint` | 3 | gold, teal, magenta | magenta | pale gold | no ring |
| `aria` | 3 | ice, rose, gold | gold | golden | no ring |
| `koan` | 2 | teal, gold, magenta | magenta | pale gold | ringed |

To check a new seed without opening the browser:

```
node --input-type=module -e '
import { makeSession } from "./js/world/Seed.js";
const S = makeSession(process.argv[1]);
console.log(S.arms, "arms;", S.nebulae.map(n => n.hue + " " + n.strength.toFixed(2)).join(", "));
' -- myseed
```

### Listening (`source`)

Hands the Bus to a live analyser instead of the Engine's score. The same galaxy, driven by what is heard.

| Param | Values | Default | What it does |
|---|---|---|---|
| `source` | `mic`, `file`, `engine` | none | `mic` listens to the microphone. `file` plays a recording through the analysis. `engine` runs the built-in instrument through the analyser rather than the score. |
| `url` | a WAV or audio URL | none | With `source=file`, the recording to fetch. Without it the page waits for a file to be dropped on it. |
| `accompany` | `1` | off | With `source=mic`, the Engine plays under you and its own sound is subtracted from what the mic hears. |
| `sens` | 0 to 1 | driver default | Onset sensitivity of the live analyser. |

### Film mode (`film=1`)

`film=1` turns the piece into something recorded rather than sat in: fixed frame, downscaler locked, chrome hidden, depth on a scripted curve, film camera, film grade, and the journey.

| Param | Values | Default | What it does |
|---|---|---|---|
| `film` | `1` | off | Enables film mode. Everything below needs it. |
| `w`, `h` | pixels, min 256 | 2560, 1440 | Drawing buffer size. This is the frame size in the file regardless of the window. |
| `pr` | min 0.5 | 1 | Pixel ratio applied to `w` and `h`. |
| `mins` | min 1 | 30 | Film length in minutes. Drives the depth curve, the journey timing, and stops the recording by itself. |
| `fps` | 12 to 120 | 60 | Recorder frame rate. |
| `mbps` | min 1 | 40 | Video bitrate in megabits per second. |
| `cam` | `film`, `drift` | `film` | `film` holds elevation between 25° and 65°, orbits slowly, and pushes in on the nucleus every few hundred seconds. `drift` is the live camera, which spends most of a take edge-on. |
| `grade` | `0` | on | `0` turns off the film grade: exposure floor, lifted blacks, static dither, and 1080-line star sizing. Use it only for an A/B. |
| `floor` | 0 to 1 | 0.75 | Exposure floor of the depth descent under the grade. Live depth dims to 0.45, which is near black on a phone. |
| `journey` | `0`, `1` | `1`, but `0` when `mode=focus` | The voyage: overture, approach, the star, the world, return. See below. |
| `at` | minutes | 0 | Audition from this minute. A recording still starts from the top. |
| `save` | `opfs` | picker | `opfs` skips the save dialog: the take streams to the origin's private storage and downloads when it ends. Lets a take be started and left alone. |
| `vpulse` | `0`, `1` | `0` | Visual entrainment pulse. Off in films because 6 to 10 Hz flicker is a photosensitivity risk and the audio pulse stays regardless. |
| `swing` | number | 1, or 0.35 in focus | How far the camera swings. |
| `readout` | `0`, `1` | `1` with a session, else `0` | The on-screen session readout in the film HUD. Not in the recording. |

### Focus films (`mode=focus`)

`mode=focus` switches the defaults from a bath to a working session: pomodoro blocks, calmer camera, no journey, struck layers gated through the body of each block.

| Param | Values | Default | What it does |
|---|---|---|---|
| `session` | `pomodoro`, `none` | `pomodoro` in focus, `none` otherwise | Blocks or a single long descent. |
| `work` | minutes, min 1 | 25 | Work block length. |
| `brk` | minutes, min 0.5 | 5 | Break length. |

## The journey

Five chapters on the film clock, placed as fractions of `mins`, with each flight clamped in absolute time so a short test still gets a real approach. Which star is chosen comes from `seed`. There are no per-chapter parameters.

For a 30-minute film:

| Chapter | Starts | Notes |
|---|---|---|
| Overture | 0:00 | one star begins answering strikes at 3:00 |
| Approach | 5:06 | a powers-of-ten flight lasting 2:20 |
| The star | 7:26 | dwell, with the galaxy in miniature around it |
| The world | 13:12 | the crossing takes 1:15, then day rolls into night |
| Return | 21:00 | pull-back lasting 3:00 |
| Coda | 24:00 | the whole disc as the depth curve surfaces |

Preview a chapter with `at`:

```
?film=1&mins=30&at=13      arrive at the world
?film=1&mins=30&at=21      the return
```

## Recipes

Sound bath with the journey, 1440p60, 30 minutes:

```
http://localhost:8137/?film=1&w=2560&h=1440&mins=30&mbps=40&p=1024
```

Same film, pinned galaxy, no save dialog:

```
http://localhost:8137/?film=1&w=2560&h=1440&mins=30&mbps=40&p=1024&seed=abc123&save=opfs
```

4K take:

```
http://localhost:8137/?film=1&w=3840&h=2160&mins=30&mbps=80&p=1024
```

Focus film, 100 minutes of 25/5 pomodoro:

```
http://localhost:8137/?film=1&mode=focus&mins=100&w=2560&h=1440&p=512&fps=60
```

Focus film with a journey anyway:

```
http://localhost:8137/?film=1&mode=focus&mins=50&journey=1
```

Quick two-minute check of the whole journey:

```
http://localhost:8137/?film=1&mins=2&w=1280&h=720&p=256
```

Listen to a recording drive the galaxy:

```
http://localhost:8137/?source=file&url=take.wav
```

Sing over the instrument:

```
http://localhost:8137/?source=mic&accompany=1&sens=0.6
```

## Recording a take

The film HUD has four buttons. It sits over the canvas and is never in the recording.

1. **listen** plays the live instrument, or the rendered master if there is one. Use it to confirm the mode before spending a take.
2. **render master** runs the piece through an offline context faster than real time and emits a score. Optional. A live take without it records the Engine's own audio, and sync is inherent.
3. **save wav** appears after a render. Streams 24-bit PCM to disk. The score JSON saves next to it.
4. **record** opens the recorder, then starts the film from the top. It stops itself at `mins`.

Order matters when a master is rendered: the recorder opens first, then the master starts, and the measured gap is the `lead-in` for `master.sh`.

## After the take

Live take, its own audio is the master:

```
tools/master.sh --live take.webm [out.webm]
```

Take plus a rendered master WAV:

```
tools/master.sh take.webm master.wav [lead-in-seconds] [out.webm]
```

Both normalise to -14 LUFS in two passes, mux with the video copied untouched, and print what YouTube will see.

## Things that cost a take

- **Hidden tabs freeze after about five minutes unless they are playing audio.** A live take with the Engine audible survives. A silent offline render in a background tab does not. Keep the tab visible or audible.
- **A rendered master and the microphone cannot meet.** The master plays in its own audio context. Rendering a master and then singing over it gives a take with none of your voice.
- **Offline render ceiling is 25 to 30 minutes.** Longer needs segments that overlap and sum, since bowls ring for 40 seconds and the gong for 52.
- **Pin `seed` for anything you may re-record.** Without it every take is a different galaxy and a different star.
- **`p=1024` is a million motes.** Check the frame rate in a short test before a long take on a new machine.

## Uploading to YouTube

Copy-paste metadata for a 30-minute sound bath with the journey. Swap the
length wherever it appears for a different `mins`. Everything below claims
only what the piece does: the 432 Hz tuning is an aesthetic choice and the
README says so, so the copy says "tuned to", never "heals" or "treats".

### Title (100 characters max)

Pick one. Front-load the search terms, keep the length and tuning as the
scannable tail.

```
Deep Space Sound Bath · A Journey to One Star · 30 Minutes · 432 Hz Singing Bowls
```
```
30 Minute Sound Bath in a Living Galaxy · Fly to a Star and Its World · 432 Hz
```
```
Cosmic Sound Bath for Deep Rest · Voyage Through a Spiral Galaxy · 30 Min · 432 Hz
```

### Description

The first two lines show before "more", so they carry the hook.

```
A 30-minute sound bath inside a living spiral galaxy. Singing bowls, a gong, and slow drones tuned to A = 432 Hz, while the camera leaves the galaxy, flies to one star, and arrives at its world.

Sit or lie down, let the screen be dim, and let the bowls do the work. Headphones or speakers both work: the pulse under the drones is monaural, so nothing is lost on a laptop.

THE JOURNEY
0:00 The galaxy
3:00 One star begins to answer the bowls
5:06 The approach
7:26 The star, and the galaxy again in miniature
13:12 The world, from daylight into night
21:00 The return
24:00 The galaxy, where it began

HOW TO LISTEN
Best with the lights low and the volume just above quiet. The piece gets dimmer and slower as it goes. That is the design, not your screen.

ABOUT THIS PIECE
Nothing here is a loop or a stock track. The music is generated live by an instrument built for this galaxy: drone voices drifting through a mode, granular texture, struck bells, singing bowls whose partials beat like real metal, and a gong that blooms after the strike. The bowls are scheduled ahead on the audio clock, so the galaxy draws breath before each one lands.

The galaxy is a quarter of a million stars simulated on the GPU. Every take is a different galaxy, chosen by a seed. This one is seed [SEED]. A 6 Hz pulse sits under the sustained layers, easing slower as the piece descends.

Tuned to A = 432 Hz as a musical choice. This is music for rest and attention, not a medical treatment.

Made with ANIMA, a generative audiovisual instrument.

#soundbath #432hz #singingbowls #spaceambient #meditationmusic #deepsleep #ambientmusic #galaxy #generativeart #4k
```

### Tags (500 characters total)

```
sound bath, singing bowls, 432 hz, 432 hz music, deep space ambient, space music, sleep music, meditation music, relaxing music, ambient music, cosmic meditation, galaxy ambient, theta waves, isochronic tones, gong bath, deep relaxation, study music, focus music, planetarium, sci-fi ambient, generative music, 4k space, sound healing music, calm music, drone music
```

### Settings

- **Category:** Music
- **Audience:** not made for kids
- **Altered or synthetic content:** yes. The visuals and music are computer generated. Answering honestly here is what keeps the upload safe.
- **Language:** English
- **License:** Standard YouTube
- **Playlist:** Sound Baths, and Journeys if there will be more than one
- **Comments:** on, hold potentially inappropriate for review
- **End screen:** the previous film and a subscribe button, from 29:40
- **Cards:** one at 13:12 pointing to the previous film

### Thumbnail

- Take the frame from around 18:00 to 20:00, when the star sits at the limb of the world and the atmosphere is a lit crescent. It is the one frame in the film that reads as an image rather than a texture. The approach frame around 6:30 is the alternative.
- Text, three words or fewer, large, high contrast, upper left where the disc is darkest: `ONE STAR` or `30 MIN · 432 Hz`.
- Export at 1280×720, under 2 MB. Do not lift the exposure: the grade already puts blacks at 2/255 so the thumbnail matches the video.

### Pinned comment

```
Every take is a different galaxy. This one is seed [SEED]. The camera leaves the galaxy at 5:06 and arrives at the world at 13:12. If you want to stay in the galaxy, the first film is here: youtube.com/watch?v=oXTIC9ROIqU
```

### Before publishing

- Run `master.sh` so the audio lands at -14 LUFS. YouTube turns loud uploads down but never lifts quiet ones.
- Upload 1440p or 2160p. The 1080p ladder averages 3.3 Mbps and turns dark particles to mush.
- Fill `[SEED]` from the console line at boot, or the take is unrepeatable.
- Set the chapter timestamps to the real ones from the HUD if `mins` was not 30.
