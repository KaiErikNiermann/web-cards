// Which canvas draws a card, and whether its DOM parts (bake.ts) rise above the overlay canvas.
// Each section row has a canvas under its card slots; the overlay canvas sits above every slot.
// A DOM part is real DOM in its card's slot, so it paints above its row's canvas and below the
// overlay, unless its slot is raised above the overlay.

export interface Routing {
  /** Shown in the showcase. */
  readonly isShown: boolean;
  /** Being dragged by a pointer. */
  readonly isDragged: boolean;
  /** Moving in the physics (dragged, pushed aside, gliding home). */
  readonly isMoving: boolean;
  /** The card has DOM parts. */
  readonly hasParts: boolean;
  /** Some card in the card's row has DOM parts. */
  readonly rowHasParts: boolean;
}

/**
 * Whether a card must be drawn on the overlay whatever its position: the showcased card (above
 * every row), and a moving card in a row with DOM parts, which would pass under them on the
 * row's canvas. A card with DOM parts goes there only while dragged: merely moving under a
 * dragged card, it would sit under the overlay with holes where its parts are cut out.
 */
export function isOverlayOnly(c: Routing): boolean {
  if (c.isShown) return true;
  return c.hasParts ? c.isDragged : c.isMoving && c.rowHasParts;
}

/**
 * The overlay cards (in drawing order, bottom first) whose DOM parts rise above the overlay
 * canvas: those with parts that no card drawn after them overlaps. One that is overlapped stays
 * under the canvas, which draws the card above it.
 */
export function raisedAboveOverlay<T>(
  list: readonly T[],
  hasParts: (card: T) => boolean,
  isOverlapping: (a: T, b: T) => boolean,
): Set<T> {
  return new Set(list.filter((p, i) => hasParts(p) && list.slice(i + 1).every((q) => !isOverlapping(p, q))));
}
