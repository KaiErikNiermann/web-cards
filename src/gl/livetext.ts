// Text that changes on a face (a clock, a counter), drawn straight into the face's atlas with
// Canvas2D instead of snapshotting the face again. The face is snapshotted once with these
// elements transparent; their box, font and the pixels behind them are kept, and every change
// puts the background back and draws the new text, using the fonts the page has loaded.
//
// A face snapshot took about 230 ms on the phone (the fonts are embedded and decoded with every
// SVG); redrawing a line of text is a fill and an upload of its rectangle.

/** Marks an element whose text changes: its text is drawn live, not snapshotted (bake.ts). */
export { LIVE as LIVE_TEXT } from "./bake";

export interface LiveText {
  /** The element on the page whose text is drawn. */
  readonly el: HTMLElement;
  /** The atlas canvas holding the face, and the element's box in it (device px). */
  readonly canvas: HTMLCanvasElement;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly scale: number;
  readonly font: string;
  readonly color: string;
  readonly letterSpacing: string;
  readonly transform: string;
  readonly isCentred: boolean;
  readonly background: ImageData;
}

/** Records a live-text element of a clone in the atlas grid, before the snapshot. */
export interface LiveTextSpec {
  readonly el: HTMLElement;
  /** Box relative to the atlas grid, in artboard px. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly font: string;
  readonly color: string;
  readonly letterSpacing: string;
  readonly transform: string;
  readonly isCentred: boolean;
}

/** Reads a live-text element's box and text style from its clone, then hides its text. */
export function specOf(page: HTMLElement, clone: HTMLElement, grid: DOMRect): LiveTextSpec {
  const r = clone.getBoundingClientRect();
  const cs = getComputedStyle(clone);
  const parent = clone.parentElement ? getComputedStyle(clone.parentElement) : undefined;
  const isCentred =
    cs.textAlign === "center" ||
    (parent?.display.includes("flex") === true && parent.alignItems === "center");
  // Room to grow within the face: the box is measured around the text of the moment, and a
  // counter that went from "1" to "13" was clipped to "1". Left-aligned text may run to the
  // face's end; centred text grows evenly, keeping its centre.
  const face = (
    clone.closest("[data-face]") ??
    clone.parentElement ??
    clone
  ).getBoundingClientRect();
  const grow = Math.max(0, Math.min(r.x - face.x, face.right - r.right));
  const [x, w] = isCentred
    ? [r.x - grow, r.width + 2 * grow]
    : [r.x, Math.max(r.width, face.right - r.x)];
  const spec = {
    el: page,
    x: x - grid.x,
    y: r.y - grid.y,
    w,
    h: r.height,
    font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
    color: cs.color,
    letterSpacing: cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing,
    transform: cs.textTransform,
    isCentred,
  };
  clone.style.setProperty("color", "transparent");
  clone.style.setProperty("text-shadow", "none");
  return spec;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("gl: atlas canvas has no 2d context");
  return ctx;
}

/** Keeps the pixels behind the element and draws its current text once. */
export function bind(spec: LiveTextSpec, canvas: HTMLCanvasElement, scale: number): LiveText {
  const x = Math.floor(spec.x * scale);
  const y = Math.floor(spec.y * scale);
  const w = Math.ceil((spec.x + spec.w) * scale) - x;
  const h = Math.ceil((spec.y + spec.h) * scale) - y;
  const t = {
    ...spec,
    canvas,
    x,
    y,
    w,
    h,
    scale,
    background: context(canvas).getImageData(x, y, w, h),
  };
  paint(t);
  return t;
}

/** Draws the element's current text over its saved background; returns the rectangle. */
export function paint(t: LiveText): void {
  const ctx = context(t.canvas);
  ctx.putImageData(t.background, t.x, t.y);
  let text = t.el.textContent;
  if (t.transform === "uppercase") text = text.toUpperCase();
  else if (t.transform === "lowercase") text = text.toLowerCase();
  ctx.save();
  ctx.beginPath();
  ctx.rect(t.x, t.y, t.w, t.h);
  ctx.clip();
  ctx.setTransform(t.scale, 0, 0, t.scale, 0, 0);
  ctx.font = t.font;
  ctx.fillStyle = t.color;
  ctx.letterSpacing = t.letterSpacing;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = t.isCentred ? "center" : "left";
  // The text sits in its box as CSS centres a line: half the leftover height above the font's
  // ascent-to-descent span, the baseline after the ascent.
  const m = ctx.measureText(text);
  const ascent = m.fontBoundingBoxAscent;
  const span = ascent + m.fontBoundingBoxDescent;
  const top = t.y / t.scale + (t.h / t.scale - span) / 2;
  const left = t.x / t.scale;
  ctx.fillText(text, t.isCentred ? left + t.w / t.scale / 2 : left, top + ascent);
  ctx.restore();
}
