// The HTML-in-Canvas face source (Chromium 157+; htmlcanvas.d.ts). Each card's real face moves
// into a small 2D canvas with `content="drawable"` inside the card, where it stays laid out,
// focusable and hit-testable but is painted only by `drawElementImage`. The browser paints it
// with its own engine (no snapshot, no copied styles, no stand-ins), and every change it reports
// in a `paint` event is uploaded to the GPU in place. The canvas is invisible, like the ghost
// face of the snapshot path; WebGL draws the card.
//
// Card backs are hidden until a card is turned, and a canvas cannot draw what is not rendered,
// so each back size is drawn from a copy in an invisible canvas of its own at the page's corner.
// Faces and backs baked at build time (baked.ts) keep their baked image.

import { FACE, type Geometry } from "../data";
import type { CardRefs } from "../dom";
import { artOf } from "./art";
import { SHADER_DRAWN } from "./bake";
import { bakedImage } from "./baked";
import type { FaceImages, FaceSource } from "./faces";

/** Whether this browser can draw elements into a canvas (HTML-in-Canvas). */
export function hasDrawableCanvas(): boolean {
  return (
    "requestPaint" in HTMLCanvasElement.prototype &&
    "drawElementImage" in CanvasRenderingContext2D.prototype
  );
}

interface Drawn {
  readonly canvas: HTMLCanvasElement;
  readonly el: HTMLElement;
  readonly board: { readonly bw: number; readonly bh: number };
  /** Device px per artboard px of the canvas's backing store. */
  scale: number;
  /** Resolves at the canvas's next paint. */
  readonly nextPaint: () => Promise<void>;
}

/**
 * The face source; `changed(id)` is told when a card's face canvas has drawn something new,
 * so the renderer can upload it.
 */
export function drawableFaces(root: HTMLElement, changed: (id: string) => void): FaceSource & {
  /** Redraws a card's face at `scale` device px per artboard px (the showcase's sharper copy). */
  rescale: (id: string, scale: number) => void;
} {
  const faces = new Map<string, Drawn>();
  const backs = new Map<string, Drawn>();

  function mount(el: HTMLElement, board: Drawn["board"], parent: Element, onDraw: () => void): Drawn {
    const canvas = document.createElement("canvas");
    canvas.className = "gl-drawable";
    canvas.setAttribute("content", "drawable");
    canvas.style.setProperty("--draw-w", `${String(board.bw)}px`);
    canvas.style.setProperty("--draw-h", `${String(board.bh)}px`);
    el.setAttribute("drawable", "");
    // The canvas carries the card's scale. With the face's own scale(--face-k) left on, the
    // face filled only that share of the canvas in Chromium 159 (a bare transformed element in
    // a drawable canvas drew untransformed, so something else in the card is involved).
    el.style.setProperty("transform", "none");
    parent.append(canvas);
    canvas.append(el);
    const ctx = canvas.getContext("2d");
    if (!ctx?.drawElementImage) throw new Error("gl: this canvas cannot draw elements");
    const draw = ctx.drawElementImage.bind(ctx);
    let waiters: (() => void)[] = [];
    canvas.onpaint = () => {
      ctx.reset();
      draw(el, 0, 0, canvas.width, canvas.height);
      for (const w of waiters) w();
      waiters = [];
      onDraw();
    };
    return {
      canvas,
      el,
      board,
      scale: 0,
      nextPaint: async () =>
        new Promise((resolve) => {
          waiters.push(resolve);
        }),
    };
  }

  /** Sizes the backing store; resolves once the element is drawn at that size. */
  async function resize(d: Drawn, scale: number): Promise<void> {
    if (d.scale === scale) return;
    d.scale = scale;
    const painted = d.nextPaint();
    // Resizing clears the backing store; the next paint draws the element again.
    d.canvas.width = Math.round(d.board.bw * scale);
    d.canvas.height = Math.round(d.board.bh * scale);
    d.canvas.requestPaint?.();
    await painted;
  }

  function faceOf(c: CardRefs): Drawn {
    const known = faces.get(c.def.id);
    if (known) return known;
    const el = c.card.querySelector<HTMLElement>("[data-face]");
    const clip = el?.parentElement;
    if (!el || !clip) throw new Error(`gl: card ${c.def.id} has no face`);
    const d = mount(el, c.def.mini ? FACE.mini : FACE.full, clip, () => {
      changed(c.def.id);
    });
    faces.set(c.def.id, d);
    return d;
  }

  function backOf(c: CardRefs, board: Drawn["board"]): Drawn | undefined {
    const key = `${String(board.bw)}x${String(board.bh)}`;
    const known = backs.get(key);
    if (known) return known;
    const src = c.card.querySelector<HTMLElement>("[data-back]");
    if (!src) return undefined;
    const copy = src.cloneNode(true);
    if (!(copy instanceof HTMLElement)) return undefined;
    copy.className = "gl-drawable-back";
    for (const el of copy.querySelectorAll<HTMLElement>(SHADER_DRAWN))
      el.style.setProperty("visibility", "hidden");
    const d = mount(copy, board, root, () => {
      for (const [id, f] of faces) if (f.board === board) changed(id);
    });
    d.canvas.classList.add("gl-drawable-page");
    backs.set(key, d);
    return d;
  }

  return {
    async load(cards: readonly CardRefs[], geo: Geometry, dpr: number) {
      const out = new Map<string, FaceImages>();
      for (const c of cards) {
        const board = c.def.mini ? FACE.mini : FACE.full;
        const k = (c.def.mini ? geo.mw : geo.w) / board.bw;
        const baked = await bakedImage(
          c.card.querySelector("[data-face]")?.firstElementChild,
          board,
        );
        const face = faceOf(c);
        const backImage = await bakedImage(
          c.card.querySelector("[data-back]")?.firstElementChild,
          board,
        );
        const back = backImage ? undefined : backOf(c, board);
        // A face already drawn sharper for the showcase keeps that size.
        await Promise.all([resize(face, Math.max(k * dpr, face.scale)), back && resize(back, k * dpr)]);
        out.set(c.def.id, {
          face: { source: baked ?? face.canvas, uv: [0, 0, 1, 1] },
          art: await artOf(c, k, dpr),
          back: { source: backImage ?? back?.canvas ?? face.canvas, uv: [0, 0, 1, 1] },
          live: [],
        });
      }
      return out;
    },
    rescale(id: string, scale: number): void {
      const d = faces.get(id);
      if (d) void resize(d, scale);
    },
  };
}
