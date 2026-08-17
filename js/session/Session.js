/**
 * Session — the shape of a working hour.
 *
 * The single-descent film curve is right for a sound bath and wrong for work.
 * Somebody sitting down to concentrate is not on one long slide into stillness;
 * they are on a cycle, and the useful thing a piece of focus music can do is
 * carry that cycle so they do not have to watch a clock.
 *
 * So the film is built out of pomodoro blocks: descend into a work block, hold
 * there, surface for the break, descend again a little deeper than last time.
 *
 * Two things this owns beyond depth:
 *
 *   GATE   how much the event layers are allowed to play. Through the body of a
 *          work block this sits near zero, because a struck bell is an
 *          attention magnet and attention is the entire commodity here. Events
 *          come back at the end of a block and through the break, where they
 *          are not interruptions but the thing telling you the block is over.
 *
 *   PHASE  what to call the current stretch, and how long is left of it, so the
 *          readout can say it without anybody breaking off to work it out.
 */

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const POMODORO = { work: 25 * 60, brk: 5 * 60, lead: 90 };

/** A single continuous descent — the sound-bath shape, as a session config. */
export const CONTINUOUS = null;

/**
 * @param {number} t      seconds into the film
 * @param {number} total  film length in seconds
 * @param {object} cfg    {work, brk, lead} in seconds
 * @returns {{depth:number, gate:number, phase:string, left:number,
 *            cycle:number, cycles:number}}
 */
export function sessionAt(t, total, cfg = POMODORO) {
  const span = cfg.work + cfg.brk;
  const idx = Math.floor(t / span);
  const u = t - idx * span;
  const inWork = u < cfg.work;

  /* Each block settles a little lower than the one before, so a third pomodoro
     is quieter and darker than the first without anything announcing it.
     Capped, or a two-hour film would end in the dark. */
  const base = Math.min(0.42, idx * 0.11);

  let depth, gate;

  if (inWork) {
    const w = u / cfg.work;
    // Ease down over the first sixth rather than dropping on the boundary —
    // the transition should be something you notice only in retrospect.
    depth = base + (0.92 - base) * smoothstep(0.0, 0.16, w);
    // Silence through the body, events returning over the last tenth as the
    // block runs out. This is the piece telling you to look up.
    gate = 0.10 + 0.90 * smoothstep(0.90, 1.0, w);
  } else {
    const b = (u - cfg.work) / cfg.brk;
    // Surface briskly — a break you cannot feel arriving is not a break.
    depth = 0.92 + (base * 0.30 - 0.92) * smoothstep(0.0, 0.25, b);
    gate = 1;
  }

  /* The opening stays bright regardless of the cycle. The first minute is what
     decides whether anyone is still here for the second one, and a film that
     begins already dimmed has spent that. */
  depth *= smoothstep(0, cfg.lead, t);

  // And it surfaces at the end, whatever phase it happens to be in.
  depth *= 1 - smoothstep(0.94, 1.0, total > 0 ? t / total : 0) * 0.7;

  return {
    depth: Math.max(0, Math.min(1, depth)),
    gate,
    phase: inWork ? "focus" : "break",
    left: Math.max(0, inWork ? cfg.work - u : span - u),
    cycle: idx,
    cycles: Math.max(1, Math.ceil(total / span)),
  };
}

/** Seconds at which a phase changes — where the transition markers belong. */
export function boundaries(total, cfg = POMODORO) {
  const span = cfg.work + cfg.brk;
  const out = [];
  for (let t = 0; t < total; t += span) {
    if (t + cfg.work < total) out.push({ t: t + cfg.work, to: "break" });
    if (t + span < total) out.push({ t: t + span, to: "focus" });
  }
  return out;
}
