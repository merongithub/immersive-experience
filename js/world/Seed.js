/**
 * Seed — the galaxy you got this time.
 *
 * Until now every session opened onto the same two-armed spiral at the same
 * pitch in the same colours. That is the right decision for a piece you sit
 * with once and the wrong one for a piece people come back to: there is
 * nothing to return FOR. A field that is identical on the ninth visit has
 * quietly told you the eighth was the last one worth making.
 *
 * So the structure is drawn from a seed. Arm count, how tightly the arms wind,
 * where the nebulae sit and what colour they are, and the palette's resting
 * bias — all of it fixed for a session and different in the next one. It is
 * one number, it is in the URL, and it is on the keepsake, so a galaxy you
 * liked is one you can go back to and one you can hand to somebody else.
 *
 * What is deliberately NOT seeded: disc radius, core radius, thickness, the
 * rotation curve. Those are what make it read as a galaxy at all. Vary them
 * and you are not generating galaxies, you are generating shapes — and about
 * one in five of them would be worse than the one this replaced.
 */

/* Curated rather than random. A hue picked uniformly off the wheel lands on
   sour yellow-green about a sixth of the time, and one bad draw is enough for
   somebody to decide the piece looks cheap. These three sit AROUND the
   violet -> ember -> bone ramp rather than off it: teal extends its cold end,
   magenta sits between violet and ember, gold between ember and bone. The
   field bends toward them locally and never leaves its key. */
const NEBULA_HUES = [
  { name: "teal",    rgb: [0.32, 0.86, 0.92] },
  { name: "magenta", rgb: [0.94, 0.36, 0.78] },
  { name: "gold",    rgb: [1.00, 0.78, 0.38] },
  { name: "rose",    rgb: [1.00, 0.48, 0.52] },
  { name: "ice",     rgb: [0.62, 0.78, 1.00] },
];

/** mulberry32 — small, fast, and good enough that nobody will see a pattern. */
export function makeRng(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A second seeded stream for one purpose, off the same session.
 *
 * Anything added after the fact draws from its own stream rather than from
 * session.rng — which Nova reads lazily, at detonation time — or every
 * existing seed would start detonating somewhere new the moment a feature
 * was added that took a few numbers first.
 */
export function makeStream(session, name) {
  return makeRng(hashString(`${session.label}/${name}`));
}

/** Fold a string into a 32-bit integer. */
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Build a session's parameters from a seed string.
 *
 * @param {string} label  the seed, as it appears in the URL and on the sigil
 */
export function makeSession(label) {
  const rng = makeRng(hashString(label));

  /* Two arms is the classic and reads cleanest, three is the most striking,
     four gets busy at this particle density and starts to look like a
     pinwheel. Weighted accordingly rather than picked flat — "varied" should
     not mean "as often bad as good". */
  const r = rng();
  const arms = r < 0.5 ? 2 : r < 0.85 ? 3 : 4;

  /* How open the spiral is. The floor is not arbitrary: below about 0.5 the
     arms wrap past a full turn, overlap themselves, and read as concentric
     rings rather than as a spiral. More arms need a more open winding or they
     collide, so the floor rises with the count. */
  const pitchLo = 0.52 + (arms - 2) * 0.07;
  const pitch = pitchLo + rng() * 0.26;

  /* Where the palette rests before the music moves it. A narrow range: this
     is the difference between a cold session and a warm one, not between two
     different pieces. */
  const warmthBias = (rng() - 0.5) * 0.22;

  /* Two or three regions. One is a blemish, four and the disc is a smear of
     competing colours with no dark left between them. */
  const count = rng() < 0.45 ? 2 : 3;
  const picks = [...NEBULA_HUES];
  const nebulae = [];
  for (let i = 0; i < count; i++) {
    const hue = picks.splice((rng() * picks.length) | 0, 1)[0];
    /* Out in the disc where the arms are, never over the core — the nucleus
       is the one place allowed to reach bone white and a tint sitting on it
       just makes it look dirty. The clearance is structural rather than a
       range that happens to work: distance is measured from the region's own
       EDGE, so a large region is pushed further out instead of swallowing the
       centre. Drawing the two independently let a third of all regions reach
       the core, which is the sort of thing that shows up once in twenty
       sessions and reads as a rendering fault. */
    const radius = 11 + rng() * 9;
    nebulae.push({
      hue: hue.name,
      rgb: hue.rgb,
      radius,
      angle: rng() * Math.PI * 2,
      dist: radius + 10 + rng() * 13,
      height: (rng() - 0.5) * 3,
      // Each drifts at its own rate, so the regions separate over a long sit
      // instead of turning as one rigid painted layer.
      drift: 0.004 + rng() * 0.010,
      strength: 0.55 + rng() * 0.45,
    });
  }

  return { label, rng, arms, pitch, warmthBias, nebulae };
}

/**
 * The seed for this session: whatever `?seed=` says, or a fresh one.
 *
 * Short and typeable on purpose. It is meant to be read off a keepsake and
 * passed to somebody, and a UUID is neither.
 */
export function sessionSeed() {
  const q = new URLSearchParams(location.search).get("seed");
  if (q) return q.slice(0, 12);
  return Math.floor(Math.random() * 0x7fffffff).toString(36);
}

/** The session in force. Set once at boot, read by the world as it builds. */
export let SESSION = makeSession("anima");

export function applySession(label) {
  SESSION = makeSession(label);
  return SESSION;
}
