// Where the WebGL renderer gets each card's face from. The shader, physics and input do not
// depend on how the face became a texture, so the source differs by browser:
//  - drawableFaces (drawable.ts), where the browser has HTML-in-Canvas (Chromium 157+): the
//    real face, kept in a drawable canvas inside the card, is painted by the browser itself
//    and uploaded on every change;
//  - snapshotFaces (raster.ts) everywhere else, or with `?glsrc=snapshot`: the faces are
//    rasterized through an SVG foreignObject into one atlas per card size, with stand-ins for
//    what that misses (controls, live text, line locking).
// Faces baked at build time (baked.ts) use their image with either.

import type { Geometry } from "../data";
import type { CardRefs } from "../dom";
import type { LiveText } from "./livetext";

export interface FaceArt {
  readonly image: ImageBitmap;
  /** Box the image is clipped to, in card px from the card's top-left corner. */
  readonly rect: readonly [number, number, number, number];
  /** That box's corner radius in card px. */
  readonly r: number;
  /** object-fit: cover placement inside that box: offset x, y and drawn width, height. */
  readonly fit: readonly [number, number, number, number];
  /** The parallax layer's scale (1.1 for `.par`, 1 for a plain full-face image). */
  readonly scale: number;
  /** The image paints over the face (the unit card's framed window) rather than under it. */
  readonly isOnTop: boolean;
}

export interface FaceImages {
  /**
   * Text, plates and gradients of the face, as a region of `source` (u, v, width, height in
   * [0, 1]); undefined when the face is only an image.
   */
  readonly face:
    | { readonly source: TexImageSource; readonly uv: readonly [number, number, number, number] }
    | undefined;
  readonly art: FaceArt | undefined;
  /** The card back, a region of its own atlas; undefined when it was not rasterized. */
  readonly back?: FaceImages["face"];
  /** Text on the face that changes, drawn into the face's atlas live (livetext.ts). */
  readonly live?: readonly LiveText[];
}

export interface FaceSource {
  /** Face images of `cards` at geometry `geo` and device pixel ratio `dpr`, by card id. */
  load(
    cards: readonly CardRefs[],
    geo: Geometry,
    dpr: number,
  ): Promise<ReadonlyMap<string, FaceImages>>;
}
