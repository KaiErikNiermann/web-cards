// How each element of a card face reaches the WebGL texture, chosen in the markup with
// `data-bake` on the element or an ancestor (the nearest one wins):
//  - "runtime" (the default): rasterized on the device into the face atlas (raster.ts), and
//    again when it changes;
//  - "build": screenshotted at build time in headless Chromium (scripts/bake-faces.ts), so it
//    looks the same on every device; without a matching image (the dev server, changed
//    markup) it falls back to "runtime". Whole faces and backs only, for now;
//  - "live": text drawn straight into the atlas with Canvas2D on every change, without a new
//    snapshot (livetext.ts). Per element, for elements holding only text; `data-live-text`
//    means the same;
//  - "none": not rasterized at all. The element stays real DOM on top of the card (caret,
//    selection, IME and accessibility as usual) and follows its transform. The material
//    layers (foil, glare) do not light it, and on a card in a row it sits above the whole
//    row's canvas, so a card stacked over it would not cover it.
//
// With HTML-in-Canvas faces (drawable.ts, Chromium) the browser draws every face itself and the
// face stays live and interactive, so "runtime", "live" and "none" all mean the same there:
// drawn from the real element on every change. "build" still uses its baked image.

/** Elements whose text is drawn live into the atlas. */
export const LIVE = "[data-live-text], [data-bake='live']";

/** Elements left as DOM over the canvas: the marked ones and everything inside them. */
export const DOM_PART = "[data-bake='none']";

/** Whether `el` is a DOM part or inside one. */
export const isInDomPart = (el: Element): boolean => el.closest(DOM_PART) !== null;

/**
 * Marks the elements between `card` and the DOM parts of its face that hold them
 * (`data-gl-path`) and their other children (`data-gl-veil`), so CSS can hide only the
 * holders' own paint and keep the rest a ghost while the DOM parts show.
 */
export function markDomParts(card: HTMLElement): void {
  const parts = [...card.querySelectorAll<HTMLElement>(DOM_PART)];
  const paths = new Set<HTMLElement>();
  for (const part of parts) {
    for (let el = part.parentElement; el && el !== card; el = el.parentElement) paths.add(el);
  }
  for (const el of paths) {
    el.dataset.glPath = "";
    for (const child of el.children) {
      if (child instanceof HTMLElement && !paths.has(child) && !parts.includes(child))
        child.dataset.glVeil = "";
    }
  }
}

/** Whether `face` has any DOM part. */
export const hasDomParts = (face: Element): boolean => face.querySelector(DOM_PART) !== null;

/**
 * Hides the content of the DOM parts in a face's snapshot copy but keeps their boxes
 * (background, border). WebGL then draws the same box under the live part, so a part a pixel
 * off while the card settles, or a compositor tile seam where the part is drawn at a
 * fractional scale, shows its own colour instead of what was behind it: hidden whole, a dark
 * line crossed the Lab note's textarea in the showcase on the phone (Firefox for Android).
 */
export function hideDomParts(clone: HTMLElement): void {
  for (const part of clone.querySelectorAll<HTMLElement>(DOM_PART)) {
    for (const el of [part, ...part.querySelectorAll<HTMLElement>("*")]) {
      for (const p of [
        "color",
        "-webkit-text-fill-color",
        "caret-color",
        "text-decoration-color",
      ]) {
        el.style.setProperty(p, "transparent");
      }
      el.style.setProperty("text-shadow", "none");
      if (el.matches("img, svg, canvas, video")) el.style.setProperty("visibility", "hidden");
    }
  }
}

/** Elements the snapshot leaves out because the shader draws them: images and moving layers. */
export const SHADER_DRAWN = "img, .par, .ember";

/** The bake mode an element resolves to: its own `data-bake` or its nearest ancestor's. */
export function bakeOf(el: Element): string {
  return el.closest<HTMLElement>("[data-bake]")?.dataset.bake ?? "runtime";
}

/**
 * Whether `root` (a face's content, or a card back) is baked whole at build time: it resolves
 * to "build" and holds nothing that must be rasterized on the device (runtime or live parts).
 * DOM parts are fine; the bake leaves them out like the snapshot does.
 */
export function isBuildBaked(root: Element): boolean {
  const isDeviceBaked = (el: Element): boolean =>
    el.closest(DOM_PART) === null && (bakeOf(el) !== "build" || el.matches("[data-live-text]"));
  return (
    bakeOf(root) === "build" &&
    [...root.querySelectorAll("[data-bake], [data-live-text]")].every((el) => !isDeviceBaked(el))
  );
}

/**
 * Key of a build-baked image: a hash of the element's markup without the renderer's own marks
 * (`data-gl-*`) and inline styles (the table writes custom properties there as cards move), and
 * the artboard size it is laid out at. A face whose markup differs from the
 * one baked at build time gets another key and is rasterized on the device instead.
 */
export function bakeKey(
  root: Element,
  board: { readonly bw: number; readonly bh: number },
): string {
  const copy = root.cloneNode(true);
  if (!(copy instanceof Element)) throw new TypeError("gl: bake root is not an element");
  for (const el of [copy, ...copy.querySelectorAll("*")]) {
    for (const name of el.getAttributeNames()) {
      if (name === "style" || name.startsWith("data-gl-")) el.removeAttribute(name);
    }
  }
  // FNV-1a, 32 bit: $h \leftarrow (h \oplus c) \cdot 16777619 \bmod 2^{32}$.
  let h = 0x81_1C_9D_C5;
  for (const ch of copy.outerHTML) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 0x01_00_01_93) >>> 0;
  return `${h.toString(16).padStart(8, "0")}-${String(board.bw)}x${String(board.bh)}`;
}

/** The build bake's manifest (scripts/bake-faces.ts writes it next to the page). */
export interface BakeManifest {
  /** Device px per artboard px the images were taken at. */
  readonly scale: number;
  /** Image file, relative to the manifest, by key. */
  readonly images: Readonly<Record<string, string>>;
}
