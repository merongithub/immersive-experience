# ANIMA — working plan

Last updated 2026-09-12. This is the pick-up-where-we-left-off document: what is
done, what was decided, and what is next. The README describes the piece as it
is; this describes where it is going.

## Governing rule

> Give people peace and excitement, not overwhelm. — restraint over spectacle;
> fewer, gentler events.

## Where things stand

Branch `voice-and-mystery` (the ear + converge/diverge + film hardening
committed as `19a470b`):

- **The ear (Phase 0 of creative-space) — done and validated.** `js/listen/`
  (`Source`, `Analysis`, `LiveDriver`) turns a mic'd instrument into Bus
  signals: spectral-flux onsets, chroma from interpolated peaks, note-at-onset,
  inter-onset tempo prediction → `anticipation`. `?source=mic|file|engine`.
  Validated on a synthetic handpan recording at 120 fps: 16/16 groove strikes,
  every note named, tempo confidence 1.0. Not yet heard a real instrument —
  **the mic tuning session with a handpan/bowls is still owed.**
- **Converge / diverge** star pattern (`uConverge` in `Tendrils.js`): strikes
  spread the disc outward along a spiral, quiet gathers it back. Accents
  (strength > 0.75) launch a ring. Strike weight compresses with density so a
  groove is rhythm, not lightning.
- **Film-mode hardening** after the 20-minute take: camera locks during a take;
  frames paced off the audio clock when the tab is hidden (`attachPacer`);
  `&save=opfs` records without a save dialog and downloads at the end; the
  offline render yields via `MessageChannel` (immune to timer throttling);
  `Engine.setMode` guarded against an unbuilt graph.
- **First film shipped**: youtube.com/watch?v=oXTIC9ROIqU — 1080p60 live take,
  20:00, bath. Source: `~/Downloads/anima-20min-2026-08-30-02-46.webm`.

## Lessons from the first film (2026-08-29)

1. Chrome **freezes a hidden tab after ~5 min unless it is playing audio**.
   The offline master render (no audio) stalled at 50%; a live take (Engine
   audible) survives. Any long browser job must either be audible, be visible,
   or run in a Chrome started with `--disable-renderer-backgrounding
   --disable-background-timer-throttling --disable-backgrounding-occluded-windows`.
2. `requestAnimationFrame` halts in a hidden tab → frozen picture while the
   master plays on. Fixed by `attachPacer`.
3. A scroll on the page mid-take handed the film to free look, parked inside
   the disc. Fixed by `rig.locked`.
4. YouTube: a 1080p upload gets an AVC ladder averaging ~3.3 Mbps. Dark
   particles + animated grain at that budget = mush. **Upload 4K.**
5. The live drift camera is wrong for film: base elevation 54° ± 39° swing,
   + 17° toward the plane with depth → it lives within ~10° of the plane and
   the disc reads as a stretched streak; the spiral is almost never on screen.
6. Depth dims exposure to ~0.5 → near-black on a phone. Film needs a floor.

## Next: the film pipeline (state of the art)

Order of work:

1. ~~**Film camera preset**~~ — done. `CameraRig._driftPointFilm`, on by
   default in film mode (`&cam=drift` opts back into the live drift): elevation
   held 25–65° above the plane (base 45°, ±10° on a ~14-min cycle, depth leans
   it down a little, clamp catches everything), orbit at 0.46–1.03°/s (live is
   1.03–2.75), push-in toward the nucleus (radius ×0.55, ~40 s each way) from a
   smoothstepped 9.5-min sine whose depth a 45-min sine modulates — first one
   lands ~4 min in; per simulated 20-min take roughly one full arrival, one
   half-lean, one skip. Aim wander slower/smaller than live and stills as a
   push arrives. Simulated 20 min: elevation 29.6–52.6°, radius 52–99.
   **Not yet seen on screen.**
