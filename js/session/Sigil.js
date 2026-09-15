/**
 * Sigil — the session, drawn.
 *
 * One continuous spiral from the centre outward, one full turn per minute. It
 * is drawn as a single unbroken path rather than as concentric rings because a
 * session IS continuous — rings would imply the minutes were separable, and the
 * whole idea is that the last five minutes only exist because of the first ten.
 *
 * What the drawing encodes:
 *   radius     time — one turn per minute, outward
 *   thickness  energy at that moment
 *   colour     warmth, on the same violet → ember → bone ramp as the field
 *   wobble     breath
 *   solidity   stillness — a still passage draws unbroken, a restless one frays
 *   nucleus    the deepest point the session reached
 *   ticks      each bowl, gong or bell, at the angle where it landed
 *
 * Two people sitting the same length of time produce visibly different marks.
 * That is the entire point — it is a record, not a badge.
 */

const C_VIOLET = [0.36, 0.13, 0.78];
const C_EMBER  = [1.00, 0.34, 0.11];
const C_BONE   = [1.00, 0.93, 0.85];

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The palette, matching the shader's anima() so the keepsake is in the same key. */
function anima(t, h) {
  const k = smoothstep(0.12, 1.02, t);
  const lift = Math.max(0, Math.min(1, h)) * 0.62;
  const out = [];
  for (let i = 0; i < 3; i++) {
    const base = C_VIOLET[i] + (C_EMBER[i] - C_VIOLET[i]) * k;
    out[i] = Math.round((base + (C_BONE[i] - base) * lift) * 255);
  }
  return out;
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export class Sigil {
  /**
   * @param {Trace} trace
   * @param {number} size  square edge, in pixels
   */
  static render(trace, size = 1400) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d");

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size * 0.47;      // a little high; the caption sits below
    const samples = trace.samples;
    if (!samples.length) return cv;

    const total = Math.max(trace.elapsed, 30);
    const turns = Math.max(1.2, total / 60);
    const rInner = size * 0.055;
    const rOuter = size * 0.40;

    ctx.globalCompositeOperation = "lighter";   // additive, like the field
    ctx.lineCap = "round";

    /* --- the spiral --------------------------------------------------- */
    const STEPS = Math.max(900, Math.floor(turns * 420));
    let prev = null;

    for (let i = 0; i <= STEPS; i++) {
      const u = i / STEPS;                       // 0..1 through the session
      const s = samples[Math.min(samples.length - 1,
        Math.floor(u * samples.length))];

      const angle = u * turns * Math.PI * 2 - Math.PI / 2;
      const baseR = rInner + (rOuter - rInner) * u;

      // Breath makes the line undulate; the amplitude is small enough that the
      // spiral never crosses itself, which would read as an error.
      const wob = (s.breath - 0.5) * (size * 0.010) * (0.4 + s.energy);
      const r = baseR + wob;

      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;

      if (prev) {
        // Stillness draws solid; activity frays the line into broken strokes.
        const solid = s.still;
        const skip = solid < 0.55 && ((i * 7919) % 100) / 100 > 0.35 + solid;

        if (!skip) {
          const heat = Math.min(1, s.energy * 0.55 + s.depth * 0.25);
          const c = anima(s.warmth + s.depth * 0.10, heat * heat);
          // Held brighter than the live field. The galaxy is viewed in a dark
          // room by someone who has been sitting in it; the keepsake gets
          // opened on a phone in daylight and has to survive that.
          ctx.strokeStyle = rgba(c, 0.55 + s.energy * 0.42);
          ctx.lineWidth = size * (0.0016 + s.energy * 0.0050) * (1 - s.depth * 0.30);
          ctx.beginPath();
          ctx.moveTo(prev[0], prev[1]);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
      }
      prev = [x, y];
    }

    /* --- strikes ------------------------------------------------------
       Each bowl or bell as a short radial tick at the angle it happened. This
       is what makes two sessions of the same length unmistakably different. */
    for (const m of trace.marks) {
      const u = Math.max(0, Math.min(1, m.t / total));
      const s = samples[Math.min(samples.length - 1, Math.floor(u * samples.length))];
      const angle = u * turns * Math.PI * 2 - Math.PI / 2;
      const r = rInner + (rOuter - rInner) * u;
      const len = size * (0.006 + m.mag * 0.016);
      const c = anima(s.warmth + 0.25, 0.55);

      ctx.strokeStyle = rgba(c, 0.50 + m.mag * 0.40);
      ctx.lineWidth = size * 0.0020;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * (r - len / 2), cy + Math.sin(angle) * (r - len / 2));
      ctx.lineTo(cx + Math.cos(angle) * (r + len / 2), cy + Math.sin(angle) * (r + len / 2));
      ctx.stroke();
    }

    /* --- nucleus ------------------------------------------------------
       Sized by the deepest point reached. A restless session leaves a faint
       dot; a still one leaves something with weight at the centre. */
    const dR = size * (0.012 + trace.maxDepth * 0.055);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, dR);
    const cCore = anima(0.30 + trace.maxDepth * 0.2, 0.95);
    g.addColorStop(0, rgba(cCore, 0.98));
    g.addColorStop(0.35, rgba(cCore, 0.42));
    g.addColorStop(1, rgba(cCore, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, dR, 0, Math.PI * 2);
    ctx.fill();

    /* --- caption ------------------------------------------------------ */
    ctx.globalCompositeOperation = "source-over";
    const sum = trace.summary();
    const mono = '300 {S}px "IBM Plex Mono", ui-monospace, Menlo, monospace';
    const y0 = size * 0.905;

    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(239,230,220,0.92)";
    ctx.font = mono.replace("{S}", Math.round(size * 0.030));
    ctx.letterSpacing = `${size * 0.004}px`;
    ctx.fillText("ANIMA", cx, y0 - size * 0.048);

    ctx.fillStyle = "rgba(239,230,220,0.62)";
    ctx.font = mono.replace("{S}", Math.round(size * 0.020));
    ctx.letterSpacing = `${size * 0.001}px`;
    const line = trace.restored
      ? `${sum.duration}  ·  depth ${sum.depth}  ·  ${sum.strikes} strikes`
      : `${sum.duration}  ·  depth ${sum.depth}  ·  still ${sum.stillPct}%  ·  ${sum.strikes} strikes`;
    ctx.fillText(line, cx, y0);

    ctx.fillStyle = "rgba(239,230,220,0.32)";
    ctx.font = mono.replace("{S}", Math.round(size * 0.0155));
    const modes = sum.modes.length ? sum.modes.join(" → ") : "meditate";
    const date = sum.date.toLocaleDateString(undefined,
      { year: "numeric", month: "short", day: "numeric" });
    ctx.fillText(`${modes}${sum.voiced ? "  ·  with voice" : ""}  ·  ${date}`,
      cx, y0 + size * 0.030);

    /* The seed. Faint, and last, because it is the one line here that is not
       about the sitting — but it is the line that lets somebody go back to a
       galaxy they liked, or hand it to someone else. A keepsake of a field
       that can never be seen again is a smaller thing than one that can. */
    if (trace.seed) {
      ctx.fillStyle = "rgba(239,230,220,0.20)";
      ctx.font = mono.replace("{S}", Math.round(size * 0.0135));
      ctx.fillText(`seed ${trace.seed}`, cx, y0 + size * 0.058);
    }

    return cv;
  }

  /** Trigger a download. The only way any of this leaves the machine. */
  static save(canvas, name) {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, "image/png");
  }
}
