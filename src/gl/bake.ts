// How each element of a card face reaches the WebGL texture, chosen in the markup with
// `data-bake` on the element or an ancestor (the nearest one wins):
//  - "runtime" (the default): rasterized on the device into the face atlas (raster.ts), and
//    again when it changes;
//  - "build": rasterized at build time, so it looks the same on every device; treated as
//    "runtime" until the build step exists;
//  - "live": text drawn straight into the atlas with Canvas2D on every change, without a new
//    snapshot (livetext.ts). Per element, for elements holding only text; `data-live-text`
//    means the same;
//  - "none": not rasterized at all. The element stays real DOM on top of the card (caret,
//    selection, IME and accessibility as usual) and follows its transform. The material
//    layers (foil, glare) do not light it, and on a card in a row it sits above the whole
//    row's canvas, so a card stacked over it would not cover it.

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
      if (child instanceof HTMLElement && !paths.has(child) && !parts.includes(child)) child.dataset.glVeil = "";
    }
  }
}

/** Whether `face` has any DOM part. */
export const hasDomParts = (face: Element): boolean => face.querySelector(DOM_PART) !== null;

/** Hides the DOM parts in a face's snapshot copy, keeping their space and what is behind. */
export function hideDomParts(clone: HTMLElement): void {
  for (const el of clone.querySelectorAll<HTMLElement>(DOM_PART)) el.style.setProperty("visibility", "hidden");
}

