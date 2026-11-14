// The snapshot face source: what WebGL draws of each card's face, taken from the live DOM so
// the page's markup and stylesheet stay the only description of it, in any browser.
//  - Text, plates and gradients: every face of one size is cloned into an off-screen grid and
//    rasterized in one pass through modern-screenshot (an SVG foreignObject the browser renders
//    with its own text and layout engine), giving one atlas per card size. One snapshot per
//    face cost the phone 5.6 s and about 565 MB, since every snapshot is its own SVG document
//    with the fonts embedded and decoded again.
//  - Images: the decoded <img> itself, downscaled once to the largest size the shader draws
//    it at, plus the box it sits in and its object-fit placement (art.ts), so the shader can
//    move it (parallax, Ken Burns) the way cards.css does. Embedded in snapshots, each one
//    decoded its card's full-size art again.

import html2canvas from "html2canvas-pro";
import { createContext, destroyContext, domToCanvas, type Options } from "modern-screenshot";

import { FACE, type Geometry } from "../data";
import type { CardRefs } from "../dom";
import { artOf } from "./art";
import type { FaceImages, FaceSource } from "./faces";
import { bind, LIVE_TEXT, specOf, type LiveText, type LiveTextSpec } from "./livetext";

const shared: { sandbox?: Promise<HTMLIFrameElement> } = {};

/**
 * A loaded, standards-mode iframe for modern-screenshot's default-style lookups. Its own
 * sandbox is read before its srcdoc loads, while it is still a quirks-mode about:blank, where
 * Firefox zeroes the margins of body's first and last child: a `<p>` with `margin: 0` then
 * matches that "default", the margin is left out of the snapshot, and the `<p>` gets 1em
 * margins there (.upstream-issues/modern-screenshot-quirks-sandbox-drops-margins-2026-11-14.md).
 */
function standardsSandbox(): Promise<HTMLIFrameElement> {
  shared.sandbox ??= new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.addEventListener(
      "load",
      () => {
        resolve(frame);
      },
      { once: true },
    );
    frame.srcdoc = '<!DOCTYPE html><meta charset="UTF-8"><title></title><body>';
    document.body.append(frame);
  });
  return shared.sandbox;
}

async function snapshot(el: HTMLElement, options: Options): Promise<HTMLCanvasElement> {
  const ctx = await createContext(el, options);
  ctx.sandbox = await standardsSandbox();
  try {
    return await domToCanvas(ctx);
  } finally {
    // The sandbox is shared; keep destroyContext from removing it.
    delete ctx.sandbox;
    destroyContext(ctx);
  }
}

/**
 * TEMP experiment (`?glsrc=canvas`): bake with html2canvas-pro, which walks the DOM and paints
 * it with Canvas2D using the page's loaded fonts, instead of an SVG foreignObject image that
 * embeds and decodes the fonts with every snapshot.
 */
const BAKER = location.search.includes("glsrc=canvas") ? "canvas" : "svg";

async function paintSnapshot(el: HTMLElement, scale: number): Promise<HTMLCanvasElement> {
  return html2canvas(el, {
    scale,
    // eslint-disable-next-line unicorn/no-null -- html2canvas takes null for a transparent background
    backgroundColor: null,
    logging: false,
    // It clones the whole document; keep only the element, its ancestors and the styles.
    ignoreElements: (e) =>
      !(e.contains(el) || el.contains(e) || e.closest("head")),
  });
}

/** Elements the face snapshot leaves out: images, and layers the shader animates. */
const isLeftOut = (n: Node): boolean =>
  n instanceof HTMLImageElement ||
  (n instanceof Element && (n.classList.contains("par") || n.classList.contains("ember")));

/**
 * Carries live state the clone does not: `cloneNode` copies attributes, not the current value
 * of a field, a checkbox or a select, nor how far a box is scrolled.
 */
function copyLiveState(src: HTMLElement, clone: HTMLElement): void {
  const from = src.querySelectorAll("input, textarea, select");
  const to = clone.querySelectorAll("input, textarea, select");
  for (const [i, a] of from.entries()) {
    const b = to[i];
    if (a instanceof HTMLTextAreaElement && b instanceof HTMLTextAreaElement) b.textContent = a.value;
    else if (a instanceof HTMLInputElement && b instanceof HTMLInputElement) {
      b.setAttribute("value", a.value);
      b.toggleAttribute("checked", a.checked);
    } else if (a instanceof HTMLSelectElement && b instanceof HTMLSelectElement) {
      for (const [j, o] of [...a.options].entries()) b.options[j]?.toggleAttribute("selected", o.selected);
    }
  }
}

/** Scroll offsets of `src`'s scrolled boxes, applied to the clone once it is laid out. */
function copyScroll(src: HTMLElement, clone: HTMLElement): void {
  const from = [src, ...src.querySelectorAll<HTMLElement>("*")];
  const to = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  for (const [i, a] of from.entries()) {
    const b = to[i];
    if (!b || (a.scrollTop === 0 && a.scrollLeft === 0)) continue;
    b.scrollTop = a.scrollTop;
    b.scrollLeft = a.scrollLeft;
  }
}

/** Gap between atlas cells, in artboard px, so mipmaps of one face never sample the next. */
const CELL_GAP = 4;

/** Key of the card back's cell in its atlas. */
const BACK = "back";

export interface Atlas {
  readonly regions: Map<string, NonNullable<FaceImages["face"]>>;
  /** Live-text elements of each face, drawn into the atlas canvas. */
  readonly live: Map<string, LiveText[]>;
}

