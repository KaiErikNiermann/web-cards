// HTML-in-Canvas (WICG explainer, https://github.com/WICG/html-in-canvas), in Chromium from
// version 157 and not yet in TypeScript's DOM types. Optional, so code checks for it first.

interface CanvasPaintEvent extends Event {
  /** The drawable elements whose rendering changed since the last paint. */
  readonly changedElements: readonly Element[];
}

interface HTMLCanvasElement {
  /** Fires once the drawable children have a new rendering to draw. */
  onpaint?: ((this: HTMLCanvasElement, ev: CanvasPaintEvent) => unknown) | null;
  /** Fires `paint` at the next rendering opportunity even without changes. */
  requestPaint?: () => void;
}

interface CanvasRenderingContext2D {
  /**
   * Draws a drawable child's latest rendering (from its border box, before CSS transforms),
   * and maps its hit-testing to the drawn rectangle.
   */
  drawElementImage?: (element: Element, dx: number, dy: number, dw: number, dh: number) => void;
}
