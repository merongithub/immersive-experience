/**
 * Readout — the session, stated quietly, inside the frame.
 *
 * Someone working wants to know how far into the block they are. Making them
 * look at a clock costs exactly the attention the film is trying to protect, so
 * the film says it — but at an opacity you have to choose to read.
 *
 * It is drawn INTO the canvas rather than over it in the DOM, because
 * captureStream() records the canvas alone and anything in the DOM would be
 * visible while filming and absent from the file. It renders after the
 * composite, so bloom and grain never touch the type: everything else in the
 * piece is light, and this is the one element that has to stay legible.
 */

import * as THREE from "three";

const W = 760;
const H = 120;

export class Readout {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = W;
    this.canvas.height = H;
    this.c = this.canvas.getContext("2d");

    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;

    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);

    // Spans 0..1 across the viewport, so placement is in screen fractions.
    this.cam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);

    this._key = "";
    this.setSize(1920, 1080);
  }

  setSize(w, h) {
    // Sized from the canvas's own pixels so the type stays the same physical
    // size whatever the film is rendered at, rather than scaling with it.
    const scale = Math.max(0.55, Math.min(1.6, w / 2560));
    const pw = (W * scale) / w;
    const ph = (H * scale) / h;
    this.mesh.scale.set(pw, ph, 1);
    this.mesh.position.set(56 / w + pw / 2, 44 / h + ph / 2, 0);
  }

  /**
   * @param {{phase:string, left:number, cycle:number, cycles:number}} info
   * @param {number} depth  dims the type as the session descends
   */
  update(info, depth = 0) {
    if (!info) return;
    const mm = Math.floor(info.left / 60);
    const ss = Math.floor(info.left % 60);
    const label = `${info.phase.toUpperCase()}  ${mm}:${String(ss).padStart(2, "0")}`;
    const key = `${label}|${info.cycle}|${info.cycles}|${depth.toFixed(2)}`;
    if (key === this._key) return;      // redraw only when the second turns
    this._key = key;

    const c = this.c;
    c.clearRect(0, 0, W, H);

    // Recedes as the block deepens, but never disappears — you should be able
    // to find it without waiting for it to come back.
    const a = 0.34 * (1 - depth * 0.45);

    c.textBaseline = "middle";
    c.letterSpacing = "7px";
    c.font = '300 40px "IBM Plex Mono", ui-monospace, Menlo, monospace';
    c.fillStyle = `rgba(239,230,220,${a.toFixed(3)})`;
    c.fillText(label, 2, 34);

    // One mark per block: filled for done, hollow for the rest. Reads as
    // progress at a glance without resolving into a number to think about.
    const r = 6;
    const gap = 26;
    for (let i = 0; i < Math.min(info.cycles, 12); i++) {
      const x = 8 + r + i * gap;
      const y = 84;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      if (i < info.cycle) {
        c.fillStyle = `rgba(239,230,220,${(a * 0.9).toFixed(3)})`;
        c.fill();
      } else {
        // A hollow ring at a third of the text's alpha is invisible against a
        // black field — it needs most of it to read as a mark at all.
        c.strokeStyle = `rgba(239,230,220,${(a * 0.8).toFixed(3)})`;
        c.lineWidth = 2;
        c.stroke();
      }
    }

    this.tex.needsUpdate = true;
  }

  /** After the composite, so post never touches the type. */
  render(renderer) {
    const prev = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, this.cam);
    renderer.autoClear = prev;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}