/**
 * Card backs by size and raster scale: the back never changes, so it is rasterized once and
 * not again with every face that is snapshotted anew.
 */
const backs = new Map<string, Promise<FaceImages["face"]>>();

/**
 * Rasterizes `entries` (faces or a card back, one artboard size) into one atlas, by key.
 * Exported for the parity check (debug/parity.html), which compares it with the browser's
 * own rendering.
 */
export async function atlas(
  root: HTMLElement,
  entries: readonly { readonly key: string; readonly el: HTMLElement }[],
  board: { readonly bw: number; readonly bh: number },
  scale: number,
): Promise<Atlas> {
  if (entries.length === 0) return { regions: new Map(), live: new Map() };
  const cols = Math.ceil(Math.sqrt(entries.length));
  const rows = Math.ceil(entries.length / cols);
  const cw = board.bw + CELL_GAP;
  const ch = board.bh + CELL_GAP;
  const grid = document.createElement("div");
  grid.className = "gl-atlas";
  grid.style.setProperty("--atlas-w", `${String(cols * cw)}px`);
  grid.style.setProperty("--atlas-h", `${String(rows * ch)}px`);
  const cells = entries.map(({ key, el: faceEl }, i) => {
    const cell = faceEl.cloneNode(true);
    if (!(cell instanceof HTMLElement)) throw new TypeError("gl: face clone is not an element");
    copyLiveState(faceEl, cell);
    cell.className = "gl-atlas-cell";
    cell.style.setProperty("--cell-x", `${String((i % cols) * cw)}px`);
    cell.style.setProperty("--cell-y", `${String(Math.floor(i / cols) * ch)}px`);
    cell.style.setProperty("--cell-w", `${String(board.bw)}px`);
    cell.style.setProperty("--cell-h", `${String(board.bh)}px`);
    grid.append(cell);
    return { id: key, i, faceEl, cell };
  });
  root.append(grid);
  // Scroll offsets apply only to laid-out boxes; the left-out parts go after, so the clone's
  // elements still pair up with the face's.
  for (const { faceEl, cell } of cells) {
    copyScroll(faceEl, cell);
    for (const el of cell.querySelectorAll("*")) if (isLeftOut(el)) el.remove();
  }
  // Text that changes is left out of the snapshot and drawn live (livetext.ts).
  const gridBox = grid.getBoundingClientRect();
  const specs = new Map<string, LiveTextSpec[]>(
    cells.map(({ id, faceEl, cell }) => {
      const pages = faceEl.querySelectorAll<HTMLElement>(LIVE_TEXT);
      const clones = cell.querySelectorAll<HTMLElement>(LIVE_TEXT);
      return [
        id,
        [...pages].flatMap((p, j) => {
          const clone = [...clones][j];
          return clone ? [specOf(p, clone, gridBox)] : [];
        }),
      ];
    }),
  );
  try {
    const source =
      BAKER === "canvas"
        ? await paintSnapshot(grid, scale)
        : await snapshot(grid, {
            width: cols * cw,
            height: rows * ch,
            scale,
            style: { position: "static", transform: "none" },
          });
    const W = cols * cw;
    const H = rows * ch;
    const scaleX = source.width / W;
    return {
      regions: new Map(
        cells.map(({ id, i }) => [
          id,
          {
            source,
            uv: [((i % cols) * cw) / W, (Math.floor(i / cols) * ch) / H, board.bw / W, board.bh / H],
          },
        ]),
      ),
      live: new Map([...specs].map(([id, list]) => [id, list.map((sp) => bind(sp, source, scaleX))])),
    };
  } finally {
    grid.remove();
  }
}

function faceOf(c: CardRefs): HTMLElement {
  const el = c.card.querySelector<HTMLElement>("[data-face]");
  if (!el) throw new Error(`gl: card ${c.def.id} has no face`);
  return el;
}

/** Faces with something besides their image: they need the snapshot. */
const hasOverlay = (c: CardRefs): boolean =>
  [...(c.card.querySelector("[data-face]")?.children ?? [])].some((ch) => !isLeftOut(ch));

export function snapshotFaces(root: HTMLElement): FaceSource {
  return {
    async load(cards: readonly CardRefs[], geo: Geometry, dpr: number) {
      const out = new Map<string, FaceImages>();
      for (const isMini of [false, true]) {
        const group = cards.filter((c) => (c.def.mini ?? false) === isMini);
        const board = isMini ? FACE.mini : FACE.full;
        const k = (isMini ? geo.mw : geo.w) / board.bw;
        const entries = group.filter((c) => hasOverlay(c)).map((c) => ({ key: c.def.id, el: faceOf(c) }));
        const backEl = group[0]?.card.querySelector<HTMLElement>("[data-back]");
        const backKey = `${String(isMini)}|${String(k * dpr)}`;
        if (backEl && !backs.has(backKey)) {
          const backOf = async (): Promise<FaceImages["face"]> => {
            const a = await atlas(root, [{ key: BACK, el: backEl }], board, k * dpr);
            return a.regions.get(BACK);
          };
          backs.set(backKey, backOf());
        }
        // One atlas at a time: the first version took all snapshots at once, and the phone's tab
        // passed 2 GB until Android killed it.
        const faces = await atlas(root, entries, board, k * dpr);
        const back = await backs.get(backKey);
        for (const c of group) {
          // In turn, so cards showing the same image at the same size share its bitmap.
          const art = await artOf(c, k, dpr);
          out.set(c.def.id, {
            face: faces.regions.get(c.def.id),
            art,
            back,
            live: faces.live.get(c.def.id) ?? [],
          });
        }
      }
      return out;
    },
  };
}
