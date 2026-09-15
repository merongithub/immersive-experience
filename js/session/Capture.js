/**
 * Capture — the piece, as a film.
 *
 * Video off the canvas, audio off the Engine's compressor, both into one
 * MediaRecorder. Taking both from the same clock is the whole reason to do it
 * this way rather than with a screen recorder: there is no drift to correct
 * over an hour, because there are not two clocks.
 *
 * Two decisions worth knowing about:
 *
 *   MANUAL FRAMES  captureStream(0) plus an explicit requestFrame() after each
 *                  composite, rather than captureStream(60). The auto-capturing
 *                  form samples on a timer against a WebGL canvas that does not
 *                  preserve its drawing buffer — which can emit blank frames,
 *                  and which duplicates or drops whenever the render rate and
 *                  the capture rate disagree. One drawn frame, one recorded
 *                  frame, and a slow machine produces an honest variable rate
 *                  instead of a stuttering fixed one.
 *
 *   STREAMED TO DISK  an hour at 40 Mbps is about 18 GB, which is not going to
 *                  sit in a Blob. Chunks are written to a file handle as they
 *                  arrive. The handle comes from a save dialog when there is
 *                  somebody there to answer it; otherwise from the origin's
 *                  private file system, which needs neither a dialog nor a
 *                  gesture, and the finished file is handed to the browser's
 *                  downloader at the end. That second path is what lets a
 *                  twenty-minute take run unattended. Memory and a download is
 *                  the last resort — fine for a few minutes, not for a bath.
 *
 * Note the HTML chrome is NOT in the recording. captureStream reads the canvas
 * only, so the readouts and mode list never appear. Hiding them is for the
 * operator and for screen recorders, not for this.
 */

const MIMES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

export class Capture {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {{tap: function}} opts.source  whatever is making sound — an Engine
   *   or a FilmDriver. Both expose tap(), so recording does not care which.
   */
  constructor({ canvas, source, bitrate = 40e6, fps = 60, picker = true }) {
    this.canvas = canvas;
    this.source = source;
    this.bitrate = bitrate;
    /* false skips the save dialog and goes straight to private storage — for
       a take started by a script, or one nobody wants to babysit. */
    this.picker = picker;
    this._opfs = null;    // { root, name } while writing to private storage

    /* Frames are requested once per composite, and rAF runs at the DISPLAY's
       refresh rate — which on a 120 Hz panel means a 120 fps variable-rate
       file. YouTube caps at 60, so everything above it is bytes and encoder
       load spent on frames nobody will ever see. Throttling here also pushes
       the result close to constant-rate, which transcodes far more predictably
       than the 1000/1 timebase MediaRecorder otherwise emits.

       The 2 ms tolerance matters: without it, a 60 Hz display whose frames
       arrive a hair early would have every second frame rejected and record at
       30. */
    this.fps = fps;
    this._minGap = 1000 / fps - 2;
    this._lastFrame = -1e9;

    this.rec = null;
    this.track = null;
    this.writer = null;
    this.chunks = null;
    this.bytes = 0;
    this.frames = 0;
    this.startedAt = 0;
    this._queue = Promise.resolve();
  }

  get recording() { return !!this.rec && this.rec.state === "recording"; }

  static get supported() {
    return typeof MediaRecorder !== "undefined"
        && !!HTMLCanvasElement.prototype.captureStream;
  }

  /** Must be called from a user gesture — the file picker requires one. */
  async start(name = "anima") {
    if (this.rec) return false;

    const dest = this.source?.tap();
    if (!dest) throw new Error("Start the sound before recording.");

    const mime = MIMES.find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error("This browser cannot record video.");

    // Ask for the file first: the picker needs the user gesture, and an
    // AbortError here should not leave a half-built recorder behind.
    this.writer = await this._openFile(name, mime);
    this.chunks = this.writer ? null : [];

    const v = this.canvas.captureStream(0);
    this.track = v.getVideoTracks()[0];
    const stream = new MediaStream([this.track, ...dest.stream.getAudioTracks()]);

    this.rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: this.bitrate,
      audioBitsPerSecond: 256000,
    });

    this.rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      this.bytes += e.data.size;
      if (this.writer) {
        // Serialised: writes must not interleave, and awaiting inside the
        // event handler would let the next chunk overtake this one.
        this._queue = this._queue.then(() => this.writer.write(e.data));
      } else {
        this.chunks.push(e.data);
      }
    };

    this.bytes = 0;
    this.frames = 0;
    this.startedAt = performance.now();
    this.mime = mime;
    this.rec.start(2000);
    return true;
  }

  async _openFile(name, mime) {
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    this._opfs = null;

    if (this.picker && window.showSaveFilePicker) {
      try {
        const handle = await showSaveFilePicker({
          suggestedName: `${name}.${ext}`,
          types: [{
            description: "Video",
            accept: { [mime.split(";")[0]]: [`.${ext}`] },
          }],
        });
        return await handle.createWritable();
      } catch {
        // Declined. Fall through to private storage rather than to memory.
      }
    }

    /* The origin's private file system. No dialog and no gesture, and it is
       real disk, so a multi-gigabyte take streams to it as happily as to a
       chosen file. It is not user-visible, which is why stop() downloads the
       result — and why the previous take is cleared here first: the quota is
       shared with everything else the site stores. */
    if (navigator.storage?.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        for await (const key of root.keys()) {
          try { await root.removeEntry(key); } catch { /* in use elsewhere */ }
        }
        const fileName = `${name}.${ext}`;
        const fh = await root.getFileHandle(fileName, { create: true });
        this._opfs = { root, name: fileName, handle: fh };
        return await fh.createWritable();
      } catch (err) {
        console.warn("[ANIMA] private storage unavailable, recording to memory", err);
      }
    }
    return null;
  }

  /** Called by Organism once per composite. */
  frame() {
    if (!this.recording) return;
    const now = performance.now();
    if (now - this._lastFrame < this._minGap) return;
    this._lastFrame = now;
    this.track.requestFrame?.();
    this.frames++;
  }

  /** @returns {{seconds:number, gb:number, fps:number, saved:boolean}|null} */
  stats() {
    if (!this.rec) return null;
    const seconds = (performance.now() - this.startedAt) / 1000;
    return {
      seconds,
      gb: this.bytes / 1e9,
      fps: seconds > 1 ? this.frames / seconds : 0,
      saved: !!this.writer,
    };
  }

  async stop() {
    const rec = this.rec;
    if (!rec) return null;
    this.rec = null;

    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.stop();
    await stopped;
    await this._queue;

    const out = { bytes: this.bytes, seconds: (performance.now() - this.startedAt) / 1000 };

    if (this.writer) {
      await this.writer.close();
      this.writer = null;
      if (this._opfs) {
        // Nobody can see private storage; hand the finished file to the
        // browser's downloader. The Blob is file-backed, so this is a copy
        // to the downloads folder, not a load into memory.
        const file = await this._opfs.handle.getFile();
        const url = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = url;
        a.download = this._opfs.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        out.saved = false;
        out.name = this._opfs.name;
        return out;
      }
      out.saved = true;
      return out;
    }

    const blob = new Blob(this.chunks, { type: rec.mimeType });
    this.chunks = null;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `anima.${rec.mimeType.startsWith("video/mp4") ? "mp4" : "webm"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    out.saved = false;
    return out;
  }
}
