// A face's image for the shader: the decoded <img>, downscaled once to the largest size it is
// drawn at, with the box it is clipped to and its object-fit: cover placement read from the
// live DOM. Shared by every face source.

import type { CardRefs } from "../dom";
import type { FaceArt } from "./faces";

/** The parallax layer's scale(1.1) times the Ken Burns zoom's largest scale, 1.16. */
const PAR_MAX_SCALE = 1.1 * 1.16;
const PAR_SCALE = 1.1;

const bitmaps = new Map<string, Promise<ImageBitmap>>();

/** Offset of `el` from `ancestor`, in unscaled layout px. */
function offsetWithin(el: HTMLElement, ancestor: HTMLElement): [number, number] {
  let x = 0;
  let y = 0;
  for (
    let cur: Element | null = el;
    cur !== ancestor && cur instanceof HTMLElement;
    cur = cur.offsetParent
  ) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
  }
  return [x, y];
}

const px = (v: string): number => Number(v.replace("px", ""));

/** The image downscaled to `width` px, shared by every card that shows it at that size. */
function bitmap(img: HTMLImageElement, width: number): Promise<ImageBitmap> {
  const w = Math.min(img.naturalWidth, Math.ceil(width));
  const key = `${img.currentSrc}|${String(w)}`;
  let made = bitmaps.get(key);
  if (!made) {
    made = createImageBitmap(img, {
      resizeWidth: w,
      resizeHeight: Math.round((img.naturalHeight * w) / img.naturalWidth),
      resizeQuality: "high",
    });
    bitmaps.set(key, made);
  }
  return made;
}

/** The face's image at face scale `k` (card px per artboard px); undefined without one. */
/** The art box's place on the artboard, measured once while the face was laid out. */
interface ArtGeometry {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly r: number;
  readonly fx: number;
  readonly fy: number;
  readonly isPar: boolean;
  readonly isOnTop: boolean;
}

const geometries = new Map<string, ArtGeometry>();

/** Reads the art box from the live face; undefined while the face is not laid out. */
function measure(faceEl: HTMLElement, img: HTMLImageElement): ArtGeometry | undefined {
  const par = img.parentElement?.classList.contains("par") ? img.parentElement : undefined;
  const box = par?.parentElement ?? faceEl;
  if (box.offsetWidth === 0 || box.offsetHeight === 0) return undefined;
  const [x, y] = box === faceEl ? [0, 0] : offsetWithin(box, faceEl);
  const [posX = "50%", posY = "50%"] = getComputedStyle(img).objectPosition.split(" ", 2);
  return {
    x,
    y,
    w: box.offsetWidth,
    h: box.offsetHeight,
    r: box === faceEl ? 0 : px(getComputedStyle(box).borderTopLeftRadius),
    fx: Number(posX.replace("%", "")) / 100,
    fy: Number(posY.replace("%", "")) / 100,
    isPar: par !== undefined,
    isOnTop: box !== faceEl,
  };
}

/**
 * The face's image at face scale `k` (card px per artboard px) and `dpr` device px per card
 * px; undefined without one. The box is measured on the live face the first time; a face drawn
 * by WebGL is not laid out, so later calls (a sharper copy for the showcase) reuse it.
 */
export async function artOf(c: CardRefs, k: number, dpr: number): Promise<FaceArt | undefined> {
  const faceEl = c.card.querySelector<HTMLElement>("[data-face]");
  const img = faceEl?.querySelector<HTMLImageElement>(":scope .par > img, :scope img.full");
  if (!faceEl || !img) return undefined;
  const g = measure(faceEl, img) ?? geometries.get(c.def.id);
  if (!g) return undefined;
  geometries.set(c.def.id, g);
  await img.decode();
  const bw = g.w * k;
  const bh = g.h * k;
  // object-fit: cover, placed by object-position (percentages, as every face uses).
  const cover = Math.max(bw / img.naturalWidth, bh / img.naturalHeight);
  const dw = img.naturalWidth * cover;
  const dh = img.naturalHeight * cover;
  return {
    image: await bitmap(img, dw * dpr * (g.isPar ? PAR_MAX_SCALE : 1)),
    rect: [g.x * k, g.y * k, bw, bh],
    r: g.r * k,
    fit: [(bw - dw) * g.fx, (bh - dh) * g.fy, dw, dh],
    scale: g.isPar ? PAR_SCALE : 1,
    isOnTop: g.isOnTop,
  };
}
