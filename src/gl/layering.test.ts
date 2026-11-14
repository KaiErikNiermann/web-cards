import { describe, expect, it } from "vitest";

import { isOverlayOnly, raisedAboveOverlay, type Routing } from "./layering";

const card = (over: Partial<Routing> = {}): Routing => ({
  isShown: false,
  isDragged: false,
  isMoving: false,
  hasParts: false,
  rowHasParts: false,
  ...over,
});

describe("isOverlayOnly", () => {
  it("puts the showcased card on the overlay, even when it fits its row", () => {
    // A showcased card drawn on its row's canvas sat under the Lab note's textarea (a DOM part).
    expect(isOverlayOnly(card({ isShown: true }))).toBe(true);
    expect(isOverlayOnly(card({ isShown: true, rowHasParts: true }))).toBe(true);
  });

  it("puts a moving card on the overlay in a row with DOM parts, not elsewhere", () => {
    expect(isOverlayOnly(card({ isMoving: true, rowHasParts: true }))).toBe(true);
    expect(isOverlayOnly(card({ isMoving: true }))).toBe(false);
    expect(isOverlayOnly(card({ rowHasParts: true }))).toBe(false);
  });

  it("keeps a card with DOM parts on its row while it is only moving, not dragged", () => {
    // Pushed aside or gliding home under a dragged card, the note went on the overlay too, under
    // the dragged card, so its textarea stayed under the overlay canvas: a blank hole (Firefox).
    expect(isOverlayOnly(card({ hasParts: true, isMoving: true, rowHasParts: true }))).toBe(false);
  });

  it("puts a card with DOM parts on the overlay while it is dragged", () => {
    expect(
      isOverlayOnly(card({ hasParts: true, isDragged: true, isMoving: true, rowHasParts: true })),
    ).toBe(true);
  });
});

describe("raisedAboveOverlay", () => {
  // Overlay cards in drawing order (bottom first), with intervals on one axis for their bounds.
  interface Box {
    readonly id: string;
    readonly hasParts: boolean;
    readonly from: number;
    readonly to: number;
  }
  const isOverlapping = (a: Box, b: Box): boolean => a.from < b.to && b.from < a.to;
  const raised = (list: readonly Box[]): string[] =>
    [...raisedAboveOverlay(list, (b) => b.hasParts, isOverlapping)].map((b) => b.id);

  it("raises a card with DOM parts that is on top", () => {
    expect(
      raised([
        { id: "list", hasParts: false, from: 0, to: 10 },
        { id: "note", hasParts: true, from: 5, to: 15 },
      ]),
    ).toEqual(["note"]);
  });

  it("keeps a card with DOM parts under a card drawn above it that overlaps it", () => {
    // Raised regardless, the note's textarea showed over the showcased card above it.
    expect(
      raised([
        { id: "note", hasParts: true, from: 0, to: 10 },
        { id: "shown", hasParts: false, from: 5, to: 15 },
      ]),
    ).toEqual([]);
  });

  it("raises a card with DOM parts under a card above it that does not overlap it", () => {
    // Raising only the topmost card left the note's parts under the canvas, a hole, although
    // nothing covered it.
    expect(
      raised([
        { id: "note", hasParts: true, from: 0, to: 10 },
        { id: "far", hasParts: false, from: 20, to: 30 },
      ]),
    ).toEqual(["note"]);
  });

  it("raises nothing without DOM parts", () => {
    expect(raised([{ id: "a", hasParts: false, from: 0, to: 10 }])).toEqual([]);
  });
});