2. ~~**Film grade**~~ — done, on by default in film mode (`&grade=0` for an
   A/B). Exposure floor 0.75 (`&floor=`), the depth descent rescaled onto it;
   `FilmGradeShader` after `OutputPass`: blacks at 2/255 plus a static
   void-and-cluster blue-noise dither (±1/255, triangular, luma) replacing the
   animated grain; sprites sized in 1080-line pixels with a 1.25 px floor
   (2.5 px at 4K) and brightness compensation (`POINT_GLSL`). Measured in
   headless Chrome: sprite light conserved to 0.3% across scales; a graded 4K
   frame downscaled to 1080 carries 104% of a 1080 take's light, an ungraded
   one 20% — **the 4K upload would have been a fifth as bright without this.**
   Black renders as {1, 2, 3}/255 at 1:6:1, identical frame to frame.
   **Not yet seen through an encoder** — check on the 1440p re-record.
3. **Quick win**: re-record live at 2560×1440 with 1+2, `master.sh --live`,
   re-upload. The 1440p VP9 ladder alone transforms it.
4. **Offline 4K renderer**: step the world at a fixed 1/60 s with the
   FilmDriver playhead set from the score (no wall clock); render 3840×2160;
   WebCodecs `VideoEncoder` (H.264 High / HEVC, 80–120 Mbps) → raw stream to
   private storage → download → `ffmpeg` mux with the 24-bit master WAV →
   `loudnorm -14 LUFS` → MP4. Render speed irrelevant; frame-accurate sync.
   Upload spec: 2160p, 60 fps (test 30), yuv420p, AAC 384k or PCM.
5. Later: HDR (HLG 10-bit) upload — YouTube gives it its own ladder and the
   bloom would glow; Chrome's 10-bit WebCodecs path is shaky, so phase two.

## The journey (2026-09-12) — built, not yet committed

Request: "take a trip to the galaxy … zoom into a particular planet or star so
we can build a story." `Voyage` (where and when) + `StarSystem` (the bodies) +
`CameraRig._voyage` (three poses joined by log-distance flights). Five
chapters on the film clock: overture (a glint that answers strikes) →
approach → the star → the world (daylight → terminator → night side, star at
the limb at the deepest point) → return → coda. First feedback (same day):
the textured sun read as a fireball pasted onto the galaxy and the world was
out of proportion — so the star became light (a point in a halo, no surface)
inside a mote disc that repeats the galaxy at small scale (Kepler orbits,
seeded rings, a lane at the world's orbit, strike waves), and the world shot
pulled back to a quarter of the frame. On by default in film mode
except focus; `&journey=0`, `&at=` for auditioning. Tuned from headless stills
across three seeds (teal/ringed, magenta, gold): bloom eased back in close-up
(UnrealBloom's widest kernels are truncated at 1σ → square halo on a lit
disc), star held at ~0.55 HDR so its surface survives. **Not yet seen moving
or with the music**; the glint's answer to strikes can only be judged with
audio. Live piece unchanged (journey is film-only for now — a depth-driven
live version, "be still and you are carried to a world", is the obvious
next step if wanted).

## Next: creative-space (the derivative)

Decisions (2026-08-29):
1. Stillness/depth **replaced by flow** — continuous playing deepens, silence
   drifts back.
2. Note → colour **fixed per session**: 12 pitch classes on a seeded palette
   ring; each class has a fixed home direction in the cloud.
3. Built-in Engine as **accompaniment** (reference-spectrum subtraction + score
   masking are in `LiveDriver`; `Engine.setKey` + key detection later so the
   drone follows the player's key).
4. First scene **Nebula**: 3D curl, no rotation; velocity `.w` = per-particle
   hue charge painted by note pulses.
5. Keepsake: **constellation drawing** (onset = star, phrase = connected figure).

Requests while watching the rig: shooting stars from the darkest side of the
frame; less flashing (done in the driver, keep for the Nebula); bigger, softer
bodies; a **journey** — the camera sometimes travels in to dwell on one random
body, then drifts back out.

Phasing: 1 page + `Cosmos` + `Nebula` + `Flow` + palettes + legend ring →
2 tempo/anticipation polish, bowl beating, sustained-tone draw → 3 constellation,
key following, film mode on the new page.

Planned files: `creative-space.html`, `css/creative.css`, `js/creative.js`,
`js/creative/{Cosmos,Nebula,palettes,Flow,Constellation}.js`.

## Loose ends

- Test `?source=mic` with a real handpan or bowls; tune `sens`.
- `?source=engine` hears the Engine's grain layer as strikes — documented, not
  a bug to chase.
- Fallback takes in `~/Downloads/anima-takes/` can be deleted.
